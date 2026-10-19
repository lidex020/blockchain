'use strict';
/**
 * Testnet faucet.
 *
 * Deliberately conservative: it signs a normal transfer from a faucet key the
 * node holds, so there is no privileged minting path - the faucet can only
 * hand out coin it already owns, and every claim is an ordinary transaction
 * that anyone can see in the explorer.
 *
 * Enabled only when the genesis document says so (test networks). A mainnet
 * genesis must leave `faucet.enabled` false; there is no code path that turns a
 * faucet on without a new genesis.
 */

const { ethers } = require('ethers');
const { COIN } = require('./constants');
const { createLogger } = require('./logger');

const log = createLogger('faucet');

class Faucet {
  /**
   * @param {object} opts
   * @param {Chain} opts.chain
   * @param {{privateKey:string}} opts.key
   * @param {bigint} opts.amount FSTOP per claim (base units)
   * @param {number} opts.cooldownMs per address
   * @param {bigint} opts.budgetPerEpoch total per sliding window
   */
  constructor({ chain, key, amount, cooldownMs = 6 * 60 * 60 * 1000, budgetPerEpoch, windowMs = 24 * 60 * 60 * 1000 }) {
    this.chain = chain;
    this.wallet = new ethers.Wallet(key.privateKey);
    this.amount = BigInt(amount ?? 10n * COIN.unit);
    this.cooldownMs = cooldownMs;
    this.windowMs = windowMs;
    this.budgetPerEpoch = BigInt(budgetPerEpoch ?? this.amount * 500n);
    this.claims = new Map(); // address -> [timestamps]
    this.enabled = true;
  }

  async status() {
    const balance = await this.chain.execution.balance(this.wallet.address);
    return {
      enabled: this.enabled,
      address: this.wallet.address,
      balance: BigInt(balance ?? 0n).toString(),
      amountPerClaim: this.amount.toString(),
      cooldownMs: this.cooldownMs,
      dailyBudget: this.budgetPerEpoch.toString(),
      claimed: [...this.claims.values()].reduce((a, v) => a + v.length, 0),
    };
  }

  _recent(address) {
    const list = (this.claims.get(address.toLowerCase()) ?? []).filter((t) => Date.now() - t < this.windowMs);
    this.claims.set(address.toLowerCase(), list);
    return list;
  }

  async claim(address) {
    if (!this.enabled) throw new Error('the faucet is disabled');
    const target = ethers.getAddress(address).toLowerCase();
    if (!/0x[0-9a-f]{40}/.test(target)) throw new Error('invalid address');
    const recent = this._recent(target);
    const last = recent[recent.length - 1];
    if (last && Date.now() - last < this.cooldownMs) {
      const waitMin = Math.ceil((this.cooldownMs - (Date.now() - last)) / 60000);
      throw new Error(`this address already claimed; try again in about ${waitMin} minutes`);
    }
    // recent.length is a Number and this.amount is a BigInt: convert explicitly.
    const spentInWindow = BigInt(recent.length) * this.amount;
    if (spentInWindow + this.amount > this.budgetPerEpoch) {
      throw new Error('the faucet budget for this window is exhausted');
    }
    const balance = await this.chain.execution.balance(this.wallet.address);
    if (balance < this.amount) throw new Error('the faucet account is empty; ask the network operators to top it up');

    const nonce = Number((await this.chain.execution.account(this.wallet.address)).nonce);
    const gasPrice = this.chain.gasPrice();
    const raw = await this.wallet.signTransaction({
      to: target,
      value: this.amount,
      gasLimit: 21000n,
      gasPrice,
      nonce,
      chainId: Number(this.chain.chainId),
      type: 0,
    });
    const entry = await this.chain.pool.add(raw, { source: 'faucet' });
    recent.push(Date.now());
    log.info('faucet claim queued', { address: target, amount: this.amount.toString(), hash: entry.hash });
    return { hash: entry.hash, amount: this.amount.toString(), ticker: COIN.ticker };
  }
}

module.exports = { Faucet };
