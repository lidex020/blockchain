#!/usr/bin/env node
'use strict';
/**
 * Full Stop node.
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
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { ethers } = require('ethers');

const { Chain, defaultParams } = require('./chain');
const { Consensus } = require('./consensus');
const { P2P } = require('./p2p');
const { RpcServer, handle, hex } = require('./rpc');
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
      'mainnet startup is disabled: the current custom consensus implementation is testnet-only and has not been replaced by a production consensus engine'
    );
  }
}

function loadConfig(args) {
  const genesisPath = args.genesis ?? process.env.FULLSTOP_GENESIS;
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
    supplyAuditEvery: process.env.FULLSTOP_AUDIT ? 1 : 0,
    consensusTimeouts: {
      proposeBaseMs: Number(args['propose-timeout'] ?? 1200),
      voteBaseMs: Number(args['vote-timeout'] ?? 900),
    },
  };
  return { genesis, genesisPath, datadir, key, params, args };
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
  constructor({ genesis, datadir, key, params, args }) {
    this.genesis = genesis;
    this.datadir = datadir;
    this.key = key;
    this.params = params;
    this.args = args;
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
    this.rpcRateLimit = Number(this.args['rpc-rate-limit'] ?? process.env.FULLSTOP_RPC_RATE_LIMIT ?? PROTOCOL.rpcRateLimit);
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
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '12mb' }));

    app.get('/health', (req, res) =>
      res.json({
        ok: true,
        height: this.chain.head.height,
        target: this.p2p.highestPeerHeight(),
        syncing: this.isSyncing(),
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        version: VERSION.software,
      })
    );

    app.get('/metrics', (req, res) => {
      const c = this.chain;
      const st = c.status();
      const supply = c.supplyReport();
      const lines = [
        '# TYPE fullstop_height gauge',
        `fullstop_height ${st.height}`,
        '# TYPE fullstop_peer_count gauge',
        `fullstop_peer_count ${this.peerCount()}`,
        '# TYPE fullstop_validators gauge',
        `fullstop_validators ${st.validators}`,
        '# TYPE fullstop_mempool_size gauge',
        `fullstop_mempool_size ${st.mempool.total}`,
        '# TYPE fullstop_rpc_requests_total counter',
        `fullstop_rpc_requests_total ${this.metrics.rpcCalls}`,
        '# TYPE fullstop_rpc_errors_total counter',
        `fullstop_rpc_errors_total ${this.metrics.rpcErrors}`,
        '# TYPE fullstop_p2p_messages_total counter',
        `fullstop_p2p_messages_total ${this.metrics.p2pMessages}`,
        '# TYPE fullstop_blocks_applied_total counter',
        `fullstop_blocks_applied_total ${this.metrics.blocksApplied}`,
        '# TYPE fullstop_supply_issued_wei gauge',
        `fullstop_supply_issued_wei ${supply.totalIssued}`,
        '# TYPE fullstop_supply_burned_wei gauge',
        `fullstop_supply_burned_wei ${supply.burned}`,
        '# TYPE fullstop_supply_max_wei gauge',
        `fullstop_supply_max_wei ${supply.maxSupply}`,
        '# TYPE fullstop_power gauge',
        `fullstop_power ${this.consensus?.status?.().totalPower ?? 0}`,
        '# TYPE fullstop_consensus_round gauge',
        `fullstop_consensus_round ${this.consensus?.round ?? 0}`,
      ];
      res.type('text/plain').send(lines.join('\n') + '\n');
    });

    // ---- JSON-RPC --------------------------------------------------------
    app.post('/', async (req, res) => {
      const verdict = this.rateLimit(req);
      if (!verdict.allowed) {
        return res.status(429).json({ jsonrpc: '2.0', error: { code: -32005, message: `rate limited: ${verdict.retryAfterMs}ms` }, id: req.body?.id ?? null });
      }
      this.metrics.rpcCalls += 1;
      const response = await handle(this.rpc, req.body, { ip: req.ip });
      if (response?.error) this.metrics.rpcErrors += 1;
      if (response === null) return res.status(204).end();
      res.json(response);
    });

    // ---- peer endpoints --------------------------------------------------
    app.get('/p2p/status', (req, res) => res.json(this.p2p.statusPayload()));
    app.post('/p2p/broadcast', async (req, res) => {
      this.metrics.p2pMessages += 1;
      const result = await this.p2p.handleBroadcast(req.body);
      res.json(result ?? { ok: true });
    });
    app.get('/p2p/blocks', (req, res) => {
      const from = Math.max(0, Number(req.query.from ?? 0));
      const limit = Math.min(200, Number(req.query.limit ?? 50));
      const out = [];
      for (let h = from; h < from + limit; h++) {
        const block = this.chain.blocks.get(h);
        if (!block) break;
        out.push(block.toJSON());
      }
      res.json(out);
    });
    app.get('/p2p/block/:height', (req, res) => {
      const block = this.chain.blocks.get(Number(req.params.height));
      if (!block) return res.status(404).json({ error: 'unknown height' });
      res.json(block.toJSON());
    });
    app.get('/p2p/receipts/:height', (req, res) => {
      res.json(this.chain.receiptsByHeight.get(Number(req.params.height)) ?? []);
    });
    app.get('/p2p/mempool', (req, res) => res.json(this.chain.pool.contents()));

    // ---- explorer / app --------------------------------------------------
    const webDir = path.resolve(__dirname, '..', 'web');
    app.get('/', (req, res) => res.sendFile(path.join(webDir, 'index.html')));
    app.get('/network.json', (req, res) =>
      res.json({
        chainName: CHAIN.displayName,
        chainId: String(this.chain.chainId),
        networkId: Number(this.chain.chainId),
        rpcUrl: `${req.protocol}://${req.get('host')}`,
        wsUrl: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`,
        // shaped for wallet_addEthereumChain: `symbol` is the field a wallet reads
        currency: { name: COIN.name, symbol: COIN.ticker, decimals: COIN.decimals },
        explorerUrl: `${req.protocol}://${req.get('host')}/`,
        contracts: this.chain.genesis.system_contracts ?? {},
        faucet: this.genesis.faucet ?? { enabled: false },
        // read from the running chain, not from the compiled-in default, so a
        // network that raised its fee floor at genesis reports the right number
        minGasPrice: BigInt(this.chain.params.minGasPrice ?? FEES.minGasPrice).toString(),
      })
    );
    app.get('/contract-abis.json', (req, res, next) => {
      let compiled;
      try {
        compiled = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'artifacts', 'contracts.json'), 'utf8'));
      } catch (err) {
        return next(err);
      }

      const names = ['FullStopERC20Factory', 'FullStopERC721Factory', 'FullStopERC1155Factory'];
      const abis = {};
      for (const name of names) {
        const abi = compiled.artifacts?.[name]?.abi;
        if (!Array.isArray(abi)) return next(new Error(`compiled ABI missing for ${name}`));
        abis[name] = abi;
      }
      res.json({ abis });
    });
    app.use(express.static(webDir, { index: false }));

    app.use((err, req, res, next) => {
      log.error('http error', { err: err.message, path: req.path });
      res.status(500).json({ error: err.message });
    });

    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws' });
    this.attachWebSocket(wss);
    return server;
  }

  attachWebSocket(wss) {
    wss.on('connection', (socket) => {
      this.metrics.wsPeers += 1;
      socket.isAlive = true;
      socket.on('pong', () => (socket.isAlive = true));
      const subs = new Set();
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'fullstop.subscribeStatus', params: { chainId: String(this.chain.chainId), height: this.chain.head.height } }));
      socket.on('message', async (buf) => {
        let msg;
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          return socket.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }));
        }
        if (msg.method === 'eth_subscribe') {
          const id = '0x' + (++this._subId ?? 1).toString(16);
          this._subId = this._subId ?? 1;
          subs.add(id);
          this.subs ??= new Map();
          this.subs.set(id, { socket, type: msg.params?.[0], address: msg.params?.[1]?.address, topics: msg.params?.[1]?.topics });
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: id }));
          return;
        }
        if (msg.method === 'eth_unsubscribe') {
          this.subs?.delete(msg.params?.[0]);
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: true }));
          return;
        }
        const response = await handle(this.rpc, { ...msg, method: msg.method });
        socket.send(JSON.stringify(response ?? { jsonrpc: '2.0', id: msg.id ?? null, result: null }));
      });
      socket.on('close', () => {
        for (const [id, sub] of this.subs ?? []) if (sub.socket === socket) this.subs.delete(id);
      });
      this.chain.onCommitted((block) => {
        for (const [id, sub] of this.subs ?? []) {
          if (sub.socket.readyState !== 1) continue;
          if (sub.type === 'newHeads') {
            sub.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: id, result: { number: hex(block.height), hash: block.hash, parentHash: block.header.parentHash, timestamp: hex(Math.floor(block.header.time / 1000)), gasUsed: hex(BigInt(block.header.gasUsed)), gasLimit: hex(BigInt(block.header.gasLimit)), miner: SYSTEM.feeCollectorAddress, extraData: block.header.appHash, stateRoot: block.header.stateRoot } } }));
          }
          if (sub.type === 'logs') {
            for (const r of this.chain.receiptsByHeight.get(block.height) ?? []) {
              for (const log of r.logs) {
                if (sub.address && normalizeAddr(sub.address) !== normalizeAddr(log.address)) continue;
                sub.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: id, result: log } }));
              }
            }
          }
        }
      });
    });
    const ping = setInterval(() => {
      for (const socket of wss.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30000);
    if (ping.unref) ping.unref();
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
        'Full Stop node',
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

module.exports = { Node, loadConfig, parseArgs, assertSupportedNetwork };
