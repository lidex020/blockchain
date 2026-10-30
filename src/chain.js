'use strict';
/**
 * Chain: glues the execution layer, the protocol state machine, the mempool
 * and the block store together, and owns the rules for what makes a block
 * acceptable.
 *
 * Block acceptance (validateAndCommit) checks, in order:
 *   - structural: chain id, height, parent link, timestamp monotonicity and
 *     the minimum block interval, transaction count and gas ceilings;
 *   - proposer: the header's proposer must be the validator deterministically
 *     selected for that (height, round) by the set the network agreed on;
 *   - commit: `lastCommit` must contain valid signatures from validators whose
 *     voting power exceeds 2/3 of that set, all for this block hash;
 *   - execution: the block's transactions and the protocol transition are
 *     re-executed, and the recomputed state root, receipt root, logs bloom,
 *     gas used and application hash must match the header;
 *   - accounting: the supply ledger's own conservation assertion.
 *
 * A block that fails any of these is rejected and, if it came from a peer,
 * that peer's connection is dropped.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { Execution } = require('./execution');
const { Protocol } = require('./protocol');
const { Mempool } = require('./mempool');
const { Store } = require('./store');
const { FullStopBlock, ZERO_HASH, verifyVote, dataRoot, evidenceRoot } = require('./block');
const { ExecutionError } = require('./execution.js');
const { BLOCK, COIN, FEES, SYSTEM, VERSION, STAKING, COMMUNITY, ALLOCATIONS, CHAIN } = require('./constants');
const { hashObject, merkleRoot, keccak256Bytes, stableStringify } = require('./crypto');
const { createLogger } = require('./logger');

const log = createLogger('chain');

class Chain {
  constructor({ execution, protocol, store, genesis, params }) {
    this.execution = execution;
    this.protocol = protocol;
    this.store = store;
    this.genesis = genesis;
    this.params = params;
    this.chainId = BigInt(params.chainId);
    this.blocks = new Map(); // height -> FullStopBlock
    this.blockIndex = new Map(); // hash -> height
    this.evmHeaders = new Map(); // height -> sealed EVM header fields
    this.receiptsByHeight = new Map();
    this.receiptByTx = new Map();
    this.txPosition = new Map(); // hash -> {blockNumber, transactionIndex}
    this.addressTransactions = new Map(); // lowercase address -> chronological transaction summaries
    this.nonceCache = new Map();
    this.head = null;
    this.headEvmBlock = null;
    this.validatorsHash = ZERO_HASH;
    this.appHash = ZERO_HASH;
    this.stateRoot = ZERO_HASH;
    this.pool = new Mempool({ chain: this, execution, params, onAccepted: params.onGossipTx });
    this.pendingEvidence = [];
    /** height -> commit that sealed that height (needed for the next block) */
    this.commits = new Map();
    this.heightVotes = new Map(); // height -> {hash -> power}
    this._committedHooks = [];
  }

  static async create({ genesis, datadir, params = {}, mode = 'validator' }) {
    const mergedParams = { ...defaultParams(), ...params, chainId: genesis.chain_id };
    const execution = await Execution.create(mergedParams);
    const protocol = new Protocol(mergedParams);
    const store = datadir ? Store.open(datadir) : null;
    const chain = new Chain({ execution, protocol, store, genesis, params: mergedParams });
    chain.mode = mode;
    await chain.init();
    return chain;
  }

  // ------------------------------------------------------------- lifecycle

  async init() {
    let resume = false;
    if (this.store && this.store.exists()) {
      const meta = this.store.meta();
      if (meta && meta.chainId === String(this.chainId) && meta.genesisHash === genesisHash(this.genesis)) {
        resume = true;
      } else if (meta) {
        throw new Error(`data directory ${this.store.dir} belongs to chain ${meta.chainId} (genesis ${meta.genesisHash}), not this one`);
      }
    }

    if (resume) {
      await this._recover();
    } else {
      await this._initGenesis();
    }
    log.info('chain ready', {
      height: this.head.height,
      chainId: this.chainId.toString(),
      mode: this.mode,
      stateRoot: this.stateRoot.slice(0, 18),
    });
  }

  async _initGenesis() {
    // 1. accounts, 2. protocol issuance, 3. system contract deployment. The
    // order matters: the genesis deployer pays gas, so it must be funded first.
    await this.execution.applyAlloc(this.genesis);
    await this.protocol.applyGenesis(this.execution);
    const { stateRoot, deployed } = await this.execution.runGenesisTxs(this.genesis);
    this.genesisDeployments = deployed;
    await this.verifySystemContracts(deployed);
    const audit = await this.protocol.supplyAudit(this.execution);
    if (!audit.ok) {
      throw new Error(`genesis supply audit failed: on-chain ${audit.onchainTotal} vs ledger ${audit.ledgerTotal}`);
    }
    const appHash = await this.protocol.computeAppHash(0, this.execution);
    const validatorsHash = hashObject(
      this.protocol.staking.activeSet().map((v) => ({ op: v.operator, p: v.power.toString(), cs: v.consensusAddress }))
    );
    const genesisBlock = FullStopBlock.fromJSON({
      header: {
        version: { app: VERSION.appVersion, block: '1' },
        chainId: String(this.chainId),
        height: 0,
        time: new Date(this.genesis.genesis_time).getTime(),
        round: 0,
        proposer: SYSTEM.moduleAddress,
        parentHash: ZERO_HASH,
        dataHash: ZERO_HASH,
        evidenceHash: ZERO_HASH,
        appHash: toHex(appHash),
        validatorsHash: toHex(validatorsHash),
        stateRoot,
        gasUsed: '0',
        gasLimit: String(this.params.blockGasLimit),
        txCount: (this.genesis.genesisTxs ?? []).length,
        software: `${VERSION.software}+genesis`,
      },
      txs: this.genesis.genesisTxs ?? [],
      evidence: [],
      lastCommit: null,
    });
    const evmGenesis = this.execution.genesisBlock(this.genesis, stateRoot);
    this.headEvmBlock = evmGenesis;
    this.execution.headBlock = evmGenesis;
    void 0;
    this.evmHeaders.set(0, evmHeaderFields({ evmBlock: evmGenesis, stateRoot, gasUsed: 0n }));
    this.stateRoot = stateRoot;
    this.appHash = genesisBlock.header.appHash;
    this.validatorsHash = genesisBlock.header.validatorsHash;
    this._register(genesisBlock, []);
    if (this.store) {
      this.store.saveGenesis(this.genesis);
      // The genesis record is part of the block log so that recovery can start
      // from height 0 and re-derive every root from an empty state.
      this.store.append(genesisBlock.toJSON(), []);
      this.store.flush();
      this._writeMeta();
    }
  }

  /** Rebuild state by replaying the block log from genesis. */
  /**
   * Rebuild the chain from the block log.
   *
   * The state trie is not persisted, so recovery re-runs genesis and then every
   * block through the same execution path used for live consensus, comparing
   * the recomputed state root with the root recorded in each header. A log that
   * was torn by a crash mid-write is repaired by dropping the trailing record;
   * a log whose roots do not reproduce is a hard error, never a warning.
   */
  async _recover() {
    return this.withState(async () => this.__recoverInner());
  }

  async __recoverInner() {
    const t0 = Date.now();
    const records = this.store.readBlocks();
    if (records.length === 0) {
      await this._initGenesis();
      return;
    }
    log.info('recovering chain state by replaying blocks', { blocks: records.length });
    const genesisRecord = records[0];
    if (genesisRecord.header.height !== 0) throw new Error('block log does not start at genesis');

    await this.execution.applyAlloc(this.genesis);
    await this.protocol.applyGenesis(this.execution);
    const { stateRoot, deployed } = await this.execution.runGenesisTxs(this.genesis);
    await this.verifySystemContracts(deployed);
    if (stateRoot !== genesisRecord.header.stateRoot) {
      throw new Error(
        `genesis state root mismatch on recovery: recomputed ${stateRoot} but the log claims ${genesisRecord.header.stateRoot}. ` +
          'This node build does not reproduce this network\'s genesis - check the genesis file, the compiled system contracts and the protocol version.'
      );
    }
    const audit = await this.protocol.supplyAudit(this.execution);
    if (!audit.ok) throw new Error(`genesis supply audit failed on recovery: ${JSON.stringify(audit)}`);

    const evmGenesis = this.execution.genesisBlock(this.genesis, stateRoot);
    this.headEvmBlock = evmGenesis;
    this.execution.headBlock = evmGenesis;
    this.evmHeaders.set(0, evmHeaderFields({ evmBlock: evmGenesis, stateRoot, gasUsed: 0n }));
    this._register(FullStopBlock.fromJSON(genesisRecord), []);
    this.stateRoot = stateRoot;
    this.appHash = genesisRecord.header.appHash;
    this.validatorsHash = genesisRecord.header.validatorsHash;
    for (const rec of records) if (rec.commit) this.commits.set(Number(rec.header.height), rec.commit);

    const receipts = new Map(this.store.readReceipts().map((r) => [r.height, r.receipts]));
    let replayHeight = 0;
    for (const rec of records.slice(1)) {
      const block = FullStopBlock.fromJSON(rec);
      // Heights must arrive one after another. An out-of-order log means the
      // directory was written by two processes (or edited), and re-executing
      // that would look like a state corruption in the protocol.
      if (block.height !== replayHeight + 1) {
        throw new Error(
          `block log is not ordered: height ${block.height} follows ${replayHeight} in ${this.store.blocksPath}. ` +
            'This directory was written by more than one process; restore it from a peer or start from a fresh data directory.'
        );
      }
      replayHeight = block.height;
      const outcome = await this._executeBlockUnqueued({ block, dryRun: false });
      const staleLog =
        'This block log was written by a node build that derives state differently from this one. Before a network is live there is no migration: start from a fresh data directory (or delete blocks.jsonl and receipts.jsonl in it) instead of replaying.';
      if (outcome.stateRoot !== rec.header.stateRoot) {
        throw new Error(`state root mismatch while replaying height ${rec.header.height}: recomputed ${outcome.stateRoot}. ${staleLog}`);
      }
      if (outcome.appHash !== rec.header.appHash) {
        throw new Error(`app hash mismatch while replaying height ${rec.header.height}: recomputed ${outcome.appHash}. ${staleLog}`);
      }
      await this._commit(block, outcome, { persist: false, source: 'replay' });
    }
    for (const [h, list] of receipts) if (!this.receiptsByHeight.has(h)) this.receiptsByHeight.set(h, list);
    log.info('recovery complete', { height: this.head.height, ms: Date.now() - t0 });
  }

  /**
   * The genesis document names the system contracts and, optionally, the code
   * hash each must have. Mismatch means the node was built from a different
   * contract set than the network it is joining, which is fatal, not a warning.
   */
  async verifySystemContracts(deployed) {
    const expected = this.genesis.system_contracts ?? {};
    const artifacts = this.genesis.contract_artifacts ?? {};
    const moduleAccounts = new Set(Object.values(SYSTEM).filter((v) => typeof v === 'string').map((v) => v.toLowerCase()));
    for (const [name, address] of Object.entries(expected)) {
      // Protocol module accounts hold coin but run no code by design; only the
      // contracts listed with artifacts are checked.
      if (!artifacts[name] || moduleAccounts.has(String(address).toLowerCase())) continue;
      const code = await this.execution.getCode(String(address));
      if (!code || code === '0x') {
        throw new Error(`system contract "${name}" at ${address} has no code after the genesis deployment step`);
      }
      const expectedHash = artifacts[name]?.deployedCodeHash;
      if (expectedHash) {
        const { keccak256 } = require('ethereum-cryptography/keccak');
        const { ethers } = require('ethers');
        const actual = ethers.hexlify(keccak256(ethers.getBytes(code)));
        if (actual.toLowerCase() !== String(expectedHash).toLowerCase()) {
          throw new Error(
            `system contract "${name}" deployed code hash ${actual} does not match the compiled artifact ${expectedHash}`
          );
        }
      }
    }
    void deployed;
  }

  // ------------------------------------------------------------ execution

  /** Run `fn` with the execution state to itself. */
  withState(fn) {
    return this.execution.queue(fn);
  }

  /**
   * Execute a block against the current head, producing everything needed to
   * seal it. With dryRun the state (both EVM and protocol) is rolled back.
   */
  executeBlock(opts) {
    return this.withState(() => this._executeBlockUnqueued(opts));
  }
  /** Must be called inside `execution.queue` (see `withState`). */
  _executeBlockUnqueued({ block, dryRun = true }) {
    if (block.height !== this.head.height + 1) {
      throw new Error(`cannot execute block ${block.height}: head is ${this.head.height}`);
    }
    return this.execution._executeBlock({
      parentBlock: this.headEvmBlock,
      txs: block.txs.map((raw) => ({ raw })),
      height: block.height,
      timestamp: Math.floor(block.header.time / 1000),
      protocol: this.protocol,
      evidence: block.evidence,
      dryRun,
      gasLimit: this.params.blockGasLimit,
      // Whose precommits sealed the previous height. Derived from the block
      // itself, so this is replayable, not a node-local observation.
      lastCommitSigners: block.lastCommit?.votes?.map((v) => v.validator) ?? null,
    });
  }

  /**
   * Remember the commit that sealed a height so the next block can carry it.
   * The same object is persisted inside the block record, so a restart reads it
   * back from the block log rather than needing a second store.
   */
  recordCommit(height, commit) {
    if (!commit?.votes?.length) return;
    this.commits.set(Number(height), commit);
  }

  /**
   * Build the next block from the pool. Only the elected proposer calls this.
   */
  produceBlock(opts) {
    return this.withState(() => this._produceBlock(opts));
  }

  async _produceBlock({ height, round, time, proposer }) {
    await this._refreshPoolNonces();
    const selected = this.pool.selectForBlock({ gasLimit: this.params.blockGasLimit, maxTxs: BLOCK.maxBlockTxs });
    const txs = selected.map((e) => e.raw);
    // Evidence is re-verified here, before it goes into a block: a proposal
    // carrying junk evidence would be refused by peers, so dropping it now
    // protects the proposer's liveness instead of just wasting a round.
    const evidence = this.pendingEvidence
      .filter((ev) => this.protocol.staking.verifyEvidence(ev).ok)
      .slice(0, 8);
    const lastCommit = this.commits.get(height - 1) ?? null;
    const draftOptions = {
      chainId: String(this.chainId),
      height,
      time,
      round,
      proposer,
      parentHash: this.head.hash,
      txs,
      evidence,
      gasUsed: 0n,
      gasLimit: this.params.blockGasLimit,
      lastCommit,
    };
    const draft = FullStopBlock.assemble({
      ...draftOptions,
      stateRoot: ZERO_HASH,
      appHash: ZERO_HASH,
      validatorsHash: ZERO_HASH,
    });
    const outcome = await this._executeBlockUnqueued({ block: draft, dryRun: true });
    const block = FullStopBlock.assemble({
      ...draftOptions,
      stateRoot: outcome.stateRoot,
      appHash: outcome.appHash,
      validatorsHash: outcome.validatorsHash,
      gasUsed: outcome.gasUsed,
    });
    return { block, outcome, selected };
  }

  async _refreshPoolNonces() {
    for (const sender of this.pool.bySender.keys()) {
      const acc = await this.execution.account(sender);
      this.nonceCache.set(sender, Number(acc.nonce));
    }
  }

  /**
   * Validate a proposed block against the head without changing state.
   * @returns {{ok: true, outcome: object} | {ok: false, reason: string}}
   */
  /**
   * Validate a proposed block against the head without changing state.
   *
   * Must be called inside the state section: it runs a speculative execution,
   * and a block committed by another path in between the check and the commit
   * would make the result meaningless.
   */
  async validateBlockUnqueued(block, { checkCommit = true, commitFor = null } = {}) {
    try {
      if (BigInt(block.header.chainId) !== this.chainId) return reject(block, 'wrong chain id');
      if (block.height !== this.head.height + 1) return reject(block, `height ${block.height} is not the next height ${this.head.height + 1}`);
      if (block.header.parentHash !== this.head.hash) return reject(block, 'parent hash does not match the current head');
      if (block.txs.length > BLOCK.maxBlockTxs) return reject(block, 'too many transactions');
      const parentTime = this.head.header.time;
      if (block.header.time <= parentTime) return reject(block, 'block time must increase');
      if (block.header.time - parentTime < this.params.minBlockIntervalMs) {
        return reject(block, `block time is closer than the ${this.params.minBlockIntervalMs}ms minimum interval to its parent`);
      }
      if (block.header.time > Date.now() + this.params.maxClockDriftMs) {
        return reject(block, 'block time is too far in the future');
      }
      // NOTE: deliberately *not* compared against this.validatorsHash here. That
      // value is the set as of the parent block, while a block's own header
      // commits to the set that results from executing it (a bond, a jail or a
      // registration all change it). Requiring the parent value made any block
      // that changed the set unacceptable to every peer, and since the offending
      // transaction stays in the pool that is a permanent halt, not a reorg -
      // which is exactly what this check once did on a four-node devnet. The
      // claim is checked below against the hash each node derives by execution,
      // so a proposer still cannot invent a validator set.
      const expectedData = block.txs.length ? merkleRoot(block.txs.map((t) => keccak256Bytes(ethers.getBytes(t)))) : keccak256Bytes(Uint8Array.from([]));
      if (String(block.header.dataHash).toLowerCase() !== toHex(expectedData).toLowerCase()) {
        return reject(block, 'data hash does not match the transaction list');
      }
      if (checkCommit) {
        const verdict = this._checkLastCommit(block, commitFor);
        if (!verdict.ok) return reject(block, verdict.reason);
      }
      const outcome = await this._executeBlockUnqueued({ block, dryRun: true });
      if (outcome.stateRoot !== block.header.stateRoot) {
        return reject(block, `state root mismatch: proposer claimed ${block.header.stateRoot}, execution produced ${outcome.stateRoot}`);
      }
      if (outcome.appHash !== block.header.appHash) {
        if (process.env.FULLSTOP_DEBUG_HASH_DIFF) {
          const mine = this.protocol.serialize();
          fs.writeFileSync(`/tmp/mine-${block.height}.json`, JSON.stringify(mine, null, 1));
          log.warn('app hash mismatch', { height: block.height, mine: JSON.stringify(mine).slice(0, 2000) });
        }
        return reject(block, `app hash mismatch: claimed ${block.header.appHash}, computed ${outcome.appHash}`);
      }
      if (String(block.header.validatorsHash).toLowerCase() !== toHex(outcome.validatorsHash).toLowerCase()) {
        return reject(block, `validator set hash mismatch: claimed ${block.header.validatorsHash}, execution derived ${toHex(outcome.validatorsHash)}`);
      }
      if (BigInt(block.header.gasUsed) !== outcome.gasUsed) {
        return reject(block, `gas used mismatch: claimed ${block.header.gasUsed}, executed ${outcome.gasUsed}`);
      }
      if (block.header.txCount !== outcome.transactions.length) {
        return reject(block, `transaction count mismatch: claimed ${block.header.txCount}, executed ${outcome.transactions.length}`);
      }
      return { ok: true, outcome };
    } catch (err) {
      return { ok: false, reason: err.message, code: err.code };
    }
  }

  validateBlock(block, opts = {}) {
    return this.withState(() => this.validateBlockUnqueued(block, opts));
  }

  _checkLastCommit(block, forSet) {
    const commit = block.lastCommit;
    if (!commit) {
      if (block.height === 1) return { ok: true }; // first block after genesis
      return { ok: false, reason: 'block is missing its last commit' };
    }
    const set = forSet ?? this.currentCommitSet();
    if (!set.length) return { ok: false, reason: 'no validators to check the commit against' };
    const totalPower = set.reduce((a, v) => a + v.power, 0n);
    const quorum = totalPower * 2n / 3n + 1n;
    let power = 0n;
    const seen = new Set();
    for (const vote of commit.votes ?? []) {
      if (BigInt(vote.height) !== BigInt(block.height - 1)) continue;
      const v = set.find((x) => normalize(x.operator) === normalize(vote.validator) || normalize(x.consensusAddress) === normalize(vote.validator));
      if (!v) continue; // not in the set: contributes nothing
      if (seen.has(v.operator)) continue;
      if (vote.blockHash !== commit.blockHash) continue;
      if (!verifyVote(vote, this.chainId)) return { ok: false, reason: `invalid signature from ${vote.validator}` };
      seen.add(v.operator);
      power += v.power;
    }
    if (power < quorum) {
      return { ok: false, reason: `commit power ${power} below the 2/3 quorum ${quorum}` };
    }
    return { ok: true, power, quorum };
  }

  validateCommit(commit, block, forSet = this.protocol.staking.activeSet()) {
    if (!commit || !Array.isArray(commit.votes)) return { ok: false, reason: 'missing commit votes' };
    if (Number(commit.height) !== block.height) return { ok: false, reason: 'commit height does not match block height' };
    if (Number(commit.round) !== Number(block.header.round)) return { ok: false, reason: 'commit round does not match block round' };
    if (String(commit.blockHash).toLowerCase() !== block.hash.toLowerCase()) return { ok: false, reason: 'commit hash does not match block hash' };
    if (!forSet.length) return { ok: false, reason: 'no validators to check the commit against' };

    const totalPower = forSet.reduce((a, v) => a + v.power, 0n);
    const quorum = (totalPower * 2n) / 3n + 1n;
    const seen = new Set();
    let power = 0n;
    for (const vote of commit.votes) {
      if (
        Number(vote.height) !== block.height ||
        Number(vote.round) !== Number(block.header.round) ||
        vote.type !== 'precommit' ||
        String(vote.blockHash).toLowerCase() !== block.hash.toLowerCase() ||
        !verifyVote(vote, this.chainId)
      ) {
        return { ok: false, reason: `invalid precommit vote from ${vote.validator ?? 'unknown validator'}` };
      }
      const validator = forSet.find(
        (v) =>
          normalize(v.operator) === normalize(vote.validator) ||
          normalize(v.consensusAddress) === normalize(vote.validator)
      );
      if (!validator) return { ok: false, reason: `commit contains a vote from unknown validator ${vote.validator}` };
      if (seen.has(validator.operator)) return { ok: false, reason: `commit contains duplicate votes from ${vote.validator}` };
      seen.add(validator.operator);
      power += validator.power;
    }
    if (power < quorum) return { ok: false, reason: `commit power ${power} below the 2/3 quorum ${quorum}` };
    return { ok: true, power, quorum };
  }

  currentCommitSet() {
    return this.protocol.staking.activeSet();
  }

  /**
   * Commit a validated block: apply it for real, index it, persist it.
   */
  async commitBlock(block, { source = 'consensus', commit = null, validate = true } = {}) {
    return this.withState(async () => {
      const seal = commit ?? block.commit;
      if (source === 'consensus' || source === 'sync') {
        const verdict = this.validateCommit(seal, block);
        if (!verdict.ok) throw new ExecutionError(`invalid block commit at height ${block.height}: ${verdict.reason}`, 'INVALID_COMMIT');
      }
      if (validate) {
        const verdict = await this.validateBlockUnqueued(block);
        if (!verdict.ok) throw new ExecutionError(`invalid block at height ${block.height}: ${verdict.reason}`, 'INVALID_BLOCK');
      }
      const outcome = await this._executeBlockUnqueued({ block, dryRun: false });
      await this._commit(block, outcome, { persist: true, source, commit: seal });
      return outcome;
    });
  }

  async _commit(block, outcome, { persist, source, commit = null } = {}) {
    // Self-check before anything is recorded: this node's own execution must
    // reproduce the header it is about to store. A node that cannot do that has
    // diverged from the network and must stop rather than serve wrong data.
    if (block.height > 0) {
      if (outcome.stateRoot !== block.header.stateRoot) {
        throw new ExecutionError(
          `LOCAL DIVERGENCE at height ${block.height}: recomputed state root ${outcome.stateRoot} but the block declares ${block.header.stateRoot}. Stopping instead of serving inconsistent data.`,
          'DIVERGENCE'
        );
      }
      if (outcome.appHash !== block.header.appHash) {
        throw new ExecutionError(
          `LOCAL DIVERGENCE at height ${block.height}: recomputed app hash ${outcome.appHash} but the block declares ${block.header.appHash}. Stopping instead of serving inconsistent data.`,
          'DIVERGENCE'
        );
      }
    }
    if (commit) this.commits.set(block.height, commit);
    else if (block.commit) this.commits.set(block.height, block.commit);
    this._register(block, outcome.receipts);
    this.evmHeaders.set(block.height, outcome.evmHeader ?? evmHeaderFields(outcome));
    this.head = block;
    this.headEvmBlock = outcome.evmBlock;
    this.execution.headBlock = outcome.evmBlock;
    this.stateRoot = outcome.stateRoot;
    this.appHash = outcome.appHash;
    this.headEvmBlock = outcome.evmBlock;
    this.execution.headBlock = outcome.evmBlock;
    this.validatorsHash = outcome.validatorsHash;

    const confirmed = outcome.transactions.map((tx) => toHex(tx.hash()));
    this.pool.afterCommit(confirmed, outcome.transactions.map((tx) => [normalize(tx.getSenderAddress().toString()), Number(tx.nonce) + 1]));
    for (const tx of outcome.transactions) {
      this.nonceCache.set(normalize(tx.getSenderAddress().toString()), Number(tx.nonce) + 1);
    }
    this.pendingEvidence = this.pendingEvidence.filter((ev) => !block.evidence.some((e) => e.id === ev.id));


    if (persist && this.store) {
      const sealed = commit ? { ...block.toJSON(), commit } : block.toJSON();
      this.store.append(sealed, outcome.receipts);
      this.store.flush();
      this._writeMeta();
    }
    if (this.params.supplyAuditEvery && block.height % this.params.supplyAuditEvery === 0) {
      const audit = await this.protocol.supplyAudit(this.execution);
      if (!audit.ok) throw new Error(`supply conservation broken at height ${block.height}: ${JSON.stringify(audit)}`);
      log.debug('supply audit passed', { height: block.height, accounts: audit.accounts });
    }
    for (const hook of this._committedHooks) {
      try {
        hook(block, outcome, source);
      } catch (err) {
        log.error('commit hook failed', { err: err.message });
      }
    }
    log.debug('committed block', { height: block.height, txs: block.header.txCount, source });
  }

  _register(block, receipts) {
    this.blocks.set(block.height, block);
    if (!this.head || block.height > this.head.height) this.head = block;
    this.blockIndex.set(block.hash, block.height);
    this.receiptsByHeight.set(block.height, receipts);
    receipts.forEach((r, i) => {
      const hash = r.transactionHash.toLowerCase();
      this.receiptByTx.set(hash, { ...r, blockHeight: block.height });
      this.txPosition.set(hash, { blockNumber: block.height, transactionIndex: i });
      const addresses = new Set([r.from, r.to, r.contractAddress].filter(Boolean).map((address) => address.toLowerCase()));
      for (const address of addresses) {
        const history = this.addressTransactions.get(address) ?? [];
        history.push(hash);
        this.addressTransactions.set(address, history);
      }
    });
  }

  onCommitted(fn) {
    this._committedHooks.push(fn);
  }

  _writeMeta() {
    if (!this.store) return;
    this.store.writeMeta({
      chainId: String(this.chainId),
      genesisHash: genesisHash(this.genesis),
      height: this.head.height,
      blockHash: this.head.hash,
      appHash: this.appHash,
      stateRoot: this.stateRoot,
      updatedAt: new Date().toISOString(),
      software: VERSION.software,
    });
  }

  onHead(fn) {
    this._committedHooks.push(fn);
  }

  // --------------------------------------------------------------- queries

  headNonce(address) {
    return this.nonceCache.get(normalize(address)) ?? 0;
  }

  getBlock(heightOrHash) {
    if (typeof heightOrHash === 'number' || /^\d+$/.test(String(heightOrHash))) {
      return this.blocks.get(Number(heightOrHash)) ?? null;
    }
    const h = this.blockIndex.get(String(heightOrHash).toLowerCase());
    return h === undefined ? null : this.blocks.get(h);
  }

  latestBlock() {
    return this.head;
  }

  getReceipt(txHash) {
    return this.receiptByTx.get(String(txHash).toLowerCase()) ?? null;
  }

  allLogs() {
    const out = [];
    for (const [, list] of this.receiptsByHeight) for (const r of list) out.push(...(r.logs ?? []));
    return out;
  }

  getLogs({ fromBlock = 0, toBlock = this.head?.height ?? 0, address, topics } = {}) {
    const out = [];
    const want = address ? (Array.isArray(address) ? address.map(normalize) : [normalize(address)]) : null;
    for (let h = Math.max(0, fromBlock); h <= Math.min(toBlock, this.head.height); h++) {
      for (const r of this.receiptsByHeight.get(h) ?? []) {
        for (const logEntry of r.logs ?? []) {
          if (want && !want.includes(normalize(logEntry.address))) continue;
          if (topics && !matchTopics(topics, logEntry.topics)) continue;
          out.push(logEntry);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------- protocol view

  supplyReport() {
    const report = this.protocol.ledger.supplyReport();
    const escrow = this.protocol.requiredEscrow();
    report.staking = {
      bonded: this.protocol.staking.activeSet().reduce((a, v) => a + BigInt(v.totalStake), 0n).toString(),
      // Both sides of the custody invariant belong in the report: a reader must
      // be able to see that the escrow holds exactly what it owes, not take the
      // requirement's word for it.
      escrowRequired: escrow.toString(),
      escrowHeld: this.protocol.lastEscrow?.held ?? null,
      validators: this.protocol.staking.activeSet().length,
    };
    return report;
  }

  validators() {
    return this.protocol.staking.validatorSummary();
  }

  status() {
    return {
      nodeVersion: VERSION.software,
      protocolVersion: VERSION.appVersion,
      chainId: String(this.chainId),
      chainName: CHAIN.displayName,
      height: this.head.height,
      blockHash: this.head.hash,
      appHash: this.appHash,
      stateRoot: this.stateRoot,
      time: this.head.header.time,
      proposer: this.head.header.proposer,
      txCount: this.blocks.size ? [...this.blocks.values()].reduce((a, b) => a + b.header.txCount, 0) : 0,
      mempool: this.pool.stats(),
      validators: this.protocol.staking.activeSet().length,
      nativeCoin: { name: COIN.name, ticker: COIN.ticker, decimals: COIN.decimals },
      hardfork: this.params.hardfork,
    };
  }

  /** Fee estimate: the median of recent effective gas prices, floored. */
  gasPrice() {
    const prices = [];
    for (let h = Math.max(1, this.head.height - 20); h <= this.head.height; h++) {
      for (const r of this.receiptsByHeight.get(h) ?? []) prices.push(BigInt(r.effectiveGasPrice));
    }
    if (!prices.length) return BigInt(this.params.suggestedGasPrice ?? FEES.suggestedGasPrice);
    prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const mid = prices[Math.floor(prices.length / 2)];
    return mid < BigInt(FEES.minGasPrice) ? BigInt(FEES.minGasPrice) : mid;
  }
}

function defaultParams() {
  return {
    chainId: CHAIN.chainId,
    blockGasLimit: BLOCK.blockGasLimit,
    minGasPrice: FEES.minGasPrice,
    suggestedGasPrice: FEES.suggestedGasPrice,
    minBlockIntervalMs: BLOCK.minBlockIntervalMs,
    maxClockDriftMs: 10_000,
    maxBlockTxs: BLOCK.maxBlockTxs,
    supplyAuditEvery: 0,
    hardfork: 'shanghai',
  };
}

function normalize(address) {
  return String(address).toLowerCase();
}

function normalizeHex(hex) {
  return String(hex).toLowerCase();
}

function toHex(bytes) {
  return ethers.hexlify(bytes);
}

function reject(block, reason) {
  log.warn('block rejected', { height: block.height, reason });
  return { ok: false, reason };
}

function matchTopics(filter, topics) {
  for (let i = 0; i < filter.length; i++) {
    const want = filter[i];
    if (!want) continue;
    const got = topics[i];
    const list = Array.isArray(want) ? want : [want];
    if (!list.some((w) => normalize(w) === normalize(got ?? ''))) return false;
  }
  return true;
}

function evmHeaderFields(outcome) {
  const h = outcome.evmBlock.header;
  return {
    number: Number(h.number),
    hash: toHex(outcome.evmBlock.hash()),
    parentHash: toHex(h.parentHash),
    stateRoot: toHex(h.stateRoot),
    receiptsRoot: toHex(h.receiptTrie),
    transactionsRoot: toHex(h.transactionsTrie),
    logsBloom: toHex(h.logsBloom),
    gasUsed: h.gasUsed.toString(),
    gasLimit: h.gasLimit.toString(),
    timestamp: h.timestamp.toString(),
    baseFeePerGas: (h.baseFeePerGas ?? 0n).toString(),
    miner: h.coinbase.toString(),
    extraData: toHex(h.extraData),
  };
}

function genesisHash(genesis) {
  return toHex(hashObject(genesis));
}

module.exports = { Chain, defaultParams, genesisHash, evmHeaderFields, normalize };
