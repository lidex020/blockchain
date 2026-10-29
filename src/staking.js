'use strict';
/**
 * Validator set, staking, delegation, slashing and community-reward
 * bookkeeping.
 *
 * This is protocol-level state (not an ordinary smart contract) because the
 * values it governs - who may propose blocks, how much LDX backs each
 * validator, and what may be slashed - are consensus-critical. Its `commitment()`
 * is mixed into every block's appHash, so two validators that disagree about
 * any of it fail to converge.
 *
 * Coin custody model: delegated LDX is held by the protocol module account
 * inside the EVM state; this module records who is entitled to it. A user
 * therefore never trusts this file - they trust the invariant
 * `module EVM balance === sum of recorded entitlements`, which the chain
 * asserts after every block.
 */

const { ethers } = require('ethers');
const { STAKING, COIN, SYSTEM, REWARDS, COMMUNITY } = require('./constants');
const { hashObject, keccak256Bytes, stableStringify } = require('./crypto');
const { voteTag } = require('./vote-tag.js');

const BPS = REWARDS.bpsDenominator;
const UNIT = COIN.unit;

/** ABI-encoded selectors for the system actions accepted by the module. */
const SYSTEM_ABI = new ethers.Interface([
  'function registerValidator(string moniker, address consensusAddress, uint256 commissionBps)',
  'function bond(address operator)',
  'function unbond(address operator, uint256 amount)',
  'function rebond(address operator, uint256 amount)',
  'function unjail()',
  'function submitContribution(bytes32 contributionId, address beneficiary, uint256 amount, string reference)',
  'function reviewContribution(bytes32 contributionId, bool approve)',
  'function fundCommunity(uint256 amount)',
]);

const SELECTORS = Object.fromEntries(
  // FunctionFragment#selector is the 4-byte keccak of the canonical signature,
  // which is exactly what an Ethereum wallet computes for `data`.
  SYSTEM_ABI.fragments.map((f) => [f.name, f.selector])
);

class StakingError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'StakingError';
  }
}

class Staking {
  constructor(params = {}) {
    this.params = {
      minSelfStake: params.minSelfStake ?? STAKING.minSelfStake,
      minDelegation: params.minDelegation ?? STAKING.minDelegation,
      unbondingBlocks: params.unbondingBlocks ?? STAKING.unbondingBlocks,
      maxCommissionBps: params.maxCommissionBps ?? STAKING.maxCommissionBps,
      maxActiveValidators: params.maxActiveValidators ?? STAKING.maxActiveValidators,
      doubleSignSlashBps: params.doubleSignSlashBps ?? REWARDS.doubleSignSlashBps,
      downtimeSlashBps: params.downtimeSlashBps ?? REWARDS.downtimeSlashBps,
      downtimeWindow: params.downtimeWindow ?? REWARDS.downtimeWindow,
      jailDurationBlocks: params.jailDurationBlocks ?? REWARDS.jailDurationBlocks,
      distributionInterval: params.rewardDistributionInterval ?? REWARDS.distributionInterval,
      communityRoundBlocks: params.communityRoundBlocks ?? COMMUNITY.roundBlocks,
      maxPerAddressPerRound: params.maxPerAddressPerRound ?? COMMUNITY.maxPerAddressPerRound,
      approvalQuorum: params.communityApprovalQuorum ?? COMMUNITY.approvalQuorum,
    };
    this.state = {
      validators: {},
      unbonding: [],
      /** Reviewers allowed to approve community claims. */
      reviewers: [],
      claims: {},
      claimOrder: [],
      evidence: [],
      missed: {},
      totals: { distributed: 0n, slashed: 0n, communityPaid: 0n, feesPaid: 0n, subsidyPaid: 0n },
      lastDistribution: 0,
      height: 0,
      jailedUntil: {},
    };
  }

  // ------------------------------------------------------------ validators

  registerValidator({ operator, moniker, consensusAddress, commissionBps, amount, height }) {
    const op = normalize(operator);
    if (this.state.validators[op]) throw new StakingError('validator already registered');
    if (commissionBps > this.params.maxCommissionBps) {
      throw new StakingError(`commission ${commissionBps}bps exceeds maximum ${this.params.maxCommissionBps}bps`);
    }
    if (amount < this.params.minSelfStake) {
      throw new StakingError(`self-bond ${amount} below minimum ${this.params.minSelfStake}`);
    }
    if (!moniker || moniker.length > 64) throw new StakingError('moniker must be 1-64 characters');
    this.state.validators[op] = {
      operator: op,
      moniker: String(moniker),
      consensusAddress: normalize(consensusAddress || op),
      commissionBps: BigInt(commissionBps),
      selfStake: BigInt(amount),
      totalStake: BigInt(amount),
      delegators: { [op]: BigInt(amount) },
      status: 'bonded',
      registeredAt: height,
      priority: 0n,
    };
    return this.state.validators[op];
  }

  bond({ owner, operator, amount, height }) {
    const op = normalize(operator);
    const v = this.state.validators[op];
    if (!v) throw new StakingError('unknown validator');
    if (v.status === 'tombstoned') throw new StakingError('validator is tombstoned');
    if (amount < this.params.minDelegation) throw new StakingError('delegation below minimum');
    const ow = normalize(owner);
    v.delegators[ow] = (v.delegators[ow] ?? 0n) + BigInt(amount);
    v.totalStake += BigInt(amount);
    if (ow === op) v.selfStake += BigInt(amount);
    return v;
  }

  unbond({ owner, operator, amount, height }) {
    const op = normalize(operator);
    const v = this.state.validators[op];
    if (!v) throw new StakingError('unknown validator');
    const ow = normalize(owner);
    const held = v.delegators[ow] ?? 0n;
    const want = BigInt(amount) === 0n ? held : BigInt(amount);
    if (want > held) throw new StakingError('unbond amount exceeds bonded amount');
    if (want === 0n) throw new StakingError('nothing to unbond');
    v.delegators[ow] = held - want;
    if (v.delegators[ow] === 0n) delete v.delegators[ow];
    v.totalStake -= want;
    if (ow === op) v.selfStake = v.selfStake > want ? v.selfStake - want : 0n;
    this.state.unbonding.push({ owner: ow, operator: op, amount: want, maturesAt: height + this.params.unbondingBlocks });
    if (v.totalStake < this.params.minSelfStake && v.selfStake < this.params.minSelfStake) {
      v.status = 'unbonding';
    }
    return want;
  }

  /** Release matured unbonding entries. Returns payout deltas. */
  completeUnbonding(height) {
    const matured = this.state.unbonding.filter((u) => u.maturesAt <= height);
    if (matured.length === 0) return [];
    this.state.unbonding = this.state.unbonding.filter((u) => u.maturesAt > height);
    const deltas = [];
    for (const m of matured) {
      // The coin was held by the escrow while the unbonding period ran; paying
      // it out must move it, not create it. Missing the debit here is how a
      // staking implementation prints money.
      deltas.push({ address: SYSTEM.moduleAddress, amount: -m.amount, reason: 'unbond-complete' });
      deltas.push({ address: m.owner, amount: m.amount, reason: 'unbond-complete' });
      const v = this.state.validators[m.operator];
      if (v && v.status === 'unbonding' && v.selfStake >= this.params.minSelfStake) v.status = 'bonded';
    }
    return deltas;
  }

  jail(op, untilHeight, reason, slashBps = 0n) {
    const v = this.state.validators[normalize(op)];
    if (!v) return;
    v.status = 'jailed';
    this.state.jailedUntil[normalize(op)] = untilHeight;
    v.jailReason = reason;
    if (slashBps > 0n) this.slash(v.operator, slashBps, reason);
  }

  slash(op, slashBps, reason) {
    const v = this.state.validators[normalize(op)];
    if (!v) return 0n;
    const amount = (v.totalStake * BigInt(slashBps)) / BPS;
    if (amount === 0n) return 0n;
    // Pro-rata across delegators, largest remainder retained by the pool.
    let removed = 0n;
    for (const [addr, held] of Object.entries(v.delegators)) {
      const cut = (held * BigInt(slashBps)) / BPS;
      if (cut > 0n) {
        v.delegators[addr] = held - cut;
        removed += cut;
        if (v.delegators[addr] === 0n) delete v.delegators[addr];
      }
    }
    v.totalStake -= removed;
    v.selfStake = v.selfStake > removed ? v.selfStake - removed : 0n;
    this.state.totals.slashed += removed;
    // Slashed coins stay in the module account until the ledger destroys them
    // in the same block, which keeps `module balance === entitlements` true.
    this.state.pendingSlashBurn = (this.state.pendingSlashBurn ?? 0n) + removed;
    this.state.evidence.push({ type: 'slash', operator: v.operator, amount: removed, reason, height: this.state.height });
    return removed;
  }

  tombstone(op, reason) {
    const v = this.state.validators[normalize(op)];
    if (!v) return;
    v.status = 'tombstoned';
    v.tombstonedReason = reason;
    v.totalStake = 0n;
    for (const addr of Object.keys(v.delegators)) {
      const held = v.delegators[addr];
      if (held > 0n) {
        this.state.unbonding.push({ owner: addr, operator: v.operator, amount: held, maturesAt: this.state.height });
      }
      delete v.delegators[addr];
    }
    this.state.evidence.push({ type: 'tombstone', operator: v.operator, reason, height: this.state.height });
  }

  unjail(op, height) {
    const v = this.state.validators[normalize(op)];
    if (!v) throw new StakingError('unknown validator');
    if (v.status === 'tombstoned') throw new StakingError('tombstoned validators cannot unjail');
    if (v.status !== 'jailed') throw new StakingError('validator is not jailed');
    if ((this.state.jailedUntil[v.operator] ?? 0) > height) {
      throw new StakingError(`jailed until block ${this.state.jailedUntil[v.operator]}`);
    }
    if ((this.state.missed[v.operator] ?? 0) > 0) throw new StakingError('missed-block counter must be reset by proposing a block first');
    v.status = 'bonded';
    delete this.state.jailedUntil[v.operator];
    return v;
  }

  // ------------------------------------------------------------ validator set

  /** Active (bonded) validator set ordered by voting power, capped in size. */
  activeSet() {
    const list = Object.values(this.state.validators)
      .filter((v) => v.status === 'bonded' && v.totalStake > 0n)
      .map((v) => ({ ...v, power: this.powerOf(v.totalStake) }))
      .sort((a, b) => (b.power === a.power ? cmpHex(a.operator, b.operator) : Number(b.power - a.power)));
    return list.slice(0, this.params.maxActiveValidators);
  }

  powerOf(stake) {
    return (BigInt(stake) * STAKING.powerPerCoin) / UNIT;
  }

  totalPower() {
    return this.activeSet().reduce((acc, v) => acc + v.power, 0n);
  }

  /**
   * Deterministic weighted proposer selection for (height, round). Stateless
   * by design: any node that knows the validator set can recompute it.
   */
  proposerFor(height, round) {
    const set = this.activeSet();
    if (set.length === 0) return null;
    const total = set.reduce((a, v) => a + v.power, 0n);
    if (total === 0n) return set[0];
    const seed = BigInt('0x' + Buffer.from(keccak256Bytes(ethers.toUtf8Bytes(`propose:${height}:${round}`))).toString('hex'));
    let target = seed % total;
    for (const v of set) {
      if (target < v.power) return v;
      target -= v.power;
    }
    return set[set.length - 1];
  }

  // ------------------------------------------------------- block lifecycle

  /**
   * End-of-block bookkeeping: reward distribution, downtime tracking and
   * unbonding completion. Returns balance deltas the chain must apply.
   */
  endBlock({ height, moduleBalance }) {
    const deltas = [];
    this.state.height = height;
    const set = this.activeSet();
    const total = set.reduce((a, v) => a + v.power, 0n);

    // Downtime tracking uses markProposed/markMissed driven by the node.

    // Reward distribution: the validator module balance is shared by stake
    // weight at each distribution boundary, minus validator commission.
    // Integer remainders stay in the pool, so the payout can never exceed
    // what the module actually holds.
    let distributed = 0n;
    if (this.params.distributionInterval > 0 && height % this.params.distributionInterval === 0 && total > 0n) {
      const pool = moduleBalance > 0n ? moduleBalance : 0n;
      if (pool > 0n) {
        for (const v of set) {
          const share = (pool * v.power) / total;
          if (share === 0n) continue;
          const commission = (share * v.commissionBps) / BPS;
          const delegable = share - commission;
          const validatorPower = v.power > 0n ? v.power : 1n;
          for (const [addr, held] of Object.entries(v.delegators)) {
            const amt = (delegable * this.powerOf(held)) / validatorPower;
            if (amt > 0n) {
              deltas.push({ address: addr, amount: amt, reason: 'staking-reward', operator: v.operator });
              distributed += amt;
            }
          }
          if (commission > 0n) {
            deltas.push({ address: v.operator, amount: commission, reason: 'staking-commission', operator: v.operator });
            distributed += commission;
          }
          this.state.lastDistribution = height;
        }
        if (distributed > 0n) {
          deltas.push({ address: SYSTEM.validatorPoolAddress, amount: -distributed, reason: 'staking-distribution' });
          this.state.totals.distributed += distributed;
        }
      }
    }

    const matured = this.completeUnbonding(height);
    deltas.push(...matured);

    // Jailed validators whose jail period elapsed become eligible to unjail.
    for (const [op, until] of Object.entries(this.state.jailedUntil)) {
      if (until <= height) delete this.state.jailedUntil[op];
    }
    return { deltas, distributed };
  }

  /** Coins slashed leave the bonded pool and are destroyed by the ledger. */
  pendingSlashedBurn(height) {
    const height_ = height;
    return this.state.evidence
      .filter((e) => e.burn !== undefined && e.burnHeight === height_ && !e.burned)
      .reduce((acc, e) => acc + e.burn, 0n);
  }

  /**
   * Downtime accounting, executed as part of the block transition.
   *
   * The evidence is the commit embedded in the block being applied: the set of
   * validators whose precommits sealed the previous height. That makes the
   * counters a pure function of the block log, so any node reproduces them at
   * any point in a replay, and they are covered by the application hash.
   */
  trackAttendance(signers, height) {
    if (!signers) return { jailed: [] };
    const set = new Set(signers.map(normalize));
    const jailed = [];
    for (const v of this.activeSet()) {
      const attended = set.has(normalize(v.operator)) || set.has(normalize(v.consensusAddress));
      if (attended) {
        this.state.missed[v.operator] = 0;
        continue;
      }
      this.state.missed[v.operator] = (this.state.missed[v.operator] ?? 0) + 1;
      if (this.state.missed[v.operator] >= this.params.downtimeWindow) {
        this.state.missed[v.operator] = 0;
        this.jail(v.operator, height + this.params.jailDurationBlocks, 'downtime', this.params.downtimeSlashBps);
        jailed.push(v.operator);
      }
    }
    return { jailed };
  }

  markProposed(op) {
    this.state.missed[normalize(op)] = 0;
  }

  markMissed(op, height) {
    const k = normalize(op);
    this.state.missed[k] = (this.state.missed[k] ?? 0) + 1;
    if (this.state.missed[k] >= this.params.downtimeWindow) {
      this.state.missed[k] = 0;
      this.jail(k, height + this.params.jailDurationBlocks, 'downtime', this.params.downtimeSlashBps);
    }
  }

  // ---------------------------------------------------- double-sign evidence

  /**
   * Verify and punish a double-sign. Two distinct valid seals by the same
   * consensus key at the same (height, round) is a safety violation: the
   * validator is slashed and permanently removed.
   */
  /**
   * Double-sign evidence: the same consensus key signing two different blocks
   * at the same (height, round). The digests are recomputed from the vote
   * fields rather than trusted from the submitter, so evidence cannot be
   * smuggled in with a pre-forged digest.
   */
  static evidenceDigest(ev, which) {
    return voteTag({
      type: ev[`type${which}`] ?? 'precommit',
      chainId: ev.chainId,
      height: ev[`height${which}`],
      round: ev[`round${which}`],
      blockHash: ev[`blockHash${which}`],
    });
  }

  verifyEvidence(ev) {
    try {
      if (!ev || ev.type !== 'double-sign') return { ok: false, reason: 'unsupported evidence type' };
      if (Number(ev.heightA) !== Number(ev.heightB) || Number(ev.roundA) !== Number(ev.roundB)) {
        return { ok: false, reason: 'the two votes are not for the same height and round' };
      }
      if (String(ev.blockHashA).toLowerCase() === String(ev.blockHashB).toLowerCase()) {
        return { ok: false, reason: 'the two votes are for the same block' };
      }
      const a = Staking.evidenceDigest(ev, 'A');
      const b = Staking.evidenceDigest(ev, 'B');
      if (!verifySeal(a, ev.sigA, ev.validator) || !verifySeal(b, ev.sigB, ev.validator)) {
        return { ok: false, reason: 'evidence signatures do not recover to the validator consensus key' };
      }
      const op = this.operatorForKey(ev.validator);
      if (!op) return { ok: false, reason: 'evidence names a validator that is not registered' };
      return { ok: true, operator: op };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * A vote is signed by the consensus key, but stake, commission and slashing
   * live against the operator address. Evidence therefore has to be resolved
   * from one to the other - punishing "the address in the evidence" directly
   * would silently do nothing whenever the two differ, which is the normal case.
   */
  operatorForKey(key) {
    const k = normalize(key);
    for (const v of Object.values(this.state.validators)) {
      if (normalize(v.consensusAddress) === k || normalize(v.operator) === k) return v.operator;
    }
    return null;
  }

  submitDoubleSign(ev) {
    const { heightA, roundA, heightB, roundB } = ev;
    const height = ev.evidenceHeight ?? this.state.height;
    const check = this.verifyEvidence(ev);
    if (!check.ok) throw new StakingError(check.reason);
    const validator = check.operator ?? this.operatorForKey(ev.validator);
    if (!validator) throw new StakingError('evidence does not resolve to a registered operator');
    const digestA = Staking.evidenceDigest(ev, 'A');
    const digestB = Staking.evidenceDigest(ev, 'B');
    if (heightA === heightB && roundA === roundB) {
      const slashed = this.slash(validator, this.params.doubleSignSlashBps, 'double-sign');
      this.tombstone(validator, 'double-sign');
      this.state.evidence.push({
        type: 'double-sign',
        operator: normalize(validator),
        height,
        a: { height: heightA, round: roundA },
        b: { height: heightB, round: roundB },
        slashed,
      });
      return { slashed };
    }
    throw new StakingError('evidence must be two different blocks at the same height and round');
  }

  // --------------------------------------------------- community rewards

  setReviewers(list) {
    this.state.reviewers = list.map(normalize);
  }

  addReviewer(addr) {
    const a = normalize(addr);
    if (!this.state.reviewers.includes(a)) this.state.reviewers.push(a);
  }

  /**
   * Record a community contribution claim. Idempotent on `contributionId`,
   * which is what makes duplicate claims impossible at the protocol level.
   */
  submitContribution({ contributionId, beneficiary, amount, reference, sender }) {
    const id = ethers.hexlify(contributionId);
    if (this.state.claims[id]) throw new StakingError('duplicate claim: contribution id already registered');
    const round = Math.floor(this.state.height / this.params.communityRoundBlocks);
    const perAddress = Object.values(this.state.claims)
      .filter((c) => c.round === round && c.beneficiary === normalize(beneficiary))
      .reduce((a, c) => a + c.amount, 0n);
    if (perAddress + BigInt(amount) > this.params.maxPerAddressPerRound) {
      throw new StakingError(`per-address round cap exceeded (${this.params.maxPerAddressPerRound} max)`);
    }
    this.state.claims[id] = {
      id,
      contributionId: id,
      beneficiary: normalize(beneficiary),
      amount: BigInt(amount),
      reference: String(reference ?? '').slice(0, 256),
      submittedBy: normalize(sender),
      round,
      approvals: [],
      rejections: [],
      status: 'pending',
      submittedAt: this.state.height,
    };
    this.state.claimOrder.push(id);
    return this.state.claims[id];
  }

  reviewContribution({ contributionId, approve, reviewer }) {
    const claim = this.state.claims[ethers.hexlify(contributionId)];
    if (!claim) throw new StakingError('unknown contribution id');
    const rv = normalize(reviewer);
    if (!this.state.reviewers.includes(rv)) throw new StakingError('reviewer is not in the reviewer set');
    if (claim.approvals.includes(rv) || claim.rejections.includes(rv)) {
      throw new StakingError('reviewer already acted on this claim');
    }
    if (claim.status !== 'pending') throw new StakingError('claim already settled');
    if (approve) claim.approvals.push(rv);
    else claim.rejections.push(rv);
    if (claim.rejections.length >= this.params.approvalQuorum) {
      claim.status = 'rejected';
    } else if (claim.approvals.length >= this.params.approvalQuorum) {
      claim.status = 'approved';
    }
    return claim;
  }

  /**
   * Approved claims, ready to be paid by the ledger.
   *
   * The ledger decides what it can actually afford this round and reports back
   * through `deferClaims`, so a claim that was deferred stays approved and is
   * settled later rather than being silently lost or partially paid.
   */
  takePayableClaims() {
    const out = [];
    for (const id of this.state.claimOrder) {
      const c = this.state.claims[id];
      if (c && c.status === 'approved') {
        out.push({ id: c.id, to: c.beneficiary, amount: c.amount });
        c.status = 'settling';
      }
    }
    return out;
  }

  /** Mark settling claims as paid (with the round tally) or return them to approved. */
  settleClaims(paidIds, deferredIds = []) {
    const paid = new Set(paidIds);
    for (const id of [...this.state.claimOrder]) {
      const c = this.state.claims[id];
      if (!c || c.status !== 'settling') continue;
      if (paid.has(c.id)) {
        c.status = 'paid';
        c.paidAt = this.state.height;
        this.state.totals.communityPaid += c.amount;
        this.state.claimOrder = this.state.claimOrder.filter((x) => x !== id);
      } else {
        c.status = 'approved';
      }
    }
    void deferredIds;
  }

  // ---------------------------------------------------------- system tx path

  /** Decode a system transaction's calldata into a named action. */
  static decodeSystemCall(data) {
    const hex = ethers.hexlify(data ?? '0x');
    if (hex.length < 10) return null;
    const selector = hex.slice(0, 10);
    for (const [name, sig] of Object.entries(SELECTORS)) {
      if (sig === selector) {
        const frag = SYSTEM_ABI.getFunction(name === 'registerValidator' ? 'registerValidator' : name);
        try {
          const args = SYSTEM_ABI.decodeFunctionData(frag, hex);
          return { action: name, args: args.toArray(), fragment: frag.format() };
        } catch {
          return { action: name, error: 'malformed calldata' };
        }
      }
    }
    return null;
  }

  /**
   * Apply a decoded system action for transaction `from`.
   * @returns {{ok:boolean, detail?:string, refund?:bigint, note?:object}}
   */
  applySystemAction({ action, args, from, value, height }) {
    try {
      switch (action) {
        case 'registerValidator': {
          const [moniker, consensusAddress, commissionBps] = args;
          this.registerValidator({ operator: from, moniker, consensusAddress, commissionBps, amount: value, height });
          return { ok: true, detail: 'validator registered' };
        }
        case 'bond': {
          const [operator] = args;
          this.bond({ owner: from, operator, amount: value, height });
          return { ok: true, detail: 'delegated' };
        }
        case 'unbond': {
          const [operator, amount] = args;
          const released = this.unbond({ owner: from, operator, amount, height });
          return { ok: true, detail: 'unbonding started', refund: released };
        }
        case 'rebond': {
          const [operator, amount] = args;
          const want = BigInt(amount);
          const idx = this.state.unbonding.findIndex(
            (u) => u.owner === normalize(from) && u.operator === normalize(operator) && u.amount === want
          );
          if (idx < 0) throw new StakingError('no matching unbonding entry');
          this.state.unbonding.splice(idx, 1);
          this.bond({ owner: from, operator, amount: want, height });
          return { ok: true, detail: 'rebonded', refund: want };
        }
        case 'unjail': {
          this.unjail(from, height);
          return { ok: true, detail: 'unjailed' };
        }
        case 'submitContribution': {
          const [contributionId, beneficiary, amount, reference] = args;
          this.submitContribution({ contributionId, beneficiary, amount, reference, sender: from });
          return { ok: true, detail: 'claim recorded' };
        }
        case 'reviewContribution': {
          const [contributionId, approve] = args;
          this.reviewContribution({ contributionId, approve, reviewer: from });
          return { ok: true, detail: 'review recorded' };
        }
        case 'fundCommunity': {
          return { ok: true, detail: 'community top-up accepted' };
        }
        default:
          return { ok: false, detail: `unsupported system action: ${action}` };
      }
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  // ------------------------------------------------------------- reporting

  validatorSummary() {
    return Object.values(this.state.validators).map((v) => ({
      operator: v.operator,
      consensusAddress: v.consensusAddress,
      moniker: v.moniker,
      status: v.status,
      commissionBps: v.commissionBps.toString(),
      selfStake: v.selfStake.toString(),
      totalStake: v.totalStake.toString(),
      power: this.powerOf(v.totalStake).toString(),
      delegators: Object.entries(v.delegators).map(([a, amt]) => ({ address: a, amount: amt.toString() })),
      missedBlocks: this.state.missed[v.operator] ?? 0,
      jailReason: v.jailReason,
    }));
  }

  commitment() {
    return hashObject(this.serialize());
  }

  serialize() {
    return {
      validators: Object.fromEntries(
        Object.entries(this.state.validators).map(([op, v]) => [
          op,
          {
            moniker: v.moniker,
            consensusAddress: v.consensusAddress,
            commissionBps: v.commissionBps.toString(),
            selfStake: v.selfStake.toString(),
            totalStake: v.totalStake.toString(),
            status: v.status,
            delegators: mapVals(v.delegators, (x) => x.toString()),
            registeredAt: v.registeredAt,
            jailReason: v.jailReason ?? null,
            tombstonedReason: v.tombstonedReason ?? null,
          },
        ])
      ),
      unbonding: this.state.unbonding.map((u) => ({ ...u, amount: u.amount.toString() })),
      reviewers: this.state.reviewers,
      claims: mapVals(this.state.claims, (c) => ({
        ...c,
        amount: c.amount.toString(),
      })),
      missed: this.state.missed,
      jailedUntil: this.state.jailedUntil,
      claimOrder: this.state.claimOrder,
      pendingSlashBurn: (this.state.pendingSlashBurn ?? 0n).toString(),
      totals: mapVals(this.state.totals, (x) => x.toString()),
      lastDistribution: this.state.lastDistribution,
      height: this.state.height,
      evidenceCount: this.state.evidence.length,
      evidenceRoot: hashOfList(this.state.evidence),
    };
  }

  static fromSerialized(obj, params, staking) {
    const s = staking ?? new Staking(params);
    s.state = {
      ...obj,
      validators: Object.fromEntries(
        Object.entries(obj.validators).map(([op, v]) => [
          op,
          {
            operator: op,
            moniker: v.moniker,
            consensusAddress: v.consensusAddress,
            commissionBps: BigInt(v.commissionBps),
            selfStake: BigInt(v.selfStake),
            totalStake: BigInt(v.totalStake),
            status: v.status,
            delegators: mapVals(v.delegators, (x) => BigInt(x)),
            registeredAt: v.registeredAt,
            jailReason: v.jailReason ?? undefined,
            tombstonedReason: v.tombstonedReason ?? undefined,
            priority: 0n,
          },
        ])
      ),
      unbonding: (obj.unbonding ?? []).map((u) => ({ ...u, amount: BigInt(u.amount) })),
      claims: mapVals(obj.claims ?? {}, (c) => ({ ...c, amount: BigInt(c.amount) })),
      totals: {
        distributed: BigInt(obj.totals?.distributed ?? 0),
        slashed: BigInt(obj.totals?.slashed ?? 0),
        communityPaid: BigInt(obj.totals?.communityPaid ?? 0),
        feesPaid: BigInt(obj.totals?.feesPaid ?? 0),
        subsidyPaid: BigInt(obj.totals?.subsidyPaid ?? 0),
      },
      reviewers: obj.reviewers ?? [],
      claimOrder: obj.claimOrder ?? [],
      pendingSlashBurn: BigInt(obj.pendingSlashBurn ?? 0),
      evidence: obj.evidence ?? [],
      missed: obj.missed ?? {},
      jailedUntil: obj.jailedUntil ?? {},
      lastDistribution: obj.lastDistribution ?? 0,
      height: obj.height ?? 0,
    };
    return s;
  }
}

function verifySeal(digest, signature, consensusAddress) {
  try {
    const rec = ethers.recoverAddress(digest, signature);
    return rec.toLowerCase() === normalize(consensusAddress);
  } catch {
    return false;
  }
}

function hashOfList(list) {
  return '0x' + Buffer.from(hashObject(list.map((e) => ({ ...e })))).toString('hex');
}

function mapVals(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = fn(v);
  return out;
}

function normalize(addr) {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    return String(addr).toLowerCase();
  }
}

function cmpHex(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = { Staking, StakingError, SELECTORS, SYSTEM_ABI, normalize };
