#!/usr/bin/env node
'use strict';
/**
 * Determinism check: two nodes initialised from the same genesis must compute
 * the same application hash for the same block. Run against a generated
 * devnet genesis:
 *
 *   node tools/determinism-check.js --genesis data/devnet/genesis.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chain } = require('../src/chain.js');
const { loadGenesis, toExecutionGenesis } = require('../src/genesis.js');
const { defaultParams } = require('../src/chain.js');
const { loadConfig, parseArgs } = require('../src/node.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function makeChain(genesisPath, datadir, keyFile, extra = []) {
  fs.rmSync(datadir, { recursive: true, force: true });
  const args = parseArgs(['--genesis', genesisPath, '--datadir', datadir, '--port', '7399', '--key', keyFile, ...extra]);
  const cfg = loadConfig(args);
  const eg = toExecutionGenesis(cfg.genesis);
  const chain = await Chain.create({ genesis: eg, datadir, params: cfg.params, mode: 'validator' });
  return { chain, cfg };
}

async function main() {
  const genesisPath = path.resolve(arg('genesis', path.join(__dirname, '..', 'data', 'devnet', 'genesis.json')));
  const keyFile = path.resolve(arg('key', path.join(path.dirname(genesisPath), 'keys', 'v1.json')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsdet-'));
  const a = await makeChain(genesisPath, path.join(tmp, 'a'), keyFile);
  const b = await makeChain(genesisPath, path.join(tmp, 'b'), keyFile);

  const results = [];
  const assert = (label, ok, detail) => {
    results.push({ label, ok, detail });
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}\n`);
  };

  assert('genesis app hashes match', a.chain.appHash === b.chain.appHash, a.chain.appHash.slice(0, 22));
  assert('genesis state roots match', a.chain.stateRoot === b.chain.stateRoot, a.chain.stateRoot.slice(0, 22));

  const time0 = a.chain.head.header.time;
  let prevA = a.chain.head;
  for (let h = 1; h <= 6; h++) {
    const { block } = await a.chain.produceBlock({ height: h, round: 0, time: time0 + h * 1500, proposer: a.cfg.key.address });
    const va = await a.chain.validateBlock(block, { checkCommit: false });
    const vb = await b.chain.validateBlock(block, { checkCommit: false });
    assert(`height ${h}: accepted by the producing node`, va.ok, va.reason ?? '');
    assert(`height ${h}: accepted by the second node`, vb.ok, vb.reason ?? '');
    if (!vb.ok) {
      process.stdout.write(`  A protocol: ${JSON.stringify(a.chain.protocol.serialize()).slice(0, 900)}\n`);
      process.stdout.write(`  B protocol: ${JSON.stringify(b.chain.protocol.serialize()).slice(0, 900)}\n`);
      break;
    }
    await a.chain.commitBlock(block, { source: 'test' });
    await b.chain.commitBlock(block, { source: 'test' });
    assert(`height ${h}: state roots agree`, a.chain.stateRoot === b.chain.stateRoot, a.chain.stateRoot.slice(0, 22));
    assert(`height ${h}: app hashes agree`, a.chain.appHash === b.chain.appHash, a.chain.appHash.slice(0, 22));
    const audit = await a.chain.protocol.supplyAudit(a.chain.execution);
    assert(`height ${h}: supply conservation`, audit.ok, `onchain=${audit.onchainTotal} ledger=${audit.ledgerTotal}`);
    prevA = block;
  }

  // Recovery: a third node must rebuild identical state by replaying the log.
  const c = await Chain.create({
    genesis: toExecutionGenesis(loadGenesis(genesisPath)),
    datadir: path.join(tmp, 'a'),
    params: a.cfg.params,
    mode: 'validator',
  });
  assert('restart recovery reproduces the head', c.head.height === a.chain.head.height, `height ${c.head.height}`);
  assert('restart recovery reproduces the app hash', c.appHash === a.chain.appHash, c.appHash?.slice(0, 22));
  assert('restart recovery reproduces the state root', c.stateRoot === a.chain.stateRoot, c.stateRoot?.slice(0, 22));

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} determinism checks passed\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('determinism check crashed:', err);
  process.exit(2);
});
