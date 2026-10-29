#!/usr/bin/env node
'use strict';
/**
 * Full Stop command line interface.
 *
 * A thin, honest wrapper over the pieces that already exist: the node, the
 * devnet generator, the key files, and the JSON-RPC surface. Everything here
 * is something a wallet or an indexer could do over RPC too - the CLI is a
 * reference client, not a privileged tool. Anything that changes chain state
 * is an ordinary signed transaction and costs gas.
 *
 *   fullstop help
 *   fullstop keys new --label validator-1 --out data/devnet/keys
 *   fullstop status --rpc http://127.0.0.1:7300
 *   fullstop send --rpc ... --key data/devnet/keys/alice.json --to 0x.. --value 1.5
 *   fullstop stake bond --rpc ... --key ... --operator 0x.. --value 250
 *   fullstop asset token --rpc ... --key ... --name "Demo" --symbol DEMO ...
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const { SYSTEM, COIN, STAKING, REWARDS, FEES } = require('./constants');
const { newKey, writeKey, readKey } = require('./keys');
const { SELECTORS, SYSTEM_ABI } = require('./staking');

// ------------------------------------------------------------------ utilities

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
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function isWithinDirectory(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function rpc(url, method, params = []) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (err) {
    // A transport failure is almost always "you are not talking to a node", and
    // a bare `fetch failed` does not say that, so name the url and the fix.
    throw new Error(`no node reachable at ${url} (${err.message}) - start one with \`fullstop devnet\` or pass --rpc <url>`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

const fmtFstop = (wei) => `${ethers.formatUnits(BigInt(wei ?? 0), COIN.decimals)} ${COIN.ticker}`;

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stderr.write(`fullstop: ${message}\n`);
  process.exit(1);
}

function loadWallet(args, url) {
  const keyFile = args.key;
  if (!keyFile) fail('this action needs --key <file> (an operator or account key)');
  const key = readKey(path.resolve(String(keyFile)));
  return new ethers.Wallet(key.privateKey, new ethers.JsonRpcProvider(url));
}

async function send(wallet, url, tx, { wait = true, quiet = false } = {}) {
  const chainId = Number(BigInt(await rpc(url, 'eth_chainId')));
  const gasPrice = BigInt(await rpc(url, 'eth_gasPrice'));
  const nonce = tx.nonce ?? (await wallet.provider.getTransactionCount(wallet.address));
  const signed = await wallet.signTransaction({
    ...tx,
    nonce,
    gasPrice,
    chainId,
    type: 0,
    gasLimit: tx.gasLimit ?? 100_000n,
  });
  const hash = await rpc(url, 'eth_sendRawTransaction', [signed]);
  if (!quiet) out(`sent ${hash}`);
  if (!wait) return { hash };
  for (let i = 0; i < 300; i++) {
    const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash]);
    if (receipt) {
      const status = Number(BigInt(receipt.status));
      if (!quiet) {
        out(`  included in block ${Number(BigInt(receipt.blockNumber))}, status ${status === 1 ? 'success' : 'REVERTED'}, gas used ${Number(BigInt(receipt.gasUsed))}`);
        out(`  fee paid ${fmtFstop(BigInt(receipt.effectiveGasPrice) * BigInt(receipt.gasUsed))}`);
      }
      return { hash, receipt, ok: status === 1 };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { hash, receipt: null, ok: false };
}

/** Calldata for a protocol action on the module account. */
function systemCall(action, args = []) {
  const frag = SYSTEM_ABI.getFunction(action);
  if (!frag) fail(`unknown system action "${action}" (one of: ${Object.keys(SELECTORS).join(', ')})`);
  return SYSTEM_ABI.encodeFunctionData(frag, args);
}

// ------------------------------------------------------------------- commands

const commands = {
  async help() {
    out(
      [
        'Full Stop Blockchain - command line interface',
        '',
        '  node                 run a validator or full node (see: fullstop node --help)',
        '  devnet               start a local N-validator development network',
        '  init                 generate a genesis + keys for a new devnet/testnet',
        '  compile              compile the system contracts with solc',
        '',
        '  status               chain status (height, validators, versions)',
        '  supply               issuance, burn, cap and per-pool accounting',
        '  audit                walk the state trie and check supply conservation',
        '  validators           the validator set, stake and commission',
        '  validator <address>  one validator in detail, including delegators',
        '  account <address>    balance, nonce, code flag',
        '  blocks [--count n]   recent blocks',
        '  tx <hash>            transaction + receipt',
        '  mempool              pool contents and limits',
        '  evidence             accepted slashable evidence',
        '  claims               community participation claims',
        '',
        '  send --to .. --value .. --key ..            transfer native LDX',
        '  stake register --moniker .. --commission .. --key ..   become a validator',
        '  stake bond --operator .. --value .. --key ..           delegate',
        '  stake unbond --operator .. --value .. --key ..         start unbonding',
        '  stake unjail --key ..                                  re-activate after jail',
        '  claim submit --id .. --amount .. --ref .. --key ..     request a community reward',
        '  claim review --id .. --approve true|false --key ..     reviewer decision',
        '  asset token|collection|multi-token ...                 deploy via the official factories',
        '  faucet --to ..                                         testnet claim (if this node runs one)',
        '',
        '  demo                 end-to-end tour of a devnet, verifying every step',
        '  bench                run the load benchmark (writes docs/BENCHMARKS.md)',
        '  test                 run the test suites',
        '  determinism          verify two nodes reproduce the same roots',
        '',
        'Every command takes --rpc <url> (default http://127.0.0.1:7300).',
        'State-changing commands need --key <file>; they are ordinary signed',
        'transactions and pay the ordinary fee.',
        '',
      ].join('\n')
    );
  },

  version: async (args) => {
    const { VERSION } = require('./constants');
    const lines = [VERSION.software, `protocol ${VERSION.appVersion}`];
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    try {
      const [client, chainId, height] = await Promise.all([rpc(url, 'web3_clientVersion'), rpc(url, 'eth_chainId'), rpc(url, 'eth_blockNumber')]);
      lines.push(`node    ${client} at ${url}`, `chain id ${BigInt(chainId)}`, `head height ${Number(BigInt(height))}`);
    } catch {
      lines.push(`node    none reachable at ${url} (pass --rpc <url>)`);
    }
    out(lines.join('\n'));
  },

  /** `fullstop keys new --label alice --out data/devnet/keys` */
  keys: async (args) => {
    const sub = args._[1];
    if (sub === 'new') {
      const label = String(args.label ?? `key-${Date.now()}`);
      const dir = path.resolve(String(args.out ?? '.'));
      if (!isWithinDirectory(process.cwd(), dir)) {
        fail(`refusing to write keys outside the working directory (${process.cwd()})`);
      }
      const key = newKey(label);
      const file = writeKey(dir, label.replace(/[^a-z0-9._-]/gi, '-'), key);
      out(`wrote ${file}`);
      out(`  address ${key.address}`);
      out(`  ${key.warning}`);
      return;
    }
    if (sub === 'show') {
      const file = args.file ?? args._[2];
      if (!file) fail('usage: fullstop keys show <file> [--out <dir>]');
      const key = readKey(path.isAbsolute(String(file)) ? String(file) : path.resolve(String(args.out ?? '.'), String(file)));
      out(JSON.stringify({ label: key.label, address: key.address, consensusAddress: key.consensusAddress ?? key.address }, null, 2));
      return;
    }
    fail('usage: fullstop keys new --label <name> --out <dir> | keys show --file <path>');
  },

  init: async (args) => run(path.join(ROOT, 'scripts', 'init-devnet.js'), passthrough(['validators', 'out', 'chain-id', 'name', 'block-time', 'unbonding-blocks', 'distribution-interval', 'community-round-blocks', 'validator-stake', 'faucet-budget', 'network', 'seed'], args)),
  compile: async (args) => run(path.join(ROOT, 'scripts', 'compile-contracts.js'), []),
  devnet: async (args) => {
    const argv = passthrough(['validators', 'out', 'base-port'], args);
    if (args.reset) argv.push('--reset');
    return run(path.join(ROOT, 'scripts', 'start-devnet.js'), argv);
  },
  node: async (args) => run(path.join(ROOT, 'src', 'node.js'), process.argv.slice(3)),
  bench: async (args) => run(path.join(ROOT, 'scripts', 'benchmark.js'), process.argv.slice(3)),
  test: async (args) => run(path.join(ROOT, 'tests', 'run.js'), process.argv.slice(3)),
  demo: (args) => run('scripts/demo.js', passthrough(['rpc', 'validators', 'keep', 'keys'], args)),

  determinism: async (args) => run(path.join(ROOT, 'tools', 'determinism-check.js'), process.argv.slice(3)),
  acceptance: async (args) => run(path.join(ROOT, 'tests', 'run.js'), process.argv.slice(3)),

  status: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const s = await rpc(url, 'fs_status');
    out(
      [
        `chain        ${s.chainName} (id ${BigInt(s.chainId)})`,
        `head         height ${s.height}  ${s.blockHash.slice(0, 18)}…`,
        `app hash     ${s.appHash.slice(0, 26)}…`,
        `state root   ${s.stateRoot.slice(0, 26)}…`,
        `validators   ${s.validators} bonded, ${s.txCount} transactions in the chain`,
        `mempool      ${s.mempool?.total ?? 0} pending (${s.mempool?.rejected ?? 0} rejected lifetime)`,
        `versions     ${s.nodeVersion} / protocol ${s.protocolVersion} / ${s.hardfork}`,
        `consensus    ${s.consensus ? `${s.consensus.step} at height ${s.consensus.height} round ${s.consensus.round}, quorum ${s.consensus.quorum}` : 'not a validator'}`,
        `peers        ${(s.peers ?? []).length}`,
      ].join('\n')
    );
  },

  supply: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const r = await rpc(url, 'fs_supply');
    const coins = (v) => ethers.formatUnits(BigInt(v), COIN.decimals);
    out(
      [
        `hard cap        ${coins(r.maxSupply)} ${COIN.ticker}`,
        `issued          ${coins(r.totalIssued)}  (${((Number(r.totalIssued) / Number(r.maxSupply)) * 100).toFixed(2)}% of the cap)`,
        `burned          ${coins(r.burned)}`,
        `unissued        ${coins(r.unissued)}`,
        `locked in       ${coins(r.locked)}  (vesting + reward pools)`,
        `circulating     ${coins(r.circulatingLowerBound)}  (lower bound: issued minus locked)`,
        `escrow          required ${coins(r.staking?.escrowRequired ?? 0)}, bonded ${coins(r.staking?.bonded ?? 0)}`,
        '',
        'pools:',
        ...Object.entries(r.pools ?? {}).map(([k, p]) => `  ${k.padEnd(14)} ${coins(p.allocation)} allocated, ${coins(p.issued)} issued, ${coins(p.remaining)} remaining [${p.mode}]`),
        '',
        `community round ${r.communityRound?.index ?? 0}: ${coins(r.communityRound?.spent ?? 0)} of ${coins(r.communityRound?.budget ?? 0)} spent over ${r.communityRound?.claims ?? 0} claims`,
        `events          ${r.eventCount} recorded, root ${String(r.eventRoot).slice(0, 18)}…`,
      ].join('\n')
    );
  },

  audit: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const a = await rpc(url, 'fs_supplyAudit');
    out(
      [
        `conservation    ${a.ok ? 'OK' : 'VIOLATED'}`,
        `on-chain sum    ${fmtFstop(a.onchainTotal)}`,
        `minted-burned   ${fmtFstop(a.ledgerTotal)}`,
        `difference      ${a.difference}`,
        `accounts seen   ${a.accounts}`,
        `head-room       ${fmtFstop(a.headroom)} below the cap`,
      ].join('\n')
    );
    if (!a.ok) process.exitCode = 1;
  },

  validators: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const list = await rpc(url, 'fs_validators');
    out(`${list.length} registered validator(s)`);
    for (const v of list) {
      out(
        `  ${v.operator}  ${v.moniker ?? ''}\n` +
          `    status ${v.status.padEnd(10)} commission ${(Number(v.commissionBps) / 100).toFixed(2)}%\n` +
          `    self ${fmtFstop(v.selfStake)}  total ${fmtFstop(v.totalStake)}  power ${v.power}\n` +
          `    missed ${v.missedBlocks} blocks${v.jailReason ? `  jailed for ${v.jailReason}` : ''}`
      );
    }
  },

  validator: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const address = args._[1];
    if (!address) fail('usage: fullstop validator <operator-address>');
    const v = await rpc(url, 'fs_validator', [address]);
    out(v ? JSON.stringify(v, null, 2) : 'not found');
  },

  account: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const address = args._[1] ?? args.address;
    if (!address) fail('usage: fullstop account <address>');
    const a = await rpc(url, 'fs_account', [address]);
    out(JSON.stringify(a, null, 2));
  },

  blocks: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const list = await rpc(url, 'fs_blocks', [{ count: Number(args.count ?? 12) }]);
    out(['height  time                     txs  gas used    round proposer'.trim()]);
    for (const b of list) {
      out(`${String(b.height).padEnd(7)} ${b.time}  ${String(b.txCount).padStart(3)}  ${String(b.gasUsed).padStart(9)}  ${String(b.round).padStart(4)} ${b.proposer}`);
    }
  },

  tx: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const hash = args._[1];
    if (!hash) fail('usage: fullstop tx <hash>');
    const [tx, receipt] = await Promise.all([rpc(url, 'eth_getTransactionByHash', [hash]), rpc(url, 'eth_getTransactionReceipt', [hash])]);
    if (!tx) fail('unknown transaction');
    out(JSON.stringify({ transaction: tx, receipt }, null, 2));
  },

  mempool: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const m = await rpc(url, 'fs_mempool', [{ limit: Number(args.limit ?? 20) }]);
    out(JSON.stringify(m, null, 2));
  },

  evidence: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    out(JSON.stringify(await rpc(url, 'fs_evidence'), null, 2));
  },

  claims: async (args) => {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const list = await rpc(url, 'fs_communityClaims', [{ status: args.status, limit: Number(args.limit ?? 50) }]);
    if (!list.length) return out('no claims recorded');
    for (const c of list) {
      out(`${c.id.slice(0, 18)}…  ${c.status.padEnd(8)} ${fmtFstop(c.amount)} → ${c.beneficiary}  round ${c.round}  approvals ${c.approvals?.length ?? 0}  ${c.reference ?? ''}`);
    }
  },

  async send(args) {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const wallet = loadWallet(args, url);
    if (!args.to || args.value === undefined) fail('usage: fullstop send --to <address> --value <LDX> --key <file>');
    const gas = args.gas ? BigInt(String(args.gas)) : 21_000n;
    const r = await send(wallet, url, { to: ethers.getAddress(String(args.to)), value: ethers.parseUnits(String(args.value), COIN.decimals), gasLimit: gas, data: args.data ? String(args.data) : '0x' });
    if (!r.ok) process.exitCode = 1;
  },

  async stake(args) {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const action = args._[1];
    const wallet = loadWallet(args, url);
    const value = args.value !== undefined ? ethers.parseUnits(String(args.value), COIN.decimals) : 0n;
    let data;
    switch (action) {
      case 'register': {
        if (!args.moniker) fail('stake register needs --moniker <name>');
        const commissionBps = BigInt(args.commissionBps ?? STAKING.defaultCommissionBps);
        data = systemCall('registerValidator', [String(args.moniker), args.consensusAddress ? ethers.getAddress(String(args.consensusAddress)) : wallet.address, commissionBps]);
        break;
      }
      case 'bond':
        if (!args.operator) fail('stake bond needs --operator <address>');
        data = systemCall('bond', [ethers.getAddress(String(args.operator))]);
        break;
      case 'unbond':
        if (!args.operator) fail('stake unbond needs --operator <address>');
        data = systemCall('unbond', [ethers.getAddress(String(args.operator)), value]);
        break;
      case 'rebond':
        if (!args.operator) fail('stake rebond needs --operator <address>');
        data = systemCall('rebond', [ethers.getAddress(String(args.operator)), value]);
        break;
      case 'unjail':
        data = systemCall('unjail', []);
        break;
      case 'fund-community':
        data = systemCall('fundCommunity', [value]);
        break;
      default:
        fail('usage: fullstop stake register|bond|unbond|rebond|unjail|fund-community --help for flags');
    }
    const r = await send(wallet, url, { to: SYSTEM.moduleAddress, value, data, gasLimit: 200_000n });
    if (r.receipt) {
      const actions = r.receipt.fsProtocolActions ?? [];
      for (const a of actions) out(`  protocol: ${a.action ?? 'system'} → ${a.ok ? 'accepted' : `REFUSED (${a.reason ?? 'no reason'})`}`);
      if (actions.length && actions.every((a) => !a.ok)) process.exitCode = 1;
    }
  },

  async claim(args) {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const action = args._[1];
    const wallet = loadWallet(args, url);
    if (action === 'submit') {
      // A contribution id is any bytes32. Passing --id makes a claim
      // re-submittable-by-id (duplicate claims are refused); hashing --ref is
      // the convenience path, and it dedupes on the reference text itself.
      const id = args.id
        ? /^0x[0-9a-fA-F]{64}$/.test(String(args.id))
          ? String(args.id)
          : ethers.id(String(args.id))
        : ethers.id(String(args.ref ?? 'contribution'));
      const beneficiary = args.beneficiary ? ethers.getAddress(String(args.beneficiary)) : wallet.address;
      const amount = ethers.parseUnits(String(args.amount ?? '0'), COIN.decimals);
      const data = systemCall('submitContribution', [id, beneficiary, amount, String(args.ref ?? '')]);
      out(`contribution id ${id}`);
      const r = await send(wallet, url, { to: SYSTEM.moduleAddress, value: 0, data, gasLimit: 200_000n });
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (action === 'review') {
      if (!args.id) fail('claim review needs --id <bytes32>');
      const data = systemCall('reviewContribution', [String(args.id), args.approve === true || String(args.approve) === 'true']);
      const r = await send(wallet, url, { to: SYSTEM.moduleAddress, value: 0, data, gasLimit: 200_000n });
      if (!r.ok) process.exitCode = 1;
      return;
    }
    fail('usage: fullstop claim submit --amount <LDX> [--ref <text>] | claim review --id <bytes32> --approve true|false');
  },

  async asset(args) {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const kind = args._[1];
    // Reading the registry is public: it must not ask for a key, and any node
    // can answer it, which is what explorers and wallets do.
    if (kind === 'list' || kind === 'show') {
      if (kind === 'list') {
        const page = await rpc(url, 'fs_assets', [{ offset: Number(args.offset ?? 0), limit: Number(args.limit ?? 25) }]);
        out(`asset registry ${page.registry}: ${page.total} registered asset(s)${page.note ? ` (${page.note})` : ''}`);
        for (const a of page.assets ?? []) {
          out(`  ${a.contractAddress}  ${String(a.kind).padEnd(9)} ${a.name} (${a.symbol})  by ${a.creator}  block ${a.blockNumber}`);
        }
        if (!(page.assets ?? []).length) out('  (none yet)');
        return;
      }
      const addr = args.address ?? args._[2];
      if (!addr) fail('usage: fullstop asset show <address> [--rpc <url>]');
      const one = await rpc(url, 'fs_asset', [String(addr)]);
      if (!one) fail(`${addr} is not registered with this network's asset registry`);
      out(JSON.stringify(one, null, 2));
      return;
    }
    const wallet = loadWallet(args, url);
    const nodeParams = await rpc(url, 'fs_params');
    const contracts = nodeParams.systemContracts ?? {};
    const factory = { token: contracts.erc20_factory, collection: contracts.erc721_factory, 'multi-token': contracts.erc1155_factory }[kind];
    if (!factory) fail(`no ${kind} factory address in this network's genesis (known: ${Object.keys(contracts).join(', ')})`);
    const iface = new ethers.Interface(
      kind === 'token'
        ? ['function createToken((string name,string symbol,uint8 decimals,uint256 initialSupply,uint256 maxSupply,bool mintable,bool burnable,bool transferRestricted,address supplyRecipient) p)']
        : ['function createCollection(string name,string symbol,string baseUri,uint256 maxSupply)']
    );
    const name = String(args.name ?? 'Full Stop Asset');
    const symbol = String(args.symbol ?? 'FSA');
    let data;
    if (kind === 'token') {
      data = iface.encodeFunctionData('createToken', [
        {
          name,
          symbol,
          decimals: Number(args.decimals ?? 18),
          initialSupply: ethers.parseUnits(String(args.supply ?? '0'), Number(args.decimals ?? 18)),
          maxSupply: args.cap ? ethers.parseUnits(String(args.cap), Number(args.decimals ?? 18)) : 0n,
          mintable: args.mintable === true || String(args.mintable) === 'true',
          burnable: args.burnable === true || String(args.burnable) === 'true',
          transferRestricted: args.restricted === true || String(args.restricted) === 'true',
          supplyRecipient: args.recipient ? ethers.getAddress(String(args.recipient)) : wallet.address,
        },
      ]);
    } else {
      data = iface.encodeFunctionData('createCollection', [name, symbol, String(args.baseUri ?? 'ipfs://'), args.maxId ? BigInt(String(args.maxId)) : 0n]);
    }
    // A call to a factory leaves receipt.contractAddress null: the deployed
    // address is only in the factory's event and in the registry, so read the
    // registry entry that this transaction added instead of guessing.
    const before = BigInt((await rpc(url, 'fs_assets', [{ limit: 1 }])).total ?? '0');
    const r = await send(wallet, url, { to: factory, data, value: 0, gasLimit: 6_000_000n });
    if (!r.receipt) return (process.exitCode = 1);
    if (!r.ok) {
      process.exitCode = 1;
      fail(`the create transaction reverted (gas used ${r.receipt.gasUsed}); nothing was registered`);
    }
    const after = BigInt((await rpc(url, 'fs_assets', [{ limit: 1 }])).total ?? '0');
    let created = r.receipt.contractAddress;
    if (after > before) {
      const page = await rpc(url, 'fs_assets', [{ offset: Number(before), limit: 1 }]);
      created = page.assets?.[0]?.contractAddress ?? created;
    }
    out(created ? `  contract ${created}` : '  the transaction succeeded but no new registry entry was found');
    if (created) out(`  details  ${JSON.stringify(await rpc(url, 'fs_asset', [created]))}`);
    out(`  registry now holds ${after} asset(s)`);
  },

  faucet: (args) =>
    // One implementation, and it proves the credit landed before exiting green.
    run('scripts/faucet.js', passthrough(['rpc', 'to', 'balance', 'no-wait'], args)),

  async gas(args) {
    const url = args.rpc ?? 'http://127.0.0.1:7300';
    const price = BigInt(await rpc(url, 'eth_gasPrice'));
    out(
      [
        `gas price      ${price} wei/gas (${Number(price) / 1e9} gwei)`,
        `transfer cost  ${21000n * price} wei = ${ethers.formatUnits(21000n * price, COIN.decimals)} ${COIN.ticker}`,
        `fee floor      ${FEES.minGasPrice} wei/gas`,
        `fee split      ${Number(FEES.burnBps) / 100}% of every fee is destroyed, ${Number(FEES.validatorFeeBps) / 100}% is paid to validators`,
      ].join('\n')
    );
  },
};

/** Flags copied straight through to the delegated script. */
function passthrough(names, args) {
  const out = [];
  for (const n of names) if (args[n] !== undefined && args[n] !== true) out.push(`--${n}`, String(args[n]));
  if (args.help) out.push('--help');
  return out;
}

/** Run another script in this repo as a child process, inheriting the terminal. */
function run(script, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...argv], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code) process.exitCode = code;
      resolve();
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const name = String(args._[0] ?? 'help');
  const fn = commands[name];
  if (!fn) fail(`unknown command "${name}" - try: fullstop help`);
  await fn(args);
}

if (require.main === module) {
  // A usage or connectivity failure is one line; a stack is only noise unless
  // someone is debugging the CLI itself.
  main().catch((err) => fail(process.env.FULLSTOP_DEBUG ? err.stack ?? err.message : err.message));
}

module.exports = { main, parseArgs, systemCall, SELECTORS, isWithinDirectory };
