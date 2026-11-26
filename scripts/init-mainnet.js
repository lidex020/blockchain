#!/usr/bin/env node
'use strict';
/**
 * Generate a LIDEX public Mainnet genesis directory.
 *
 * This wrapper reuses the exact genesis construction in
 * scripts/init-devnet.js (createNetwork) with network=mainnet, but it is
 * deliberately stricter than the devnet bootstrap:
 *
 *   - --chain-id is REQUIRED and must be an owner-approved Mainnet chain id.
 *     It is never defaulted.
 *   - The devnet chain id (721220) is rejected, so Mainnet can never be
 *     launched on a devnet id by accident.
 *   - The faucet is disabled (faucetEnabled: false). Mainnet has no faucet.
 *   - --seed is refused. Mainnet validator and account keys must be generated
 *     offline through a genesis ceremony, never derived from a published seed.
 *   - The output directory must be empty (or not exist); an existing genesis
 *     is never overwritten.
 *
 * Until an approved chain id and a genesis ceremony exist, this script
 * will refuse to run. That is intentional: a public Mainnet genesis must
 * not be improvised.
 *
 * Usage:
 *   node scripts/init-mainnet.js --chain-id 72122 --out data/mainnet \
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
      'public Mainnet genesis requires an explicit owner-approved --chain-id; ' +
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
  // Reject the devnet chain id. The approved Mainnet id (72122) is allowed.
  if (chainId === BigInt(CHAIN.devnetChainId)) {
    throw new Error(`refusing to create a public Mainnet on the devnet chain id 721220; supply the approved Mainnet chain id`);
  }
  return chainId;
}

function assertEmptyOutDir(outDir) {
  if (!fs.existsSync(outDir)) return;
  const entries = fs.readdirSync(outDir);
  if (entries.length) {
    throw new Error(
      `refusing to write a public Mainnet genesis into non-empty directory ${outDir}; ` +
        'preserve the existing directory and use a new --out path'
    );
  }
}

async function main() {
  const chainId = parseChainId(arg('chain-id', null));
  const outDir = path.resolve(arg('out', path.join(__dirname, '..', 'data', 'mainnet')));
  assertEmptyOutDir(outDir);

  // A public Mainnet genesis must not be derived from a published seed.
  // Deterministic seed keys are local-fixture only.
  if (arg('seed', null)) {
    throw new Error('refusing --seed for a public Mainnet genesis; deterministic seed keys are local-fixture only');
  }

  return createNetwork({
    validators: Number(arg('validators', '4')),
    outDir,
    chainId,
    networkName: arg('name', 'Lidex Mainnet'),
    network: 'mainnet',
    blockTime: Number(arg('block-time', String(BLOCK.targetBlockTimeMs))),
    unbondingBlocks: Number(arg('unbonding-blocks', '40')),
    distributionInterval: Number(arg('distribution-interval', '20')),
    communityRoundBlocks: Number(arg('community-round-blocks', '80')),
    seed: null,
    faucetEnabled: false,
    validatorStake: arg('validator-stake', '5000'),
    faucetBudget: arg('faucet-budget', '200000'),
    genesisTime: arg('genesis-time', undefined),
    quiet: flag('quiet'),
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('init-mainnet failed:', err.message ?? err);
    process.exit(1);
  });
}

module.exports = { main, parseChainId, assertEmptyOutDir };
