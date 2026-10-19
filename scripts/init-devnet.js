#!/usr/bin/env node
'use strict';
/**
 * Generate a Full Stop network configuration: genesis document, validator keys
 * and test accounts.
 *
 * This is a *development* bootstrap. A mainnet genesis would be produced by a
 * coordinated validator key ceremony with the private keys generated offline
 * and never written to a shared filesystem; see docs/VALIDATOR-OPS.md. What
 * this script produces is honest about being a test network: keys are written
 * in plaintext into the data directory (git-ignored) and the accounts are
 * labelled as test funding.
 *
 * Usage:
 *   node scripts/init-devnet.js --validators 4 --out data/devnet
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { createTx } = require('@ethereumjs/tx');
const { bytesToHex } = require('@ethereumjs/util');
const { createChainCommon } = require('../src/execution.js');
const { newKey, writeKey } = require('../src/keys.js');
const { toBase, GENESIS_SCHEMA, serializedAllocations, moduleFor } = require('../src/genesis.js');
const { COIN, SYSTEM, CHAIN, STAKING, BLOCK, FEES, COMMUNITY, VERSION } = require('../src/constants.js');
const { keccak256 } = require('ethereum-cryptography/keccak');

const ARTIFACTS = path.resolve(__dirname, '..', 'artifacts', 'contracts.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

function main() {
  const validatorCount = Number(arg('validators', '4'));
  const outDir = path.resolve(arg('out', path.join(__dirname, '..', 'data', 'devnet')));
  const chainId = BigInt(arg('chain-id', String(CHAIN.testnetChainId)));
  const networkName = arg('name', 'Full Stop Devnet');
  const blockTime = Number(arg('block-time', String(BLOCK.targetBlockTimeMs)));
  const unbonding = Number(arg('unbonding-blocks', '40'));
  const distribution = Number(arg('distribution-interval', '20'));
  const roundBlocks = Number(arg('community-round-blocks', '80'));
  const artifacts = JSON.parse(fs.readFileSync(ARTIFACTS, 'utf8')).artifacts;

  fs.mkdirSync(outDir, { recursive: true });
  const keyDir = path.join(outDir, 'keys');
  fs.mkdirSync(keyDir, { recursive: true });

  // ---- identities --------------------------------------------------------
  const deterministicSeed = arg('seed', null);
  const mk = (label) => {
    if (deterministicSeed) {
      const pk = ethers.keccak256(ethers.toUtf8Bytes(`${deterministicSeed}:${label}`));
      const w = new ethers.Wallet(pk);
      return { label, address: w.address, privateKey: w.privateKey, publicKey: w.publicKey, createdAt: new Date().toISOString(), warning: 'TEST KEY - derived from --seed; never use on a network with value.' };
    }
    return newKey(label);
  };

  const validators = [];
  for (let i = 1; i <= validatorCount; i++) {
    const operator = mk(`validator-${i}-operator`);
    const consensus = mk(`validator-${i}-consensus`);
    writeKey(keyDir, `v${i}-operator`, operator);
    writeKey(keyDir, `v${i}-consensus`, consensus);
    // Combined file the node can sign with: operator key for value-bearing
    // operations, consensus key for votes. Both are test keys.
    writeKey(keyDir, `v${i}`, {
      version: 1,
      label: `validator-${i}`,
      kind: 'validator',
      address: operator.address,
      privateKey: operator.privateKey,
      consensusAddress: consensus.address,
      consensusPrivateKey: consensus.privateKey,
      createdAt: new Date().toISOString(),
      warning: 'TEST KEY - never use on a network with value.',
    });
    validators.push({
      address: operator.address,
      consensus_address: consensus.address,
      moniker: `devnet-validator-${i}`,
      self_stake: toBase(arg('validator-stake', '5000')).toString(),
      commission_bps: '1000',
      website: `https://example.invalid/validator-${i}`,
      files: { validator: `keys/v${i}.json`, operator: `keys/v${i}-operator.json`, consensus: `keys/v${i}-consensus.json` },
    });
  }
  const deployer = mk('genesis-deployer');
  const faucet = mk('faucet');
  const reviewers = [mk('reviewer-1'), mk('reviewer-2'), mk('reviewer-3')];
  const users = [mk('alice'), mk('bob'), mk('carol'), mk('dave')];
  writeKey(keyDir, 'genesis-deployer', deployer);
  writeKey(keyDir, 'faucet', faucet);
  for (const r of reviewers) writeKey(keyDir, r.label, r);
  for (const u of users) writeKey(keyDir, u.label, u);

  // ---- system contract deployment (genesis transactions) -----------------
  // Deterministic addresses: registry at deployer nonce 0, then one factory
  // each. The deployer then registers the factories and hands ownership to the
  // protocol module account, which no key controls: after genesis the factory
  // set can only change through a governance-approved protocol upgrade.
  const ifaceFor = (name) => new ethers.Interface(artifacts[name].abi);
  const registryIface = ifaceFor('FullStopAssetRegistry');
  /** creation code = compiled initcode || ABI-encoded constructor arguments */
  const deployData = (name, args) => {
    const encoded = args.length ? ifaceFor(name).encodeDeploy(args).slice(2) : '';
    return artifacts[name].bytecode + encoded;
  };

  const txs = [];
  let nonce = 0;
  const registry = ethers.getCreateAddress({ from: deployer.address, nonce: 0 });
  void 0;
  const erc20Factory = ethers.getCreateAddress({ from: deployer.address, nonce: 1 });
  const erc721Factory = ethers.getCreateAddress({ from: deployer.address, nonce: 2 });
  const erc1155Factory = ethers.getCreateAddress({ from: deployer.address, nonce: 3 });

  const send = async (to, data, value = 0n, gasLimit = 6_000_000n) => {
    const tx = createTx(
      {
        type: 0,
        chainId,
        nonce: nonce++,
        gasLimit,
        gasPrice: FEES.minGasPrice,
        to: to ?? null,
        value,
        data,
      },
      { common: createChainCommon(chainId) }
    );
    const signed = tx.sign(ethers.getBytes(deployer.privateKey));
    txs.push(bytesToHex(signed.serialize()));
    return { nonce: nonce - 1, signed };
  };

  const jobs = [
    ['FullStopAssetRegistry', registry, deployData('FullStopAssetRegistry', [[erc20Factory, erc721Factory, erc1155Factory]]), 12_000_000n],
    ['FullStopERC20Factory', erc20Factory, deployData('FullStopERC20Factory', [registry]), 8_000_000n],
    ['FullStopERC721Factory', erc721Factory, deployData('FullStopERC721Factory', [registry]), 8_000_000n],
    ['FullStopERC1155Factory', erc1155Factory, deployData('FullStopERC1155Factory', [registry]), 8_000_000n],
  ];

  const runAsync = async () => {
    for (const [, expectedAddress, data, gas] of jobs) {
      const signed = await send(null, data, 0n, gas);
      const created = ethers.getCreateAddress({ from: deployer.address, nonce: signed.nonce });
      if (created.toLowerCase() !== expectedAddress.toLowerCase()) {
        throw new Error(`genesis deployment address drift: expected ${expectedAddress} at nonce ${signed.nonce}, got ${created}`);
      }
    }
    // Freeze the factory set: the registry's owner becomes the protocol module
    // account, which has no private key.
    await send(registry, registryIface.encodeFunctionData('transferOwnership', [SYSTEM.moduleAddress]), 0n, 500_000n);
    return txs;
  };

  return runAsync().then(() => {
    // ---- allocation ------------------------------------------------------
    const maxSupply = COIN.maxSupply;
    const alloc = [];

    const fund = (address, amountUnits, source, label, note) => {
      alloc.push({
        address,
        balance: toBase(amountUnits).toString(),
        source: source ? { pool: source, reason: note ?? 'genesis distribution' } : null,
        label: label ?? null,
        note: note ?? null,
      });
    };

    // The genesis deployer pays gas for the system contract deployment, so it
    // is funded from the ecosystem pool - every coin still traces to a pool.
    fund(deployer.address, '2', 'developers', 'genesis deployer', 'gas for system contract deployment at genesis');
    for (const v of validators) {
      fund(v.address, ethers.formatUnits(v.self_stake, COIN.decimals), 'developers', `validator ${v.moniker} operator`, 'testnet bootstrap self-bond');
    }
    for (const u of users) fund(u.address, '2500', 'community', `test account ${u.label}`, 'testnet funds for functional testing');
    // Reviewers pay gas to vote on claims, so a devnet whose reviewers are empty
    // cannot exercise the review path at all. Fund them like any other test
    // account and say so in accounts.json below.
    for (const r of reviewers) fund(r.address, '500', 'community', `reviewer ${r.label}`, 'gas funds so claims can be reviewed on a devnet');
    fund(faucet.address, arg('faucet-budget', '200000'), 'community', 'testnet faucet', 'testnet faucet budget');

    const genesis = {
      schema: GENESIS_SCHEMA,
      chain_id: String(chainId),
      name: networkName,
      network: arg('network', 'devnet'),
      genesis_time: new Date(Date.now() - (Date.now() % 1000)).toISOString(),
      software: VERSION.software,
      documentation:
        'This genesis file is generated by scripts/init-devnet.js. It is a test network: the FSTOP in it has no value and the keys are published on this machine.',
      protocol: {
        hardfork: 'shanghai',
        max_supply: maxSupply.toString(),
        initial_issuance: toBase('75000000').toString(),
        allocations: serializedAllocations(),
        block_subsidy: (10n ** 17n).toString(),
        burn_bps: FEES.burnBps.toString(),
        validator_fee_bps: FEES.validatorFeeBps.toString(),
        min_gas_price: FEES.minGasPrice.toString(),
        block_gas_limit: BLOCK.blockGasLimit.toString(),
        max_block_txs: BLOCK.maxBlockTxs,
        staking: {
          min_self_stake: STAKING.minSelfStake.toString(),
          min_delegation: STAKING.minDelegation.toString(),
          unbonding_blocks: unbonding,
          max_commission_bps: STAKING.maxCommissionBps.toString(),
          max_active_validators: STAKING.maxActiveValidators,
          reward_distribution_interval: distribution,
          downtime_window: 30,
          double_sign_slash_bps: '2000',
          downtime_slash_bps: '100',
          jail_duration_blocks: 30,
        },
        community: {
          round_blocks: roundBlocks,
          round_budget: toBase('500').toString(),
          max_per_address_per_round: toBase('50').toString(),
          approval_quorum: 2,
        },
        rewards: { pool_share_bps: '2500', bps_denominator: '10000' },
      },
      alloc,
      validators: validators.map((v) => ({
        address: v.address,
        consensus_address: v.consensus_address,
        moniker: v.moniker,
        self_stake: v.self_stake,
        commission_bps: v.commission_bps,
        website: v.website,
      })),
      reviewers: reviewers.map((r) => ({ address: r.address, label: r.label })),
      system_contracts: {
        asset_registry: registry,
        erc20_factory: erc20Factory,
        erc721_factory: erc721Factory,
        erc1155_factory: erc1155Factory,
        protocol_module: SYSTEM.moduleAddress,
        community_pool: SYSTEM.communityPoolAddress,
        validator_reward_pool: SYSTEM.validatorPoolAddress,
        vesting: SYSTEM.vestingAddress,
        fee_collector: SYSTEM.feeCollectorAddress,
      },
      genesis_txs: txs,
      contract_artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([name, a]) => [name, { source: a.source, deployedCodeHash: a.deployedCodeHash, abi: a.abi }])
      ),
      consensus: {
        block_time_ms: blockTime,
        min_block_interval_ms: Math.max(100, Math.floor(blockTime / 3)),
        double_sign_window_blocks: 100_000,
        algorithm: 'FSC/0.1 - round-based BFT over a staked validator set (see docs/ADR.md)',
      },
      faucet: {
        enabled: true,
        address: faucet.address,
        key_file: 'keys/faucet.json',
        amount: toBase('25').toString(),
        cooldown_ms: 60_000,
        budget: toBase('200000').toString(),
        note: 'testnet only: hands out coin from a funded faucet account as an ordinary transfer, never by minting',
      },
    };

    const genesisPath = path.join(outDir, 'genesis.json');
    fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));

    const accounts = {
      warning: 'TEST KEYS ONLY - this file is generated for a local devnet and is git-ignored. Never send anything of value to these addresses.',
      deployer: { address: deployer.address, key_file: 'keys/genesis-deployer.json' },
      faucet: { address: faucet.address, key_file: 'keys/faucet.json' },
      reviewers: reviewers.map((r) => ({ address: r.address, key_file: `keys/${r.label}.json` })),
      users: users.map((u) => ({ address: u.address, key_file: `keys/${u.label}.json` })),
      validators: validators.map((v) => ({ moniker: v.moniker, operator: v.address, node_key_file: v.files.validator, operator_key_file: v.files.operator, consensus_key_file: v.files.consensus })),
    };
    fs.writeFileSync(path.join(outDir, 'accounts.json'), JSON.stringify(accounts, null, 2));

    process.stdout.write(
      [
        `wrote ${genesisPath}`,
        `chain id        ${chainId}`,
        `validators      ${validatorCount} (keys under ${path.relative(process.cwd(), keyDir)}/)`,
        `asset registry  ${registry}`,
        `erc20 factory   ${erc20Factory}`,
        `genesis hash    ${ethers.hexlify(keccak256(ethers.toUtf8Bytes(JSON.stringify(genesis)))).slice(0, 18)}...`,
        flag('quiet') ? '' : JSON.stringify({ genesisPath, validators: validators.map((v) => v.address) }, null, 2),
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    );
    return { genesisPath, genesis, validators, accounts };
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('init failed:', err);
    process.exit(1);
  });
}

module.exports = { main };
