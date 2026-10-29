'use strict';
/**
 * Node, RPC and wallet integration tests.
 *
 * A real node process is started on a free port and driven over HTTP exactly
 * the way a wallet or dapp drives it: JSON-RPC batch calls, ethers.js signing,
 * eth_call against a deployed contract, log filters, a restart, and a
 * second node that has to sync by re-executing.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const WebSocket = require('ws');

const { Suite, assert, assertEqual, toBase } = require('./helpers.js');
const { SYSTEM, FEES } = require('../src/constants.js');

const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// The RPC suite runs against its own single-validator network so a lone node
// can reach a quorum; consensus behaviour under a real validator set is
// covered by the network suite instead.
const NETDIR = path.join(ROOT, 'data', 'rpcnet');
const GENESIS = path.join(NETDIR, 'genesis.json');

function ensureNetwork(dir, validators) {
  const genesisPath = path.join(dir, 'genesis.json');
  if (!fs.existsSync(genesisPath)) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'init-devnet.js'), '--out', dir, '--validators', String(validators), '--seed', 'fs-rpcnet', '--block-time', '250', '--unbonding-blocks', '8', '--distribution-interval', '4', '--community-round-blocks', '40', '--quiet'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not generate the test network:\n${r.stdout}\n${r.stderr}`);
  }
  return genesisPath;
}
ensureNetwork(NETDIR, 1);
const UNIT = 10n ** 18n;
const ART = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'contracts.json'), 'utf8')).artifacts;

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

async function call(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message);
    err.rpcCode = json.error.code;
    throw err;
  }
  return json.result;
}

async function headHeight(url) {
  return BigInt(await call(url, 'eth_blockNumber'));
}

async function waitForHeight(url, height, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    try {
      const n = await headHeight(url);
      if (n >= BigInt(height)) return n;
    } catch {
      /* still booting */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`node never reached height ${height}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForReceipt(url, hash, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const rc = await call(url, 'eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) return rc;
    if (Date.now() - started > timeoutMs) throw new Error(`transaction ${hash} never produced a receipt`);
    await new Promise((r) => setTimeout(r, 350));
  }
}

/** Boot a node process. `role` validator joins the devnet genesis validator set. */
async function startNode(role, opts = {}) {
  const port = await pickPort();
  const url = `http://127.0.0.1:${port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsnode-${role}-`));
  const keyDir = path.join(NETDIR, 'keys');
  const args = [path.join(ROOT, 'src', 'node.js'), '--genesis', GENESIS, '--datadir', dir, '--port', String(port), '--moniker', `test-${role}`];
  if (role === 'validator') args.push('--key', path.join(keyDir, `v${opts.validatorIndex ?? 1}.json`), '--faucet-key', path.join(keyDir, 'faucet.json'));
  if (opts.peers) args.push('--peers', opts.peers);
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, FULLSTOP_LOG_LEVEL: process.env.FULLSTOP_LOG_LEVEL ?? 'warn' } });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const handle = {
    url,
    port,
    dir,
    get log() {
      return log;
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
      if (!handle.keepDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  try {
    await waitForHeight(url, opts.waitFor ?? 1);
  } catch (err) {
    throw new Error(`${err.message}\nnode output:\n${log.slice(-3000)}`);
  }
  return handle;
}

async function run(suite) {
  const accounts = JSON.parse(fs.readFileSync(path.join(NETDIR, 'accounts.json'), 'utf8'));
  const genesis = JSON.parse(fs.readFileSync(GENESIS, 'utf8'));
  const chainId = Number(genesis.chain_id);
  const keyOf = (rel) => JSON.parse(fs.readFileSync(path.join(NETDIR, rel), 'utf8')).privateKey;
  const alice = new ethers.Wallet(keyOf(accounts.users[0].key_file));

  let node = await startNode('validator');
  let url = node.url;
  /** Always read the nonce live: a cached provider nonce is how tests race. */
  const nonceOf = async (addr) => Number(BigInt(await call(url, 'eth_getTransactionCount', [addr, 'latest'])));

  try {
    await suite.test('staking parameters are JSON-safe over RPC', async () => {
      const params = await call(url, 'fs_stakingParams');
      assert(params.minSelfStake !== undefined, 'minimum self-stake parameter is missing');
      assert(/^\d+$/.test(params.minSelfStake), `minimum self-stake was not serialized as a decimal string: ${params.minSelfStake}`);
      assert(/^\d+$/.test(params.escrowBalance), `escrow balance was not serialized as a decimal string: ${params.escrowBalance}`);
      assert(/^\d+$/.test(params.escrowRequired), `escrow requirement was not serialized as a decimal string: ${params.escrowRequired}`);
    });

    await suite.test('the node produces blocks on its own and serves them over JSON-RPC', async () => {
      const h0 = await headHeight(url);
      await waitForHeight(url, Number(h0 + 2n), 30_000);
      const block = await call(url, 'eth_getBlockByNumber', ['latest', false]);
      assert(block && block.hash, 'no head block');
      assert(/^0x[0-9a-f]{64}$/.test(block.stateRoot), 'block state root');
      assertEqual(block.baseFeePerGas, '0x0', 'base fee is zero on this chain');
      assertEqual(block.miner.toLowerCase(), SYSTEM.feeCollectorAddress.toLowerCase(), 'coinbase is the protocol fee collector');
      // headers must be linked
      const parent = await call(url, 'eth_getBlockByNumber', ['0x' + (BigInt(block.number) - 1n).toString(16), false]);
      assertEqual(block.parentHash, parent.hash, 'block linkage');
    });

    await suite.test('a raw transfer signs, lands in a block, and the receipt is complete', async () => {
      const to = ethers.Wallet.createRandom().address;
      const nonce = await nonceOf(alice.address);
      const raw = await alice.signTransaction({ to, value: toBase('7'), gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice), nonce, chainId });
      const hash = await call(url, 'eth_sendRawTransaction', [raw]);
      const rc = await waitForReceipt(url, hash);
      assertEqual(rc.status, '0x1', 'receipt status');
      assertEqual(BigInt(rc.gasUsed), 21000n, 'gas used');
      assertEqual(rc.from.toLowerCase(), alice.address.toLowerCase(), 'receipt from');
      assertEqual(rc.to.toLowerCase(), to.toLowerCase(), 'receipt to');
      const bal = await call(url, 'eth_getBalance', [to, 'latest']);
      assertEqual(BigInt(bal), toBase('7'), 'recipient balance');
      const tx = await call(url, 'eth_getTransactionByHash', [hash]);
      assertEqual(tx.blockHash, rc.blockHash, 'transaction/block agreement');
      assertEqual(BigInt(tx.transactionIndex), BigInt(rc.transactionIndex), 'transaction index');
      assertEqual(await call(url, 'eth_getTransactionCount', [alice.address, 'latest']), '0x' + (nonce + 1).toString(16), 'nonce advanced');
    });

    await suite.test('a replayed transaction is accepted by the pool only once, and never twice', async () => {
      const to = ethers.Wallet.createRandom().address;
      const raw = await alice.signTransaction({ to, value: toBase('1'), gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice), nonce: await nonceOf(alice.address), chainId });
      const hash = await call(url, 'eth_sendRawTransaction', [raw]);
      const again = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: [raw] }) });
      const json = await again.json();
      assertEqual(json.result, hash, 're-submitting the same bytes returns the same hash');
      await waitForReceipt(url, hash);
      const after = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: [raw] }) });
      const afterJson = await after.json();
      assert(afterJson.error, 'a confirmed transaction must not be accepted again');
      assert(/nonce too low/i.test(afterJson.error.message), `unexpected rejection: ${afterJson.error.message}`);
    });

    await suite.test('a transaction signed for another chain is refused with a clear message', async () => {
      const w = new ethers.Wallet(keyOf(accounts.users[2].key_file));
      const foreign = await w.signTransaction({ to: w.address, value: 0n, gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice), nonce: await nonceOf(w.address), chainId: chainId + 1 });
      let err = null;
      try {
        await call(url, 'eth_sendRawTransaction', [foreign]);
      } catch (e) {
        err = e;
      }
      assert(err, 'a foreign-chain transaction was accepted');
      assert(/chain id|chainId/i.test(err.message), `unhelpful error: ${err.message}`);
    });

    await suite.test('an underpriced transaction is refused by the fee floor', async () => {
      const raw = await alice.signTransaction({ to: alice.address, value: 0n, gasLimit: 21000n, gasPrice: 1n, nonce: await nonceOf(alice.address), chainId });
      let err = null;
      try {
        await call(url, 'eth_sendRawTransaction', [raw]);
      } catch (e) {
        err = e;
      }
      assert(err && /floor/i.test(err.message), `fee floor not enforced: ${err?.message}`);
    });

    await suite.test('a contract deploys through RPC, is readable, logs an event, and filters by address', async () => {
      const iface = new ethers.Interface(ART.LDXERC20.abi);
      const deployData = ART.LDXERC20.bytecode + iface.encodeDeploy(['RPC Token', 'RPC', 18, toBase('1000'), 0, true, true, false, alice.address, '0x' + '00'.repeat(20)]).slice(2);
      const raw = await alice.signTransaction({ to: null, data: deployData, gasLimit: 6_000_000n, gasPrice: BigInt(FEES.minGasPrice), nonce: await nonceOf(alice.address), chainId });
      const hash = await call(url, 'eth_sendRawTransaction', [raw]);
      const rc = await waitForReceipt(url, hash);
      assertEqual(rc.status, '0x1', 'deployment reverted');
      const token = rc.contractAddress;
      assert(token, 'no contract address');
      const code = await call(url, 'eth_getCode', [token, 'latest']);
      assert(code.length > 40, 'no code at the deployed address');
      const bal = await call(url, 'eth_call', [{ to: token, data: iface.encodeFunctionData('balanceOf', [alice.address]) }, 'latest']);
      assertEqual(BigInt(bal), toBase('1000'), 'eth_call balanceOf');
      const transfer = iface.encodeFunctionData('transfer', [ethers.Wallet.createRandom().address, toBase('10')]);
      const est = await call(url, 'eth_estimateGas', [{ from: alice.address, to: token, data: transfer }]);
      assert(BigInt(est) > 21000n, `estimate too low: ${est}`);
      const txr = await alice.signTransaction({ to: token, data: transfer, gasLimit: BigInt(est), gasPrice: BigInt(FEES.minGasPrice), nonce: await nonceOf(alice.address), chainId });
      const h2 = await call(url, 'eth_sendRawTransaction', [txr]);
      const rc2 = await waitForReceipt(url, h2);
      assertEqual(rc2.status, '0x1', 'the transfer at the estimated gas limit should succeed');
      assertEqual(rc2.logs.length, 1, 'expected a single Transfer log');
      assertEqual(rc2.logs[0].address.toLowerCase(), token.toLowerCase(), 'log address');
      const logs = await call(url, 'eth_getLogs', [{ address: token }]);
      // two Transfer logs exist for this token: the genesis of supply in the
      // constructor, and the transfer above
      assertEqual(logs.length, 2, 'eth_getLogs by address');
      assert(logs.every((l) => l.address.toLowerCase() === token.toLowerCase()), 'filter leaked another contract');
      assertEqual(logs[logs.length - 1].transactionHash, rc2.transactionHash, 'log points back at its transaction');
      const inRange = await call(url, 'eth_getLogs', [{ address: token, fromBlock: rc2.blockNumber, toBlock: rc2.blockNumber }]);
      assertEqual(inRange.length, 1, 'a single-block range should isolate the transfer log');
      // and the same call is visible through the block-level index
      const blockTxs = await call(url, 'eth_getBlockTransactionCountByHash', [rc2.blockHash]);
      assert(BigInt(blockTxs) >= 1n, 'block transaction count');
    });

    await suite.test('a log range larger than the node is willing to serve is refused', async () => {
      let err = null;
      try {
        await call(url, 'eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x' + (10n ** 6n).toString(16) }]);
      } catch (e) {
        err = e;
      }
      assert(err && /limit/i.test(err.message), `range guard missing: ${err?.message}`);
    });

    await suite.test('a second node syncs the chain by re-executing it and reaches the same app hash', async () => {
      await waitForHeight(url, 3, 30_000);
      const peer = await startNode('full', { peers: url.replace(/\/$/, ''), waitFor: 0 });
      try {
        const target = await headHeight(url);
        await waitForHeight(peer.url, Number(target), 90_000);
        const [a, b] = await Promise.all([call(url, 'fs_status'), call(peer.url, 'fs_status')]);
        assert(b.height >= a.height - 3, `peer only reached ${b.height} of ${a.height}`);
        const height = Math.min(a.height, b.height);
        const [ra, rb] = await Promise.all([
          call(url, 'eth_getBlockByNumber', ['0x' + BigInt(height).toString(16), false]),
          call(peer.url, 'eth_getBlockByNumber', ['0x' + BigInt(height).toString(16), false]),
        ]);
        assertEqual(rb.stateRoot, ra.stateRoot, 'the syncing node computed a different state root');
        assertEqual(rb.extraData, ra.extraData, 'the syncing node computed a different app hash');
        const [sa, sb] = await Promise.all([call(url, 'fs_supplyAudit'), call(peer.url, 'fs_supplyAudit')]);
        assert(sa.ok && sb.ok, `conservation failed: ${JSON.stringify({ sa, sb })}`);
      } finally {
        await peer.stop();
      }
    });

    await suite.test('a restarted node replays its log and resumes from the same head', async () => {
      await waitForHeight(url, 4, 30_000);
      const before = await call(url, 'fs_status');
      const beforeBlock = await call(url, 'eth_getBlockByNumber', ['0x' + BigInt(before.height).toString(16), false]);
      node.keepDir = true;
      await node.stop();
      node.keepDir = true;
      const dir = node.dir;
      const port = await pickPort();
      const restartUrl = `http://127.0.0.1:${port}/`;
      const child = spawn(
        process.execPath,
        [path.join(ROOT, 'src', 'node.js'), '--genesis', GENESIS, '--datadir', dir, '--port', String(port), '--key', path.join(NETDIR, 'keys', 'v1.json')],
        { cwd: ROOT, env: process.env }
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      try {
        await waitForHeight(restartUrl, before.height, 90_000);
        const after = await call(restartUrl, 'fs_status');
        assert(after.height >= before.height, `the restarted node went backwards: ${after.height} < ${before.height}`);
        // Compare the *same height* on both sides: the node keeps producing, so
        // "current head" is not a stable thing to assert on.
        const replayedBlock = await call(restartUrl, 'eth_getBlockByNumber', ['0x' + BigInt(before.height).toString(16), false]);
        assertEqual(replayedBlock.stateRoot, beforeBlock.stateRoot, `replay did not reproduce the state root\n${out.slice(-1500)}`);
        assertEqual(replayedBlock.extraData, beforeBlock.extraData, 'replay did not reproduce the app hash');
        assertEqual(replayedBlock.hash, beforeBlock.hash, 'replay did not reproduce the block hash');
        // and it keeps producing after the restart
        await waitForHeight(restartUrl, after.height + 2, 30_000);
      } finally {
        child.kill('SIGTERM');
        await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
        fs.rmSync(dir, { recursive: true, force: true });
      }
      // hand the suite back a live node for the tests that follow
      node = await startNode('validator');
      url = node.url;
      void restartUrl;
    });

    await suite.test('the explorer app is served and its network descriptor matches the node', async () => {
      const res = await fetch(url.replace(/\/$/, '') + '/');
      assertEqual(res.status, 200, 'explorer not served');
      const html = await res.text();
      assert(html.includes('LIDEX'), 'unexpected page');
      assert(!/<link[^>]+href=["'](?!data:)[^"']*\.css/.test(html), 'the app must not depend on external stylesheets');
      const logo = await fetch(url.replace(/\/$/, '') + '/lidex-logo.png');
      assertEqual(logo.status, 200, 'Lidex logo not served');
      assert(logo.headers.get('content-type')?.startsWith('image/png'), 'Lidex logo must be served as PNG');
      const descriptor = await (await fetch(url.replace(/\/$/, '') + '/network.json')).json();
      assertEqual(descriptor.chainId, String(chainId), 'network.json chain id');
      assertEqual(descriptor.rpcUrl.replace(/\/$/, ''), url.replace(/\/$/, ''), 'network.json rpc url');
      assertEqual(descriptor.chainName, 'Lidex Blockchain', 'network name');
      assert(descriptor.contracts.erc20_factory, 'network.json advertises the asset factories');
      assertEqual(descriptor.currency.symbol, 'LDX', 'currency symbol');
      assertEqual(descriptor.currency.name, 'Lidex Coin', 'currency name');
      assertEqual(descriptor.currency.decimals, 18, 'currency decimals');
      assert(descriptor.currency.name, 'currency name');
    });

    await suite.test('the node serves asset factory ABIs for older genesis files', async () => {
      const res = await fetch(url.replace(/\/$/, '') + '/contract-abis.json');
      assertEqual(res.status, 200, 'compiled contract ABIs not served');
      const { abis } = await res.json();
      for (const name of ['FullStopERC20Factory', 'FullStopERC721Factory', 'FullStopERC1155Factory']) {
        assert(Array.isArray(abis[name]), `missing ABI for ${name}`);
      }
      assert(
        abis.FullStopERC20Factory.some((entry) => entry.type === 'function' && entry.name === 'createToken'),
        'ERC-20 factory ABI is incomplete'
      );
      for (const name of ['FullStopERC721Factory', 'FullStopERC1155Factory']) {
        assert(abis[name].some((entry) => entry.type === 'function' && entry.name === 'createCollection'), `${name} ABI is incomplete`);
      }
    });

    await suite.test('wallet_addEthereumChain metadata is derivable from the node itself', async () => {
      const descriptor = await (await fetch(url.replace(/\/$/, '') + '/network.json')).json();
      const cfg = {
        chainId: '0x' + BigInt(descriptor.chainId).toString(16),
        chainName: descriptor.chainName,
        nativeCurrency: descriptor.currency,
        rpcUrls: [descriptor.rpcUrl],
        blockExplorerUrls: [descriptor.explorerUrl],
      };
      assertEqual(cfg.chainId, '0x' + BigInt(chainId).toString(16), 'chain id hex');
      assertEqual(cfg.nativeCurrency.symbol, 'LDX', 'nativeCurrency.symbol is the field a wallet reads');
      assert(cfg.rpcUrls[0].startsWith('http'), 'rpc url');
      assert(cfg.blockExplorerUrls[0].startsWith('http'), 'explorer url');
    });

    await suite.test('WebSocket subscriptions stream new heads', async () => {
      const wsUrl = url.replace(/^http/, 'ws') + 'ws';
      const ws = new WebSocket(wsUrl);
      const first = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no newHeads notification within 25s')), 25_000);
        ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })));
        ws.on('message', (buf) => {
          const msg = JSON.parse(buf.toString());
          if (msg.method === 'eth_subscription') {
            clearTimeout(t);
            resolve(msg.params.result);
          }
        });
        ws.on('error', (e) => {
          clearTimeout(t);
          reject(e);
        });
      });
      ws.close();
      assert(/^0x[0-9a-f]+$/.test(first.number), 'newHeads number');
      assert(/^0x[0-9a-f]{64}$/.test(first.stateRoot), 'newHeads state root');
    });

    await suite.test('the faucet pays an ordinary transfer, then enforces its cooldown', async () => {
      const to = ethers.Wallet.createRandom().address;
      const r = await call(url, 'fs_faucet', [to]);
      assert(r && r.hash, `faucet response was not usable: ${JSON.stringify(r)}`);
      assert(r.amount !== undefined, `faucet response missing the amount: ${JSON.stringify(r)}`);
      await waitForReceipt(url, r.hash);
      assertEqual(BigInt(await call(url, 'eth_getBalance', [to, 'latest'])), BigInt(r.amount), 'faucet amount');
      let err = null;
      try {
        await call(url, 'fs_faucet', [to]);
      } catch (e) {
        err = e;
      }
      assert(err && /again|cooldown/i.test(err.message), `cooldown not enforced: ${err?.message}`);
    });

    await suite.test('fs_params reports the live genesis parameters, not compiled-in defaults', async () => {
      const params = await call(url, 'fs_params');
      assertEqual(params.chainId, String(chainId), 'chain id');
      assertEqual(params.ticker, 'LDX', 'ticker');
      assertEqual(params.decimals, 18, 'decimals');
      assertEqual(BigInt(params.maxSupply), toBase('100000000'), 'the hard cap the node enforces');
      assert(BigInt(params.blockGasLimit) > 0n, 'block gas limit');
      assert(BigInt(params.minGasPriceWei) >= BigInt(FEES.minGasPrice), 'fee floor');
      assert(params.systemContracts?.asset_registry, 'the registry address is published');
      assert(/^0x0{32}f5700001$/i.test(params.moduleAddress), 'the protocol module account wallets must send stake to');
      assert(params.limits.rpcRequestsPerMinute > 0, 'the node publishes its own rpc budget');
    });

    await suite.test('an asset created through the official factory is readable from the registry over RPC', async () => {
      const genesis = await call(url, 'fs_genesis');
      const factory = genesis.system_contracts.erc20_factory;
      assert(factory, 'this network was generated without the erc20 factory');
      const abi = ART.FullStopERC20Factory.abi;
      const iface = new ethers.Interface(abi);
      const empty = await call(url, 'fs_assets', [{}]);
      assert(Array.isArray(empty.assets), 'fs_assets returns a page');
      assert(/^[0-9]+$/.test(String(empty.total)), `fs_assets.total must be a JSON-safe decimal string, got ${empty.total}`);
      const before = BigInt(empty.total);

      const data = iface.encodeFunctionData('createToken', [
        {
          name: 'Factory RPC Token',
          symbol: 'FRPC',
          decimals: 18,
          initialSupply: toBase('500'),
          maxSupply: toBase('1000'),
          mintable: true,
          burnable: false,
          transferRestricted: false,
          supplyRecipient: alice.address,
        },
      ]);
      const raw = await alice.signTransaction({ to: factory, data, gasLimit: 8_000_000n, gasPrice: BigInt(FEES.minGasPrice), nonce: await nonceOf(alice.address), chainId });
      const hash = await call(url, 'eth_sendRawTransaction', [raw]);
      const rc = await waitForReceipt(url, hash);
      assertEqual(rc.status, '0x1', 'the factory call reverted');

      // the factory's receipt has no contractAddress: the address it deployed is
      // in the TokenCreated event, exactly as a wallet would read it
      const created = new ethers.Interface(abi).parseLog(rc.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase()));
      const asset = created?.args?.asset ?? rc.contractAddress;
      assert(asset, `no TokenCreated event in ${JSON.stringify(rc.logs).slice(0, 300)}`);

      const after = await call(url, 'fs_assets', [{ limit: 50 }]);
      assertEqual(BigInt(after.total), before + 1n, 'the registry grew by exactly one asset');
      const mine = after.assets.find((a) => a.contractAddress?.toLowerCase() === String(asset).toLowerCase());
      assert(mine, `the new asset is not in the registry page: ${JSON.stringify(after.assets).slice(0, 400)}`);
      assertEqual(mine.kind, 'ERC-20', 'kind decoded from the enum');
      assertEqual(mine.creator.toLowerCase(), alice.address.toLowerCase(), 'creator is the sender, not the factory');
      assertEqual(mine.name, 'Factory RPC Token', 'name');
      const one = await call(url, 'fs_asset', [asset]);
      assertEqual(one.symbol, 'FRPC', 'fs_asset reads the same record');
      // and the same data is readable without the node's help, which is what a
      // wallet actually does: the rpc view is a convenience, not a source of truth
      const direct = await call(url, 'eth_call', [{ to: genesis.system_contracts.asset_registry, data: new ethers.Interface(ART.FullStopAssetRegistry.abi).encodeFunctionData('assetCount', []) }]);
      assertEqual(BigInt(direct), before + 1n, 'assetCount agrees with fs_assets');
      const unknown = await call(url, 'fs_asset', [ethers.Wallet.createRandom().address]);
      assertEqual(unknown, null, 'an unregistered contract reports null, not an empty object');
    });

    await suite.test('the faucet status is honest about what it can spend', async () => {
      const status = await call(url, 'fs_faucetStatus');
      assert(status.enabled === true, 'faucet should be enabled on this test network');
      assert(/^[0-9]+$/.test(String(status.balance)), `faucet balance must be a decimal string, got ${status.balance}`);
      assert(BigInt(status.balance) >= 0n, 'faucet balance');
      assert(BigInt(status.amountPerClaim) > 0n, 'amount per claim');
      assert(status.cooldownMs > 0, 'a cooldown is configured');
    });

    await suite.test('a huge request burst is rate limited rather than queued forever', async () => {
      const info = await call(url, 'fs_rateLimitInfo');
      const burst = Math.min(info.limit + 200, 1400);
      const responses = [];
      const concurrency = 50;
      for (let offset = 0; offset < burst; offset += concurrency) {
        const batchSize = Math.min(concurrency, burst - offset);
        const batch = await Promise.all(
          Array.from({ length: batchSize }, () =>
            fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
            }).then((r) => r.status)
          )
        );
        responses.push(...batch);
      }
      assert(responses.includes(429), 'the rate limiter never pushed back on a burst beyond its published limit');
      const served = responses.filter((s) => s === 200).length;
      assert(served <= info.limit, `the limiter served ${served} requests above its advertised allowance of ${info.limit}`);
      assert(served >= info.limit - 300, `the limiter cut off far too early: ${served} of ${info.limit}`);
    });
  } finally {
    await node.stop().catch(() => {});
  }
}

module.exports = { run, title: 'Node, RPC and wallet integration' };

if (require.main === module) {
  const suite = new Suite(module.exports.title);
  run(suite).then(() => process.exit(suite.summary() ? 1 : 0));
}
