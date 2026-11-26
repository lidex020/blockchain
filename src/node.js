#!/usr/bin/env node
'use strict';
/**
 * Lidex node.
 *
 * One process, three faces:
 *   - the consensus engine (only when a validator key is supplied),
 *   - the JSON-RPC + WebSocket endpoint wallets and dapps talk to,
 *   - the peer-to-peer endpoint other nodes gossip through,
 * plus the static block explorer / asset app served from ./web.
 *
 * Usage:
 *   node src/node.js --genesis data/devnet/genesis.json --port 72131 \
 *        --key data/devnet/validators/v1.json --peers http://127.0.0.1:72132
 *
 * Without --key the node runs as a non-validating full node: it verifies and
 * stores every block by re-executing it, and serves reads.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { Chain, defaultParams } = require('./chain');
const { Consensus } = require('./consensus');
const { P2P } = require('./p2p');
const { RpcServer } = require('./rpc');
const { createHttpServer, attachWebSocket } = require('./http');
const { Faucet } = require('./faucet');
const { loadGenesis, toExecutionGenesis } = require('./genesis');
const { readKey, toIdentity } = require('./keys');
const { MessageType } = require('./block');
const { createLogger } = require('./logger');
const { COIN, SYSTEM, PROTOCOL, VERSION, CHAIN, FEES, BLOCK } = require('./constants');

const log = createLogger('node');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function assertSupportedNetwork(genesis) {
  if (genesis.network === 'mainnet') {
    throw new Error(
      'Mainnet must be started via the CometBFT ABCI application (src/abci/serve.js), ' +
        'not the custom-consensus node. Use: node src/abci/serve.js --genesis <mainnet-genesis> ' +
        '--validator-map <validator-map.json> --datadir <dedicated-dir>'
    );
  }
}

function loadPublicUrls(env = process.env, network = null) {
  const load = (name, protocol, pathname) => {
    const value = env[name];
    if (value === undefined || value === '') return null;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be an absolute ${protocol}// URL`);
    }
    if (
      url.protocol !== protocol ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== pathname ||
      url.search ||
      url.hash
    ) {
      throw new Error(`${name} must be an absolute ${protocol}// URL with path ${pathname}`);
    }
    return `${url.origin}${pathname === '/' ? '' : pathname}`;
  };
  const urls = {
    rpc: load('LIDEX_PUBLIC_RPC_URL', 'https:', '/'),
    ws: load('LIDEX_PUBLIC_WS_URL', 'wss:', '/ws'),
    explorer: load('LIDEX_EXPLORER_URL', 'https:', '/'),
  };
  if (network === 'devnet' && Object.values(urls).some(Boolean)) {
    throw new Error('devnet must not advertise production public endpoint URLs');
  }
  const expectedHosts = network === 'mainnet'
    ? { rpc: 'rpc.lidex.tech', ws: 'ws.lidex.tech', explorer: 'explorer.lidex.tech' }
    : network === 'testnet'
      ? { rpc: 'testnet-rpc.lidex.tech', ws: 'testnet-rpc.lidex.tech', explorer: 'testnet.lidex.tech' }
      : null;
  if (expectedHosts) {
    for (const [service, expectedHost] of Object.entries(expectedHosts)) {
      if (urls[service] && new URL(urls[service]).hostname !== expectedHost) {
        throw new Error(`${service} public URL does not belong to the configured ${network} domain`);
      }
    }
  }
  return urls;
}

function loadConfig(args) {
  const genesisPath = args.genesis ?? process.env.LIDEX_GENESIS;
  if (!genesisPath) throw new Error('--genesis <file> is required (see scripts/init-devnet.js to create one)');
  const genesis = loadGenesis(genesisPath);
  assertSupportedNetwork(genesis);
  const datadir = args.datadir ?? path.join(path.dirname(genesisPath), 'nodes', args.port ? `p${args.port}` : 'default');
  fs.mkdirSync(datadir, { recursive: true });

  let key = null;
  if (args.key) key = toIdentity(readKey(path.resolve(args.key)));

  const params = {
    ...defaultParams(),
    chainId: genesis.chain_id,
    hardfork: genesis.protocol.hardfork,
    blockGasLimit: BigInt(genesis.protocol.block_gas_limit),
    // Pacing is a genesis value, so it belongs in the parameter set a client
    // reads back: without it fs_params.consensus reported null block times.
    blockTimeMs: Number(genesis.consensus?.block_time_ms ?? BLOCK.targetBlockTimeMs),
    minBlockIntervalMs: Number(genesis.consensus?.min_block_interval_ms ?? BLOCK.minBlockIntervalMs),
    maxBlockTxs: genesis.protocol.max_block_txs,
    minGasPrice: BigInt(genesis.protocol.min_gas_price),
    suggestedGasPrice: BigInt(args['gas-price'] ?? genesis.protocol.min_gas_price),
    feeCollector: SYSTEM.feeCollectorAddress,
    maxSupply: BigInt(genesis.protocol.max_supply),
    initialIssuance: BigInt(genesis.protocol.initial_issuance),
    blockSubsidy: BigInt(genesis.protocol.block_subsidy),
    burnBps: BigInt(genesis.protocol.burn_bps),
    validatorFeeBps: BigInt(genesis.protocol.validator_fee_bps),
    communityRoundBudget: BigInt(genesis.protocol.community.round_budget),
    communityRoundBlocks: genesis.protocol.community.round_blocks,
    maxPerAddressPerRound: BigInt(genesis.protocol.community.max_per_address_per_round),
    communityApprovalQuorum: genesis.protocol.community.approval_quorum,
    minSelfStake: BigInt(genesis.protocol.staking.min_self_stake),
    minDelegation: BigInt(genesis.protocol.staking.min_delegation),
    unbondingBlocks: genesis.protocol.staking.unbonding_blocks,
    maxCommissionBps: BigInt(genesis.protocol.staking.max_commission_bps),
    maxActiveValidators: genesis.protocol.staking.max_active_validators,
    rewardDistributionInterval: genesis.protocol.staking.reward_distribution_interval,
    downtimeWindow: genesis.protocol.staking.downtime_window,
    doubleSignSlashBps: BigInt(genesis.protocol.staking.double_sign_slash_bps),
    downtimeSlashBps: BigInt(genesis.protocol.staking.downtime_slash_bps),
    jailDurationBlocks: genesis.protocol.staking.jail_duration_blocks,
    allocations: expandAllocations(genesis.protocol.allocations),
    genesisAlloc: genesis.alloc,
    genesisValidators: genesis.validators,
    reviewers: genesis.reviewers.map((address) => ({ address })),
    minBlockIntervalMs: genesis.consensus.min_block_interval_ms,
    maxClockDriftMs: 15_000,
    supplyAuditEvery: process.env.LIDEX_AUDIT ? 1 : 0,
    consensusTimeouts: {
      proposeBaseMs: Number(args['propose-timeout'] ?? 1200),
      voteBaseMs: Number(args['vote-timeout'] ?? 900),
    },
  };
  return { genesis, genesisPath, datadir, key, params, args, publicUrls: loadPublicUrls(process.env, genesis.network) };
}

function expandAllocations(serialized) {
  const out = {};
  for (const [key, cfg] of Object.entries(serialized)) {
    out[key] = {
      label: cfg.label,
      shareBps: BigInt(cfg.share_bps),
      issuance: cfg.issuance,
      cliffBlocks: cfg.cliff_blocks,
      vestingBlocks: cfg.vesting_blocks,
    };
  }
  return out;
}

/** Default port: 72131, i.e. the chain id with a node suffix. */
const DEFAULT_PORT = 72131;

class Node {
  constructor({ genesis, datadir, key, params, args, publicUrls }) {
    this.genesis = genesis;
    this.datadir = datadir;
    this.key = key;
    this.params = params;
    this.args = args;
    this.publicUrls = publicUrls ?? loadPublicUrls(process.env, genesis.network);
    this.port = Number(this.args.port ?? DEFAULT_PORT);
    this.moniker = this.args.moniker ?? `node-${this.port}`;
    this.nodeId = this.args['node-id'] ?? ethers.hexlify(ethers.randomBytes(8)).slice(2);
    this.startedAt = Date.now();
    this.metrics = { rpcCalls: 0, rpcErrors: 0, p2pMessages: 0, wsPeers: 0, blocksApplied: 0 };
    this.rateCounters = new Map();
    // Per-node policy, not a consensus parameter: two nodes on the same network
    // may serve different clients and therefore set different budgets. The
    // default is the published one; a benchmark or an internal indexer raises
    // it deliberately instead of the node silently dropping honest traffic.
    this.rpcRateLimit = Number(this.args['rpc-rate-limit'] ?? process.env.LIDEX_RPC_RATE_LIMIT ?? PROTOCOL.rpcRateLimit);
  }

  async start() {
    assertSupportedNetwork(this.genesis);
    const execGenesis = toExecutionGenesis(this.genesis);
    this.chain = await Chain.create({
      genesis: execGenesis,
      datadir: this.datadir,
      params: { ...this.params, chainId: this.genesis.chain_id },
      mode: this.key ? 'validator' : 'full',
    });
    this.chain.genesisHash = this.genesis.__hash;

    if (this.key) {
      this.consensus = new Consensus({
        chain: this.chain,
        identity: this.key,
        broadcast: (msg) => this.p2p?.broadcast(msg),
        params: { ...this.params, blockTimeMs: this.genesis.consensus.block_time_ms },
      });
    }

    this.p2p = new P2P({
      chain: this.chain,
      consensus: this.consensus,
      peers: String(this.args.peers ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      port: this.port,
      nodeId: this.nodeId,
      moniker: this.moniker,
    });

    if (this.genesis.faucet?.enabled && this.args['faucet-key']) {
      this.faucet = new Faucet({
        chain: this.chain,
        key: readKey(path.resolve(this.args['faucet-key'])),
        amount: BigInt(this.genesis.faucet.amount ?? 10n * COIN.unit),
        cooldownMs: Number(this.genesis.faucet.cooldown_ms ?? 6 * 60 * 60 * 1000),
        budgetPerEpoch: BigInt(this.genesis.faucet.budget ?? 0n) || undefined,
      });
    }

    // Transaction relay. A transaction arrives at whichever endpoint the user
    // chooses, and only the validators can put it in a block: without this hook
    // a transaction submitted to a non-validating RPC node would sit in that
    // node's pool forever and never be seen by the network. Gossip is
    // single-hop by design here - the RPC node talks to every validator it knows
    // about - and is documented as such in docs/ARCHITECTURE.md.
    this.chain.pool.onAccepted = (raw) => {
      this.p2p?.broadcast({ type: MessageType.Tx, chainId: String(this.chain.chainId), raw });
    };

    this.rpc = new RpcServer({ chain: this.chain, consensus: this.consensus, node: this });
    this.server = this.buildServer();
    await new Promise((resolve) => this.server.listen(this.port, '0.0.0.0', resolve));
    log.info('node listening', { port: this.port, mode: this.key ? 'validator' : 'full-node', moniker: this.moniker });
    this.p2p.start();
    if (this.consensus && !this.args['no-consensus']) this.consensus.start();

    this.chain.onCommitted(() => {
      this.metrics.blocksApplied += 1;
    });

    if (this.args['block-tx'] === undefined && this.args['mine-empty'] === undefined) {
      // keep producing empty blocks so the chain advances: a blockchain that
      // stops when the pool is empty cannot be a base layer.
    }
    this.heartbeat = setInterval(() => {
      this.chain.pool.expire();
      this.p2p?.tick();
    }, 5000);
    if (this.heartbeat.unref) this.heartbeat.unref();
    return this;
  }

  peerCount() {
    return this.p2p?.peerCount() ?? 0;
  }

  peerStatus() {
    return this.p2p?.peerStatus() ?? [];
  }

  isSyncing() {
    return !!this.p2p?.isSyncing();
  }

  get syncStart() {
    return this.p2p?.syncStart ?? 0;
  }

  get syncTarget() {
    return this.p2p?.syncTarget ?? 0;
  }

  buildServer() {
    // The HTTP/RPC/WS/explorer surface lives in src/http.js so the CometBFT
    // ABCI process (src/abci/serve.js) serves the identical surface from the
    // same Chain. This node exposes the custom-consensus peer endpoints.
    this.exposeP2p = true;
    return createHttpServer(this);
  }

  attachWebSocket(wss) {
    return attachWebSocket(this, wss);
  }

  rateLimit(req) {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = this.rateCounters.get(ip) ?? { count: 0, resetAt: now + PROTOCOL.rpcRateWindowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + PROTOCOL.rpcRateWindowMs;
    }
    entry.count += 1;
    this.rateCounters.set(ip, entry);
    if (entry.count > this.rpcRateLimit) return { allowed: false, retryAfterMs: entry.resetAt - now };
    return { allowed: true };
  }

  async stop() {
    this.p2p?.stop();
    this.consensus?.stop();
    clearInterval(this.heartbeat);
    this.chain.store?.flush();
    await new Promise((r) => this.server.close(r));
  }
}

function normalizeAddr(a) {
  return String(a).toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        'Lidex node',
        '',
        '  --genesis <file>      genesis document (required)',
        '  --datadir <dir>       data directory (default: <genesis dir>/nodes/<port>)',
        `  --port <n>            HTTP/WS port (default ${DEFAULT_PORT})`,
        '  --key <file>          validator key; omit to run a full node',
        '  --peers <url,url>     bootstrap peer URLs',
        '  --moniker <name>      peer name',
        '  --faucet-key <file>   enable the testnet faucet with this key',
        '  --no-consensus        verify and serve, but do not vote',
        '  --rpc-rate-limit <n>  JSON-RPC requests per minute per client (default 1200)',
        '',
      ].join('\n')
    );
    return;
  }
  const config = loadConfig(args);
  const node = new Node(config);
  await node.start();

  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    await node.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err: err?.message ?? String(err) }));
}

if (require.main === module) {
  main().catch((err) => {
    log.error('node failed to start', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { Node, loadConfig, parseArgs, assertSupportedNetwork, loadPublicUrls };
