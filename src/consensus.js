'use strict';
/**
 * Full Stop Consensus (FSC) v0.1 - round-based Byzantine-fault-tolerant
 * finality over the chain's own validator set.
 *
 * Flow per height:
 *   - a proposer is selected deterministically from the active validator set
 *     (stake-weighted, seeded by height and round);
 *   - the proposer executes and broadcasts a block with its app hash;
 *   - validators re-execute it, then cast a prevote;
 *   - +2/3 of voting power prevoting the same block hash -> precommit;
 *   - +2/3 precommitting -> the block is committed and the commit is
 *     attached to the next block as `lastCommit`;
 *   - a round that cannot gather a prevote quorum ends with a nil vote and
 *     advances the round, which moves the proposal right to the next
 *     validator in the weight order.
 *
 * Safety notes that matter for review (docs/SECURITY.md):
 *   - this is a BFT *approximation*: it implements quorum intersection,
 *     round advancement, double-sign evidence and slashing, but it does NOT
 *     implement the full lock/lockRound rules of a formally specified
 *     algorithm, so a 1/3 adversarial coalition could in principle cause a
 *     fork at a round boundary. It is intended for testnets and for
 *     validating the rest of the protocol, not as a finished consensus
 *     library;
 *   - liveness assumes partial synchrony and a correct proposer;
 *   - `+2/3` is computed as `2 * totalPower / 3 + 1`, i.e. strictly more than
 *     a third of power may be faulty.
 */

const { ethers } = require('ethers');
const { FullStopBlock, makeVote, verifyVote, ZERO_HASH, MessageType } = require('./block');
const { hashObject } = require('./crypto');
const { createLogger } = require('./logger');
const { BLOCK } = require('./constants');

const log = createLogger('consensus');

const TIMEOUTS = {
  proposeBaseMs: 1200,
  proposeDeltaMs: 400,
  voteBaseMs: 900,
  voteDeltaMs: 300,
};

class Consensus {
  /**
   * @param {object} deps
   * @param {Chain} deps.chain
   * @param {{address:string,privateKey:string,consensusAddress?:string}} deps.identity
   * @param {(msg:object, peers?:string[])=>void} deps.broadcast
   * @param {boolean} [deps.autostart]
   */
  constructor({ chain, identity, broadcast, params = {} }) {
    this.chain = chain;
    this.identity = identity;
    this.broadcast = broadcast ?? (() => {});
    this.params = params;
    this.enabled = !!identity && chain.mode === 'validator';
    this.height = 0;
    this.round = 0;
    this.step = 'new-height';
    this.proposal = null;
    this.votes = new Map(); // key `${height}:${round}:${type}` -> Map(validator -> vote)
    this.evidenceFound = new Map();
    this.timer = null;
    this.running = false;
    /** `${height}:${round}:${type}` -> blockHash we already signed */
    this.signedVotes = new Map();
    this.metrics = { rounds: 0, nilVotes: 0, skippedProposals: 0, blocksProposed: 0, emptyBlocks: 0 };
    /** round pacing: propose only once the block we would produce is legal */
    this.mustPropose = false;
    this.roundEarliestAt = 0;
    this.lastStepChange = Date.now();
    this.timeouts = { ...TIMEOUTS, ...(params.consensusTimeouts ?? {}) };
  }

  get isValidator() {
    if (!this.enabled) return false;
    const set = this.chain.protocol.staking.activeSet();
    return set.some((v) => this._represents(v, this.identity.address) || this._represents(v, this.identity.consensusAddress));
  }

  _represents(validator, address) {
    const a = address.toLowerCase();
    return validator.operator.toLowerCase() === a || validator.consensusAddress.toLowerCase() === a;
  }

  get votingPower() {
    const set = this.chain.protocol.staking.activeSet();
    const me = set.find((v) => this._represents(v, this.identity?.address) || this._represents(v, this.identity?.consensusAddress));
    return me ? me.power : 0n;
  }

  // ------------------------------------------------------------- lifecycle

  start() {
    if (this.running) return;
    this.running = true;
    this.enterHeight(this.chain.head.height + 1);
    // A single heartbeat drives every timeout. Chained setTimeout calls looked
    // simpler but each new timer cancelled the previous one, so a node could
    // end up with no pending timer at all and stall forever. The heartbeat
    // re-derives "what is due now" from (height, round, step, stepAt) instead.
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.error('consensus tick failed', { err: err.message, stack: err.stack?.split('\n')[1]?.trim() });
      }
    }, this.tickMs ?? 100);
    if (this.timer.unref) this.timer.unref();
  }

  get tickMs() {
    return this.params.consensusTickMs ?? 100;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Evaluate the state machine once. */
  tick() {
    if (!this.running) return;
    const head = this.chain.head;
    if (this.step === 'waiting-for-validators' || this.step === 'waiting-for-blocks') {
      if (this.chain.protocol.staking.activeSet().length && this.isValidator) this.enterHeight(head.height + 1);
      return;
    }
    if (this.height <= head.height) {
      // A node that learned about a block from a peer's commit (rather than by
      // committing in its own 'committed' step) lands here. It must still wait
      // out the pacing interval: entering the next height immediately is how a
      // healthy network ends up producing blocks at the *minimum* interval
      // instead of the target one.
      if (Date.now() >= (this.nextHeightAt ?? 0)) this.enterHeight(head.height + 1);
      return;
    }
    if (!this.isValidator) return;
    const elapsed = Date.now() - this.stepAt;
    switch (this.step) {
      case 'new-height':
        this.startRound(0);
        break;
      case 'propose': {
        // The proposer for this round speaks as soon as the slot opens. Driving
        // it from here instead of from startRound() is what keeps the chain
        // legal: a node that races into a height (right after a sync, or after
        // the height<=head catch-up branch above) would otherwise broadcast a
        // block whose time is inside the minimum interval, which every peer -
        // including itself - must reject. That reject storm burns rounds and
        // looks like a stall.
        if (this.mustPropose && Date.now() >= this.roundEarliestAt) {
          this.mustPropose = false;
          this.propose().catch((err) => {
            log.error('proposal failed', { err: err.message, stack: err.stack?.split('\n')[1]?.trim() });
            this.startPrevoteRound();
          });
        }
        const due = this.proposeDeadline();
        if (Date.now() >= due) {
          if (!this.proposal) {
            log.debug('proposal timeout, prevoting nil', { height: this.height, round: this.round });
            this.metrics.skippedProposals += 1;
          }
          this.startPrevoteRound();
        }
        break;
      }
      case 'prevote':
        if (elapsed > this.voteTimeout()) {
          this.metrics.nilVotes += 1;
          this._precommitNil();
        }
        break;
      case 'precommit':
        if (elapsed > this.voteTimeout()) this.advanceRound();
        break;
      case 'committed':
        if (Date.now() >= this.nextHeightAt) this.enterHeight(this.chain.head.height + 1);
        break;
      default:
        break;
    }
  }

  /**
   * When this node is allowed to give up on the round and prevote nil.
   *
   * Measured from the moment the round's slot *opens*, not from the step
   * change: an earlier build derived the deadline from `stepAt` and compared it
   * against the same pacing instant the proposer was waiting for, so a correct
   * proposal and the nil prevote became due at the same millisecond and the
   * proposal lost. Every block then committed at round 1 - a permanent view
   * change, and a block time of two intervals instead of one.
   */
  proposeDeadline() {
    const opened = this.roundEarliestAt ?? this.stepAt;
    return opened + this.timeouts.proposeBaseMs + this.round * this.timeouts.proposeDeltaMs;
  }

  /**
   * Earliest wall-clock time a block sealing `height` may carry. The protocol
   * rejects a block whose header time is closer than `minBlockIntervalMs` to
   * its parent, so a proposer must not produce one before that point.
   */
  earliestBlockTime() {
    const parent = this.chain.head;
    const minInterval = this.params.minBlockIntervalMs ?? BLOCK.minBlockIntervalMs;
    return (parent ? parent.header.time : 0) + minInterval;
  }

  voteTimeout() {
    return this.timeouts.voteBaseMs + this.round * this.timeouts.voteDeltaMs;
  }

  enterHeight(height) {
    this.height = height;
    this.round = 0;
    this.proposal = null;
    this.mustPropose = false;
    this.roundEarliestAt = 0;
    this.step = 'new-height';
    this.stepAt = Date.now();
    this.signedVotes.clear();
    if (!this.isValidator) {
      this.step = 'waiting-for-blocks';
      return;
    }
    if (!this.chain.protocol.staking.activeSet().length) {
      this.step = 'waiting-for-validators';
      return;
    }
    // Block pacing: a validator proposes at the target interval, and the same
    // bound is enforced on receipt (`minBlockIntervalMs`), so this is liveness
    // etiquette rather than a trust assumption. `nextHeightAt` is what every
    // path into the next height - own commit, peer commit, recovery - waits on.
    const parent = this.chain.head;
    const nextAt = parent ? parent.header.time + this.blockTimeMs : Date.now();
    this.nextHeightAt = Math.max(Date.now(), nextAt);
    this.proposeAt = this.nextHeightAt;
  }

  get blockTimeMs() {
    return this.params.blockTimeMs ?? 1500;
  }

  startRound(round) {
    if (!this.running || !this.isValidator) return;
    if (round < this.round) return;
    this.round = round;
    this.metrics.rounds += 1;
    this.step = 'propose';
    this.stepAt = Date.now();
    this.proposal = null;
    const proposer = this.chain.protocol.staking.proposerFor(this.height, round);
    if (!proposer) {
      log.warn('no active validators: consensus is stalled', { height: this.height });
      this.step = 'waiting-for-validators';
      return;
    }
    const mine = this._represents(proposer, this.identity.address) || this._represents(proposer, this.identity.consensusAddress);
    const pacing = round === 0 ? this.nextHeightAt ?? 0 : 0;
    this.roundEarliestAt = Math.max(Date.now(), this.earliestBlockTime(), pacing);
    this.mustPropose = mine;
  }

  async propose() {
    const set = this.chain.protocol.staking.activeSet();
    const expected = this.chain.protocol.staking.proposerFor(this.height, this.round);
    if (!expected || !(this._represents(expected, this.identity.address) || this._represents(expected, this.identity.consensusAddress))) {
      log.debug('not the proposer for this round', { height: this.height, round: this.round });
      return;
    }
    if (this.chain.head.height + 1 !== this.height) {
      this.enterHeight(this.chain.head.height + 1);
      return;
    }
    const { block } = await this.chain.produceBlock({
      height: this.height,
      round: this.round,
      // Clamped, not just "now": `roundEarliestAt` can be a few hundred ms in
      // the future when the previous block arrived late, and a block time
      // inside the minimum interval is invalid by rule.
      time: Math.max(Date.now(), this.roundEarliestAt ?? 0, this.earliestBlockTime()),
      proposer: this.identity.address,
    });
    this.metrics.blocksProposed += 1;
    if (block.header.txCount === 0) this.metrics.emptyBlocks += 1;
    const msg = {
      type: MessageType.Proposal,
      chainId: String(this.chain.chainId),
      height: this.height,
      round: this.round,
      block: block.toJSON(),
      proposer: this.identity.address,
      timestamp: Date.now(),
    };
    this.receiveProposal(msg, { from: 'self' });
    this.broadcast(msg);
    log.debug('proposed block', { height: this.height, round: this.round, txs: block.header.txCount });
    void set;
  }

  // -------------------------------------------------------- message handling

  handleMessage(msg, { from = 'network' } = {}) {
    if (String(msg.chainId ?? this.chain.chainId) !== String(this.chain.chainId)) return;
    switch (msg.type) {
      case MessageType.Proposal:
        return this.receiveProposal(msg, { from });
      case MessageType.Prevote:
      case MessageType.Precommit:
        return this.receiveVote(msg, { from });
      case MessageType.Commit:
        return this.receiveCommit(msg, { from });
      default:
        return undefined;
    }
  }

  async receiveProposal(msg, { from }) {
    if (msg.height !== this.height) {
      if (msg.height > this.chain.head.height + 1) this._bufferFuture(msg);
      return;
    }
    if (msg.round < this.round) return;
    if (this.proposal && this.proposal.block.hash === msg.block.blockHash) {
      // already seen, but a later round must still prevote
    }
    const block = FullStopBlock.fromJSON(msg.block);
    if (block.height !== msg.height || block.header.round !== msg.round) {
      log.debug('proposal metadata inconsistent, ignoring', { from });
      return;
    }
    const expectedProposer = this.chain.protocol.staking.proposerFor(msg.height, msg.round);
    if (!expectedProposer || !this._represents(expectedProposer, block.header.proposer)) {
      log.debug('proposal from unexpected proposer, ignoring', { from, height: msg.height, round: msg.round });
      return;
    }
    if (msg.proposer && !this._represents(expectedProposer, msg.proposer)) {
      log.debug('proposal sender does not match proposer, ignoring', { from, height: msg.height, round: msg.round });
      return;
    }
    if (msg.round > this.round) this.startRound(msg.round);
    if (this.proposal && this.proposal.round === msg.round && this.proposal.block.hash !== block.hash) {
      // Conflicting proposal for the same round: if we signed ours, that is
      // only evidence against *us*; if the proposer sent two different blocks
      // we record it so the network can slash.
      this._recordProposerEvidence(msg.round, this.proposal.block, block);
    }
    if (this.proposal?.round === msg.round && this.proposal.block.hash === block.hash) return;

    const verdict = await this.chain.validateBlock(block, { checkCommit: true });
    if (msg.height !== this.height || msg.round !== this.round || this.step !== 'propose') return;
    if (this.proposal) {
      if (this.proposal.round === msg.round && this.proposal.block.hash !== block.hash) {
        this._recordProposerEvidence(msg.round, this.proposal.block, block);
      }
      return;
    }
    if (!verdict.ok) {
      log.warn('invalid proposal dropped', { height: msg.height, round: msg.round, reason: verdict.reason, from });
      this._prevoteNil();
      return;
    }
    this.proposal = { block, round: msg.round, outcome: verdict.outcome };
    this.startPrevoteRound();
  }

  startPrevoteRound() {
    if (this.step !== 'propose') return;
    this.step = 'prevote';
    this.stepAt = Date.now();
    if (!this.proposal) {
      this._prevoteNil();
      return;
    }
    this._vote(MessageType.Prevote, this.proposal.block.hash);
  }

  _prevoteNil() {
    if (!this.isValidator) return;
    this.step = 'prevote';
    this.stepAt = Date.now();
    this.metrics.nilVotes += 1;
    this._vote(MessageType.Prevote, ZERO_HASH);
  }

  _precommitNil() {
    if (!this.isValidator) return;
    this.step = 'precommit';
    this.stepAt = Date.now();
    this._vote(MessageType.Precommit, ZERO_HASH);
  }

  /**
   * Consensus messages are signed by the validator's *consensus* key when the
   * node holds one, otherwise by the operator key. The `validator` field of a
   * vote is always the address matching the key that signed it, so a verifier
   * recovers the signer and looks the power up under either name.
   */
  _signer() {
    if (this.identity.consensusPrivateKey) {
      return { privateKey: this.identity.consensusPrivateKey, address: this.identity.consensusAddress };
    }
    return { privateKey: this.identity.privateKey, address: this.identity.address };
  }

  /**
   * Sign and broadcast one vote for (height, round, type).
   *
   * The `signedVotes` guard is what keeps this node from ever producing
   * slashable evidence against itself: after the first vote in a round the
   * step machine may still fire (a timeout racing an arriving proposal), and
   * signing a second, different value in the same round is precisely the
   * double-sign the network punishes.
   */
  _vote(type, blockHash) {
    const key = `${this.height}:${this.round}:${type}`;
    const already = this.signedVotes.get(key);
    if (already) {
      if (already !== blockHash) {
        log.error('REFUSING to double-sign: a second vote was requested for the same round', {
          height: this.height,
          round: this.round,
          type,
          signed: already,
          requested: blockHash,
        });
      }
      return;
    }
    const set = this.chain.protocol.staking.activeSet();
    const me = set.find((v) => this._represents(v, this.identity.address) || this._represents(v, this.identity.consensusAddress));
    if (!me) return;
    this.signedVotes.set(key, blockHash);
    const vote = makeVote({
      validatorKey: this._signer(),
      type,
      chainId: this.chain.chainId,
      height: this.height,
      round: this.round,
      blockHash,
      timestamp: Date.now(),
    });
    this.receiveVote({ ...vote, chainId: String(this.chain.chainId), type }, { from: 'self' });
    this.broadcast({ ...vote, chainId: String(this.chain.chainId), type });
  }

  _signingField(validator) {
    return this.identity.consensusAddress ? 'consensusAddress' : 'operator';
  }

  receiveVote(vote, { from = 'network' } = {}) {
    if (vote.height !== this.height || vote.round !== this.round) return;
    if (!verifyVote(vote, this.chain.chainId)) {
      log.warn('vote with an invalid signature ignored', { from, validator: vote.validator });
      return;
    }
    const key = `${vote.height}:${vote.round}:${vote.type}`;
    const map = this.votes.get(key) ?? new Map();
    const existing = map.get(vote.validator.toLowerCase());
    if (existing && existing.blockHash !== vote.blockHash) {
      this._recordEvidence(existing, vote);
      return;
    }
    if (existing) return;
    map.set(vote.validator.toLowerCase(), vote);
    this.votes.set(key, map);
    this._tally(vote.type);
  }

  powerFor(map) {
    const set = this.chain.protocol.staking.activeSet();
    let power = 0n;
    for (const vote of map.values()) {
      const v = set.find((x) => this._represents(x, vote.validator));
      if (v) power += v.power;
    }
    return power;
  }

  quorum() {
    const total = this.chain.protocol.staking.activeSet().reduce((a, v) => a + v.power, 0n);
    if (total === 0n) return 0n;
    return (total * 2n) / 3n + 1n;
  }

  _tally(type) {
    const key = `${this.height}:${this.round}:${type}`;
    const map = this.votes.get(key);
    if (!map) return;
    const total = this.chain.protocol.staking.activeSet().reduce((a, v) => a + v.power, 0n);
    if (total === 0n) return;
    const quorum = this.quorum();
    const byHash = new Map();
    for (const vote of map.values()) byHash.set(vote.blockHash, (byHash.get(vote.blockHash) ?? 0n) + this._powerOf(vote.validator));
    let bestHash = null;
    let bestPower = 0n;
    for (const [hash, power] of byHash) {
      if (power >= quorum && power > bestPower) {
        bestHash = hash;
        bestPower = power;
      }
    }

    if (type === MessageType.Prevote) {
      if (bestHash === null) return;
      if (this.step !== 'prevote') {
        if (this.step === 'propose' && bestHash !== ZERO_HASH && this.proposal?.block.hash === bestHash) {
          this.step = 'prevote';
          this.stepAt = Date.now();
        } else return;
      }
      if (bestHash === ZERO_HASH) {
        this._precommitNil();
        return;
      }
      this.step = 'precommit';
      this.stepAt = Date.now();
      this._vote(MessageType.Precommit, bestHash);
      return;
    }

    if (type === MessageType.Precommit) {
      if (bestHash === null) return;
      if (bestHash === ZERO_HASH) {
        this.advanceRound();
        return;
      }
      this.commit(bestHash);
    }
  }

  _powerOf(address) {
    const v = this.chain.protocol.staking.activeSet().find((x) => this._represents(x, address));
    return v ? v.power : 0n;
  }

  advanceRound() {
    if (this.step === 'committed' || this.step === 'waiting-for-blocks') return;
    const next = this.round + 1;
    // The propose deadline for the new round is pushed out by the round
    // `proposeDelta`, which is the backoff: a height that keeps failing moves
    // to a different proposer on a schedule instead of spinning.
    this.startRound(next);
    if (next % 20 === 0) log.warn('repeated round failures', { height: this.height, round: next });
  }

  /** Broadcast the commit we gathered, then apply the block. */
  async commit(blockHash) {
    if (this.step === 'committed' || this._committing) return;
    this._committing = true;
    try {
      await this._commit(blockHash);
    } finally {
      this._committing = false;
    }
  }

  async _commit(blockHash) {
    const block = this.proposal?.block ?? this.chain.getBlock(blockHash);
    if (!block) {
      log.warn('precommit quorum without the block, waiting for it', { blockHash });
      return;
    }
    this.step = 'committed';
    const key = `${this.height}:${this.round}:${MessageType.Precommit}`;
    const votes = [...(this.votes.get(key) ?? new Map()).values()].filter((v) => v.blockHash === blockHash);
    const commit = { height: this.height, round: this.round, blockHash, votes };
    this.broadcast({ type: MessageType.Commit, chainId: String(this.chain.chainId), height: this.height, round: this.round, blockHash, commit, block: block.toJSON() });
    await this.applyCommit(block, commit);
    this._clearOldVotes(this.height);
    // Pace the next height off the block time rather than committing and
    // immediately proposing the following block.
    this.nextHeightAt = block.header.time + this.blockTimeMs;
  }

  async applyCommit(block, commit) {
    if (block.height <= this.chain.head.height) return;
    if (block.height !== this.chain.head.height + 1) return;
    // `lastCommit` is the vote set that sealed the *previous* height and is part
    // of what the proposer committed to; the commit for this height is recorded
    // alongside the block so the next proposer can embed it. Overwriting
    // lastCommit with the current commit changes the application hash, which is
    // exactly the kind of divergence that forks a network.
    const withCommit = commit ? block.withCommit(commit) : block;
    const already = this.chain.getBlock(block.height);
    if (already && already.hash === withCommit.hash) return;
    const outcome = await this.chain.commitBlock(withCommit, { source: this.enabled ? 'consensus' : 'sync', commit });
    log.info('committed block', {
      height: withCommit.height,
      txs: withCommit.header.txCount,
      gasUsed: withCommit.header.gasUsed,
      fees: outcome.feesCollected.toString(),
    });
  }

  async receiveCommit(msg, { from = 'network' } = {}) {
    if (msg.height !== this.chain.head.height + 1) return;
    const block = msg.block ? FullStopBlock.fromJSON(msg.block) : this.chain.getBlock(msg.blockHash);
    if (!block) throw new Error(`commit from ${from} did not include a block at height ${msg.height}`);
    if (
      block.height !== msg.height ||
      block.hash.toLowerCase() !== String(msg.blockHash).toLowerCase() ||
      Number(msg.round) !== Number(block.header.round)
    ) {
      throw new Error(`commit from ${from} does not match its block at height ${msg.height}`);
    }
    await this.applyCommit(block, msg.commit);
  }

  // --------------------------------------------------------------- evidence

  /** Two conflicting signed votes from the same validator at one height/round. */
  _recordEvidence(a, b) {
    const id = `${a.validator}:${a.height}:${a.round}`;
    if (this.evidenceFound.has(id)) return;
    if (this._isMe(a.validator)) {
      log.error('LOCAL VALIDATOR SIGNED TWO DIFFERENT VOTES - refusing to continue', { validator: a.validator });
      this.running = false;
      return;
    }
    const ev = {
      id,
      type: 'double-sign',
      chainId: String(this.chain.chainId),
      validator: a.validator,
      heightA: a.height,
      roundA: a.round,
      typeA: a.type,
      sigA: a.signature,
      blockHashA: a.blockHash,
      heightB: b.height,
      roundB: b.round,
      typeB: b.type,
      sigB: b.signature,
      blockHashB: b.blockHash,
    };
    // Only include evidence this node can actually verify. A proposal carrying
    // unverifiable evidence would be dropped by every peer, so filtering here is
    // what keeps the height advancing.
    const check = this.chain.protocol.staking.verifyEvidence(ev);
    if (!check.ok) {
      log.warn('conflicting votes observed but are not slashable evidence', { validator: a.validator, reason: check.reason });
      return;
    }
    this.evidenceFound.set(id, ev);
    this.chain.pendingEvidence.push(ev);
    log.warn('recorded double-sign evidence', { validator: a.validator, height: a.height, round: a.round });
  }

  _recordProposerEvidence(round, blockA, blockB) {
    // Two different proposals in one round is a proposer misbehaviour; it is
    // only slashable when the proposer signed both, which the vote evidence
    // path captures, so this is recorded for diagnostics only.
    log.warn('proposer sent conflicting proposals for one round', { height: this.height, round });
  }

  _isMe(address) {
    return this.identity && address.toLowerCase() === this.identity.address.toLowerCase();
  }

  _clearOldVotes(height) {
    for (const key of [...this.votes.keys()]) {
      const h = Number(key.split(':')[0]);
      if (h <= height) this.votes.delete(key);
    }
  }

  _bufferFuture(msg) {
    this.future ??= [];
    if (this.future.length > 128) this.future.shift();
    this.future.push(msg);
  }

  status() {
    return {
      enabled: this.enabled,
      isValidator: this.isValidator,
      votingPower: this.votingPower.toString(),
      height: this.height,
      round: this.round,
      step: this.step,
      metrics: this.metrics,
      quorum: this.quorum().toString(),
      totalPower: this.chain.protocol.staking.activeSet().reduce((a, v) => a + v.power, 0n).toString(),
      evidence: this.evidenceFound.size,
    };
  }
}

module.exports = { Consensus, TIMEOUTS };
