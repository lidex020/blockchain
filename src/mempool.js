'use strict';
/**
 * Transaction mempool.
 *
 * Admission control is the chain's first line of defence against spam and
 * resource exhaustion (spec 3.3): every entry must clear signature, chain-id,
 * nonce, balance, gas-price-floor and size checks, and per-sender and global
 * caps bound the memory a single actor can consume.
 *
 * The pool holds at most one transaction per (sender, nonce); a replacement
 * must pay a strictly higher gas price, which is what makes fee-bumping work
 * and prevents an attacker from pinning a sender's queue.
 */

const { ethers } = require('ethers');
const { Capability } = require('@ethereumjs/tx');
const { PROTOCOL, BLOCK, FEES } = require('./constants');
const { createLogger } = require('./logger');

const log = createLogger('mempool');

class PoolError extends Error {
  constructor(message, code = 'POOL') {
    super(message);
    this.name = 'PoolError';
    this.code = code;
  }
}

/** Minimum bump (10%) a replacement transaction must offer. */
const REPLACEMENT_BUMP_BPS = 1000n;

class Mempool {
  constructor({ chain, execution, params = {}, onAccepted }) {
    this.chain = chain;
    this.execution = execution;
    this.params = params;
    this.onAccepted = onAccepted;
    /** hash -> entry */
    this.entries = new Map();
    /** sender -> Map<nonce, entry> */
    this.bySender = new Map();
    this.minGasPrice = BigInt(params.minGasPrice ?? FEES.minGasPrice);
  }

  get size() {
    return this.entries.size;
  }

  has(hash) {
    return this.entries.has(String(hash).toLowerCase());
  }

  get(hash) {
    return this.entries.get(String(hash).toLowerCase()) ?? null;
  }

  /** Validate a raw transaction against current state and admit it. */
  async add(raw, { source = 'rpc', gossip = true } = {}) {
    const tx = this.execution.decodeTx(raw);
    const hash = ethers.hexlify(tx.hash()).toLowerCase();
    const existing = this.entries.get(hash);
    if (existing) return existing;
    if (this.size >= PROTOCOL.maxPoolSize) throw new PoolError('mempool is full', 'POOL_FULL');

    const sender = tx.getSenderAddress().toString().toLowerCase();
    const account = await this.execution.account(sender);
    const stateNonce = Number(account.nonce);
    const nonce = Number(tx.nonce);

    if (nonce < stateNonce) throw new PoolError(`nonce too low: account nonce is ${stateNonce}`, 'NONCE_TOO_LOW');
    if (nonce > stateNonce + 1024) throw new PoolError('nonce too far in the future', 'NONCE_TOO_FAR');

    const is1559 = tx.supports?.(Capability.EIP1559FeeMarket);
    const gasPrice = is1559 ? tx.maxFeePerGas : tx.gasPrice;
    if (gasPrice < this.minGasPrice) {
      throw new PoolError(`gas price ${gasPrice} is below the protocol floor of ${this.minGasPrice} wei per gas`, 'GAS_PRICE_TOO_LOW');
    }
    if (is1559 && tx.maxPriorityFeePerGas > tx.maxFeePerGas) {
      throw new PoolError('maxPriorityFeePerGas exceeds maxFeePerGas', 'TX_INVALID');
    }

    const upfront = gasPrice * tx.gasLimit + tx.value;
    if (account.balance < upfront) {
      throw new PoolError(`insufficient funds: balance ${account.balance}, need ${upfront} for value plus gas`, 'INSUFFICIENT_FUNDS');
    }

    const senderMap = this.bySender.get(sender) ?? new Map();
    const incumbent = senderMap.get(nonce);
    if (incumbent) {
      const required = incumbent.gasPrice + (incumbent.gasPrice * REPLACEMENT_BUMP_BPS) / 10_000n;
      if (gasPrice < required) {
        throw new PoolError(`replacement transaction underpriced: need at least ${required} wei per gas`, 'REPLACEMENT_UNDERPRICED');
      }
      this._drop(incumbent);
    }
    if (senderMap.size >= PROTOCOL.maxPendingPerAccount) {
      throw new PoolError(`sender ${sender} already has ${senderMap.size} queued transactions`, 'TOO_MANY_PENDING');
    }

    const entry = {
      hash,
      raw: ethers.hexlify(tx.serialize()),
      tx,
      sender,
      nonce,
      gasPrice,
      gasLimit: tx.gasLimit,
      value: tx.value,
      to: tx.to ? tx.to.toString().toLowerCase() : null,
      isSystem: !!tx.to && tx.to.toString().toLowerCase() === this.chain.protocol.address.toLowerCase(),
      enqueuedAt: Date.now(),
      receivedFrom: source,
      is1559,
    };
    this.entries.set(hash, entry);
    senderMap.set(nonce, entry);
    this.bySender.set(sender, senderMap);

    if (gossip && this.onAccepted) {
      try {
        this.onAccepted(entry.raw);
      } catch (err) {
        log.warn('gossip hook failed', { err: err.message });
      }
    }
    log.debug('admitted', { hash, sender, nonce });
    return entry;
  }

  _drop(entry) {
    this.entries.delete(entry.hash);
    const m = this.bySender.get(entry.sender);
    if (m) {
      m.delete(entry.nonce);
      if (m.size === 0) this.bySender.delete(entry.sender);
    }
  }

  remove(hash) {
    const entry = this.entries.get(String(hash).toLowerCase());
    if (!entry) return false;
    this._drop(entry);
    return true;
  }

  removeMany(hashes) {
    for (const h of hashes) this.remove(h);
  }

  /** Forget everything a confirmed block has included, so state stays honest. */
  afterCommit(confirmedHashes, stateNonceUpdates) {
    for (const h of confirmedHashes) this.remove(h);
    if (!stateNonceUpdates) return;
    for (const [sender, nonce] of stateNonceUpdates) {
      const m = this.bySender.get(sender);
      if (!m) continue;
      for (const [n, entry] of [...m.entries()]) {
        if (n < nonce) this._drop(entry);
      }
    }
  }

  /**
   * Choose transactions for the next block: contiguous nonces per sender,
   * senders ranked by the highest gas price they offer, bounded by the block
   * gas limit and the transaction count cap.
   */
  selectForBlock({ gasLimit = BLOCK.blockGasLimit, maxTxs = BLOCK.maxBlockTxs } = {}) {
    const headNonce = this.chain.headNonce.bind(this.chain);
    const candidates = [];
    for (const [sender, map] of this.bySender) {
      const ordered = [...map.values()].sort((a, b) => a.nonce - b.nonce);
      const fee = ordered.reduce((m, e) => (e.gasPrice > m ? e.gasPrice : m), 0n);
      candidates.push({ sender, ordered, fee });
    }
    candidates.sort((a, b) => (a.fee === b.fee ? (a.sender < b.sender ? -1 : 1) : a.fee > b.fee ? -1 : 1));

    const chosen = [];
    let gas = 0n;
    const cap = BigInt(gasLimit);
    for (const { ordered } of candidates) {
      let expected = null;
      for (const entry of ordered) {
        if (chosen.length >= maxTxs) break;
        if (expected === null) {
          expected = headNonce(entry.sender);
          if (entry.nonce !== expected) break;
        } else if (entry.nonce !== expected) {
          break;
        }
        if (gas + entry.gasLimit > cap) {
          expected += 1;
          continue;
        }
        chosen.push(entry);
        gas += entry.gasLimit;
        expected += 1;
      }
      if (chosen.length >= maxTxs) break;
    }
    return chosen;
  }

  /** Expire entries that have sat in the pool too long. */
  expire(now = Date.now()) {
    let dropped = 0;
    for (const entry of [...this.entries.values()]) {
      if (now - entry.enqueuedAt > PROTOCOL.poolTtlMs) {
        this._drop(entry);
        dropped += 1;
      }
    }
    if (dropped) log.debug('expired stale pool entries', { dropped });
    return dropped;
  }

  stats() {
    return {
      total: this.size,
      senders: this.bySender.size,
      maxPoolSize: PROTOCOL.maxPoolSize,
      minGasPrice: this.minGasPrice.toString(),
      systemPending: [...this.entries.values()].filter((e) => e.isSystem).length,
    };
  }

  list({ limit = 100 } = {}) {
    const out = [...this.entries.values()].sort((a, b) => (a.gasPrice === b.gasPrice ? 0 : a.gasPrice > b.gasPrice ? -1 : 1));
    return out.slice(0, limit).map((e) => ({
      hash: e.hash,
      from: e.sender,
      to: e.to,
      nonce: e.nonce,
      value: e.value.toString(),
      gasPrice: e.gasPrice.toString(),
      gasLimit: e.gasLimit.toString(),
      type: e.tx.type,
      system: e.isSystem,
      ageMs: Date.now() - e.enqueuedAt,
    }));
  }

  contents() {
    return [...this.entries.values()].map((e) => e.raw);
  }
}

module.exports = { Mempool, PoolError, REPLACEMENT_BUMP_BPS };
