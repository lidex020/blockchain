#!/usr/bin/env node
'use strict';
/**
 * LIDEX CometBFT ABCI application process.
 *
 * One process hosts the ABCI socket application (execution + journal) and,
 * when --rpc-port is given, the public EVM surface (JSON-RPC, WebSocket,
 * explorer, /health, /metrics, /network.json) served from the same Chain
 * instance. CometBFT owns consensus, block production and P2P; this process
 * never runs the custom consensus engine and never serves /p2p/* routes.
 *
 * Transaction flow for EVM RPC submissions: eth_sendRawTransaction admits
 * the transaction to the LIDEX mempool and forwards it to the local
 * CometBFT RPC (broadcast_tx_sync, loopback only). CometBFT then runs
 * CheckTx, proposes the transaction, and this app executes it in
 * FinalizeBlock. The LIDEX mempool entry is only a local admission record;
 * inclusion is decided by CometBFT.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const { Chain } = require('../chain');
const { loadGenesis, toExecutionGenesis } = require('../genesis');
const { loadConfig, parseArgs } = require('../node');
const { RpcServer } = require('../rpc');
const { createHttpServer } = require('../http');
const { Faucet } = require('../faucet');
const { readKey } = require('../keys');
const { createLogger } = require('../logger');
const { COIN, PROTOCOL } = require('../constants');
const { ABCIApplication } = require('./application');
const { ABCISocketServer } = require('./socket-server');

const log = createLogger('abci-serve');

const DATA_MARKER = '.lidex-comet-abci.json';

function assertNoSecrets(value, location = 'mapping file') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/private|secret|seed|priv_key/i.test(key)) throw new Error(`${location} must not contain secret material`);
    assertNoSecrets(nested, `${location}.${key}`);
  }
}

function loadValidatorMappings(file) {
  if (!file) throw new Error('--validator-map <public-key-mapping.json> is required');
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  assertNoSecrets(raw);
  if (raw.schema !== 'lidex-comet-validator-map-v1' || !Array.isArray(raw.validators)) {
    throw new Error('validator mapping file must use lidex-comet-validator-map-v1 and contain a validators array');
  }
  return raw.validators;
}

function resolveProfileArgs(args) {
  if (!args.profile) return { args, profileNetwork: null };
  const profilePath = path.resolve(args.profile);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const allowedFields = new Set(['schema', 'network', 'genesis', 'validatorMap', 'datadir', 'listen']);
  const unknownFields = Object.keys(profile ?? {}).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) throw new Error(`unknown ABCI profile fields: ${unknownFields.join(', ')}`);
  if (profile.schema !== 'lidex-abci-profile-v1' || !['devnet', 'testnet', 'mainnet'].includes(profile.network)) {
    throw new Error('ABCI profiles must use lidex-abci-profile-v1 and explicitly select devnet, testnet, or mainnet');
  }
  for (const field of ['genesis', 'validatorMap', 'datadir', 'listen']) {
    if (typeof profile[field] !== 'string' || profile[field].length === 0) {
      throw new Error(`ABCI devnet/testnet profile requires a non-empty ${field}`);
    }
  }
  const resolveProfilePath = (value) => path.resolve(path.dirname(profilePath), value);
  return {
    args: {
      ...args,
      genesis: args.genesis ?? resolveProfilePath(profile.genesis),
      'validator-map': args['validator-map'] ?? resolveProfilePath(profile.validatorMap),
      datadir: args.datadir ?? resolveProfilePath(profile.datadir),
      listen: args.listen ?? profile.listen,
    },
    profileNetwork: profile.network,
  };
}

function prepareDedicatedDataDir(datadir, genesis) {
  const root = path.resolve(datadir);
  const marker = path.join(root, DATA_MARKER);
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(marker)) {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (
      saved.schema !== 'lidex-comet-abci-data-v1' ||
      saved.chainId !== String(genesis.chain_id) ||
      saved.genesisHash !== ethers.hexlify(require('../genesis').genesisHash(genesis)) ||
      saved.network !== genesis.network
    ) {
      throw new Error('ABCI data directory marker does not match this genesis; preserve the directory and inspect it separately');
    }
    return root;
  }
  const entries = fs.readdirSync(root);
  if (entries.length) {
    throw new Error('ABCI requires a new dedicated data directory; existing unmarked data is never adopted, overwritten, or reset');
  }
  const content = {
    schema: 'lidex-comet-abci-data-v1',
    chainId: String(genesis.chain_id),
    genesisHash: ethers.hexlify(require('../genesis').genesisHash(genesis)),
    network: genesis.network,
  };
  fs.writeFileSync(marker, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
  return root;
}

async function createCometApplication(args) {
  const resolved = resolveProfileArgs(args);
  args = resolved.args;
  if (!args.genesis || !args.datadir) throw new Error('--genesis and a new dedicated --datadir are required');
  const genesisPath = path.resolve(args.genesis);
  const genesis = loadGenesis(genesisPath);
  if (resolved.profileNetwork && genesis.network !== resolved.profileNetwork) {
    throw new Error(`ABCI profile network ${resolved.profileNetwork} does not match genesis network ${genesis.network}`);
  }
  if (genesis.network !== 'devnet' && genesis.network !== 'testnet' && genesis.network !== 'mainnet') {
    throw new Error('CometBFT ABCI bootstrap only accepts explicit devnet/testnet/mainnet genesis files');
  }
  const validatorMappings = loadValidatorMappings(args['validator-map']);
  const datadir = prepareDedicatedDataDir(args.datadir, genesis);
  const config = loadConfig({ ...args, genesis: genesisPath, datadir });
  let chain;
  try {
    chain = await Chain.create({
      genesis: toExecutionGenesis(config.genesis),
      datadir: config.datadir,
      params: config.params,
      mode: 'full',
    });
    const app = await ABCIApplication.create({
      chain,
      network: genesis.network,
      validatorMappings,
      stateFile: path.join(datadir, 'abci', 'blocks.jsonl'),
    });
    return { app, chain, genesis, args, config };
  } catch (error) {
    chain?.store?.releaseLock?.();
    throw error;
  }
}

/**
 * Forward a raw transaction to the local CometBFT RPC mempool. CometBFT RPC
 * is loopback-only by configuration; this is the bridge that makes EVM RPC
 * submissions reach consensus. Failures are logged, never thrown: the
 * transaction is already admitted to the local mempool, and a down CometBFT
 * RPC is an operator-visible misconfiguration, not a reason to fail the
 * RPC request after admission.
 */
async function broadcastToComet(cometRpcUrl, rawTx, fetchImpl = fetch) {
  const base = String(cometRpcUrl).replace(/\/$/, '');
  const txBase64 = Buffer.from(String(rawTx).replace(/^0x/i, ''), 'hex').toString('base64');
  const response = await fetchImpl(`${base}/broadcast_tx_sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'broadcast_tx_sync', params: { tx: txBase64 } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`CometBFT broadcast_tx_sync returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error(`CometBFT broadcast_tx_sync failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body?.result ?? null;
}

/**
 * Host adapter exposing the ABCI-driven Chain through the shared HTTP server
 * (src/http.js). CometBFT owns P2P and consensus, so peer endpoints are
 * disabled and peer/sync metrics report the local head.
 */
function createCometRpcHost({ chain, genesis, publicUrls, rpcRateLimit }) {
  const host = {
    chain,
    genesis,
    publicUrls: publicUrls ?? { rpc: null, ws: null, explorer: null },
    metrics: { rpcCalls: 0, rpcErrors: 0, p2pMessages: 0, wsPeers: 0, blocksApplied: 0 },
    startedAt: Date.now(),
    p2p: null,
    consensus: null,
    exposeP2p: false,
    faucet: null,
    rpcRateLimit: Number(rpcRateLimit ?? PROTOCOL.rpcRateLimit),
    rateCounters: new Map(),
    peerCount() {
      return 0;
    },
    isSyncing() {
      return false;
    },
    syncStart: 0,
    syncTarget: 0,
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
    },
  };
  host.rpc = new RpcServer({ chain, consensus: null, node: host });
  return host;
}

async function startCometRpc({ chain, genesis, app, args, config }) {
  const host = createCometRpcHost({
    chain,
    genesis,
    publicUrls: config.publicUrls,
    rpcRateLimit: args['rpc-rate-limit'] ?? process.env.LIDEX_RPC_RATE_LIMIT,
  });

  if (genesis.faucet?.enabled && args['faucet-key']) {
    host.faucet = new Faucet({
      chain,
      key: readKey(path.resolve(args['faucet-key'])),
      amount: BigInt(genesis.faucet.amount ?? 10n * COIN.unit),
      cooldownMs: Number(genesis.faucet.cooldown_ms ?? 6 * 60 * 60 * 1000),
      budgetPerEpoch: BigInt(genesis.faucet.budget ?? 0n) || undefined,
    });
  }

  const cometRpcUrl = args['comet-rpc-url'] ?? process.env.LIDEX_COMET_RPC_URL ?? 'http://127.0.0.1:26657';
  chain.pool.onAccepted = (raw) => {
    broadcastToComet(cometRpcUrl, raw).catch((error) => {
      log.warn('CometBFT mempool bridge failed; transaction is admitted locally but may not be proposed', {
        err: error.message,
      });
    });
  };
  chain.onCommitted(() => {
    host.metrics.blocksApplied += 1;
  });

  const server = createHttpServer(host);
  const port = Number(args['rpc-port']);
  const rpcHost = args['rpc-host'] ?? '127.0.0.1';
  await new Promise((resolve) => server.listen(port, rpcHost, resolve));
  log.info('ABCI RPC listening', { host: rpcHost, port, chainId: String(chain.chainId), height: app.height });
  const heartbeat = setInterval(() => chain.pool.expire(), 5000);
  if (heartbeat.unref) heartbeat.unref();
  return {
    host,
    server,
    async close() {
      clearInterval(heartbeat);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      [
        'LIDEX CometBFT ABCI application',
        '',
        '  --profile <file>        ABCI profile (lidex-abci-profile-v1)',
        '  --genesis <file>        LIDEX genesis document',
        '  --validator-map <file>  public CometBFT validator mapping (lidex-comet-validator-map-v1)',
        '  --datadir <dir>         new dedicated ABCI data directory',
        '  --listen <addr>         ABCI socket (default tcp://127.0.0.1:26658, loopback only)',
        '  --rpc-port <n>          serve EVM JSON-RPC/WS/explorer on this port',
        '  --rpc-host <host>       RPC bind host (default 127.0.0.1; use 0.0.0.0 only inside containers)',
        '  --comet-rpc-url <url>   local CometBFT RPC for the mempool bridge (default http://127.0.0.1:26657)',
        '  --faucet-key <file>     enable the testnet faucet with this key',
        '  --rpc-rate-limit <n>    JSON-RPC requests per minute per client',
        '',
      ].join('\n')
    );
    return;
  }
  const { app, chain, genesis, args: resolvedArgs, config } = await createCometApplication(args);
  const server = new ABCISocketServer({
    application: app,
    listen: args.listen ?? process.env.LIDEX_ABCI_LISTEN ?? resolvedArgs.listen ?? 'tcp://127.0.0.1:26658',
  });
  let rpc = null;
  try {
    const address = await server.start();
    process.stdout.write(`LIDEX ABCI++ ${genesis.network} app listening on ${address.address}:${address.port}\n`);
    if (args['rpc-port']) {
      rpc = await startCometRpc({ chain, genesis, app, args, config });
      process.stdout.write(`LIDEX ABCI++ ${genesis.network} RPC listening on port ${args['rpc-port']}\n`);
    }
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await rpc?.close();
    await server.close();
    chain.store?.releaseLock?.();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`LIDEX ABCI++ startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createCometApplication, loadValidatorMappings, prepareDedicatedDataDir, resolveProfileArgs, createCometRpcHost, startCometRpc, broadcastToComet };
