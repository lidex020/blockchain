'use strict';
/**
 * Full Stop Blockchain - protocol constants.
 *
 * These values are the single source of truth for the consensus-critical
 * parameters of the network. Anything that validators must agree on lives
 * here (or in the genesis file) and is versioned in the spec document.
 *
 * See docs/SPEC.md for the rationale behind each value.
 */

const CHAIN = {
  name: 'fullstop',
  displayName: 'Full Stop Blockchain',
  /** EIP-155 chain id (decimal). Mainnet candidate. */
  chainId: 72122n,
  /** Human readable network identifiers used by wallets. */
  networkId: 72122,
  slip44: 721,
  /** Testnet chain id used by the public/independent test network. */
  testnetChainId: 721220,
};

const COIN = {
  name: 'Full Stop Coin',
  ticker: 'FSTOP',
  /** 18 decimals - matches the EVM native-currency convention. */
  decimals: 18,
  /** Smallest unit name (wei analogue). */
  smallestUnit: 'stops',
  /** One FSTOP expressed in `stops`. */
  unit: 10n ** 18n,
  /**
   * PROPOSED hard maximum supply. Enforced by the protocol ledger
   * (src/ledger.js); no protocol pathway may mint past this number.
   */
  maxSupply: 100_000_000n * 10n ** 18n,
  /**
   * Genesis allocators must sum to `initialIssuance`; the remainder of the
   * cap stays unissued and is only released through the reward pipeline.
   */
  initialIssuance: 75_000_000n * 10n ** 18n,
};

const BLOCK = {
  /** Target block interval (ms). Engineering target: 1-2 seconds. */
  targetBlockTimeMs: 1500,
  /** Blocks may not be produced faster than this (anti-drift guard). */
  minBlockIntervalMs: 400,
  /** Total gas allowed in a single block. */
  blockGasLimit: 150_000_000n,
  /** Gas limit for the system (end-of-block) transition itself. */
  systemGasReserve: 0n,
  /** Maximum number of transactions packed into one block. */
  maxBlockTxs: 3000,
  /** Maximum accepted RLP size of a single transaction in bytes. */
  maxTxBytes: 128 * 1024,
};

const FEES = {
  /** Protocol floor for gas price, in wei per gas (1 gwei). */
  minGasPrice: 1_000_000_000n,
  /**
   * Fraction of the collected transaction fee that is permanently burned,
   * expressed in basis points (5000 = 50%).
   */
  burnBps: 5000n,
  /** Fraction of the collected fee paid to the validator set (50%). */
  validatorFeeBps: 5000n,
  /**
   * Fraction of the collected fee kept by the block proposer as an
   * anti-withholding incentive (0%). Fees are pooled and split by stake.
   */
  proposerTipBps: 0n,
  /** Default gas price advertised over eth_gasPrice (1 gwei). */
  suggestedGasPrice: 1_000_000_000n,
  /** Per-transaction byte fee surcharge for large calldata (blob-free chain). */
  maxPriorityFee: 0n,
};

const REWARDS = {
  /** Fixed block subsidy, denominated in whole FSTOP units (0.1 FSTOP). */
  blockSubsidy: 10n ** 17n,
  /**
   * Validator security & rewards pool: 25% of max supply, minted block by
   * block and never in excess of the pool balance. When the pool is empty
   * the network continues on fee revenue alone.
   */
  poolShareBps: 2500n,
  /** Reward distribution cadence, in blocks. */
  distributionInterval: 1,
  /** Blocks a jailed validator must wait before it can unjail itself. */
  jailDurationBlocks: 64,
  /** Slashing fraction for a proven double-sign, in basis points (20%). */
  doubleSignSlashBps: 2000n,
  /** Slashing fraction for downtime, in basis points (1%). */
  downtimeSlashBps: 100n,
  /** Consecutive missed blocks before a validator is considered offline. */
  downtimeWindow: 50,
  /** Basis-point denominator used across the protocol. */
  bpsDenominator: 10_000n,
};

const STAKING = {
  /** Minimum self-bond required to activate a validator (FSTOP units). */
  minSelfStake: 100n * COIN.unit,
  /** Minimum delegation amount. */
  minDelegation: 1n * COIN.unit,
  /** Unbonding period measured in blocks (~2.5 minutes on the devnet). */
  unbondingBlocks: 100,
  /** Maximum commission a validator may charge delegators (bps, 50%). */
  maxCommissionBps: 5000n,
  /** Default commission (bps, 10%). */
  defaultCommissionBps: 1000n,
  /** Cap on the number of active validators in the set. */
  maxActiveValidators: 64,
  /** Power units per staked FSTOP. */
  powerPerCoin: 1n,
};

const ALLOCATIONS = {
  /**
   * Proposed initial allocation model (docs/TOKENOMICS.md).
   *
   * `issuance`:
   *   - 'genesis-locked' -> minted into a vesting module at genesis,
   *     released by the protocol on the schedule below.
   *   - 'protocol-pool'  -> NOT issued at genesis; released block by block
   *     through the reward pipeline (still inside the hard cap).
   */
  community: { label: 'Community participation and contributions', shareBps: 3500n, issuance: 'genesis-locked', vestingBlocks: 0, cliffBlocks: 0 },
  validator: { label: 'Validator security and rewards', shareBps: 2500n, issuance: 'protocol-pool', vestingBlocks: 0, cliffBlocks: 0 },
  developers: { label: 'Developers and ecosystem development', shareBps: 1500n, issuance: 'genesis-locked', vestingBlocks: 2_102_400, cliffBlocks: 1_051_200 },
  foundation: { label: 'Foundation and network operations', shareBps: 1000n, issuance: 'genesis-locked', vestingBlocks: 2_102_400, cliffBlocks: 525_600 },
  partnerships: { label: 'Partnerships and ecosystem reserve', shareBps: 1500n, issuance: 'genesis-locked', vestingBlocks: 3_153_600, cliffBlocks: 1_051_200 },
};

const COMMUNITY = {
  /** Blocks per reward round (~1 day at 1.5s blocks). */
  roundBlocks: 57_600,
  /** Maximum FSTOP a single round may pay out. */
  roundBudget: 100n * COIN.unit,
  /** Maximum a single contributor address may claim per round. */
  maxPerAddressPerRound: 25n * COIN.unit,
  /** Number of reviewers required to approve a claim. */
  approvalQuorum: 2,
};

const SYSTEM = {
  /**
   * Protocol-controlled module addresses. These hold pool balances and
   * vesting schedules. They have no private key: their balances move only
   * through protocol rules executed by every validator.
   */
  moduleAddress: '0x00000000000000000000000000000000F5700001',
  communityPoolAddress: '0x00000000000000000000000000000000F5700002',
  validatorPoolAddress: '0x00000000000000000000000000000000F5700003',
  vestingAddress: '0x00000000000000000000000000000000F5700004',
  feeCollectorAddress: '0x00000000000000000000000000000000F5700005',
  /**
   * The provably-unspendable address users may send coin to when they want a
   * *user-initiated* destruction. It is not how the protocol burns fees: the
   * fee burn and the slash burn are reductions of the supply ledger
   * (src/ledger.js `_burn`), not transfers, so no balance ever moves here.
   * Nothing in the consensus path references this constant.
   */
  burnAddress: '0x000000000000000000000000000000000000dEaD',
  /**
   * Reserved for a future precompiled asset factory. The shipped asset-creation
   * path is the set of contracts deployed by the genesis transactions and named
   * in `genesis.system_contracts` (`asset_registry`, `erc20_factory`,
   * `erc721_factory`, `erc1155_factory`); no code reads this address, and it is
   * listed here only so the reserved range is documented in one place.
   */
  assetFactoryAddress: '0x00000000000000000000000000000000F5AC0001',
  /** Reserved prefix marking protocol-controlled addresses. */
  reservedPrefix: '0x00000000000000000000000000000000f5',
};

const POOL = {
  /** EVM-compatible hardfork baseline used by the execution layer. */
  hardfork: 'shanghai',
  /** Chain-level feature flags (all documented in docs/COMPATIBILITY.md). */
  features: {
    eip1559: true,
    eip2930: true,
    eip4844: false,
    eip7702: false,
    withdrawals: false,
    blobs: false,
  },
};

const GAS = {
  /** Intrinsic gas of a value transfer. */
  transferGas: 21_000n,
  /** Maximum gas a single user transaction may request. */
  maxTxGasLimit: 60_000_000n,
  /** Gas refunded to the block's fee pool per byte of zero calldata (kept 0: no calldata discount). */
  calldataGasPerZeroByte: 4n,
  calldataGasPerNonZeroByte: 16n,
};

/** Chain-level limits for the protocol (non-EVM) subsystems. */
const PROTOCOL = {
  /** Maximum transactions accepted in the mempool per account. */
  maxPendingPerAccount: 64,
  /** Maximum size of the mempool. */
  maxPoolSize: 20_000,
  /** Mempool expiry in milliseconds. */
  poolTtlMs: 15 * 60 * 1000,
  /** Maximum blocks served in one RPC range query. */
  maxRangeQuery: 1000,
  /** RPC rate limit, requests per window, per client. */
  rpcRateLimit: 1200,
  rpcRateWindowMs: 60 * 1000,
};

const VERSION = {
  protocol: '0.1.0',
  software: 'fullstop-node/0.1.0',
  /** Application hash / state machine version, bumped on breaking changes. */
  appVersion: '1',
};

module.exports = {
  CHAIN,
  COIN,
  BLOCK,
  FEES,
  REWARDS,
  STAKING,
  ALLOCATIONS,
  COMMUNITY,
  SYSTEM,
  POOL,
  GAS,
  PROTOCOL,
  VERSION,
};
