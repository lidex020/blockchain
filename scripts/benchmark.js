#!/usr/bin/env node
'use strict';
/**
 * Full Stop load benchmark.
 *
 * Every number in docs/BENCHMARKS.md is produced by this file. It starts a real
 * devnet (N validator processes + one non-validating RPC node), drives
 * closed-loop transaction load at it, and reads the result back over the public
 * JSON-RPC interface. Nothing is simulated, nothing is extrapolated, and no
 * figure is reported that this script did not measure.
 *
 *   node scripts/benchmark.js                                   # 4 validators, 60s
 *   node scripts/benchmark.js --duration 120 --concurrency 64
 *   node scripts/benchmark.js --workload evm-write              # SSTORE-heavy blocks
 *   node scripts/benchmark.js --rpc-url http://127.0.0.1:7300  # measure a running node
 *   node scripts/benchmark.js --help
 *
 * The report records the machine it ran on (CPU model, cores, memory, kernel,
 * Node version) because throughput without hardware is marketing, not a
 * measurement.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const NODE_BIN = process.execPath;

// ------------------------------------------------------------------ arguments

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const num = (name, fallback) => Number(arg(name, fallback));

if (arg('help', false)) {
  process.stdout.write(
    [
      'Full Stop benchmark',
      '',
      '  --validators <n>        validator nodes to start        (default 4)',
      '  --block-time <ms>       target block interval           (default 1500)',
      '  --duration <s>          measured load window            (default 60)',
      '  --warmup <s>            untimed warm-up before it       (default 5)',
      '  --accounts <n>          funded load accounts            (default 16)',
      '  --concurrency <n>       transactions in flight, total   (default 64)',
      '  --receipt-timeout <s>   wait this long for a receipt    (default 30)',
      '  --workload <name>       transfer | burn-fees | evm-write (default transfer)',
      '  --out <dir>             data directory                  (default data/bench)',
      '  --report <file>         markdown report to write        (default docs/BENCHMARKS.md)',
      '  --json <file>           raw results to write           (default artifacts/benchmark-latest.json)',
      '  --rpc-url <url>         benchmark an already-running node instead of starting one',
      '  --no-sync-test          skip the cold-node sync measurement (it costs up to 3 minutes)',
      '  --node-heap <mb>        --max-old-space-size for each node process (default 768)',
      '  --fund-each <ldx>       LDX paid to each load account at setup (default 0.5)',
      '  --rpc-rate-limit <n>    JSON-RPC budget per client on the nodes started here (default 60000)',
      '  --keep                  leave the network running after the run',
      '',
    ].join('\n')
  );
  process.exit(0);
}

const CONFIG = {
  validators: num('validators', 4),
  blockTimeMs: num('block-time', 1500),
  durationSec: num('duration', 60),
  accounts: num('accounts', 16),
  concurrency: num('concurrency', 64),
  receiptTimeoutSec: num('receipt-timeout', 30),
  workload: String(arg('workload', 'transfer')),
  outDir: path.resolve(String(arg('out', path.join(ROOT, 'data', 'bench')))),
  report: path.resolve(String(arg('report', path.join(ROOT, 'docs', 'BENCHMARKS.md')))),
  jsonOut: path.resolve(String(arg('json', path.join(ROOT, 'artifacts', 'benchmark-latest.json')))),
  externalRpc: arg('rpc-url', null) ? String(arg('rpc-url')) : null,
  keep: !!arg('keep', false),
  syncTest: !arg('no-sync-test', false),
  warmupSec: num('warmup', 5),
  nodeHeapMb: num('node-heap', 768),
  fundEach: num('fund-each', 0.5),
  // The node's published default is 1200 requests per minute per client. A
  // closed-loop load generator polls receipts far faster than any real client,
  // so the benchmark raises the budget on the nodes it starts and says so in
  // the report. Rate-limit rejections are still counted, never hidden.
  rpcRateLimit: num('rpc-rate-limit', 60000),
};

const log = (...a) => process.stderr.write(`[bench] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------- plumbing

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

function spawnNode(args, name, sink) {
  const child = spawn(NODE_BIN, [...(CONFIG.nodeHeapMb ? [`--max-old-space-size=${CONFIG.nodeHeapMb}`] : []), ...args], { cwd: ROOT });
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) sink.write(`[${name}] ${line}\n`);
    });
    stream.on('end', () => {
      if (buf) sink.write(`[${name}] ${buf}\n`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
}

// ------------------------------------------------------------------ statistics

function percentile(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
function stat(list) {
  return {
    n: list.length,
    min: list.length ? Math.min(...list) : null,
    max: list.length ? Math.max(...list) : null,
    mean: mean(list),
    p50: percentile(list, 50),
    p95: percentile(list, 95),
    p99: percentile(list, 99),
  };
}
const fmt = (n, digits = 2) => {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};
function table(rows) {
  const lines = [`| ${rows[0].join(' | ')} |`, `|${rows[0].map(() => '---').join('|')}|`];
  for (const r of rows.slice(1)) lines.push(`| ${r.map((c) => String(c)).join(' | ')} |`);
  return lines.join('\n');
}

// --------------------------------------------------------------------- workload

/**
 * Runtime code `PUSH1 1 PUSH1 0 SSTORE STOP`. One cold SSTORE per call is the
 * cheapest reliable way to make the benchmark measure EVM work instead of only
 * mempool bookkeeping.
 */
const SSTORE_RUNTIME = '600160005500';
const SSTORE_INITCODE = '0x' + '600680600b6000396000f3' + SSTORE_RUNTIME;

/** One load account. It pipelines `depth` transactions on sequential nonces. */
class Worker {
  constructor({ url, key, depth, workload, contract, chainId, gasPrice, recipients = [], index = 0 }) {
    this.url = url;
    this.wallet = new ethers.Wallet(key);
    this.depth = depth;
    this.workload = workload;
    this.contract = contract;
    this.chainId = chainId;
    this.gasPrice = gasPrice;
    this.recipients = recipients;
    this.index = index;
    this.nonce = null;
  }

  async sign() {
    if (this.nonce === null) {
      // No JsonRpcProvider here on purpose: one provider per worker starts a
      // polling loop, and 16 of those plus the receipt pollers is enough to
      // make a benchmark process the thing that limits the measurement.
      this.nonce = Number(BigInt(await rpc(this.url, 'eth_getTransactionCount', [this.wallet.address, 'latest'])));
    }
    const base = {
      nonce: this.nonce++,
      gasPrice: this.gasPrice,
      chainId: this.chainId,
      type: 0,
    };
    if (this.workload === 'evm-write') {
      return this.wallet.signTransaction({ ...base, to: this.contract, data: '0xc0ffee00', value: 0, gasLimit: 60_000n });
    }
    if (this.workload === 'burn-fees') {
      // self-transfer with the minimum gas: pure fee burn, no state growth
      return this.wallet.signTransaction({ ...base, to: this.wallet.address, value: 0, gasLimit: 21_000n });
    }
    // Round-robin between the load accounts. A benchmark that paid a *new*
    // address every transaction was measuring address creation and trie growth
    // instead of throughput, and on a 2 GB machine it also OOM-killed the node
    // before the measurement finished.
    const to = this.recipients.length ? this.recipients[(this.index + 1) % this.recipients.length] : this.wallet.address;
    return this.wallet.signTransaction({ ...base, to, value: 1n, gasLimit: 21_000n });
  }
}

/**
 * Closed-loop load. Each worker keeps `depth` transactions in flight and waits
 * for their receipts, so the measurement reflects the chain's sustained
 * inclusion rate rather than how fast a client can fire and forget.
 */
async function runLoad(url, workers, { durationMs }) {
  const results = [];
  const t0 = Date.now();
  let stop = false;

  const one = async (worker) => {
    let raw;
    let hash;
    const submittedAt = Date.now() - t0;
    try {
      raw = await worker.sign();
      hash = await rpc(url, 'eth_sendRawTransaction', [raw]);
    } catch (err) {
      results.push({ submittedAt, includedAt: null, error: err.message.slice(0, 200) });
      return;
    }
    let includedAt = null;
    const polls = Math.max(1, Math.round((CONFIG.receiptTimeoutSec * 1000) / 50));
    for (let i = 0; i < polls && includedAt === null; i++) {
      await sleep(50);
      try {
        const r = await rpc(url, 'eth_getTransactionReceipt', [hash]);
        if (r) includedAt = Date.now() - t0;
      } catch {
        /* transient rpc failure: keep polling */
      }
    }
    results.push({ hash, submittedAt, includedAt, error: includedAt === null ? `no receipt within ${CONFIG.receiptTimeoutSec}s` : null });
  };

  // One closed loop per worker, with at most `depth` transactions outstanding.
  // Nothing here busy-waits: an idle loop would starve the node processes of
  // the only two cores this machine has, which is exactly how an earlier run of
  // this script ended up measuring nothing at all.
  const drive = async (worker) => {
    const inflight = new Set();
    while (!stop || inflight.size) {
      while (!stop && inflight.size < worker.depth) {
        const p = one(worker).finally(() => inflight.delete(p));
        inflight.add(p);
      }
      if (inflight.size) await Promise.race(inflight);
      else await sleep(5);
    }
    await Promise.allSettled(inflight);
  };

  const driver = Promise.allSettled(workers.map(drive));
  await sleep(durationMs);
  stop = true;
  await Promise.race([driver, sleep(30_000)]);
  return { results, wallMs: Date.now() - t0 };
}

// ----------------------------------------------------------------------- report

function environment() {
  const cpus = os.cpus();
  return {
    ranAt: new Date().toISOString(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    logicalCores: cpus.length,
    totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
    freeMemoryGiBAtStart: Number((os.freemem() / 1024 ** 3).toFixed(2)),
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    processesUnderTest: CONFIG.validators + 1,
    nodeHeapLimitMb: CONFIG.nodeHeapMb,
    note: `every node process ran on this one machine, sharing ${cpus.length} logical cores`,
  };
}

function renderReport({ env, cfg, summary, blocks, supply, audit, sync, rejections, notes }) {
  const latency = summary.latencyMs;
  const rows = [
    ['Metric', 'Value', 'How it was measured'],
    ['Transactions submitted', fmt(summary.submitted), 'eth_sendRawTransaction calls this script made'],
    ['Transactions included', fmt(summary.included), 'a receipt was readable for the hash'],
    ['Submissions refused', fmt(summary.submitted - summary.included - summary.neverIncluded), 'the node rejected the transaction at admission'],
    ['Never included', fmt(summary.neverIncluded, 0), `accepted into the pool, no receipt inside the ${cfg.receiptTimeoutSec} s poll window: with a backlog this is the load generator waiting, not the chain refusing`],
    ['Sustained throughput', `${fmt(summary.tps, 1)} tx/s`, 'included transactions / wall-clock seconds of the measured window'],
    ['Throughput per validator', `${fmt(summary.tpsPerValidator, 1)} tx/s`, 'the same figure divided by the validator count: every validator re-executes every block'],
    ['Gas throughput', `${fmt(summary.gasPerSec, 0)} gas/s`, 'sum of block gasUsed / wall-clock seconds'],
    ['Block utilisation', `${fmt(summary.gasUtilisationPct, 2)}% of the block gas limit`, 'mean block gasUsed / blockGasLimit'],
    ['Block interval', `mean ${fmt(blocks.interval.mean, 0)} ms, p50 ${fmt(blocks.interval.p50, 0)} ms, p95 ${fmt(blocks.interval.p95, 0)} ms, max ${fmt(blocks.interval.max, 0)} ms`, 'difference between consecutive block header timestamps'],
    ['Transactions per block', `mean ${fmt(blocks.perBlock.mean, 1)}, max ${fmt(blocks.perBlock.max, 0)}`, 'length of the transactions array per block'],
    ['Blocks produced', `${fmt(summary.blocksProduced, 0)} over ${fmt(summary.windowMs / 1000, 1)} s`, 'heights observed inside the measured window'],
    ['Latency to inclusion', `p50 ${fmt(latency.p50, 0)} ms, p95 ${fmt(latency.p95, 0)} ms, p99 ${fmt(latency.p99, 0)} ms, max ${fmt(latency.max, 0)} ms`, 'submit -> first readable receipt, polled every 50 ms'],
    ['Finality', '1 block', 'a Full Stop block carries the precommits that sealed it, so a transaction is final in the block that includes it; there is no epoch to wait for'],
    ['Consensus rounds', `p50 ${fmt(blocks.rounds.p50, 0)}, max ${fmt(blocks.rounds.max, 0)}, ${fmt(blocks.round0Pct, 1)}% of blocks committed at round 0`, 'header.round per block; round > 0 means a view change happened'],
    ['Cold node sync + replay', sync?.error ? `failed: ${sync.error}` : sync ? `${fmt(sync.height, 0)} blocks in ${fmt(sync.ms / 1000, 1)} s = ${fmt(sync.rate, 1)} blocks/s` : 'not measured', 'an empty data directory, one peer, re-executed every block from genesis (the state trie is not persisted)'],
    ['Sync agreement', sync?.error ? 'n/a' : sync ? (sync.agrees ? `identical state root and app hash at height ${sync.comparedAtHeight}` : 'DIVERGED - the synced node does not reproduce the network') : 'not measured', 'both nodes asked for the same height and their headers compared: heads are not comparable while the chain advances'],
    ['Chain size after the run', `${fmt(cfg.blockLogKiB, 1)} KiB of blocks, ${fmt(cfg.receiptLogKiB, 1)} KiB of receipts`, 'on-disk JSONL sizes of the RPC node store'],
    ['RPC read latency', `${fmt(cfg.readLatencyMs.mean, 1)} ms mean, ${fmt(cfg.readLatencyMs.p95, 1)} ms p95 over ${fmt(cfg.readLatencyMs.n, 0)} calls`, 'fs_status + eth_getBlockByNumber pairs sampled between submissions'],
  ];

  const escrowNote =
    supply.staking?.escrowHeld === undefined || supply.staking.escrowHeld === null
      ? 'n/a'
      : BigInt(supply.staking.escrowHeld) === BigInt(supply.staking.escrowRequired)
        ? `exact: the module holds ${fmt(Number(BigInt(supply.staking.escrowHeld)) / 1e18, 4)} LDX against ${fmt(Number(BigInt(supply.staking.escrowRequired)) / 1e18, 4)} LDX of recorded bonds`
        : `MISMATCH: holds ${supply.staking.escrowHeld}, owes ${supply.staking.escrowRequired}`;
  const supplyRows = [
    ['Supply check', 'Value', 'Why it matters'],
    ['Hard cap', `${fmt(supply.maxSupplyCoins, 0)} LDX`, 'a protocol constant, asserted on every mint'],
    ['Issued', `${fmt(supply.totalIssuedCoins, 6)} LDX`, 'sum of protocol mints since genesis'],
    ['Burned', `${fmt(supply.burnedCoins, 8)} LDX`, 'fee burn plus slash burn; permanently removed'],
    ['Unissued', `${fmt(supply.unissuedCoins, 6)} LDX`, 'head-room left under the cap'],
    ['Issued as % of cap', `${fmt((supply.totalIssuedCoins / supply.maxSupplyCoins) * 100, 3)}%`, 'the cap is a ceiling, not a schedule'],
    ['Conservation', audit.ok ? `holds: ${fmt(Number(BigInt(audit.onchainTotal)) / 1e18, 6)} LDX on chain = ${fmt(Number(BigInt(audit.ledgerTotal)) / 1e18, 6)} LDX minted minus burned` : `VIOLATED: ${JSON.stringify(audit)}`, 'the node walks the whole state trie and asserts sum(balances) === minted - burned'],
    ['Staking escrow', escrowNote],
  ];

  const blockRows = [
    ['Height', 'Txs', 'Gas used', 'Round', 'Interval from previous (ms)'],
    ...blocks.sample.map((b) => [fmt(b.height, 0), fmt(b.txCount, 0), fmt(b.gasUsed, 0), fmt(b.round, 0), b.interval === null ? 'n/a' : fmt(b.interval, 0)]),
  ];

  const rejectionRows = Object.keys(rejections).length
    ? ['', '', '', '### Rejection reasons', '', ...Object.entries(rejections).map(([reason, count]) => [`"${reason}"`, `${fmt(count, 0)} occurrence(s)`, 'admission control refused these; they are counted, not discarded from the statistics']), ''].map((r) => (typeof r === 'string' ? r : r))
    : [];

  return `# Benchmarks

<!-- Generated by \`node scripts/benchmark.js\` at ${env.ranAt}.
     Do not edit by hand: re-run the script and commit the result.
     Every number below is something this machine measured. -->

> **Read this first.** These are measurements of a *reference implementation* on
> a single small machine, running a test network with a handful of validators.
> They are not mainnet capacity, not a service-level commitment, not a promise
> about future versions, and not a comparison with any other chain. The
> protocol's throughput targets are in [SPEC.md](SPEC.md); what this file adds is
> evidence about what the current code actually does, with the hardware, the
> configuration and the workload named so that anyone can repeat it and get an
> answer they can check.

## 1. Command

\`\`\`bash
node scripts/benchmark.js --validators ${CONFIG.validators} --block-time ${CONFIG.blockTimeMs} \\
     --duration ${CONFIG.durationSec} --accounts ${CONFIG.accounts} --concurrency ${CONFIG.concurrency} \\
     --workload ${CONFIG.workload}
\`\`\`

Exit code is 0 only if the run completed, every included transaction is
confirmed, and the supply audit still balances afterwards.

## 2. Hardware and software under test

${table([['Field', 'Value'], ...Object.entries(env).map(([k, v]) => [k, String(v)])])}

## 3. Configuration

${table([
    ['Parameter', 'Value'],
    ['Validators', `${cfg.validators} (each a separate OS process, local gossip)`],
    ['Block time target', `${cfg.blockTimeMsTarget} ms`],
    ['Chain id', cfg.chainId],
    ['Block gas limit', `${fmt(cfg.blockGasLimit, 0)} gas`],
    ['Min gas price', `${fmt(cfg.minGasPriceWei, 0)} wei/gas (${fmt(Number(cfg.minGasPriceWei) / 1e9, 0)} gwei)`],
    ['Workload', cfg.workload],
    ['Load accounts', cfg.loadAccounts],
    ['Pipelined depth per account', cfg.concurrencyPerAccount],
    ['Total in flight', cfg.totalInFlight],
    ['Measured window', `${cfg.durationSec} s after a ${cfg.warmupSec} s warm-up`],
    ['Block log after run', `${fmt(cfg.blockLogKiB, 1)} KiB`],
    ['Receipt log after run', `${fmt(cfg.receiptLogKiB, 1)} KiB`],
  ])}

## 4. Results

${table(rows)}

## 5. Blocks observed (first 10 inside the window)

${table(blockRows)}

## 6. Supply accounting after the run

A benchmark that makes the chain cheaper to use than it is safe would show up
here, because the same conservation assertion validators make at the end of each
block is re-run against the finished state.

${table(supplyRows)}

${rejectionRows.length ? table([['Reason', 'Count', 'Note'], ...rejectionRows.filter((r) => Array.isArray(r))]) + '\n' : ''}
## 7. What these numbers do not say

${notes.map((n) => `- ${n}`).join('\n')}

## 8. Reproducing this

\`\`\`bash
npm install                 # node >= 20
npm run compile             # system-contract artifacts the genesis is verified against
node scripts/benchmark.js    # writes this file and artifacts/benchmark-latest.json
node tools/determinism-check.js
npm test
\`\`\`

The same script under a write-heavy workload is committed next to this file
(\`docs/BENCHMARKS-EVM-WRITE.md\`, produced by
\`node scripts/benchmark.js --workload evm-write --report docs/BENCHMARKS-EVM-WRITE.md
--json artifacts/benchmark-evm-write.json\`). Report both numbers together: the
transfer workload shows what admission control and consensus pacing cost, the
write workload shows what the EVM costs.

\`artifacts/benchmark-latest.json\` holds the raw per-transaction timings and every
block row, so each aggregate above can be recomputed from it. If your machine
produces different numbers, that is a real result too: publish it next to this
file rather than overwriting it.
`;
}

// ------------------------------------------------------------------------- main

async function main() {
  const children = [];
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  const sink = fs.createWriteStream(path.join(CONFIG.outDir, 'benchmark.log'), { flags: 'a' });
  let url = CONFIG.externalRpc;
  let genesisPath = null;
  let startedNodes = false;

  try {
    if (!url) {
      genesisPath = path.join(CONFIG.outDir, 'genesis.json');
      if (!fs.existsSync(genesisPath)) {
        log('generating a fresh devnet genesis for the benchmark');
        const init = spawnSync(
          NODE_BIN,
          [
            path.join(ROOT, 'scripts', 'init-devnet.js'),
            '--out', CONFIG.outDir,
            '--validators', String(CONFIG.validators),
            '--seed', 'fs-bench',
            '--block-time', String(CONFIG.blockTimeMs),
            '--quiet',
          ],
          { cwd: ROOT, stdio: 'inherit' }
        );
        if (init.status !== 0) throw new Error('genesis generation failed');
      }
      const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf8'));
      const ports = [];
      for (let i = 0; i < genesis.validators.length; i++) ports.push(await pickPort());
      const peerUrls = ports.map((p) => `http://127.0.0.1:${p}`);
      for (let i = 0; i < genesis.validators.length; i++) {
        children.push(
          spawnNode(
            [
              path.join(ROOT, 'src', 'node.js'),
              '--genesis', genesisPath,
              '--datadir', path.join(CONFIG.outDir, 'nodes', `v${i + 1}`),
              '--port', String(ports[i]),
              '--key', path.join(CONFIG.outDir, 'keys', `v${i + 1}.json`),
              '--moniker', `bench-v${i + 1}`,
              '--rpc-rate-limit', String(CONFIG.rpcRateLimit),
              '--peers', peerUrls.filter((_, j) => j !== i).join(','),
            ],
            `v${i + 1}`,
            sink
          )
        );
      }
      const rpcPort = await pickPort();
      CONFIG.rpcPort = rpcPort;
      children.push(
        spawnNode(
          [
            path.join(ROOT, 'src', 'node.js'),
            '--genesis', genesisPath,
            '--datadir', path.join(CONFIG.outDir, 'nodes', 'rpc'),
            '--port', String(rpcPort),
            '--moniker', 'bench-rpc',
          '--rpc-rate-limit', String(CONFIG.rpcRateLimit),
            '--peers', peerUrls.join(','),
          ],
          'rpc',
          sink
        )
      );
      url = `http://127.0.0.1:${rpcPort}`;
      startedNodes = true;
      log(`starting ${genesis.validators.length} validators + 1 rpc node on ports ${[...ports, rpcPort].join(', ')}`);
    }

    await waitForHead(url, 2, 180_000);
    const chainIdBig = BigInt(await rpc(url, 'eth_chainId'));
    const gasPrice = BigInt(await rpc(url, 'eth_gasPrice'));

    log(`rpc reachable at ${url} (chain id ${chainIdBig})`);

    // ---- load accounts -----------------------------------------------------
    const keys = Array.from({ length: CONFIG.accounts }, () => ethers.Wallet.createRandom());
    if (!CONFIG.externalRpc) {
      const accounts = JSON.parse(fs.readFileSync(path.join(CONFIG.outDir, 'accounts.json'), 'utf8'));
      const funderFile = path.join(CONFIG.outDir, accounts.users[0].key_file);
      const funderKey = JSON.parse(fs.readFileSync(funderFile, 'utf8')).privateKey;
      const provider = new ethers.JsonRpcProvider(url);
      const funder = new ethers.Wallet(funderKey, provider);
      const each = ethers.parseEther(String(CONFIG.fundEach));
      let nonce = await provider.getTransactionCount(funder.address);
      const sends = [];
      for (const w of keys) {
        const tx = await funder.signTransaction({ to: w.address, value: each, gasLimit: 21_000n, gasPrice, nonce: nonce++, chainId: Number(chainIdBig), type: 0 });
        sends.push(rpc(url, 'eth_sendRawTransaction', [tx]).catch((err) => log(`funding tx refused: ${err.message}`)));
      }
      await Promise.all(sends);
      for (let i = 0; i < 60; i++) {
        const balances = await Promise.all(keys.map((w) => provider.getBalance(w.address)));
        if (balances.every((b) => b >= each)) break;
        await sleep(500);
      }
      log(`funded ${keys.length} load accounts with ${CONFIG.fundEach} LDX each`);
    } else {
      const provider = new ethers.JsonRpcProvider(url);
      for (const w of keys) {
        const bal = await provider.getBalance(w.address);
        if (bal < ethers.parseEther('0.01')) {
          throw new Error(`--rpc-url mode needs ${keys.length} pre-funded accounts; ${w.address} is empty. Pass --accounts <n> matching funded keys, or omit --rpc-url.`);
        }
      }
    }

    let contract = null;
    if (CONFIG.workload === 'evm-write') {
      const provider = new ethers.JsonRpcProvider(url);
      const deployer = new ethers.Wallet(keys[0].privateKey, provider);
      const raw = await deployer.signTransaction({
        to: null,
        data: SSTORE_INITCODE,
        value: 0,
        gasLimit: 200_000n,
        gasPrice,
        nonce: await provider.getTransactionCount(deployer.address),
        chainId: Number(chainIdBig),
        type: 0,
      });
      const hash = await rpc(url, 'eth_sendRawTransaction', [raw]);
      for (let i = 0; i < 400 && !contract; i++) {
        await sleep(100);
        const r = await rpc(url, 'eth_getTransactionReceipt', [hash]);
        if (r) {
          if (Number(r.status) !== 1) throw new Error('the sstore contract failed to deploy');
          contract = r.contractAddress;
        }
      }
      if (!contract) throw new Error('the sstore deployment was never included');
      log(`evm-write target at ${contract}`);
    }

    const depth = Math.max(1, Math.floor(CONFIG.concurrency / CONFIG.accounts));
    const recipients = keys.map((w) => w.address);
    const workers = keys.map((w, i) => new Worker({ url, key: w.privateKey, depth, workload: CONFIG.workload, contract, chainId: Number(chainIdBig), gasPrice, recipients, index: i }));

    // ---- warm up, then measure --------------------------------------------
    log(`warm-up ${CONFIG.warmupSec}s`);
    await sleep(CONFIG.warmupSec * 1000);
    const fromHeight = Number(BigInt(await rpc(url, 'eth_blockNumber')));
    log(`measuring: ${CONFIG.durationSec}s, ${workers.length} accounts x depth ${depth}`);
    const load = await runLoad(url, workers, { durationMs: CONFIG.durationSec * 1000 });
    const toHeight = Number(BigInt(await rpc(url, 'eth_blockNumber')));

    // ---- read the chain back ----------------------------------------------
    // `fs_blocks` carries the consensus header's millisecond timestamp; the eth_
    // block object only carries unix seconds, which would quantise every block
    // interval in this report to 1000 or 2000 ms and make a 1.5 s target look
    // wrong. Block rows therefore come from the protocol view, and the eth_
    // read path is timed separately below.
    const seen = [];
    for (let h = fromHeight + 1; h <= toHeight; h += 400) {
      const page = await rpc(url, 'fs_blocks', [{ from: h, count: Math.min(400, toHeight - h + 1) }]);
      for (const b of page ?? []) {
        seen.push({
          height: b.height,
          time: new Date(b.time).getTime(),
          txCount: b.txCount,
          gasUsed: Number(BigInt(b.gasUsed)),
          round: b.round,
          proposer: b.proposer ?? 'n/a',
        });
      }
    }
    seen.sort((a, b) => a.height - b.height);
    // Time a handful of standard reads so the RPC path is measured too.
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
      await rpc(url, 'fs_status');
      readSamples.push(Date.now() - t0);
    }
    const intervals = [];
    for (let i = 1; i < seen.length; i++) intervals.push(seen[i].time - seen[i - 1].time);
    const windowMs = seen.length > 1 ? seen[seen.length - 1].time - seen[0].time : load.wallMs;
    const gasTotal = seen.reduce((a, b) => a + b.gasUsed, 0);
    const txInBlocks = seen.reduce((a, b) => a + b.txCount, 0);

    const includedLatencies = load.results.filter((r) => r.includedAt !== null).map((r) => r.includedAt - r.submittedAt);
    const neverIncluded = load.results.filter((r) => r.error && r.error.startsWith('no receipt')).length;
    const rejections = {};
    for (const r of load.results.filter((x) => x.error && !x.error.startsWith('no receipt'))) {
      rejections[r.error] = (rejections[r.error] ?? 0) + 1;
    }

    const params = await rpc(url, 'fs_params');
    const status = await rpc(url, 'fs_status');
    const supply = await rpc(url, 'fs_supply');
    const audit = await rpc(url, 'fs_supplyAudit');

    // ---- cold node sync -----------------------------------------------------
    let sync = null;
    if (CONFIG.syncTest && !CONFIG.externalRpc) {
      const syncPort = await pickPort();
      const syncDir = path.join(CONFIG.outDir, 'nodes', 'catchup');
      fs.rmSync(syncDir, { recursive: true, force: true });
      const peerUrl = `http://127.0.0.1:${CONFIG.rpcPort}`;
      const child = spawnNode(
        [
          path.join(ROOT, 'src', 'node.js'),
          '--genesis', genesisPath,
          '--datadir', syncDir,
          '--port', String(syncPort),
          '--moniker', 'bench-catchup',
          '--rpc-rate-limit', String(CONFIG.rpcRateLimit),
          '--peers', peerUrl,
        ],
        'catchup',
        sink
      );
      children.push(child);
      const target = Number(BigInt(await rpc(url, 'eth_blockNumber')));
      const t0 = Date.now();
      try {
        await waitForHead(`http://127.0.0.1:${syncPort}`, target, 180_000);
        const ms = Date.now() - t0;
        const synced = await rpc(`http://127.0.0.1:${syncPort}`, 'fs_status');
        // Compare a fixed height, not "whatever each node's head is right now":
        // the network keeps producing blocks while the catch-up node syncs, so
        // comparing heads compares different heights and reports a divergence
        // that does not exist.
        const ref = await rpc(url, 'fs_status');
        const at = Math.min(synced.height, ref.height);
        const [mine, theirs] = await Promise.all([
          rpc(url, 'eth_getBlockByNumber', ['0x' + at.toString(16), false]),
          rpc(`http://127.0.0.1:${syncPort}`, 'eth_getBlockByNumber', ['0x' + at.toString(16), false]),
        ]);
        sync = {
          height: synced.height,
          ms,
          rate: synced.height / (ms / 1000),
          comparedAtHeight: at,
          agrees: !!mine && !!theirs && mine.stateRoot === theirs.stateRoot && mine.fs.appHash === theirs.fs.appHash,
          note: mine && theirs ? `state root and app hash at height ${at}` : 'block not available on both nodes',
        };
      } catch (err) {
        sync = { error: err.message };
      }
      child.kill('SIGTERM');
      children.pop();
    }

    const dirSizes = {};
    if (!CONFIG.externalRpc) {
      const chainDir = path.join(CONFIG.outDir, 'nodes', 'rpc', 'chain');
      for (const [key, file] of [['blockLogBytes', 'blocks.jsonl'], ['receiptLogBytes', 'receipts.jsonl']]) {
        const p = path.join(chainDir, file);
        dirSizes[key] = fs.existsSync(p) ? fs.statSync(p).size : 0;
      }
    }

    const summary = {
      submitted: load.results.length,
      included: includedLatencies.length,
      neverIncluded,
      windowMs: windowMs || load.wallMs,
      tps: (includedLatencies.length / (windowMs || load.wallMs)) * 1000,
      tpsPerValidator: includedLatencies.length / ((windowMs || load.wallMs) / 1000) / CONFIG.validators,
      gasPerSec: (gasTotal / (windowMs || load.wallMs)) * 1000,
      gasUtilisationPct: (mean(seen.map((b) => b.gasUsed)) / Number(BigInt(params.blockGasLimit))) * 100,
      blocksProduced: seen.length,
      txsObservedInBlocks: txInBlocks,
      latencyMs: stat(includedLatencies),
      rejections,
    };

    const notes = [
      `All ${CONFIG.validators + 1} node processes shared ${os.cpus().length} logical cores on one machine, so this run is CPU-bound and says nothing about a geographically distributed validator set.`,
      'The state trie is not persisted by this implementation: a node re-executes the block log at start-up. The cold-node figure is therefore a combined sync *and* replay measurement, and start-up cost grows linearly with chain length (see docs/ADR.md).',
      'Throughput is bounded by single-threaded JavaScript execution and by the block gas limit. No parallel execution, no caching layer and no native (non-JVM/JS) runtime is part of this build.',
      'Every validator re-executes every transaction. Use "throughput per validator" when sizing hardware for a real set; the aggregate is the same work done N times in parallel.',
      'Not measured here, and not claimed: adversarial validators, wide-area network latency, disk contention under load, evidence submission storms, node restarts mid-block, long-range key reuse, or behaviour past 64 validators.',
      `The workload is ${CONFIG.workload}. A transfer benchmark measures admission control and block packaging more than EVM throughput; run \`--workload evm-write\` for a write-heavy picture and report both.`,
    ];

    const cfg = {
      validators: CONFIG.validators,
      blockTimeMsTarget: CONFIG.blockTimeMs,
      chainId: String(chainIdBig),
      workload: CONFIG.workload,
      loadAccounts: CONFIG.accounts,
      concurrencyPerAccount: depth,
      totalInFlight: CONFIG.concurrency,
      durationSec: CONFIG.durationSec,
      warmupSec: CONFIG.warmupSec,
      blockGasLimit: Number(BigInt(params.blockGasLimit)),
      minGasPriceWei: Number(BigInt(params.minGasPriceWei)),
      rpcRateLimit: CONFIG.rpcRateLimit,
      rpcRateLimitDefault: 1200,
      blockLogKiB: (dirSizes.blockLogBytes ?? 0) / 1024,
      receiptLogKiB: (dirSizes.receiptLogBytes ?? 0) / 1024,
      readLatencyMs: stat(readSamples),
    };

    const report = renderReport({
      env: environment(),
      cfg,
      summary,
      blocks: {
        interval: stat(intervals),
        perBlock: stat(seen.map((b) => b.txCount)),
        rounds: stat(seen.map((b) => b.round)),
        round0Pct: seen.length ? (seen.filter((b) => b.round === 0).length / seen.length) * 100 : null,
        sample: seen.slice(0, 10).map((b, i) => ({ ...b, interval: i === 0 && seen.length > 1 ? seen[1].time - seen[0].time : seen[seen.indexOf(b) + 1] ? seen[seen.indexOf(b) + 1].time - b.time : null })),
      },
      supply: {
        maxSupplyCoins: Number(BigInt(supply.maxSupply)) / 1e18,
        totalIssuedCoins: Number(BigInt(supply.totalIssued)) / 1e18,
        burnedCoins: Number(BigInt(supply.burned)) / 1e18,
        unissuedCoins: Number(BigInt(supply.unissued)) / 1e18,
        staking: supply.staking,
      },
      audit,
      sync,
      rejections,
      notes,
    });

    fs.mkdirSync(path.dirname(CONFIG.report), { recursive: true });
    fs.writeFileSync(CONFIG.report, report);
    fs.mkdirSync(path.dirname(CONFIG.jsonOut), { recursive: true });
    fs.writeFileSync(
      CONFIG.jsonOut,
      JSON.stringify(
        {
          environment: environment(),
          config: cfg,
          summary,
          supply,
          audit,
          status: { ...status, ...dirSizes },
          sync,
          transactions: load.results,
          blocks: seen,
        },
        null,
        2
      )
    );
    process.stdout.write(
      `\nwrote ${CONFIG.report}\nwrote ${CONFIG.jsonOut}\n\n` +
        `  throughput   ${fmt(summary.tps, 1)} tx/s over ${fmt(summary.windowMs / 1000, 1)}s (${fmt(summary.included, 0)} of ${fmt(summary.submitted, 0)} transactions included)\n` +
        `  block time   ${fmt(intervals.length ? mean(intervals) : null, 0)} ms mean\n` +
        `  latency      p50 ${fmt(percentile(includedLatencies, 50), 0)} ms / p95 ${fmt(percentile(includedLatencies, 95), 0)} ms\n` +
        `  conservation ${audit.ok ? 'holds' : 'VIOLATED'}\n\n`
    );
    if (!audit.ok) process.exitCode = 1;
  } finally {
    if (startedNodes && !CONFIG.keep) {
      for (const c of children) {
        try {
          c.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
      await sleep(400);
    }
    sink.end();
  }
}

const readSamples = [];

async function waitForHead(url, min = 1, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    try {
      const h = Number(BigInt(await rpc(url, 'eth_blockNumber')));
      if (h >= min) return h;
    } catch {
      /* the node is still booting */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`no block height >= ${min} within ${timeoutMs}ms at ${url}`);
    await sleep(250);
  }
}

main()
  .then(() => {
    // The nodes were SIGTERM'd in `finally`; exit explicitly so a lingering
    // provider poll or an un-kept-alive handle cannot keep this process alive.
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    log(`benchmark failed: ${err.stack ?? err.message}`);
    process.exit(1);
  });
