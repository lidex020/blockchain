#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const { Chain } = require('../chain');
const { loadGenesis, toExecutionGenesis } = require('../genesis');
const { loadConfig, parseArgs } = require('../node');
const { ABCIApplication } = require('./application');
const { ABCISocketServer } = require('./socket-server');

const DATA_MARKER = '.lidex-comet-abci.json';

function assertNoSecrets(value, location = 'mapping file') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/private|secret|seed|priv_key/i.test(key)) throw new Error(`${location} must not contain secret material`);
    assertNoSecrets(nested, `${location}.${key}`);
  }
}

function loadValidatorMappings(file) {
  if (!file) throw new Error('--validator-map <public-key-mapping.json> is required');
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  assertNoSecrets(raw);
  if (raw.schema !== 'lidex-comet-validator-map-v1' || !Array.isArray(raw.validators)) {
    throw new Error('validator mapping file must use lidex-comet-validator-map-v1 and contain a validators array');
  }
  return raw.validators;
}

function resolveProfileArgs(args) {
  if (!args.profile) return { args, profileNetwork: null };
  const profilePath = path.resolve(args.profile);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const allowedFields = new Set(['schema', 'network', 'genesis', 'validatorMap', 'datadir', 'listen']);
  const unknownFields = Object.keys(profile ?? {}).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) throw new Error(`unknown ABCI profile fields: ${unknownFields.join(', ')}`);
  if (profile.schema !== 'lidex-abci-profile-v1' || !['devnet', 'testnet'].includes(profile.network)) {
    throw new Error('ABCI profiles must use lidex-abci-profile-v1 and explicitly select devnet or testnet');
  }
  for (const field of ['genesis', 'validatorMap', 'datadir', 'listen']) {
    if (typeof profile[field] !== 'string' || profile[field].length === 0) {
      throw new Error(`ABCI devnet/testnet profile requires a non-empty ${field}`);
    }
  }
  const resolveProfilePath = (value) => path.resolve(path.dirname(profilePath), value);
  return {
    args: {
      ...args,
      genesis: args.genesis ?? resolveProfilePath(profile.genesis),
      'validator-map': args['validator-map'] ?? resolveProfilePath(profile.validatorMap),
      datadir: args.datadir ?? resolveProfilePath(profile.datadir),
      listen: args.listen ?? profile.listen,
    },
    profileNetwork: profile.network,
  };
}

function prepareDedicatedDataDir(datadir, genesis) {
  const root = path.resolve(datadir);
  const marker = path.join(root, DATA_MARKER);
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(marker)) {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (
      saved.schema !== 'lidex-comet-abci-data-v1' ||
      saved.chainId !== String(genesis.chain_id) ||
      saved.genesisHash !== ethers.hexlify(require('../genesis').genesisHash(genesis)) ||
      saved.network !== genesis.network
    ) {
      throw new Error('ABCI data directory marker does not match this genesis; preserve the directory and inspect it separately');
    }
    return root;
  }
  const entries = fs.readdirSync(root);
  if (entries.length) {
    throw new Error('ABCI requires a new dedicated data directory; existing unmarked data is never adopted, overwritten, or reset');
  }
  const content = {
    schema: 'lidex-comet-abci-data-v1',
    chainId: String(genesis.chain_id),
    genesisHash: ethers.hexlify(require('../genesis').genesisHash(genesis)),
    network: genesis.network,
  };
  fs.writeFileSync(marker, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
  return root;
}

async function createCometApplication(args) {
  const resolved = resolveProfileArgs(args);
  args = resolved.args;
  if (!args.genesis || !args.datadir) throw new Error('--genesis and a new dedicated --datadir are required');
  const genesisPath = path.resolve(args.genesis);
  const genesis = loadGenesis(genesisPath);
  if (resolved.profileNetwork && genesis.network !== resolved.profileNetwork) {
    throw new Error(`ABCI profile network ${resolved.profileNetwork} does not match genesis network ${genesis.network}`);
  }
  if (genesis.network !== 'devnet' && genesis.network !== 'testnet') {
    throw new Error('CometBFT ABCI bootstrap only accepts explicit devnet/testnet genesis files');
  }
  const validatorMappings = loadValidatorMappings(args['validator-map']);
  const datadir = prepareDedicatedDataDir(args.datadir, genesis);
  const config = loadConfig({ ...args, genesis: genesisPath, datadir });
  let chain;
  try {
    chain = await Chain.create({
      genesis: toExecutionGenesis(config.genesis),
      datadir: config.datadir,
      params: config.params,
      mode: 'full',
    });
    const app = await ABCIApplication.create({
      chain,
      network: genesis.network,
      validatorMappings,
      stateFile: path.join(datadir, 'abci', 'blocks.jsonl'),
    });
    return { app, chain, genesis, args };
  } catch (error) {
    chain?.store?.releaseLock?.();
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { app, chain, genesis, args: resolvedArgs } = await createCometApplication(args);
  const server = new ABCISocketServer({
    application: app,
    listen: args.listen ?? process.env.LIDEX_ABCI_LISTEN ?? resolvedArgs.listen ?? 'tcp://127.0.0.1:26658',
  });
  try {
    const address = await server.start();
    process.stdout.write(`LIDEX ABCI++ ${genesis.network} app listening on ${address.address}:${address.port}\n`);
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await server.close();
    chain.store?.releaseLock?.();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`LIDEX ABCI++ startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createCometApplication, loadValidatorMappings, prepareDedicatedDataDir, resolveProfileArgs };
