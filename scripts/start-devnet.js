#!/usr/bin/env node
'use strict';
/**
 * Start a local Full Stop devnet: N validator nodes plus a non-validating RPC
 * node, all in one command, with genesis created if it does not exist.
 *
 *   node scripts/start-devnet.js --validators 4 --explorer-port 7300
 *
 * Each node is a separate OS process with its own data directory, so this is a
 * genuine multi-node network (real gossip, real block verification, real
 * recovery on restart) rather than an in-process simulation.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { main: initDevnet } = require('./init-devnet.js');

const ROOT = path.resolve(__dirname, '..');
const NODE_BIN = process.execPath;
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    [
      'Start a local Full Stop devnet: N validator processes + 1 RPC node.',
      '',
      '  node scripts/start-devnet.js [--validators 4] [--out data/devnet]',
      '                              [--base-port 7301] [--reset] [--help]',
      '',
      '  --validators <n>   validator processes to run (the genesis must have been',
      '                     generated with the same count: scripts/init-devnet.js)',
      '  --out <dir>        directory holding genesis.json, keys/ and nodes/',
      '  --base-port <p>    validators take p..p+n-1, the RPC node takes p+n',
      '  --reset            delete the per-node data directories first, so the run',
      '                     starts at block 1 instead of replaying an old log',
      '',
      'Genesis is generated on first run. Ctrl-C stops every node.',
      '',
    ].join('\n')
  );
  process.exit(0);
}

async function main() {
  const validatorCount = Number(arg('validators', '4'));
  const outDir = path.resolve(arg('out', path.join(ROOT, 'data', 'devnet')));
  const basePort = Number(arg('base-port', '7301'));
  const genesisPath = path.join(outDir, 'genesis.json');

  if (!fs.existsSync(genesisPath)) {
    process.stdout.write(`no genesis at ${genesisPath} - generating a ${validatorCount}-validator devnet\n`);
    await initDevnet();
  }
  const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf8'));
  const validators = genesis.validators ?? [];
  if (!Number.isInteger(basePort) || basePort < 1 || basePort + validators.length > 65535) {
    throw new Error(`invalid base port ${basePort}: ${validators.length} validators and the RPC node must fit in ports 1-65535`);
  }
  const ports = Array.from({ length: validators.length + 1 }, (_, i) => basePort + i);
  const occupied = [];
  for (const port of ports) {
    if (!(await isPortAvailable(port))) occupied.push(port);
  }
  if (occupied.length) {
    throw new Error(`devnet port${occupied.length === 1 ? '' : 's'} already in use: ${occupied.join(', ')}. A devnet may already be running; check it before starting another. No node data was changed.`);
  }
  const keyFiles = validators.map((_, i) => path.join(outDir, 'keys', `v${i + 1}.json`));
  const missingKey = keyFiles.find((file) => !fs.existsSync(file));
  if (missingKey) throw new Error(`missing validator key ${missingKey}; re-run with a fresh --out directory`);

  // Each node replays its own block log on start. Replaying a log written by an
  // older build is a hard error by design, so offer the escape hatch here rather
  // than letting the operator read a stack trace.
  const nodesDir = path.join(outDir, 'nodes');
  const existing = fs.existsSync(nodesDir) ? fs.readdirSync(nodesDir).filter((n) => fs.existsSync(path.join(nodesDir, n, 'chain', 'blocks.jsonl'))) : [];
  if (process.argv.includes('--reset')) {
    if (fs.existsSync(nodesDir)) fs.rmSync(nodesDir, { recursive: true, force: true });
    process.stdout.write(`cleared ${nodesDir}${existing.length ? ` (${existing.length} node data dirs)` : ''}\n`);
  } else if (existing.length) {
    process.stdout.write(`reusing existing chain data for ${existing.join(', ')} - pass --reset to start from block 1\n`);
  }

  const procs = [];
  let shuttingDown = false;
  let failureExitCode = 0;
  const shutdownAll = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const p of procs) {
      try {
        p.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('SIGINT', shutdownAll);
  process.on('SIGTERM', shutdownAll);
  const handleUnexpectedExit = (name, code, signal) => {
    if (shuttingDown) return;
    failureExitCode = 1;
    process.stderr.write(`[${name}] stopped unexpectedly (code ${code}, signal ${signal}); stopping the remaining devnet nodes\n`);
    shutdownAll();
  };

  const peerUrls = [];
  for (let i = 0; i < validators.length; i++) peerUrls.push(`http://127.0.0.1:${basePort + i}`);

  for (let i = 0; i < validators.length; i++) {
    const port = basePort + i;
    const keyFile = path.join(outDir, 'keys', `v${i + 1}.json`);
    const args = [
      path.join(ROOT, 'src', 'node.js'),
      '--genesis', genesisPath,
      '--datadir', path.join(outDir, 'nodes', `v${i + 1}`),
      '--port', String(port),
      '--key', keyFile,
      '--moniker', `validator-${i + 1}`,
      '--peers', peerUrls.filter((_, j) => j !== i).join(','),
    ];
    const name = `v${i + 1}`;
    procs.push({ name, child: launch(args, name, (code, signal) => handleUnexpectedExit(name, code, signal)) });
  }

  // one non-validating RPC/archive node, which is what the explorer and dapps
  // talk to in this layout
  const rpcPort = basePort + validators.length;
  const rpcName = 'rpc';
  procs.push({
    name: 'rpc',
    child: launch(
      [
        path.join(ROOT, 'src', 'node.js'),
        '--genesis', genesisPath,
        '--datadir', path.join(outDir, 'nodes', 'rpc'),
        '--port', String(rpcPort),
        '--moniker', 'rpc-node',
        '--peers', peerUrls.join(','),
        // The faucet lives on the endpoint dapps and the explorer actually talk
        // to, and only there: two processes signing from one key would race on
        // the nonce and silently drop one another's claims.
        '--faucet-key', path.join(outDir, 'keys', 'faucet.json'),
      ],
      rpcName,
      (code, signal) => handleUnexpectedExit(rpcName, code, signal)
    ),
  });

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  process.stdout.write(`Starting Full Stop devnet; waiting for RPC health at ${rpcUrl}/health\n`);
  try {
    await waitForRpc(rpcPort, procs);
  } catch (err) {
    if (shuttingDown) {
      await waitForChildren(procs);
      return;
    }
    failureExitCode = 1;
    shutdownAll();
    await waitForChildren(procs);
    throw err;
  }
  process.stdout.write(
    [
      '',
      `Full Stop devnet started: ${validators.length} validators + 1 RPC node`,
      `  chain id     ${genesis.chain_id}`,
      `  rpc          ${rpcUrl}   (JSON-RPC + websocket at /ws)`,
      `  explorer     ${rpcUrl}/  (block explorer, supply dashboard, asset creator)`,
      `  health       ${rpcUrl}/health`,
      `  metrics      ${rpcUrl}/metrics`,
      '',
      'press Ctrl-C to stop every node',
      '',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(path.join(outDir, 'network.json'), JSON.stringify({ rpcUrl, chainId: genesis.chain_id, ports: { rpc: rpcPort, validators: peerUrls } }, null, 2));

  // keep this process alive while the nodes run
  await new Promise((resolve) => {
    const check = setInterval(() => {
      const alive = procs.filter((p) => p.child.exitCode === null && p.child.signalCode === null).length;
      if (alive === 0) {
        clearInterval(check);
        process.exitCode = failureExitCode;
        resolve();
      }
    }, 1000);
  });
}

function isPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else reject(err);
    });
    server.listen(port, '0.0.0.0', () => {
      server.close((err) => {
        if (err) reject(err);
        else resolve(true);
      });
    });
  });
}

async function waitForRpc(port, procs) {
  const startedAt = Date.now();
  let lastError = 'RPC endpoint is not listening yet';
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    const exited = procs.find((p) => p.child.exitCode !== null || p.child.signalCode !== null);
    if (exited) throw new Error(`${exited.name} exited before devnet startup completed`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) {
        lastError = `health endpoint returned HTTP ${response.status}`;
      } else {
        const health = await response.json();
        if (health.ok) return health;
        lastError = 'health endpoint reported the node as unhealthy';
      }
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`RPC node on port ${port} did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s (${lastError})`);
}

function waitForChildren(procs) {
  if (procs.every((p) => p.child.exitCode !== null || p.child.signalCode !== null)) return Promise.resolve();
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (procs.every((p) => p.child.exitCode !== null || p.child.signalCode !== null)) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}

function launch(args, name, onUnexpectedExit) {
  const child = spawn(NODE_BIN, args, { cwd: ROOT, env: { ...process.env, FULLSTOP_NODE_NAME: name } });
  const prefix = `[${name.padEnd(3)}]`;
  const pipe = (stream, target) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stdout);
  child.on('error', (err) => {
    process.stderr.write(`${prefix} could not start: ${err.message}\n`);
    onUnexpectedExit(1, null);
  });
  child.on('exit', (code, signal) => {
    process.stdout.write(`${prefix} exited with code ${code}\n`);
    onUnexpectedExit(code, signal);
  });
  return child;
}

main().catch((err) => {
  console.error('devnet failed:', err);
  process.exit(1);
});
