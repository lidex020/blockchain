#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const { readKey } = require('../src/keys');
const { cometAddressForKey } = require('../src/abci/application');

const projectRoot = path.resolve(__dirname, '..');
const genesisFile = path.join(projectRoot, 'data', 'testnet', 'genesis.json');
const accountsFile = path.join(projectRoot, 'data', 'testnet', 'accounts.json');
const defaultOutput = path.join(projectRoot, 'profiles', 'cometbft.devnet.validators.json');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function buildMapping() {
  const genesis = JSON.parse(fs.readFileSync(genesisFile, 'utf8'));
  const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  if (genesis.network !== 'devnet' || !Array.isArray(genesis.validators) || !Array.isArray(accounts.validators)) {
    throw new Error('the existing devnet genesis and validator fixture records are required');
  }

  const validators = genesis.validators.map((validator) => {
    const operator = ethers.getAddress(validator.address);
    const fixture = accounts.validators.find((entry) => entry.operator.toLowerCase() === operator.toLowerCase());
    if (!fixture) throw new Error(`no existing test fixture is available for validator ${operator}`);
    const key = readKey(path.join(path.dirname(accountsFile), fixture.node_key_file));
    if (!key.consensusPrivateKey || key.address.toLowerCase() !== operator.toLowerCase()) {
      throw new Error(`test fixture identity does not match validator ${operator}`);
    }
    const consensusAddress = ethers.getAddress(validator.consensus_address ?? validator.address);
    if (key.consensusAddress.toLowerCase() !== consensusAddress.toLowerCase()) {
      throw new Error(`test fixture consensus identity does not match validator ${operator}`);
    }
    const publicKey = ethers.SigningKey.computePublicKey(key.consensusPrivateKey, true);
    return {
      operator,
      consensusAddress,
      keyType: 'secp256k1',
      publicKey,
      cometAddress: cometAddressForKey('secp256k1', Buffer.from(publicKey.slice(2), 'hex')),
    };
  });

  return { schema: 'lidex-comet-validator-map-v1', validators };
}

function main() {
  const output = path.resolve(argument('out', defaultOutput));
  const serialized = `${JSON.stringify(buildMapping(), null, 2)}\n`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try {
    fs.writeFileSync(output, serialized, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (error.code !== 'EEXIST' || fs.readFileSync(output, 'utf8') !== serialized) {
      throw new Error(`refusing to replace an existing validator mapping at ${output}`);
    }
  }
  process.stdout.write(`Public-only devnet validator mapping is ready at ${output}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Devnet mapping export failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildMapping };
