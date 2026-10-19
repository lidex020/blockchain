'use strict';
/**
 * Protocol state machine.
 *
 * Ties the two protocol subsystems - the FSTOP supply ledger and the
 * validator/staking registry - to each block, and owns the rules that only
 * the protocol may apply:
 *
 *   1. interpret system transactions (register, bond, unbond, claims, reviews);
 *   2. validate and act on double-sign evidence committed with the block;
 *   3. collect the block's fees, burn the burn share, route the rest to the
 *      validator reward pool;
 *   4. mint the block subsidy from the unissued validator pool (cap enforced);
 *   5. release vesting on the approved schedule;
 *   6. pay approved community participation rewards inside the round budget;
 *   7. distribute staking rewards by stake weight, release matured unbonds,
 *      burn slashed stake;
 *   8. publish the application hash every validator must reproduce.
 *
 * Steps 1-7 are pure functions of (prior protocol state, block contents);
 * nothing reads a clock, a random value or an external service.
 */

const { ethers } = require('ethers');
const { Ledger } = require('./ledger');
const { Staking, normalize } = require('./staking');
const { SYSTEM, REWARDS, STAKING: STAKING_C, VERSION, BLOCK } = require('./constants');
const { hashObject } = require('./crypto');
const { ExecutionError } = require('./execution');

const MODULE_ACCOUNTS = [
  SYSTEM.moduleAddress,
  SYSTEM.communityPoolAddress,
  SYSTEM.validatorPoolAddress,
  SYSTEM.vestingAddress,
  SYSTEM.feeCollectorAddress,
];

class Protocol {
  constructor(params = {}) {
    this.params = params;
    this.ledger = new Ledger(params);
    this.staking = new Staking(params);
    this.checkpointStack = [];
    this.lastResult = { height: 0, actions: [], events: [], burns: 0n, mints: 0n };
    this.supplyAuditEvery = params.supplyAuditEvery ?? 25;
  }

  get address() {
    return SYSTEM.moduleAddress;
  }

  // ----------------------------------------------------------- genesis

  /**
   * Mint genesis allocations and register the genesis validator set.
   * Must be called before the first block, against the same execution
   * instance that will run block 1.
   */
  async applyGenesis(execution) {
    const deltas = this.ledger.applyGenesis();
    await execution.applyDeltas(deltas);

    // Approved starting distribution: each release moves coin out of a
    // genesis-locked module into a named account.
    for (const a of this.params.genesisAlloc ?? []) {
      if (!a.source?.pool) continue;
      const release = this.ledger.genesisRelease(a.source.pool, a.address, a.balance, a.source.reason);
      await execution.applyDeltas(release);
    }

    if (this.params.reviewers?.length) this.staking.setReviewers(this.params.reviewers.map((r) => r.address ?? r));

    for (const v of this.params.genesisValidators ?? []) {
      const amount = BigInt(v.selfStake ?? v.self_stake ?? 0n);
      this.staking.registerValidator({
        operator: v.address,
        moniker: v.moniker ?? `validator-${String(v.address).slice(2, 8)}`,
        consensusAddress: v.consensusAddress ?? v.consensus_address ?? v.address,
        commissionBps: v.commissionBps ?? STAKING_C.defaultCommissionBps,
        amount,
        height: 0,
      });
      if (amount > 0n) {
        // Genesis self-bonded stake moves from the validator's account into
        // the escrow; the escrow coverage check in applyBlock proves the two
        // agree, so a bond can never be booked without the coin behind it.
        await execution.applyDeltas([
          { address: v.address, amount: -amount, reason: 'genesis-self-bond' },
          { address: SYSTEM.moduleAddress, amount, reason: 'genesis-self-bond' },
        ]);
      }
    }
    return deltas;
  }

  /** FSTOP the escrow must hold to cover every recorded entitlement. */
  requiredEscrow() {
    let total = 0n;
    for (const v of Object.values(this.staking.state.validators)) total += v.totalStake;
    for (const u of this.staking.state.unbonding) total += u.amount;
    return total;
  }

  // --------------------------------------------------------- block pipeline

  async applyBlock(ctx) {
    const { height, execution, txs = [], results = [], evidence = [], feesCollected = 0n, lastCommitSigners = null } = ctx;
    const actions = [];
    let minted = 0n;
    let burned = 0n;

    // ---- 1. system transactions ------------------------------------------
    // A transaction sent to the protocol module account is decoded here. The
    // EVM has already moved its `value` into the escrow, exactly as it would
    // for any other transfer; the protocol then updates entitlements, and
    // refunds the value when the action is rejected.
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      if (!tx.to || normalize(tx.to.toString()) !== normalize(SYSTEM.moduleAddress)) continue;
      const sender = tx.getSenderAddress().toString();
      const value = tx.value ?? 0n;
      const decoded = Staking.decodeSystemCall(tx.data);

      if (!decoded || decoded.error) {
        await this._refund(execution, sender, value);
        actions.push({ index: i, ok: false, hash: ethers.hexlify(tx.hash()), reason: decoded ? decoded.error : 'unknown system selector' });
        continue;
      }

      const outcome = this.staking.applySystemAction({
        action: decoded.action,
        args: decoded.args,
        from: sender,
        value,
        height,
      });

      if (!outcome.ok) {
        await this._refund(execution, sender, value);
        actions.push({ index: i, ok: false, action: decoded.action, hash: ethers.hexlify(tx.hash()), reason: outcome.detail });
        continue;
      }

      const settle = [];
      switch (decoded.action) {
        case 'unbond': {
          // The unbond amount stays in the escrow until the unbonding period
          // matures; anything the sender over-paid is returned now.
          const over = value - outcome.refund;
          if (over > 0n) settle.push({ address: SYSTEM.moduleAddress, amount: -over, reason: 'system-refund' }, { address: sender, amount: over, reason: 'system-refund' });
          if (over < 0n) settle.push({ address: SYSTEM.moduleAddress, amount: -over, reason: 'unbond-shortfall' }, { address: sender, amount: over, reason: 'unbond-shortfall' });
          break;
        }
        case 'rebond': {
          if (value > 0n) settle.push({ address: SYSTEM.moduleAddress, amount: -value, reason: 'rebond-refund' }, { address: sender, amount: value, reason: 'rebond-refund' });
          break;
        }
        case 'fundCommunity': {
          if (value > 0n) settle.push({ address: SYSTEM.moduleAddress, amount: -value, reason: 'community-topup' }, { address: SYSTEM.communityPoolAddress, amount: value, reason: 'community-topup' });
          break;
        }
        case 'submitContribution': {
          if (value > 0n) settle.push({ address: SYSTEM.moduleAddress, amount: -value, reason: 'system-refund' }, { address: sender, amount: value, reason: 'system-refund' });
          break;
        }
        case 'reviewContribution':
        case 'unjail': {
          if (value > 0n) settle.push({ address: SYSTEM.moduleAddress, amount: -value, reason: 'system-refund' }, { address: sender, amount: value, reason: 'system-refund' });
          break;
        }
        default:
          break; // registerValidator and bond keep their value in the escrow
      }
      if (settle.length) await execution.applyDeltas(settle);
      actions.push({
        index: i,
        ok: true,
        action: decoded.action,
        hash: ethers.hexlify(tx.hash()),
        sender,
        value: value.toString(),
        detail: outcome.detail,
      });
    }

    // ---- 2. evidence ------------------------------------------------------
    for (const ev of evidence) {
      try {
        const res = this.staking.submitDoubleSign({ ...ev, evidenceHeight: height });
        actions.push({ evidence: true, ok: true, validator: ev.validator, slashed: res.slashed.toString() });
      } catch (err) {
        if (err.name === 'StakingError') {
          actions.push({ evidence: true, ok: false, validator: ev.validator, reason: err.message });
          continue;
        }
        throw new ExecutionError(`evidence handling failed in block ${height}: ${err.message}`, 'EVIDENCE');
      }
    }

    // ---- 3. downtime: who signed the commit that sealed the prior height ---
    const attendance = this.staking.trackAttendance(lastCommitSigners, height);

    // ---- 4/5/6/7. ledger transition --------------------------------------
    await this._syncModuleBalances(execution);
    const communityClaims = this.staking.takePayableClaims();
    const plan = this.ledger.planBlock({
      height,
      fees: feesCollected,
      validators: this.staking.activeSet(),
      communityClaims,
    });
    const deltas = [...plan.deltas];

    // ---- 7. staking transition -------------------------------------------
    // Fee revenue and the subsidy have already been credited to the validator
    // pool in `deltas`, so the pool balance to distribute is the projected one.
    const projectedPool = await this._projectedBalance(SYSTEM.validatorPoolAddress, deltas, execution);
    const stakingResult = this.staking.endBlock({ height, moduleBalance: projectedPool });
    deltas.push(...stakingResult.deltas);

    const slashBurn = this.staking.state.pendingSlashBurn ?? 0n;
    if (slashBurn > 0n) {
      // Slashed stake leaves the escrow and is destroyed in the same block, so
      // escrow coverage never drifts.
      this.ledger.state.burned += slashBurn;
      this.ledger.state.totals.slashedBurn = (this.ledger.state.totals.slashedBurn ?? 0n) + slashBurn;
      deltas.push({ address: SYSTEM.moduleAddress, amount: -slashBurn, reason: 'slash-burn' });
      this.staking.state.pendingSlashBurn = 0n;
    }

    // A claim the ledger could not afford this round goes back to `approved`
    // and is retried later; one it paid is settled permanently.
    this.staking.settleClaims(plan.paid ?? [], (plan.deferred ?? []).map((d) => d.id));

    await execution.applyDeltas(deltas);

    for (const d of deltas) {
      if (d.reason === 'block-subsidy') minted += d.amount;
      if (d.reason === 'fee-burn') burned += d.amount;
      if (d.reason === 'slash-burn') burned += d.amount;
    }
    void results;

    // ---- accounting assertions -------------------------------------------
    const escrow = await execution.balance(SYSTEM.moduleAddress);
    const required = this.requiredEscrow();
    // Published through `fs_supply` so a reader can check the custody invariant
    // for itself instead of trusting that the node asserted it.
    this.lastEscrow = { held: escrow.toString(), required: required.toString(), height };
    if (escrow < required) {
      throw new ExecutionError(`staking escrow under-collateralised: holds ${escrow}, entitlements ${required}`, 'ESCROW');
    }
    if (this.ledger.state.minted > this.ledger.maxSupply) {
      throw new ExecutionError('hard cap violated', 'SUPPLY_CAP');
    }

    const appHash = await this.computeAppHash(height, execution);
    const validatorsHash = hashObject(this.staking.activeSet().map((v) => ({ op: v.operator, p: v.power.toString(), cs: v.consensusAddress })));
    this.lastResult = {
      height,
      actions,
      events: plan.events,
      burns: burned,
      mints: minted,
      distributed: stakingResult.distributed,
      feesCollected,
    };
    return {
      appHash: toHex(appHash),
      validatorsHash: toHex(validatorsHash),
      actions,
      events: plan.events,
      deferredClaims: plan.deferred,
      paidClaims: plan.paid,
      minted,
      burned,
      distributed: stakingResult.distributed,
      feesCollected,
      deltas,
      attendance,
    };
  }

  async _refund(execution, sender, value) {
    if (value > 0n) {
      await execution.applyDeltas([
        { address: SYSTEM.moduleAddress, amount: -value, reason: 'system-refund' },
        { address: sender, amount: value, reason: 'system-refund' },
      ]);
    }
  }

  async _projectedBalance(address, deltas, execution) {
    let balance = await execution.balance(address);
    for (const d of deltas) if (normalize(d.address) === normalize(address)) balance += d.amount;
    return balance;
  }

  async _syncModuleBalances(execution) {
    const map = new Map();
    for (const a of MODULE_ACCOUNTS) map.set(normalize(a), await execution.balance(a));
    this.ledger.syncModuleBalances(map);
    return map;
  }

  async computeAppHash(height, execution) {
    const root = await execution.stateRoot();
    return hashObject({
      version: VERSION.appVersion,
      height,
      ledger: this.ledger.serialize(),
      staking: this.staking.serialize(),
      evmRoot: root,
    });
  }

  // ----------------------------------------------------- speculative states
  //
  // A speculative execution (validating a proposal, gas estimation) must leave
  // the protocol state exactly as it found it. Instead of a checkpoint stack -
  // which desynchronises the moment an execution fails part-way through - the
  // execution layer takes one full snapshot before a dry run and hands it back
  // here afterwards. Success, failure or revert, there is exactly one snapshot
  // per speculative run and restoring it cannot be skipped.

  snapshotJSON() {
    const snapshot = this.serialize();
    snapshot.staking.evidence = this.staking.state.evidence;
    return JSON.stringify(snapshot, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  }

  restoreSnapshot(json) {
    const restored = Protocol.restore(JSON.parse(json), this.params);
    this.ledger = restored.ledger;
    this.staking = restored.staking;
  }

  /** No-op kept so callers of the old interface keep working. */
  async rollback() {
    return undefined;
  }

  // ------------------------------------------------------------- reporting

  serialize() {
    return { ledger: this.ledger.serialize(), staking: this.staking.serialize(), version: VERSION.appVersion };
  }

  static restore(serialized, params = {}) {
    const p = new Protocol(params);
    p.ledger = Ledger.fromSerialized(serialized.ledger, params);
    p.staking = Staking.fromSerialized(serialized.staking, params);
    p._genesisApplied = true;
    return p;
  }

  /**
   * Full supply audit: sum every balance in the state trie and compare with
   * the ledger's own accounting. Run at block boundaries by the node when
   * `FULLSTOP_AUDIT=1`, and always by the test suite.
   */
  async supplyAudit(execution) {
    const { total, accounts } = await execution.sumAllBalances();
    const expected = this.ledger.state.minted - this.ledger.state.burned;
    return {
      ok: total === expected,
      onchainTotal: total.toString(),
      ledgerTotal: expected.toString(),
      difference: (total - expected).toString(),
      accounts,
      minted: this.ledger.state.minted.toString(),
      burned: this.ledger.state.burned.toString(),
      maxSupply: this.ledger.maxSupply.toString(),
      headroom: (this.ledger.maxSupply - this.ledger.state.minted).toString(),
    };
  }

  supplyReport(execution) {
    const report = this.ledger.supplyReport();
    if (execution) {
      report.escrow = {
        balance: this.staking && execution ? undefined : undefined,
      };
      delete report.escrow;
    }
    return report;
  }
}

function toHex(bytes) {
  return ethers.hexlify(bytes);
}

module.exports = { Protocol, MODULE_ACCOUNTS };
