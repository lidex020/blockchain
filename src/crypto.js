'use strict';
/**
 * Cryptographic primitives used by the Full Stop protocol.
 *
 * Everything here is Ethereum-native: keccak256 hashing and secp256k1
 * signatures over the same digests wallets already produce, so a validator
 * key, a delegator key and a contract owner key are all the same kind of
 * object.
 */

const { ethers } = require('ethers');

const keccak256Bytes = (data) => ethers.getBytes(ethers.keccak256(data));
const keccak256Hex = (data) => ethers.keccak256(data);

/** keccak256 over the UTF-8 encoding of a string. */
const hashString = (s) => keccak256Bytes(ethers.toUtf8Bytes(s));

function generateKey() {
  const key = ethers.Wallet.createRandom();
  return {
    privateKey: key.privateKey,
    address: key.address,
    publicKey: key.publicKey,
  };
}

function keyFromPrivate(privateKey) {
  const w = new ethers.Wallet(privateKey);
  return {
    privateKey: w.privateKey,
    publicKey: w.publicKey,
    address: w.address,
  };
}

/**
 * Sign an arbitrary 32-byte digest. Returns a 65-byte r || s || v payload
 * with a recovery id, suitable for consensus vote and block sealing.
 */
function signDigest(digest, privateKey) {
  const sig = new ethers.SigningKey(privateKey).sign(digest);
  return ethers.concat([
    ethers.toBeHex(sig.r, 32),
    ethers.toBeHex(sig.s, 32),
    ethers.toBeHex(sig.yParity === 1 ? 1 : 0, 1),
  ]);
}

function verifyDigest(digest, signature, address) {
  try {
    const rec = ethers.recoverAddress(digest, signature);
    return rec.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

const recoverAddress = (digest, signature) => ethers.recoverAddress(digest, signature);

/** Deterministic 32-byte digest over a JSON-serialisable object. */
function hashObject(obj) {
  return keccak256Bytes(ethers.toUtf8Bytes(stableStringify(obj)));
}

/** JSON.stringify with sorted object keys - required for deterministic hashes. */
function stableStringify(value) {
  // BigInt is not typeof 'object', so it has to be handled before the generic
  // branch: JSON.stringify throws on it, and consensus values are bigints.
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',') + '}';
}

/**
 * Merkle root over a list of 32-byte leaves. Empty list -> keccak256('')
 * so that an empty list still has a stable, non-null root.
 */
function merkleRoot(leaves) {
  if (leaves.length === 0) return keccak256Bytes(Uint8Array.from([]));
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(keccak256Bytes(ethers.concat([left, right])));
    }
    level = next;
  }
  return level[0];
}

/** Simple salted hash used for contribution ids and storage keys. */
function shortHash(data, length = 16) {
  return ethers.hexlify(keccak256Bytes(data)).slice(2, 2 + length);
}

module.exports = {
  keccak256Bytes,
  keccak256Hex,
  hashString,
  hashObject,
  stableStringify,
  generateKey,
  keyFromPrivate,
  signDigest,
  verifyDigest,
  recoverAddress,
  merkleRoot,
  shortHash,
};
