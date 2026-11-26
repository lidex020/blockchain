#!/usr/bin/env node
'use strict';
/**
 * Generate a LIDEX public-testnet genesis directory.
 *
 * This wrapper reuses the exact genesis construction in
 * scripts/init-devnet.js (createNetwork) with network=testnet, but it is
 * deliberately stricter than the devnet bootstrap:
 *
 *   - --chain-id is REQUIRED and must be an owner-approved public testnet
 *     chain id. It is never defaulted.
 *   - The devnet chain id (721220) and the mainnet candidate id (72122)
 *     are rejected, so a public testnet can never be launched on a devnet
 *     or mainnet id by accident.
 *   - The output directory must be empty (or not exist); an existing
 *     genesis is never overwritten.
 *
 * Until an approved chain id and a genesis ceremony exist, this script
 * will refuse to run. That is intentional: a public testnet genesis must
 * not be improvised.
 *
 * Usage:
 *   node scripts/init-testnet.js --chain-id <approved-id> --out data/testnet \
 *     --validators 4
 */

const fs = require('node:fs');
const path = require('node:path');
const { CHAIN, BLOCK } = require('../src/constants');
const { createNetwork } = require('./init-devnet');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function parseChainId(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(
      'public testnet genesis requires an explicit owner-approved --chain-id; ' +
        'refusing to default a chain id for a public network'
    );
  }
  let chainId;
  try {
    chainId = BigInt(String(raw).trim());
  } catch {
    throw new Error(`--chain-id must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  if (chainId <= 0n) throw new Error(`--chain-id must be a positive integer, got ${raw}`);
  const forbidden = new Map([
    [BigInt(CHAIN.devnetChainId), 'devnet chain id 721220'],
    [BigInt(CHAIN.chainId), 'mainnet candidate chain id 72122'],
  ]);
  if (forbidden.has(chainId)) {
    throw new Error(`refusing to create a public testnet on the ${forbidden.get(chainId)}; supply a distinct owner-approved testnet chain id`);
  }
  return chainId;
}

function assertEmptyOutDir(outDir) {
  if (!fs.existsSync(outDir)) return;
  const entries = fs.readdirSync(outDir);
  if (entries.length) {
    throw new Error(
      `refusing to write a public testnet genesis into non-empty directory ${outDir}; ` +
        'preserve the existing directory and use a new --out path'
    );
  }
}

async function main() {
  const chainId = parseChainId(arg('chain-id', null));
  const outDir = path.resolve(arg('out', path.join(__dirname, '..', 'data', 'testnet')));
  assertEmptyOutDir(outDir);

  // A public testnet genesis must not be derived from a published seed.
  // The local test fixture (seed fs-testnet-seed) is generated with
  // scripts/init-devnet.js and is never a public testnet.
  if (arg('seed', null)) {
    throw new Error('refusing --seed for a public testnet genesis; deterministic seed keys are local-fixture only');
  }

  return createNetwork({
    validators: Number(arg('validators', '4')),
    outDir,
    chainId,
    networkName: arg('name', 'Lidex Testnet'),
    network: 'testnet',
    blockTime: Number(arg('block-time', String(BLOCK.targetBlockTimeMs))),
    unbondingBlocks: Number(arg('unbonding-blocks', '40')),
    distributionInterval: Number(arg('distribution-interval', '20')),
    communityRoundBlocks: Number(arg('community-round-blocks', '80')),
    seed: null,
    validatorStake: arg('validator-stake', '5000'),
    faucetBudget: arg('faucet-budget', '200000'),
    genesisTime: arg('genesis-time', undefined),
    quiet: flag('quiet'),
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('init-testnet failed:', err.message ?? err);
    process.exit(1);
  });
}

module.exports = { main, parseChainId, assertEmptyOutDir };
