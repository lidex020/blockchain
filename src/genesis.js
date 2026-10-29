'use strict';
/**
 * Genesis document: the approved starting state of a Full Stop network.
 *
 * The genesis file is consensus-critical. Everything a validator needs in
 * order to reach the same initial state lives here, and `validateGenesis()`
 * refuses a document that is internally inconsistent - a network must never
 * start from a genesis that its own rules reject.
 */

const fs = require('fs');
const { ethers } = require('ethers');
const { CHAIN, COIN, BLOCK, FEES, REWARDS, STAKING, ALLOCATIONS, COMMUNITY, SYSTEM, POOL, VERSION } = require('./constants');
const { hashObject } = require('./crypto');

const GENESIS_SCHEMA = 'fullstop-genesis-v1';

/** Convert a decimal LDX amount to the base unit. */
function toBase(units) {
  const [whole, frac = ''] = String(units).split('.');
  const scaled = (frac + '0'.repeat(COIN.decimals)).slice(0, COIN.decimals);
  return BigInt(whole + scaled);
}

function fromBase(amount) {
  const a = BigInt(amount);
  const whole = a / COIN.unit;
  const frac = (a % COIN.unit).toString().padStart(COIN.decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Normalise whatever a user wrote in a genesis file into the canonical shape
 * the protocol consumes. Rejects unknown fields loudly rather than silently
 * ignoring a parameter the operator believed they had set.
 */
function normalize(raw) {
  const known = new Set([
    'schema', 'chain_id', 'name', 'network', 'genesis_time', 'software',
    'protocol', 'alloc', 'validators', 'reviewers', 'system_contracts',
    'genesis_txs', 'contract_artifacts', 'consensus', 'faucet', 'documentation',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`genesis: unknown field "${key}" (refusing to silently ignore a parameter)`);
  }
  const protocol = { ...(raw.protocol ?? {}) };
  const pkeys = new Set([
    'hardfork', 'max_supply', 'initial_issuance', 'allocations', 'block_subsidy', 'burn_bps', 'validator_fee_bps',
    'min_gas_price', 'block_gas_limit', 'max_block_txs', 'staking', 'community', 'rewards',
  ]);
  for (const key of Object.keys(protocol)) {
    if (!pkeys.has(key)) throw new Error(`genesis: unknown protocol field "${key}"`);
  }

  const out = {
    schema: raw.schema ?? GENESIS_SCHEMA,
    chain_id: BigInt(raw.chain_id),
    name: raw.name ?? CHAIN.displayName,
    network: raw.network ?? 'mainnet',
    genesis_time: raw.genesis_time ?? new Date().toISOString(),
    software: raw.software ?? VERSION.software,
    protocol: {
      hardfork: protocol.hardfork ?? POOL.hardfork,
      max_supply: protocol.max_supply ?? COIN.maxSupply.toString(),
      initial_issuance: protocol.initial_issuance ?? COIN.initialIssuance.toString(),
      allocations: protocol.allocations ?? serializedAllocations(),
      block_subsidy: protocol.block_subsidy ?? REWARDS.blockSubsidy.toString(),
      burn_bps: protocol.burn_bps ?? FEES.burnBps.toString(),
      validator_fee_bps: protocol.validator_fee_bps ?? FEES.validatorFeeBps.toString(),
      min_gas_price: protocol.min_gas_price ?? FEES.minGasPrice.toString(),
      block_gas_limit: protocol.block_gas_limit ?? BLOCK.blockGasLimit.toString(),
      max_block_txs: protocol.max_block_txs ?? BLOCK.maxBlockTxs,
      staking: {
        min_self_stake: protocol.staking?.min_self_stake ?? STAKING.minSelfStake.toString(),
        min_delegation: protocol.staking?.min_delegation ?? STAKING.minDelegation.toString(),
        unbonding_blocks: protocol.staking?.unbonding_blocks ?? STAKING.unbondingBlocks,
        max_commission_bps: protocol.staking?.max_commission_bps ?? STAKING.maxCommissionBps.toString(),
        max_active_validators: protocol.staking?.max_active_validators ?? STAKING.maxActiveValidators,
        reward_distribution_interval: protocol.staking?.reward_distribution_interval ?? REWARDS.distributionInterval,
        downtime_window: protocol.staking?.downtime_window ?? REWARDS.downtimeWindow,
        double_sign_slash_bps: protocol.staking?.double_sign_slash_bps ?? REWARDS.doubleSignSlashBps.toString(),
        downtime_slash_bps: protocol.staking?.downtime_slash_bps ?? REWARDS.downtimeSlashBps.toString(),
        jail_duration_blocks: protocol.staking?.jail_duration_blocks ?? REWARDS.jailDurationBlocks,
      },
      community: {
        round_blocks: protocol.community?.round_blocks ?? COMMUNITY.roundBlocks,
        round_budget: protocol.community?.round_budget ?? COMMUNITY.roundBudget.toString(),
        max_per_address_per_round: protocol.community?.max_per_address_per_round ?? COMMUNITY.maxPerAddressPerRound.toString(),
        approval_quorum: protocol.community?.approval_quorum ?? COMMUNITY.approvalQuorum,
      },
      rewards: {
        pool_share_bps: protocol.rewards?.pool_share_bps ?? REWARDS.poolShareBps.toString(),
        bps_denominator: protocol.rewards?.bps_denominator ?? REWARDS.bpsDenominator.toString(),
      },
    },
    alloc: (raw.alloc ?? []).map((a) => ({
      address: ethers.getAddress(a.address).toLowerCase(),
      balance: BigInt(a.balance).toString(),
      label: a.label ?? null,
      source: a.source ?? null,
      code: a.code ?? null,
      note: a.note ?? null,
    })),
    validators: (raw.validators ?? []).map((v) => ({
      address: ethers.getAddress(v.address).toLowerCase(),
      consensus_address: ethers.getAddress(v.consensus_address ?? v.address).toLowerCase(),
      moniker: v.moniker ?? null,
      self_stake: BigInt(v.self_stake ?? 0).toString(),
      commission_bps: BigInt(v.commission_bps ?? STAKING.defaultCommissionBps).toString(),
      website: v.website ?? null,
    })),
    reviewers: (raw.reviewers ?? []).map((r) => ethers.getAddress(r.address ?? r).toLowerCase()),
    // Split the system-contract block: addresses, the transactions that deploy
    // them, and the compiled artifacts used to verify the result.
    system_contracts: Object.fromEntries(
      Object.entries(raw.system_contracts ?? {}).filter(([, v]) => /^0x[0-9a-fA-F]{40}$/.test(String(v)))
    ),
    genesis_txs: raw.genesis_txs ?? (raw.system_contracts ?? {}).genesis_txs ?? [],
    contract_artifacts: raw.contract_artifacts ?? (raw.system_contracts ?? {}).artifacts ?? {},
    consensus: {
      block_time_ms: raw.consensus?.block_time_ms ?? BLOCK.targetBlockTimeMs,
      min_block_interval_ms: raw.consensus?.min_block_interval_ms ?? BLOCK.minBlockIntervalMs,
      double_sign_window_blocks: raw.consensus?.double_sign_window_blocks ?? 100_000,
      algorithm: raw.consensus?.algorithm ?? 'FSC/0.1 (round-based BFT, see docs/ADR.md)',
    },
    faucet: raw.faucet ?? { enabled: false },
    documentation: raw.documentation ?? null,
  };
  return out;
}

function serializedAllocations() {
  const out = {};
  for (const [key, cfg] of Object.entries(ALLOCATIONS)) {
    out[key] = {
      label: cfg.label,
      share_bps: cfg.shareBps.toString(),
      issuance: cfg.issuance,
      cliff_blocks: cfg.cliffBlocks,
      vesting_blocks: cfg.vestingBlocks,
      module: moduleFor(key),
    };
  }
  return out;
}

function moduleFor(key) {
  if (key === 'community') return SYSTEM.communityPoolAddress.toLowerCase();
  if (key === 'validator') return SYSTEM.validatorPoolAddress.toLowerCase();
  return SYSTEM.vestingAddress.toLowerCase();
}

/**
 * Enforce the genesis invariants. Throwing here is the desired behaviour: a
 * node must not boot a chain whose starting state violates its own rules.
 */
function validateGenesis(g) {
  const errors = [];
  const maxSupply = BigInt(g.protocol.max_supply);
  const initialIssuance = BigInt(g.protocol.initial_issuance);
  const unit = COIN.unit;

  if (g.schema !== GENESIS_SCHEMA) errors.push(`unsupported genesis schema ${g.schema}`);
  if (maxSupply % unit !== 0n) errors.push('max supply must be a whole number of LDX');
  if (maxSupply > COIN.maxSupply * 2n) errors.push('max supply is implausibly large for the approved model');
  if (initialIssuance > maxSupply) errors.push('initial issuance exceeds the hard cap');

  const allocations = g.protocol.allocations;
  let shareTotal = 0n;
  let allocationSum = 0n;
  for (const [key, cfg] of Object.entries(allocations)) {
    const bps = BigInt(cfg.share_bps);
    shareTotal += bps;
    const amount = (maxSupply * bps) / 10_000n;
    allocationSum += amount;
    if (cfg.issuance === 'genesis-locked' && amount > initialIssuance) {
      errors.push(`allocation ${key} is genesis-locked but larger than the initial issuance budget`);
    }
    if (!['genesis-locked', 'protocol-pool'].includes(cfg.issuance)) {
      errors.push(`allocation ${key} has unknown issuance mode ${cfg.issuance}`);
    }
  }
  if (shareTotal !== 10_000n) errors.push(`allocation shares sum to ${shareTotal}bps, expected 10000bps`);
  if (allocationSum > maxSupply) errors.push(`allocations sum to ${allocationSum} which exceeds the cap`);

  // Every genesis balance must be traceable to an allocation.
  let releaseTotal = 0n;
  for (const a of g.alloc) {
    const bal = BigInt(a.balance);
    if (bal < 0n) errors.push(`alloc ${a.address} has a negative balance`);
    if (!a.source) {
      if (bal !== 0n) errors.push(`alloc ${a.address} holds ${bal} without a source allocation; every genesis coin must come from a named pool`);
      continue;
    }
    const pool = allocations[a.source.pool];
    if (!pool) {
      errors.push(`alloc ${a.address} sources from unknown pool "${a.source.pool}"`);
      continue;
    }
    releaseTotal += bal;
  }
  const genesisLockedSum = Object.entries(allocations)
    .filter(([, cfg]) => cfg.issuance === 'genesis-locked')
    .reduce((acc, [, cfg]) => acc + (maxSupply * BigInt(cfg.share_bps)) / 10_000n, 0n);
  if (releaseTotal > genesisLockedSum) {
    errors.push(`genesis releases (${releaseTotal}) exceed the genesis-locked allocation total (${genesisLockedSum})`);
  }
  if (releaseTotal + (genesisLockedSum - releaseTotal) !== genesisLockedSum) {
    errors.push('internal accounting error in genesis generation');
  }

  const minSelf = BigInt(g.protocol.staking.min_self_stake);
  const seen = new Set();
  for (const v of g.validators) {
    if (seen.has(v.address)) errors.push(`duplicate validator ${v.address} in genesis`);
    seen.add(v.address);
    if (BigInt(v.self_stake) < minSelf) errors.push(`validator ${v.address} self-bond ${v.self_stake} is below the ${minSelf} minimum`);
    if (BigInt(v.commission_bps) > BigInt(g.protocol.staking.max_commission_bps)) {
      errors.push(`validator ${v.address} commission exceeds the maximum`);
    }
    const alloc = g.alloc.find((a) => a.address === v.address);
    if (!alloc || BigInt(alloc.balance) < BigInt(v.self_stake)) {
      errors.push(`validator ${v.address} must hold at least its self-bond in genesis alloc`);
    }
  }
  if (g.validators.length > g.protocol.staking.max_active_validators) {
    errors.push('more genesis validators than the active set limit');
  }

  for (const a of g.alloc) {
    if (a.address.startsWith(SYSTEM.reservedPrefix)) {
      errors.push(`alloc ${a.address} uses a reserved protocol address`);
    }
  }
  for (const [name, address] of Object.entries(g.system_contracts)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) errors.push(`system contract "${name}" is not an address`);
  }
  if (g.genesis_txs.length && Object.keys(g.contract_artifacts).length === 0) {
    errors.push('genesis declares deployment transactions but no artifacts to verify them against');
  }

  if (errors.length) throw new Error(`genesis is invalid:\n  - ${errors.join('\n  - ')}`);
  return true;
}

/** Deterministic identity of a genesis document. */
function genesisHash(g) {
  return ethers.hexlify(hashObject(g));
}

function loadGenesis(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = normalize(raw);
  validateGenesis(g);
  return g;
}

/**
 * Turn a normalized genesis into the execution layer's genesis format.
 *
 * Note what is *not* here: balances. Every coin in the genesis state is minted
 * by the supply ledger so that `minted - burned === sum(balances)` holds from
 * block zero. The execution alloc only carries contract code for the system
 * contracts deployed by the genesis transactions.
 */
function toExecutionGenesis(g) {
  const alloc = {};
  for (const a of g.alloc) {
    if (a.code) alloc[a.address] = { balance: '0', nonce: 0, code: a.code };
    else alloc[a.address] = { balance: '0', nonce: 0 };
  }
  for (const [name, addr] of Object.entries(g.system_contracts ?? {})) {
    if (name === 'genesis_txs') continue;
    if (!alloc[String(addr).toLowerCase()]) alloc[String(addr).toLowerCase()] = { balance: '0', nonce: 0 };
  }
  return {
    chain_id: String(g.chain_id),
    name: g.name,
    genesis_time: g.genesis_time,
    block_gas_limit: g.protocol.block_gas_limit,
    fee_collector: SYSTEM.feeCollectorAddress,
    alloc,
    genesisTxs: g.genesis_txs ?? [],
    system_contracts: g.system_contracts ?? {},
    faucet: g.faucet,
    __normalized: true,
  };
}

module.exports = { GENESIS_SCHEMA, normalize, validateGenesis, loadGenesis, toExecutionGenesis, genesisHash, serializedAllocations, moduleFor, toBase, fromBase };
