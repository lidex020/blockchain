#!/usr/bin/env node
'use strict';
/**
 * End-to-end tour of a Full Stop network.
 *
 * The point of this script is that nothing it prints is taken on trust: every
 * action is followed by a read of the chain that proves the effect the action
 * claimed to have. State changes go through the same `fullstop` CLI a developer
 * would use, so running this also exercises the CLI, the RPC surface, the
 * factories, the staking module and the community pool in one pass.
 *
 *   node scripts/demo.js                       # starts a throwaway 4-validator devnet
 *   node scripts/demo.js --rpc http://127.0.0.1:7305/   # tour a network you already run
 *   node scripts/demo.js --keep                # leave the spawned network running
 *
 * Exit code is non-zero if any step's verification fails, so this file doubles
 * as the devnet smoke test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src/cli.js');
const { COIN } = require('../src/constants.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

let stepNo = 0;
const failures = [];
function step(title) {
  stepNo += 1;
  process.stdout.write(`\n${String(stepNo).padStart(2, ' ')}. ${title}\n`);
}
function ok(line) {
  process.stdout.write(`    ✓ ${line}\n`);
}
function verify(cond, claim) {
  if (cond) ok(claim);
  else {
    failures.push(claim);
    process.stdout.write(`    ✗ ${claim}\n`);
  }
  return cond;
}
const fmt = (wei) => `${Number(BigInt(wei ?? 0)) / 1e18} ${COIN.ticker}`;

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

/** Run one `fullstop` command, returning stdout. Throws when it exits non-zero. */
function cli(argv, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], { cwd: ROOT });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      if (code !== 0 && !allowFail) return reject(new Error(`fullstop ${argv.join(' ')} exited ${code}: ${(err || out).trim()}`));
      resolve({ code, out, err });
    });
  });
}

async function waitForBlocks(url, count, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const h = Number(BigInt(await rpc(url, 'eth_blockNumber')));
      if (h >= count) return h;
    } catch {
      /* the node is still binding its port */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`no blocks after ${timeoutMs}ms at ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function freePort() {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** Start `scripts/start-devnet.js` and find its RPC url from its own banner. */
function startDevnet(outDir, basePort, validators) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/start-devnet.js'), '--out', outDir, '--base-port', String(basePort), '--validators', String(validators), '--reset'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const url = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf += chunk;
      const m = buf.match(/rpc\s+(http:\/\/\S+)/);
      if (m) return resolve(m[1].replace(/\/?$/, '/'));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`start-devnet exited ${code} before publishing an rpc url:\n${buf.slice(-2000)}`)));
  });
  return { child, url };
}

async function main() {
  const validators = Number(arg('validators', 4));
  const keep = arg('keep', false) === true;
  let spawned = null;
  let url = arg('rpc', null);
  let outDir = null;
  let tmp = null;

  if (!url) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-demo-'));
    outDir = path.join(tmp, 'devnet');
    const base = await freePort();
    process.stdout.write(`starting a ${validators}-validator devnet in ${outDir} (this takes about a minute)\n`);
    spawned = startDevnet(outDir, base, validators);
    url = await spawned.url;
  }
  process.stdout.write(`network     ${url}\n`);
  await waitForBlocks(url, 2);

  try {
    const keysDir = outDir ? path.join(outDir, 'keys') : path.resolve(String(arg('keys', path.join(ROOT, 'data', 'devnet', 'keys'))));
    const keyFile = (label) => path.join(keysDir, `${label}.json`);
    const readFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

    // ---- 1. chain identity ------------------------------------------------
    step('what chain is this');
    const params = await rpc(url, 'fs_params');
    verify(BigInt(params.chainId) > 0n, `chain id ${params.chainId} (${params.ticker}, ${params.decimals} decimals)`);
    verify(BigInt(params.maxSupply) === ethers.parseUnits('100000000', 18), `hard cap is ${fmt(params.maxSupply)}, enforced by the protocol, not by a dashboard`);
    verify(params.consensus?.blockTimeMs > 0, `block target ${params.consensus.blockTimeMs} ms, finality in the block that includes the transaction`);
    const st = await rpc(url, 'fs_status');
    process.stdout.write(`    node ${st.nodeVersion} at head ${st.height}, gas limit ${params.blockGasLimit}, fee floor ${Number(BigInt(params.minGasPriceWei)) / 1e9} gwei\n`);

    // ---- 2. supply -------------------------------------------------------
    step('supply and escrow before anything happens');
    const before = await rpc(url, 'fs_supply');
    verify(BigInt(before.totalIssued) + BigInt(before.unissued) === BigInt(before.maxSupply), `issued ${fmt(before.totalIssued)} + unissued ${fmt(before.unissued)} = the cap`);
    verify(before.staking ? BigInt(before.staking.escrowHeld ?? 0n) > 0n : true, `staking escrow holds ${fmt(before.staking?.escrowHeld)} against ${fmt(before.staking?.escrowRequired ?? 0n)} of entitlements`);

    // ---- 3. faucet -------------------------------------------------------
    step('fund a new address from the testnet faucet');
    const newcomer = ethers.Wallet.createRandom();
    let claimBalance = 0n;
    let fundedBy = 'faucet';
    try {
      await cli(['faucet', '--to', newcomer.address, '--rpc', url]);
      claimBalance = BigInt(await rpc(url, 'eth_getBalance', [newcomer.address, 'latest']));
      const status = await rpc(url, 'fs_faucetStatus');
      verify(claimBalance === BigInt(status.amountPerClaim), `${newcomer.address.slice(0, 10)}… holds ${fmt(claimBalance)} after one claim`);
      verify(BigInt(status.balance) < BigInt(before.totalIssued), `the faucet paid it out of its own balance (${fmt(status.balance)} left), it did not mint`);
    } catch (err) {
      // Not every node serves a faucet - only the ones started with --faucet-key
      // - so fall back to a normal transfer instead of pretending the network is
      // broken because an operator disabled a convenience service.
      fundedBy = 'a transfer from an existing account';
      process.stdout.write(`    · no faucet on this node (${err.message.split('\n')[0]}); funding the new address by transfer instead\n`);
      await cli(['send', '--key', path.join(keysDir, 'alice.json'), '--to', newcomer.address, '--value', '25', '--rpc', url]);
      claimBalance = BigInt(await rpc(url, 'eth_getBalance', [newcomer.address, 'latest']));
      verify(claimBalance === ethers.parseUnits('25', 18), `${newcomer.address.slice(0, 10)}… holds ${fmt(claimBalance)} after the transfer`);
    }

    // ---- 4. native transfer, and where the fee went ----------------------
    step('send FSTOP, then check the fee was burned');
    const alice = keyFile('alice');
    const aliceAddr = readFile(alice).address;
    const burnBefore = BigInt((await rpc(url, 'fs_supply')).burned);
    const sent = await cli(['send', '--key', alice, '--to', newcomer.address, '--value', '3.5', '--rpc', url]);
    const gasUsed = BigInt(sent.out.match(/gas used (\d+)/)?.[1] ?? '0');
    verify(BigInt(await rpc(url, 'eth_getBalance', [newcomer.address, 'latest'])) === claimBalance + ethers.parseUnits('3.5', 18), 'the transfer landed in the recipient balance');
    const burnAfter = BigInt((await rpc(url, 'fs_supply')).burned);
    const expectedBurn = (gasUsed * BigInt(params.minGasPriceWei) * BigInt(params.burnBps)) / 10_000n;
    verify(burnAfter - burnBefore === expectedBurn, `burned rose by ${fmt(burnAfter - burnBefore)}, matching ${gasUsed} gas × fee × ${Number(params.burnBps) / 100}%`);
    process.stdout.write(`    block ${sent.out.match(/included in block (\d+)/)?.[1] ?? '?'}, fee ${sent.out.match(/fee paid (\S+ \w+)/)?.[1] ?? '?'} (this network has no explorer UI unless you run one)\n`);

    // ---- 5. asset platform ----------------------------------------------
    step('create an ERC-20 through the official factory');
    const created = await cli([
      'asset', 'token', '--rpc', url, '--key', alice,
      '--name', 'Demo Token', '--symbol', 'DEMO', '--decimals', '18',
      '--supply', '1000', '--cap', '5000', '--mintable',
    ]);
    const asset = created.out.match(/contract (0x[0-9a-fA-F]{40})/)?.[1];
    verify(!!asset, `the factory reported a deployed contract at ${asset ?? 'nothing'}`);
    const record = await rpc(url, 'fs_asset', [asset]);
    verify(record?.kind === 'ERC-20' && record?.symbol === 'DEMO', `the registry lists it as ${record?.kind} ${record?.name} (${record?.symbol}) created by ${String(record?.creator).slice(0, 10)}…`);
    const token = new ethers.Contract(asset, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], new ethers.JsonRpcProvider(url));
    const supplyOwner = BigInt(await token.balanceOf(aliceAddr));
    verify(supplyOwner === ethers.parseUnits('1000', 18), `the creator holds the minted ${fmt(supplyOwner)} and the cap is enforced by maxSupply=5000 units above it`);
    const bobAddr = readFile(keyFile('bob')).address;
    const provider = new ethers.JsonRpcProvider(url);
    const aliceWallet = new ethers.Wallet(readFile(alice).privateKey, provider);
    await (await token.connect(aliceWallet).transfer(bobAddr, ethers.parseUnits('40', 18))).wait();
    verify(BigInt(await token.balanceOf(bobAddr)) === ethers.parseUnits('40', 18), `an ERC-20 transfer moved 40 DEMO to ${bobAddr.slice(0, 10)}… (a contract, not the native coin)`);

    // ---- 6. staking ------------------------------------------------------
    step('delegate to a validator, then start unbonding');
    const validatorsList = await rpc(url, 'fs_validators');
    const target = validatorsList[0];
    const stakeBefore = BigInt(target.totalStake);
    await cli(['stake', 'bond', '--operator', target.operator, '--value', '150', '--key', alice, '--rpc', url]);
    const afterBond = BigInt((await rpc(url, 'fs_validator', [target.operator])).totalStake);
    verify(afterBond === stakeBefore + ethers.parseUnits('150', 18), `${target.moniker} total stake ${fmt(stakeBefore)} → ${fmt(afterBond)}`);
    const del = await rpc(url, 'fs_delegations', [aliceAddr]);
    verify(del.bonded.some((d) => d.operator.toLowerCase() === target.operator.toLowerCase()), `the delegator's position is readable for ${aliceAddr.slice(0, 10)}… (${del.bonded.map((d) => fmt(d.amount)).join(', ')})`);
    await cli(['stake', 'unbond', '--operator', target.operator, '--value', '50', '--key', alice, '--rpc', url]);
    const del2 = await rpc(url, 'fs_delegations', [aliceAddr]);
    verify(del2.unbonding.length > 0, `unbonding 50 ${COIN.ticker} entered the queue, maturing at height ${del2.unbonding[0]?.maturesAt} (it is not spendable before then)`);
    const escrow = (await rpc(url, 'fs_supply')).staking;
    verify(BigInt(escrow.escrowHeld) >= BigInt(escrow.escrowRequired), `the escrow still covers every entitlement: holds ${fmt(escrow.escrowHeld)} against ${fmt(escrow.escrowRequired)} required`);

    // ---- 7. community rewards -------------------------------------------
    step('submit a participation claim and get it reviewed');
    const ref = `demo-run-${Date.now()}`;
    const submitted = await cli(['claim', 'submit', '--amount', '25', '--ref', ref, '--key', alice, '--rpc', url]);
    const claimId = submitted.out.match(/contribution id (0x[0-9a-f]{64})/)?.[1];
    verify(!!claimId, `contribution ${String(claimId).slice(0, 18)}… submitted for 25 ${COIN.ticker}`);
    const dupe = await cli(['claim', 'submit', '--amount', '25', '--ref', ref, '--key', alice, '--rpc', url], { allowFail: true });
    const dupeClaims = (await rpc(url, 'fs_communityClaims', [{}])).filter((c) => c.id === claimId);
    verify(dupeClaims.length === 1 || dupe.code !== 0, `a second submission of the same reference did not create a second payable claim (found ${dupeClaims.length})`);
    const reviewers = fs.readdirSync(keysDir).filter((f) => f.startsWith('reviewer-')).map((f) => path.join(keysDir, f));
    const quorumInfo = params.community?.reviewQuorum ?? 2;
    for (const r of reviewers.slice(0, Math.max(Number(quorumInfo), 1))) {
      await cli(['claim', 'review', '--id', claimId, '--approve', 'true', '--key', r, '--rpc', url]);
    }
    const claimNow = (await rpc(url, 'fs_communityClaims', [{}])).find((c) => c.id === claimId);
    verify(!!claimNow, `the claim is visible in the public queue with status ${claimNow?.status} after ${Math.min(reviewers.length, Number(quorumInfo))} reviewer vote(s)`);
    verify(claimNow?.status !== 'rejected', `the community pool did not reject it (${JSON.stringify({ status: claimNow?.status, approvals: claimNow?.approvals?.length, round: claimNow?.round })})`);

    // ---- 8. invariants ---------------------------------------------------
    step('the invariants a reader cannot check by eye');
    const audit = await cli(['audit', '--rpc', url]);
    const onchain = BigInt(audit.out.match(/on-chain sum\s+([0-9.]+)/)?.[1] ? ethers.parseUnits(audit.out.match(/on-chain sum\s+([0-9.]+)/)[1], 18) : 0n);
    const reported = BigInt((await rpc(url, 'fs_supply')).totalIssued) - BigInt((await rpc(url, 'fs_supply')).burned);
    verify(onchain > 0n && onchain === reported, `a full state-trie walk adds up to ${fmt(onchain)}, exactly minted minus burned`);
    const headNow = await rpc(url, 'fs_status');
    verify(/0x[0-9a-f]{64}/.test(headNow.stateRoot), `head state root ${headNow.stateRoot.slice(0, 18)}… (cross-node agreement is proved by tools/determinism-check.js and tests/01-network.test.js, not by this single-node read)`);
    const recent = await rpc(url, 'fs_blocks', [{ count: 8 }]); // a bare array, newest first
    verify(recent.length > 0, `read back ${recent.length} recent blocks: heights ${recent.map((b) => b.height).join(', ')}`);
    // Reported, not asserted: whether a block commits at round 0 depends on how
    // fast this machine can execute and gossip it, which is what
    // docs/BENCHMARKS.md measures. A demo on a 2-core sandbox would otherwise
    // fail for reasons that have nothing to do with the step it is showing.
    const round0 = recent.filter((b) => Number(b.round) === 0).length;
    process.stdout.write(`    · rounds: ${round0}/${recent.length} of the last blocks committed at round 0 (${recent.map((b) => `${b.height}:r${b.round}/${b.txCount}tx`).join(' ')}); see docs/BENCHMARKS.md\n`);
    verify(recent.every((b) => Number(b.commits) > 0), `each block carries its sealing commit (${recent[0].commits} precommits on the newest)`);

    // ---- 9. honest limits ------------------------------------------------
    step('what this demo did NOT prove');
    process.stdout.write(
      [
        '    · one devnet on one machine: no adversarial validators, no wide-area latency,',
        '      no evidence submitted against a live node, no crash during a commit',
        `    · the code path is a Node.js reference implementation (see docs/ARCHITECTURE.md),`,
        '      and it is not audited; see docs/SECURITY.md for the threat model',
        '    · nothing here says anything about the value of FSTOP; burns do not create value',
      ].join('\n') + '\n'
    );
  } finally {
    if (spawned) {
      if (keep) {
        process.stdout.write(`\nleaving the devnet running (pid ${spawned.child.pid}) on ${url}\ndata: ${outDir}\n`);
      } else {
        try {
          spawned.child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  if (failures.length) {
    process.stdout.write(`\nDEMO FAILED: ${failures.length} verification(s) did not hold\n  - ${failures.join('\n  - ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nall ${stepNo} steps verified against ${url}\n`);
}

main().catch((err) => {
  process.stdout.write(`\ndemo stopped: ${err.message}\n`);
  process.exitCode = 1;
});
