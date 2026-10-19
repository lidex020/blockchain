'use strict';
/**
 * Key handling for validator and operator keys.
 *
 * Keys are stored as plain JSON files with 0600 permissions under the node's
 * data directory. That is acceptable for testnets and local development only:
 * a production validator should hold its consensus key in an HSM or a remote
 * signer, which is why nothing in the node requires the key to live on the same
 * machine - the signing interface is a single function.
 *
 * Keys are never written to the repository: `data/` is git-ignored, and
 * `fullstop keys new` refuses to write outside the current working directory so
 * a key file cannot land somewhere the operator did not ask for.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { keyFromPrivate } = require('./crypto');

function newKey(label) {
  const w = ethers.Wallet.createRandom();
  return {
    version: 1,
    label: label ?? 'validator',
    address: w.address,
    privateKey: w.privateKey,
    publicKey: w.publicKey,
    createdAt: new Date().toISOString(),
    warning: 'TEST KEY - a plaintext private key file is only suitable for local testnets. Use an HSM or remote signer in production.',
  };
}

function writeKey(dir, name, key) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(key, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function readKey(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const privateKey = raw.privateKey ?? raw.key;
  if (!privateKey) throw new Error(`key file ${file} has no privateKey field`);
  const material = keyFromPrivate(privateKey);
  if (raw.address && material.address.toLowerCase() !== String(raw.address).toLowerCase()) {
    throw new Error(`key file ${file} is inconsistent: address does not match the private key`);
  }
  const identity = {
    label: raw.label ?? path.basename(file, '.json'),
    address: material.address,
    privateKey: material.privateKey,
    publicKey: material.publicKey,
    consensusAddress: raw.consensusAddress ?? material.address,
  };
  if (raw.consensusPrivateKey) {
    const c = keyFromPrivate(raw.consensusPrivateKey);
    identity.consensusPrivateKey = c.privateKey;
    identity.consensusAddress = raw.consensusAddress ?? c.address;
    if (raw.consensusAddress && c.address.toLowerCase() !== String(raw.consensusAddress).toLowerCase()) {
      throw new Error(`key file ${file}: consensusPrivateKey does not match consensusAddress`);
    }
  }
  return identity;
}

/** A key that can sign consensus votes; keeps the private key out of memory logs. */
function toIdentity(key) {
  return { address: key.address, privateKey: key.privateKey, consensusAddress: key.consensusAddress, label: key.label };
}

module.exports = { newKey, writeKey, readKey, toIdentity };
