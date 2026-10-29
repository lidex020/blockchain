#!/usr/bin/env node
'use strict';
/**
 * Testnet faucet client.
 *
 * The faucet is a node-side convenience for test networks only: it signs an
 * ordinary transfer from a funded account the node holds, so there is no
 * privileged minting path and a claim consumes real chain gas. The genesis
 * document decides whether a network has a faucet at all, and a mainnet genesis
 * leaves it disabled.
 *
 *   node scripts/faucet.js --to 0xYourAddress
 *   node scripts/faucet.js --to 0xYourAddress --rpc http://127.0.0.1:7300
 *   node scripts/faucet.js --balance
 */

const RPC_DEFAULT = 'http://127.0.0.1:7300';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function main() {
  const url = String(arg('rpc', RPC_DEFAULT));
  if (arg('help', false)) {
    process.stdout.write(
      ['Full Stop testnet faucet client', '', '  --to <address>     the account to fund', '  --rpc <url>        node to ask (default http://127.0.0.1:7300)', '  --balance          show the faucet account and its remaining budget', '  --watch            wait for the claim transaction to land', ''].join('\n')
    );
    return;
  }
  if (arg('balance', false)) {
    const status = await rpc(url, 'fs_faucetStatus').catch(async () => null);
    if (!status) {
      const supply = await rpc(url, 'fs_supply');
      process.stdout.write(`this node does not expose a faucet status method; community pool holds ${BigInt(supply.pools?.community?.issued ?? 0) / 10n ** 18n} LDX issued to it\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  const to = arg('to');
  if (!to) throw new Error('usage: node scripts/faucet.js --to <address> [--rpc <url>] [--watch]');

  const claim = await rpc(url, 'fs_faucet', [String(to)]);
  const amount = claim.amount ?? '0';
  process.stdout.write(
    `queued ${Number(BigInt(amount)) / 1e18} ${claim.ticker ?? 'LDX'} for ${to}\n  transaction ${claim.hash}\n`
  );
  // Verification is the default: a faucet client that prints "queued" and exits
  // green while the transaction never lands is how an operator ends up with a
  // funding script that silently does nothing.
  if (!arg('no-wait', false)) {
    for (let i = 0; i < 300; i++) {
      const receipt = await rpc(url, 'eth_getTransactionReceipt', [claim.hash]);
      if (receipt) {
        const balance = await rpc(url, 'eth_getBalance', [to, 'latest']);
        process.stdout.write(`  confirmed in block ${Number(BigInt(receipt.blockNumber))}; balance now ${Number(BigInt(balance)) / 1e18} LDX\n`);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('the claim transaction was not included within 60s');
  }
}

main().catch((err) => {
  process.stderr.write(`faucet: ${err.message}\n`);
  process.exit(1);
});
