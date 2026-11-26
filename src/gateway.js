#!/usr/bin/env node
'use strict';
/**
 * LIDEX public API gateway.
 *
 * The single process allowed to face the public internet for a LIDEX network.
 * It binds a loopback/private address, forwards ONLY the public surface to
 * one backend node, and fails closed for everything else:
 *
 *   allowed:  POST / (JSON-RPC), GET /network.json, GET /health,
 *             WebSocket upgrade on /ws, OPTIONS preflight on /
 *   denied:   /p2p/*, /metrics, and every other path/method (403/404)
 *
 * Backend node ports (which combine RPC with peer endpoints), CometBFT
 * ports, validator ports and signer ports are never exposed through this
 * process. Nginx (deploy/nginx/lidex.conf) fronts this gateway on 443;
 * the gateway itself speaks plain HTTP on a private address.
 *
 * Usage:
 *   node src/gateway.js --backend http://127.0.0.1:72131 --port 7302 \
 *     --host 127.0.0.1 --network testnet \
 *     --cors-origin https://testnet.lidex.tech
 */

const http = require('node:http');
const { URL } = require('node:url');
const { createLogger } = require('./logger');

const log = createLogger('gateway');

const ALLOWED_GET = new Set(['/network.json', '/health']);
const BLOCKED_PREFIXES = ['/p2p', '/metrics'];

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

function parseCorsOrigins(args) {
  const origins = [];
  const raw = args['cors-origin'];
  if (raw) origins.push(...String(raw).split(',').map((s) => s.trim()).filter(Boolean));
  if (process.env.LIDEX_CORS_ORIGINS) {
    origins.push(...process.env.LIDEX_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return [...new Set(origins)];
}

function isBlockedPath(pathname) {
  return BLOCKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function createGateway({ backend, corsOrigins = [], rateLimitPerMinute = 1200, maxBodyBytes = 12 * 1024 * 1024 }) {
  const backendUrl = new URL(backend);
  if (!['http:', 'https:'].includes(backendUrl.protocol)) throw new Error('--backend must be an http(s) URL');
  const counters = new Map();

  function rateLimit(ip) {
    const now = Date.now();
    const entry = counters.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60_000;
    }
    entry.count += 1;
    counters.set(ip, entry);
    return entry.count <= rateLimitPerMinute;
  }

  function corsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      return true;
    }
    return false;
  }

  function proxyHttp(req, res) {
    const target = new URL(req.url, backendUrl);
    const headers = { ...req.headers, host: backendUrl.host, 'x-forwarded-proto': 'http', 'x-forwarded-for': req.socket.remoteAddress ?? '' };
    delete headers['content-length'];
    const upstream = http.request(
      {
        protocol: backendUrl.protocol,
        hostname: backendUrl.hostname,
        port: backendUrl.port,
        path: target.pathname + target.search,
        method: req.method,
        headers,
        timeout: 30_000,
      },
      (upstreamRes) => {
        // The backend sends a permissive CORS header; the gateway is the
        // authority on cross-origin policy, so replace it.
        const responseHeaders = { ...upstreamRes.headers };
        delete responseHeaders['access-control-allow-origin'];
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', (error) => {
      log.warn('backend proxy failed', { err: error.message, path: req.url });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'backend unavailable' }));
    });
    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const pathname = url.pathname;

    if (isBlockedPath(pathname)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    const corsOk = corsHeaders(req, res);

    if (req.method === 'OPTIONS' && pathname === '/') {
      if (corsOk) {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const isRpc = req.method === 'POST' && pathname === '/';
    const isGet = req.method === 'GET' && ALLOWED_GET.has(pathname);
    if (!isRpc && !isGet) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    if (!rateLimit(req.socket.remoteAddress ?? 'unknown')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32005, message: 'rate limited' }, id: null }));
      return;
    }

    if (isRpc) {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'request too large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        // The body is buffered so the gateway can enforce a size cap before
        // proxying; proxyBuffered forwards the exact bytes to the backend.
        proxyBuffered(req, res, Buffer.concat(chunks));
      });
      return;
    }

    proxyHttp(req, res);
  });

  function proxyBuffered(req, res, body) {
    const headers = { ...req.headers, host: backendUrl.host, 'x-forwarded-proto': 'http', 'x-forwarded-for': req.socket.remoteAddress ?? '' };
    headers['content-length'] = String(body.length);
    const upstream = http.request(
      {
        protocol: backendUrl.protocol,
        hostname: backendUrl.hostname,
        port: backendUrl.port,
        path: '/',
        method: 'POST',
        headers,
        timeout: 30_000,
      },
      (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        delete responseHeaders['access-control-allow-origin'];
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', (error) => {
      log.warn('backend proxy failed', { err: error.message, path: '/' });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'backend unavailable' }));
    });
    upstream.end(body);
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !corsOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = http.request({
      protocol: backendUrl.protocol,
      hostname: backendUrl.hostname,
      port: backendUrl.port,
      path: '/ws',
      method: 'GET',
      headers: { ...req.headers, host: backendUrl.host },
    });
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        socket.write(`${key}: ${value}\r\n`);
      }
      socket.write('\r\n');
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });

  return { server, backendUrl };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      [
        'LIDEX public API gateway',
        '',
        '  --backend <url>        backend node URL (required, private address)',
        '  --port <n>             listen port (required)',
        '  --host <host>          listen host (default 127.0.0.1)',
        '  --network <name>       network label for logs (testnet|mainnet|devnet)',
        '  --cors-origin <origin> allowed browser origin (repeatable, comma-separated)',
        '  --rate-limit <n>       requests per minute per client (default 1200)',
        '',
      ].join('\n')
    );
    return;
  }
  if (!args.backend || !args.port) throw new Error('--backend and --port are required');
  const { server } = createGateway({
    backend: args.backend,
    corsOrigins: parseCorsOrigins(args),
    rateLimitPerMinute: Number(args['rate-limit'] ?? 1200),
  });
  const host = args.host ?? '127.0.0.1';
  await new Promise((resolve) => server.listen(Number(args.port), host, resolve));
  process.stdout.write(
    `LIDEX gateway (${args.network ?? 'network'}) listening on ${host}:${args.port} -> ${args.backend}\n`
  );
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`LIDEX gateway failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createGateway, parseArgs, parseCorsOrigins, isBlockedPath };
