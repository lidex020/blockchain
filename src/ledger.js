'use strict';
/**
 * FSTOP supply ledger.
 *
 * This is the protocol-level accounting authority for the native coin. It is
 * deliberately separate from the EVM: the EVM may only move balances between
 * accounts, while every *issuance* and *burn* of FSTOP goes through this
 * module. That separation is what makes the 100,000,000 FSTOP hard cap a
 * protocol rule rather than a promise made by a contract or a dashboard.
 *
 * Invariants (enforced here, asserted again by the chain after every block):
 *   1. minted - burned === sum(all EVM balances)            (conservation)
 *   2. minted <= maxSupply                                   (hard cap)
 *   3. pool payouts may never exceed that pool's balance     (bounded issuance)
 *   4. every mint/burn/transfer is attributable to a named protocol rule
 */

const { COIN, ALLOCATIONS, SYSTEM, REWARDS, FEES, COMMUNITY, VERSION } = require('./constants');
const { hashObject } = require('./crypto');

const BPS = REWARDS.bpsDenominator;

/**
 * Convert a share of the cap into the base unit. The cap comes from the
 * ledger's own parameters so a network that approves a different maximum supply
 * gets allocations sized against the number it actually agreed to.
 */
function shareFromBps(shareBps, maxSupply = COIN.maxSupply) {
  return (maxSupply * shareBps) / BPS;
}

/** Allocation key for the vesting module that holds a genesis-locked pool. */
function vestingModuleKey(key) {
  return `vesting:${key}`;
}

class SupplyCapExceeded extends Error {
  constructor(minted, requested, cap) {
    super(
      `protocol issuance rejected: minted=${minted} + requested=${requested} exceeds hard cap ${cap} ` +
      `(see docs/TOKENOMICS.md - the cap is immutable in the protocol rule set)`
    );
    this.name = 'SupplyCapExceeded';
  }
}

class Ledger {
  /**
   * @param {object} params protocol parameters taken from genesis so that two
   *   nodes configured identically compute identical state.
   */
  constructor(params = {}) {
    this.maxSupply = params.maxSupply ?? COIN.maxSupply;
    this.initialIssuance = params.initialIssuance ?? COIN.initialIssuance;
    this.burnBps = params.burnBps ?? FEES.burnBps;
    this.validatorFeeBps = params.validatorFeeBps ?? FEES.validatorFeeBps;
    this.blockSubsidy = params.blockSubsidy ?? REWARDS.blockSubsidy;
    this.allocations = params.allocations ?? ALLOCATIONS;
    this.roundBudget = params.communityRoundBudget ?? COMMUNITY.roundBudget;
    this.roundBlocks = params.communityRoundBlocks ?? COMMUNITY.roundBlocks;

    this.state = {
      appVersion: VERSION.appVersion,
      minted: 0n,
      burned: 0n,
      /** Pool metadata: remaining issuable / spendable balance. */
      pools: {},
      /** Locked balances held by vesting modules, keyed by allocation. */
      locked: {},
      /** Cumulative released-from-vesting amounts per allocation. */
      released: {},
      /** Per-round community reward accounting. */
      communityRound: { index: 0, spent: 0n, claims: 0 },
      /** Cumulative reward tallies for the public dashboard. */
      totals: { validatorRewards: 0n, communityRewards: 0n, feeRevenue: 0n, feesBurned: 0n, feesToValidators: 0n },
      /** Number of protocol blocks applied. */
      height: 0,
      /** Hash chain over ledger events (bounded, for audit and appHash). */
      eventRoot: new Uint8Array(32),
      eventCount: 0,
    };

    for (const [key, cfg] of Object.entries(this.allocations)) {
      const amount = shareFromBps(cfg.shareBps, this.maxSupply);
      this.state.pools[key] = {
        label: cfg.label,
        allocation: amount,
        issued: 0n,
        remaining: amount,
        mode: cfg.issuance,
      };
      if (cfg.issuance === 'genesis-locked') {
        this.state.locked[vestingModuleKey(key)] = 0n;
      }
    }
    this._genesisApplied = false;
    /** Module account balances, refreshed by the chain before each block. */
    this._moduleBalances = new Map();
  }

  // ---------------------------------------------------------------- genesis

  /**
   * Mint the genesis allocation into the protocol module accounts.
   * Returns the balance deltas the chain must apply to EVM state.
   */
  applyGenesis() {
    if (this._genesisApplied) throw new Error('genesis allocation already applied');
    const deltas = [];
    let genesisMint = 0n;
    for (const [key, cfg] of Object.entries(this.allocations)) {
      if (cfg.issuance !== 'genesis-locked') continue;
      const amount = this.state.pools[key].allocation;
      if (amount === 0n) continue;
      const module = this.moduleAddressFor(key);
      deltas.push({ address: module, amount, reason: `genesis-allocation:${key}` });
      this.state.pools[key].issued = amount;
      this.state.locked[vestingModuleKey(key)] = amount;
      genesisMint += amount;
      this._record({ type: 'mint', reason: `genesis:${key}`, amount, to: module });
    }
    if (genesisMint > this.initialIssuance) {
      throw new Error(
        `genesis issuance ${genesisMint} exceeds the approved initial issuance budget ${this.initialIssuance}`
      );
    }
    this._mint(genesisMint);
    this._genesisApplied = true;
    return deltas;
  }

  /**
   * Release a genesis allocation out of its module account to a named account.
   * Used for the approved starting distribution: validator self-bonds,
   * ecosystem bootstrapping and test funding. It moves already-minted coin,
   * so it cannot affect the hard cap.
   */
  genesisRelease(poolKey, to, amount, reason) {
    const pool = this.state.pools[poolKey];
    if (!pool) throw new Error(`genesis release from unknown pool "${poolKey}"`);
    const lockKey = vestingModuleKey(poolKey);
    const locked = this.state.locked[lockKey] ?? 0n;
    const want = BigInt(amount);
    if (want > locked) {
      throw new Error(`genesis release of ${want} from pool "${poolKey}" exceeds its locked balance ${locked}`);
    }
    this.state.locked[lockKey] = locked - want;
    this.state.released[poolKey] = (this.state.released[poolKey] ?? 0n) + want;
    const module = this.moduleAddressFor(poolKey);
    this._record({ type: 'genesis-release', pool: poolKey, to, amount: want });
    return [
      { address: module, amount: -want, reason: `genesis-release:${poolKey}` },
      { address: to, amount: want, reason: reason ?? `genesis-release:${poolKey}` },
    ];
  }

  /** Module address that custodies an allocation's locked balance. */
  moduleAddressFor(key) {
    if (key === 'community') return SYSTEM.communityPoolAddress;
    if (key === 'validator') return SYSTEM.validatorPoolAddress;
    return SYSTEM.vestingAddress;
  }

  // ---------------------------------------------------------- block pipeline

  /**
   * End-of-block protocol transition. Deterministic given (height, feePool,
   * validator set) so every validator arrives at the same result.
   *
   * @param {object} ctx
   * @param {number} ctx.height block height about to be committed
   * @param {bigint} ctx.fees total transaction fees collected in this block
   * @param {Array<{address:string, power:bigint}>} ctx.validators active set
   * @param {Array<{to:string, amount:bigint, id:string}>} ctx.communityClaims
   *        approved community rewards to pay out this block
   * @returns {{deltas: Array<object>, events: Array<object>}}
   */
  planBlock(ctx) {
    const { height, fees = 0n, validators = [], communityClaims = [] } = ctx;
    const deltas = [];
    const events = [];
    this.state.height = height;

    // 1. Transaction fees. The EVM already credited the block's total fee to
    //    the protocol fee collector (it is the block's coinbase), so the
    //    burn share and the validator share are both moved *out* of it here.
    if (fees > 0n) {
      const burned = (fees * this.burnBps) / BPS;
      const toValidators = fees - burned;
      deltas.push({ address: SYSTEM.feeCollectorAddress, amount: -fees, reason: 'fee-collection' });
      if (burned > 0n) {
        this._burn(burned);
        events.push({ type: 'burn', reason: 'fee-burn', amount: burned });
        this._record({ type: 'burn', reason: 'fee-burn', amount: burned });
      }
      if (toValidators > 0n) {
        // Fees are pooled in the validator reward module and released by the
        // distribution step, so that the split is stake-proportional.
        deltas.push({ address: SYSTEM.validatorPoolAddress, amount: toValidators, reason: 'fee-revenue' });
        events.push({ type: 'transfer', reason: 'fee-revenue', amount: toValidators });
        this._record({ type: 'transfer', reason: 'fee-revenue', amount: toValidators });
      }
      this.state.totals.feeRevenue += fees;
      this.state.totals.feesBurned += burned;
      this.state.totals.feesToValidators += toValidators;
    }

    // 2. Block subsidy: minted from the *unissued* portion of the validator
    //    pool, bounded by both the pool balance and the hard cap.
    const pool = this.state.pools.validator;
    let subsidy = 0n;
    if (pool) {
      subsidy = this.blockSubsidy < pool.remaining ? this.blockSubsidy : pool.remaining;
      if (subsidy > 0n) {
        const room = this.maxSupply - this.state.minted;
        if (subsidy > room) subsidy = room;
      }
      if (subsidy > 0n) {
        this._mint(subsidy);
        pool.issued += subsidy;
        pool.remaining -= subsidy;
        deltas.push({ address: SYSTEM.validatorPoolAddress, amount: subsidy, reason: 'block-subsidy' });
        events.push({ type: 'mint', reason: 'block-subsidy', amount: subsidy });
        this._record({ type: 'mint', reason: 'block-subsidy', amount: subsidy });
      }
    }

    // 3. Vesting releases for genesis-locked allocations.
    for (const [key, cfg] of Object.entries(this.allocations)) {
      if (cfg.issuance !== 'genesis-locked' || key === 'community') continue;
      const amount = this._vestingRelease(key, cfg, height);
      if (amount > 0n) {
        const total = this.state.locked[vestingModuleKey(key)];
        const released = amount > total ? total : amount;
        if (released > 0n) {
          deltas.push({ address: SYSTEM.vestingAddress, amount: -released, reason: `vesting-release:${key}` });
          deltas.push({
            address: this.treasuryRecipientFor(key),
            amount: released,
            reason: `vesting-release:${key}`,
          });
          this.state.locked[vestingModuleKey(key)] = total - released;
          this.state.released[key] = (this.state.released[key] ?? 0n) + released;
          events.push({ type: 'unlock', reason: `vesting:${key}`, amount: released });
          this._record({ type: 'unlock', reason: `vesting:${key}`, amount: released });
        }
      }
    }

    // 4. Approved community participation rewards, paid from the community
    //    module balance and bounded by the per-round budget.
    //    A claim is paid in full or deferred to the next round: partial payment
    //    would need a debt ledger, and deferral keeps the accounting exact.
    const deferred = [];
    const paid = [];
    for (const claim of communityClaims) {
      const mod = this.state.pools.community;
      const round = this._round(height);
      if (this.state.communityRound.index !== round) {
        this.state.communityRound = { index: round, spent: 0n, claims: 0 };
      }
      const budgetRoom = this.roundBudget - this.state.communityRound.spent;
      const poolRoom = this._moduleBalance(SYSTEM.communityPoolAddress, deltas);
      const pay = claim.amount;
      if (pay <= 0n || pay > budgetRoom || pay > poolRoom) {
        const reason = pay > budgetRoom ? 'community-budget-exhausted' : 'community-pool-empty';
        events.push({ type: 'defer', reason, id: claim.id, amount: pay });
        this._record({ type: 'defer', reason, id: claim.id });
        deferred.push({ id: claim.id, reason, amount: pay.toString() });
        continue;
      }
      deltas.push({ address: SYSTEM.communityPoolAddress, amount: -pay, reason: 'community-reward' });
      deltas.push({ address: claim.to, amount: pay, reason: 'community-reward' });
      this.state.communityRound.spent += pay;
      this.state.communityRound.claims += 1;
      this.state.pools.community.issued = (this.state.pools.community.issued ?? 0n);
      this.state.totals.communityRewards += pay;
      if (mod) mod.remaining = poolRoom - pay > 0n ? poolRoom - pay : 0n;
      paid.push(claim.id);
      events.push({ type: 'payout', reason: 'community-reward', id: claim.id, to: claim.to, amount: pay });
      this._record({ type: 'payout', reason: 'community-reward', id: claim.id, to: claim.to, amount: pay });
    }

    return { deltas, events, deferred, paid };
  }

  /** Locked allocations pay into a per-allocation module account. */
  treasuryRecipientFor(key) {
    // 0xF5..0010 + index range keeps these addresses deterministic.
    const idx = Object.keys(this.allocations).indexOf(key);
    const hex = (0xf570_0010 + idx * 0x100).toString(16).padStart(40, '0');
    return '0x' + hex;
  }

  /** Linear release with an optional cliff, measured in blocks. */
  _vestingRelease(key, cfg, height) {
    const total = this.state.pools[key].allocation;
    if (total === 0n) return 0n;
    if (!cfg.vestingBlocks || cfg.vestingBlocks <= 0) return 0n;
    const cliff = cfg.cliffBlocks ?? 0;
    if (height < cliff) return 0n;
    const denom = BigInt(cfg.vestingBlocks) * 10n ** 18n;
    const due = (total * BigInt(Math.max(0, height)) * 10n ** 18n) / denom;
    const already = this.state.released[key] ?? 0n;
    const amount = due > already ? due - already : 0n;
    const cap = total - already;
    return amount > cap ? cap : amount;
  }

  _round(height) {
    return Math.floor(height / this.roundBlocks);
  }

  /** Balance of a module account as it will look after `deltas` are applied. */
  _moduleBalance(address, deltas) {
    // Keys are stored lower-cased; a mixed-case lookup would silently read as
    // zero and make a community payout pay nothing.
    const current = this._moduleBalances.get(String(address).toLowerCase()) ?? 0n;
    let value = current;
    const target = String(address).toLowerCase();
    for (const d of deltas) if (String(d.address).toLowerCase() === target) value += d.amount;
    return value;
  }

  /** Chain feeds module balances back in so pool spending stays bounded. */
  syncModuleBalances(map) {
    this._moduleBalances = map;
  }

  // ------------------------------------------------------------- mint / burn

  _mint(amount) {
    const next = this.state.minted + amount;
    if (next > this.maxSupply) throw new SupplyCapExceeded(this.state.minted, amount, this.maxSupply);
    this.state.minted = next;
  }

  _burn(amount) {
    if (amount > this.state.minted - this.state.burned) {
      throw new Error(`cannot burn ${amount}: only ${this.state.minted - this.state.burned} is issued`);
    }
    this.state.burned += amount;
  }

  _record(event) {
    this.state.eventCount += 1;
    this.state.eventRoot = hashObject({
      prev: this.state.eventRoot,
      n: this.state.eventCount,
      ...event,
      amount: event.amount !== undefined ? event.amount.toString() : undefined,
    });
  }

  // ------------------------------------------------------------- reporting

  /** Supply numbers for the public dashboard (docs/SUPPLY.md). */
  supplyReport(balancesByAddress) {
    const issued = this.state.minted;
    const circulatingFloor = issued - this.totalLocked();
    const pools = {};
    for (const [key, p] of Object.entries(this.state.pools)) {
      pools[key] = {
        label: p.label,
        allocation: p.allocation.toString(),
        issued: p.issued.toString(),
        remaining: p.remaining.toString(),
        mode: p.mode,
        locked: (this.state.locked[vestingModuleKey(key)] ?? 0n).toString(),
      };
    }
    return {
      appVersion: this.state.appVersion,
      maxSupply: this.maxSupply.toString(),
      totalIssued: issued.toString(),
      burned: this.state.burned.toString(),
      unissued: (this.maxSupply - issued).toString(),
      locked: this.totalLocked().toString(),
      circulatingDefinition: 'totalIssued - balances held by protocol module accounts (vesting + reward pools)',
      circulatingLowerBound: circulatingFloor.toString(),
      pools,
      totals: mapValues(this.state.totals, (v) => v.toString()),
      communityRound: {
        index: this.state.communityRound.index,
        spent: this.state.communityRound.spent.toString(),
        claims: this.state.communityRound.claims,
        budget: this.roundBudget.toString(),
      },
      height: this.state.height,
      eventCount: this.state.eventCount,
      eventRoot: '0x' + Buffer.from(this.state.eventRoot).toString('hex'),
      onchainBalanceSum: balancesByAddress !== undefined ? sumBigint(balancesByAddress) : undefined,
    };
  }

  totalLocked() {
    let total = 0n;
    for (const v of Object.values(this.state.locked)) total += v;
    return total;
  }

  /** Hash contributed to the block appHash. */
  commitment() {
    return hashObject(this.serialize());
  }

  serialize() {
    return {
      appVersion: this.state.appVersion,
      height: this.state.height,
      minted: this.state.minted.toString(),
      burned: this.state.burned.toString(),
      pools: mapValues2(this.state.pools),
      locked: mapValues(this.state.locked, (v) => v.toString()),
      released: mapValues(this.state.released, (v) => v.toString()),
      communityRound: {
        index: this.state.communityRound.index,
        spent: this.state.communityRound.spent.toString(),
        claims: this.state.communityRound.claims,
      },
      totals: mapValues(this.state.totals, (v) => v.toString()),
      eventCount: this.state.eventCount,
      eventRoot: '0x' + Buffer.from(this.state.eventRoot).toString('hex'),
    };
  }

  static fromSerialized(obj, params) {
    const l = new Ledger(params);
    l.state = {
      ...obj,
      minted: BigInt(obj.minted),
      burned: BigInt(obj.burned),
      pools: Object.fromEntries(
        Object.entries(obj.pools).map(([k, p]) => [k, { ...p, allocation: BigInt(p.allocation), issued: BigInt(p.issued), remaining: BigInt(p.remaining) }])
      ),
      locked: mapValues(obj.locked, (v) => BigInt(v)),
      released: mapValues(obj.released ?? {}, (v) => BigInt(v)),
      communityRound: { index: obj.communityRound.index, spent: BigInt(obj.communityRound.spent), claims: obj.communityRound.claims },
      totals: mapValues(obj.totals, (v) => BigInt(v)),
      eventRoot: Uint8Array.from(Buffer.from(obj.eventRoot.slice(2), 'hex')),
    };
    l._genesisApplied = true;
    return l;
  }

  /**
   * Conservation check performed after every block. `sumBalances` must equal
   * minted - burned; anything else means a state transition created or
   * destroyed coin outside the ledger.
   */
  assertConservation(sumBalances) {
    const expected = this.state.minted - this.state.burned;
    if (sumBalances !== expected) {
      throw new Error(
        `supply conservation violated: on-chain balances=${sumBalances} ledger(minted-burned)=${expected}`
      );
    }
    if (this.state.minted > this.maxSupply) {
      throw new SupplyCapExceeded(this.state.minted, 0n, this.maxSupply);
    }
    return true;
  }
}

function mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = fn(v);
  return out;
}

function mapValues2(obj) {
  return mapValues(obj, (v) => ({
    label: v.label,
    allocation: v.allocation.toString(),
    issued: v.issued.toString(),
    remaining: v.remaining.toString(),
    mode: v.mode,
  }));
}

function sumBigint(map) {
  let total = 0n;
  for (const v of map.values()) total += v;
  return total.toString();
}

module.exports = { Ledger, shareFromBps, vestingModuleKey };
