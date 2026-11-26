'use strict';
/**
 * HTTP/JSON-RPC/WebSocket/explorer server shared by the custom-consensus
 * node (src/node.js) and the CometBFT ABCI application process
 * (src/abci/serve.js). Both modes serve the exact same EVM RPC surface from
 * the same Chain instance; they differ only in who produces blocks:
 *   - node.js: the built-in FSC consensus engine + P2P gossip (devnet/testnet
 *     custom path, exposes /p2p/* peer endpoints);
 *   - serve.js: CometBFT owns consensus and P2P, this server exposes only the
 *     public RPC/WS/explorer surface (exposeP2p=false, /p2p/* returns 404).
 *
 * The `host` object must provide: chain, rpc, genesis, publicUrls, metrics,
 * startedAt, peerCount(), isSyncing(), syncStart, syncTarget, p2p (nullable),
 * consensus (nullable), rateLimit(req), exposeP2p (boolean).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { handle, hex } = require('./rpc');
const { createLogger } = require('./logger');
const { COIN, SYSTEM, CHAIN, FEES, VERSION } = require('./constants');

const log = createLogger('http');

function normalizeAddr(a) {
  return String(a).toLowerCase();
}

function createHttpServer(host) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(cors());
  app.use(express.json({ limit: '12mb' }));

  app.get('/health', (req, res) =>
    res.json({
      ok: true,
      height: host.chain.head.height,
      target: host.p2p ? host.p2p.highestPeerHeight() : host.chain.head.height,
      syncing: host.isSyncing(),
      uptimeSeconds: Math.round((Date.now() - host.startedAt) / 1000),
      version: VERSION.software,
    })
  );

  app.get('/metrics', (req, res) => {
    const c = host.chain;
    const st = c.status();
    const supply = c.supplyReport();
    const lines = [
      '# TYPE lidex_height gauge',
      `lidex_height ${st.height}`,
      '# TYPE lidex_peer_count gauge',
      `lidex_peer_count ${host.peerCount()}`,
      '# TYPE lidex_validators gauge',
      `lidex_validators ${st.validators}`,
      '# TYPE lidex_mempool_size gauge',
      `lidex_mempool_size ${st.mempool.total}`,
      '# TYPE lidex_rpc_requests_total counter',
      `lidex_rpc_requests_total ${host.metrics.rpcCalls}`,
      '# TYPE lidex_rpc_errors_total counter',
      `lidex_rpc_errors_total ${host.metrics.rpcErrors}`,
      '# TYPE lidex_p2p_messages_total counter',
      `lidex_p2p_messages_total ${host.metrics.p2pMessages}`,
      '# TYPE lidex_blocks_applied_total counter',
      `lidex_blocks_applied_total ${host.metrics.blocksApplied}`,
      '# TYPE lidex_supply_issued_wei gauge',
      `lidex_supply_issued_wei ${supply.totalIssued}`,
      '# TYPE lidex_supply_burned_wei gauge',
      `lidex_supply_burned_wei ${supply.burned}`,
      '# TYPE lidex_supply_max_wei gauge',
      `lidex_supply_max_wei ${supply.maxSupply}`,
      '# TYPE lidex_power gauge',
      `lidex_power ${host.consensus?.status?.().totalPower ?? 0}`,
      '# TYPE lidex_consensus_round gauge',
      `lidex_consensus_round ${host.consensus?.round ?? 0}`,
    ];
    res.type('text/plain').send(lines.join('\n') + '\n');
  });

  // ---- JSON-RPC --------------------------------------------------------
  app.post('/', async (req, res) => {
    const verdict = host.rateLimit(req);
    if (!verdict.allowed) {
      return res.status(429).json({ jsonrpc: '2.0', error: { code: -32005, message: `rate limited: ${verdict.retryAfterMs}ms` }, id: req.body?.id ?? null });
    }
    host.metrics.rpcCalls += 1;
    const response = await handle(host.rpc, req.body, { ip: req.ip });
    if (response?.error) host.metrics.rpcErrors += 1;
    if (response === null) return res.status(204).end();
    res.json(response);
  });

  // ---- peer endpoints --------------------------------------------------
  // Only the custom-consensus node exposes these. In CometBFT mode consensus
  // and P2P live in the CometBFT process, so the LIDEX process must not
  // serve peer routes at all (defense in depth: the public gateway blocks
  // them too).
  if (host.exposeP2p) {
  app.get('/p2p/status', (req, res) => res.json(host.p2p.statusPayload()));
  app.post('/p2p/broadcast', async (req, res) => {
    host.metrics.p2pMessages += 1;
    const result = await host.p2p.handleBroadcast(req.body);
    res.json(result ?? { ok: true });
  });
  app.get('/p2p/blocks', (req, res) => {
    const from = Math.max(0, Number(req.query.from ?? 0));
    const limit = Math.min(200, Number(req.query.limit ?? 50));
    const out = [];
    for (let h = from; h < from + limit; h++) {
      const block = host.chain.blocks.get(h);
      if (!block) break;
      out.push(block.toJSON());
    }
    res.json(out);
  });
  app.get('/p2p/block/:height', (req, res) => {
    const block = host.chain.blocks.get(Number(req.params.height));
    if (!block) return res.status(404).json({ error: 'unknown height' });
    res.json(block.toJSON());
  });
  app.get('/p2p/receipts/:height', (req, res) => {
    res.json(host.chain.receiptsByHeight.get(Number(req.params.height)) ?? []);
  });
  app.get('/p2p/mempool', (req, res) => res.json(host.chain.pool.contents()));
  } else {
    app.use('/p2p', (req, res) => res.status(404).json({ error: 'peer endpoints are not served by this process' }));
  }

  // ---- explorer / app --------------------------------------------------
  const webDir = path.resolve(__dirname, '..', 'web');
  app.get('/', (req, res) => res.sendFile(path.join(webDir, 'index.html')));
  app.get('/network.json', (req, res) =>
    res.json({
      chainName: CHAIN.displayName,
      chainId: String(host.chain.chainId),
      networkId: Number(host.chain.chainId),
      rpcUrl: host.publicUrls.rpc ?? `${req.protocol}://${req.get('host')}`,
      wsUrl: host.publicUrls.ws ?? `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`,
      // shaped for wallet_addEthereumChain: `symbol` is the field a wallet reads
      currency: { name: COIN.name, symbol: COIN.ticker, decimals: COIN.decimals },
      explorerUrl: host.publicUrls.explorer ?? `${req.protocol}://${req.get('host')}/`,
      contracts: host.chain.genesis.system_contracts ?? {},
      faucet: host.genesis.faucet ?? { enabled: false },
      // read from the running chain, not from the compiled-in default, so a
      // network that raised its fee floor at genesis reports the right number
      minGasPrice: BigInt(host.chain.params.minGasPrice ?? FEES.minGasPrice).toString(),
    })
  );
  app.get('/contract-abis.json', (req, res, next) => {
    let compiled;
    try {
      compiled = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'artifacts', 'contracts.json'), 'utf8'));
    } catch (err) {
      return next(err);
    }

    const names = ['LidexERC20Factory', 'LidexERC721Factory', 'LidexERC1155Factory'];
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
  attachWebSocket(host, wss);
  return server;
}

function attachWebSocket(host, wss) {  wss.on('connection', (socket) => {
    host.metrics.wsPeers += 1;
    socket.isAlive = true;
    socket.on('pong', () => (socket.isAlive = true));
    const subs = new Set();
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'lidex.subscribeStatus', params: { chainId: String(host.chain.chainId), height: host.chain.head.height } }));
    socket.on('message', async (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return socket.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }));
      }
      if (msg.method === 'eth_subscribe') {
        const id = '0x' + (++host._subId ?? 1).toString(16);
        host._subId = host._subId ?? 1;
        subs.add(id);
        host.subs ??= new Map();
        host.subs.set(id, { socket, type: msg.params?.[0], address: msg.params?.[1]?.address, topics: msg.params?.[1]?.topics });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: id }));
        return;
      }
      if (msg.method === 'eth_unsubscribe') {
        host.subs?.delete(msg.params?.[0]);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: true }));
        return;
      }
      const response = await handle(host.rpc, { ...msg, method: msg.method });
      socket.send(JSON.stringify(response ?? { jsonrpc: '2.0', id: msg.id ?? null, result: null }));
    });
    socket.on('close', () => {
      for (const [id, sub] of host.subs ?? []) if (sub.socket === socket) host.subs.delete(id);
    });
    host.chain.onCommitted((block) => {
      for (const [id, sub] of host.subs ?? []) {
        if (sub.socket.readyState !== 1) continue;
        if (sub.type === 'newHeads') {
          sub.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: id, result: { number: hex(block.height), hash: block.hash, parentHash: block.header.parentHash, timestamp: hex(Math.floor(block.header.time / 1000)), gasUsed: hex(BigInt(block.header.gasUsed)), gasLimit: hex(BigInt(block.header.gasLimit)), miner: SYSTEM.feeCollectorAddress, extraData: block.header.appHash, stateRoot: block.header.stateRoot } } }));
        }
        if (sub.type === 'logs') {
          for (const r of host.chain.receiptsByHeight.get(block.height) ?? []) {
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

module.exports = { createHttpServer, attachWebSocket };
