'use strict';
/**
 * Block and vote encoding for the Full Stop consensus layer.
 *
 * A Full Stop block wraps an EVM block (the transactions themselves are
 * ordinary RLP-encoded Ethereum transactions) with the consensus header the
 * validator network signs: parent link, proposer, round, data/evidence roots,
 * the EVM state root produced by executing those transactions, and the
 * application hash produced by the protocol transition.
 */

const { ethers } = require('ethers');
const { keccak256Bytes, stableStringify, hashObject, merkleRoot } = require('./crypto');
const { BLOCK, VERSION } = require('./constants');

/** Deterministic hash of a block header. */
function headerHash(header) {
  return hashObject(header);
}

/**
 * Merkle root over a list of byte payloads. Hex strings are decoded, JSON
 * payloads are hashed over their UTF-8 encoding. This is the only definition of
 * a data/evidence root in the codebase: the proposer computes it here and every
 * validator re-computes it here, so the two can never disagree by convention.
 */
function bytesRoot(list) {
  return merkleRoot(
    list.map((item) => {
      if (typeof item !== 'string') return keccak256Bytes(item);
      return /^0x[0-9a-fA-F]*$/.test(item) ? keccak256Bytes(ethers.getBytes(item)) : keccak256Bytes(ethers.toUtf8Bytes(item));
    })
  );
}

/** Root over raw transaction payloads. */
const dataRoot = (txs) => (txs.length ? bytesRoot(txs) : emptyLeaf());
/** Root over evidence objects. */
const evidenceRoot = (items) => (items.length ? bytesRoot(items.map((i) => stableStringify(i))) : emptyLeaf());
function emptyLeaf() {
  return keccak256Bytes(Uint8Array.from([]));
}
function toHexRoot(bytes) {
  return ethers.hexlify(bytes);
}

class FullStopBlock {
  /**
   * @param {object} arg
   * @param {object} arg.header consensus header fields (without hash)
   * @param {string[]} arg.txs raw signed transactions (0x hex)
   * @param {Array} arg.evidence
   * @param {object} arg.lastCommit commit of the previous block
   */
  constructor({ header, txs = [], evidence = [], lastCommit = null, commit = null }) {
    this.header = {
      version: { app: VERSION.appVersion, block: '1' },
      chainId: header.chainId,
      height: header.height,
      time: header.time,
      round: header.round ?? 0,
      proposer: ethers.getAddress(header.proposer).toLowerCase(),
      parentHash: header.parentHash,
      dataHash: header.dataHash,
      evidenceHash: header.evidenceHash,
      appHash: header.appHash,
      stateRoot: header.stateRoot,
      validatorsHash: header.validatorsHash,
      gasUsed: header.gasUsed,
      gasLimit: header.gasLimit,
      txCount: header.txCount,
      feeBurned: header.feeBurned ?? '0',
      software: header.software ?? VERSION.software,
    };
    this.txs = txs;
    this.evidence = evidence;
    this.lastCommit = lastCommit;
    this.commit = commit;
    Object.freeze(this.header);
    Object.freeze(this);
  }

  static emptyHash() {
    return '0x' + Buffer.from(keccak256Bytes(Uint8Array.from([]))).toString('hex');
  }

  /**
   * Assemble the block from executed contents. `execution` supplies the EVM
   * header fields (state root, gas used); `protocol` supplies the app hash.
   */
  static assemble({ chainId, height, time, round, proposer, parentHash, txs, evidence, lastCommit, stateRoot, appHash, gasUsed, gasLimit, validatorsHash }) {
    const header = {
      chainId,
      height,
      time,
      round,
      proposer,
      parentHash,
      dataHash: toHexRoot(dataRoot(txs)),
      evidenceHash: toHexRoot(evidenceRoot(evidence)),
      appHash,
      stateRoot,
      validatorsHash,
      gasUsed: gasUsed.toString(),
      gasLimit: BigInt(gasLimit ?? BLOCK.blockGasLimit).toString(),
      txCount: txs.length,
      software: VERSION.software,
    };
    return new FullStopBlock({ header, txs, evidence, lastCommit });
  }

  get hash() {
    return '0x' + Buffer.from(headerHash(this.header)).toString('hex');
  }

  get height() {
    return this.header.height;
  }

  toJSON() {
    const out = { header: this.header, txs: this.txs, evidence: this.evidence, lastCommit: this.lastCommit, blockHash: this.hash };
    if (this.commit) out.commit = this.commit;
    return out;
  }

  /** Copy of this block with a different evidence list (header fields recomputed). */
  withEvidence(evidence) {
    return FullStopBlock.assemble({
      chainId: this.header.chainId,
      height: this.header.height,
      time: this.header.time,
      round: this.header.round,
      proposer: this.header.proposer,
      parentHash: this.header.parentHash,
      txs: this.txs,
      evidence,
      stateRoot: this.header.stateRoot,
      appHash: this.header.appHash,
      validatorsHash: this.header.validatorsHash,
      gasUsed: BigInt(this.header.gasUsed),
      gasLimit: this.header.gasLimit,
      lastCommit: this.lastCommit,
    });
  }

  /** Copy of this block with the sealing commit attached. */
  withCommit(commit) {
    return new FullStopBlock({
      header: this.header,
      txs: this.txs,
      evidence: this.evidence,
      lastCommit: this.lastCommit,
      commit,
    });
  }

  static fromJSON(obj) {
    return new FullStopBlock({
      header: obj.header,
      txs: obj.txs ?? [],
      evidence: obj.evidence ?? [],
      lastCommit: obj.lastCommit ?? null,
      commit: obj.commit ?? null,
    });
  }

  /** Bytes that validators sign for this block. */
  signBytes() {
    return headerHash(this.header);
  }

  /** Structural checks any node can perform without executing the block. */
  static basicValidate(block, expectedChainId) {
    const errors = [];
    const h = block.header;
    if (BigInt(h.chainId) !== BigInt(expectedChainId)) errors.push('chain id mismatch');
    if (h.height < 0) errors.push('negative height');
    if (h.txs && h.txs.length > (BLOCK.maxBlockTxs ?? 5000)) errors.push('too many transactions');
    if (block.txs.length !== h.txCount) errors.push(`txCount ${h.txCount} does not match ${block.txs.length} transactions`);
    const expectedData = block.txs.length ? bytesRoot(block.txs) : FullStopBlock.emptyHash();
    if (expectedData !== undefined && normalize(h.dataHash) !== normalize(bytesToHexSafe(expectedData))) {
      errors.push('dataHash does not match the transaction list');
    }
    if (BigInt(h.gasUsed) > BigInt(h.gasLimit)) errors.push('gasUsed exceeds gasLimit');
    if (errors.length) throw new Error(`invalid block at height ${h.height}: ${errors.join('; ')}`);
    return true;
  }
}

function normalize(hex) {
  return String(hex).toLowerCase().replace(/^0x0*/, '0x');
}

function bytesToHexSafe(bytes) {
  return ethers.hexlify(bytes);
}

/** Vote / proposal wire messages. */
const MessageType = {
  Proposal: 'proposal',
  Prevote: 'prevote',
  Precommit: 'precommit',
  Commit: 'commit',
  Tx: 'tx',
  Block: 'block',
  Status: 'status',
  Evidence: 'evidence',
  Handshake: 'handshake',
};

/**
 * Canonical signable form of a vote or proposal. Field types are normalised so
 * that the sender (bigint chain id) and the receiver (JSON numbers/strings)
 * always hash the same bytes.
 */
const { voteTag } = require('./vote-tag.js');

function signTag(block, round, type) {
  return voteTag({
    type,
    chainId: block.header.chainId,
    height: block.header.height,
    round,
    blockHash: block.hash,
  });
}

/**
 * Build a vote message. A `nil` vote has blockHash === ZERO_HASH and is used
 * by the timeout path to agree on skipping a round.
 */
function makeVote({ validatorKey, type, chainId, height, round, blockHash, timestamp }) {
  const tag = voteTag({ type, chainId, height, round, blockHash });
  const signature = new ethers.SigningKey(validatorKey.privateKey).sign(tag).serialized;
  return { type, height, round, blockHash, validator: validatorKey.address, timestamp, signature, chainId };
}

function verifyVote(vote, expectedChainId) {
  if (BigInt(vote.chainId) !== BigInt(expectedChainId)) return false;
  const tag = voteTag(vote);
  try {
    const recovered = ethers.recoverAddress(tag, vote.signature);
    return recovered.toLowerCase() === String(vote.validator).toLowerCase();
  } catch {
    return false;
  }
}

const ZERO_HASH = '0x' + '00'.repeat(32);

module.exports = {
  FullStopBlock,
  MessageType,
  signTag,
  voteTag,
  makeVote,
  verifyVote,
  headerHash,
  bytesRoot,
  dataRoot,
  evidenceRoot,
  ZERO_HASH,
  normalize,
};
