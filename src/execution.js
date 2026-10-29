'use strict';
/**
 * Execution layer.
 *
 * Wraps the EthereumJS VM and adds the Full Stop protocol transition.
 *
 * How a block is executed (identically on every validator):
 *   1. open a state checkpoint;
 *   2. run each transaction through `runTx`, which performs Ethereum-native
 *      validation (signature, chain id replay protection, nonce, balance,
 *      intrinsic gas) and credits the transaction fee to the block's coinbase,
 *      which on this chain is the protocol fee collector;
 *   3. run the protocol transition (system transactions, fee split and burn,
 *      block subsidy, vesting release, community payouts, staking
 *      distribution, unbonding, evidence) which may only move balances
 *      between accounts and mint/burn through the supply ledger;
 *   4. hash the resulting state; the state root, the transaction root, the
 *      receipt root and the application hash all go into the block header;
 *   5. commit the checkpoint (block accepted) or revert it (verification run).
 *
 * The EVM itself can never create or destroy LDX: it only moves balances.
 * All issuance is protocol code inside the ledger, which enforces the cap.
 */

const { createVM } = require('@ethereumjs/vm');
const { runTx, encodeReceipt, Bloom } = require('@ethereumjs/vm');
const { MerkleStateManager } = require('@ethereumjs/statemanager');
const { createCustomCommon, Mainnet } = require('@ethereumjs/common');
const { createTxFromRLP, Capability } = require('@ethereumjs/tx');
const { createBlock, createEmptyBlock, genTransactionsTrieRoot } = require('@ethereumjs/block');
const { MerklePatriciaTrie } = require('@ethereumjs/mpt');
const { RLP } = require('@ethereumjs/rlp');
const {
  Account,
  Address,
  createAddressFromString,
  createContractAddress,
  hexToBytes,
  bytesToHex,
  setLengthLeft,
} = require('@ethereumjs/util');
const { keccak256 } = require('ethereum-cryptography/keccak');
const { ethers } = require('ethers');
const { AsyncLocalStorage } = require('node:async_hooks');

const { POOL, BLOCK, FEES, SYSTEM, GAS, VERSION } = require('./constants');
const { hashObject } = require('./crypto');

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const EMPTY_CODE_HASH = bytesToHex(keccak256(new Uint8Array()));

class ExecutionError extends Error {
  constructor(message, code = 'EXECUTION') {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

/** The EIP-155 chain configuration shared by every component. */
function createChainCommon(chainId, hardfork = POOL.hardfork) {
  return createCustomCommon({ chainId: Number(chainId), name: 'fullstop' }, Mainnet, { hardfork });
}

const addr = (str) => createAddressFromString(str);
const toHex = (bytes) => ethers.hexlify(bytes);

function emptyTrieRoot() {
  return keccak256(RLP.encode([]));
}

class Execution {
  constructor({ vm, common, stateManager, params }) {
    this.vm = vm;
    this.common = common;
    this.stateManager = stateManager;
    this.params = params;
    this.headBlock = null;
    this._queued = Promise.resolve();
    this._als = new AsyncLocalStorage();
  }

  static async create(params = {}) {
    const common = createChainCommon(params.chainId ?? 72122, params.hardfork ?? POOL.hardfork);
    const stateManager = new MerkleStateManager({ common });
    const vm = await createVM({ common, stateManager });
    return new Execution({ vm, common, stateManager, params });
  }

  /**
   * Serialise all state-touching work so execution never interleaves.
   *
   * Re-entrancy is detected with an async context, not a boolean flag: a caller
   * that is already inside this execution's critical section (for example
   * `Chain._recover`, which applies genesis and then replays blocks, or a block
   * commit that validates first and then applies) must not deadlock waiting on
   * itself, while an unrelated caller - an eth_call from the RPC server - must
   * still wait its turn rather than write into a checkpoint someone else owns.
   */
  queue(fn) {
    if (this._als.getStore() === this) return Promise.resolve().then(fn);
    const run = () => this._als.run(this, fn);
    const chained = this._queued.then(run, run);
    this._queued = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  }

  // ------------------------------------------------------------- accessors

  async balance(address) {
    const acc = await this.stateManager.getAccount(addr(address));
    return acc ? acc.balance : 0n;
  }

  async account(address) {
    const acc = await this.stateManager.getAccount(addr(address));
    if (!acc) {
      return { address: ethers.getAddress(address), nonce: 0n, balance: 0n, codeHash: EMPTY_CODE_HASH, storageRoot: toHex(emptyTrieRoot()), exists: false };
    }
    return {
      address: ethers.getAddress(address),
      nonce: acc.nonce,
      balance: acc.balance,
      codeHash: toHex(acc.codeHash),
      storageRoot: toHex(acc.storageRoot),
      exists: true,
    };
  }

  async getCode(address) {
    const code = await this.stateManager.getCode(addr(address));
    return code && code.length ? toHex(code) : '0x';
  }

  async isContract(address) {
    const code = await this.stateManager.getCode(addr(address));
    return !!code && code.length > 0;
  }

  async getStorageAt(address, slot) {
    const raw = typeof slot === 'string' && slot.startsWith('0x') ? slot : ethers.toBeHex(BigInt(slot ?? 0), 32);
    const key = hexToBytes(raw);
    const value = await this.stateManager.getStorage(addr(address), setLengthLeft(key, 32));
    return toHex(setLengthLeft(value, 32));
  }

  async dumpStorage(address) {
    const dump = await this.stateManager.dumpStorage(addr(address));
    const out = {};
    for (const [key, value] of Object.entries(dump ?? {})) {
      out[`0x${key.replace(/^0+/, '').padStart(64, '0')}`] = `0x${String(value).replace(/^0+/, '').padStart(64, '0') || '0x0'}`;
    }
    return out;
  }

  async stateRoot() {
    return toHex(await this.stateManager.getStateRoot());
  }

  /** Sum every balance in the state trie by walking it. Used for audits. */
  async sumAllBalances() {
    const { createAccountFromRLP } = require('@ethereumjs/util');
    let total = 0n;
    let accounts = 0;
    const trie = this.stateManager._trie;
    // The walk hands back the trie node itself, not a {key, node} pair.
    await trie.walkAllValueNodes((node) => {
      const value = typeof node?.value === 'function' ? node.value() : node?._value;
      if (!value || value.length === 0) return;
      try {
        const account = createAccountFromRLP(value);
        total += account.balance;
        accounts += 1;
      } catch {
        /* not an account leaf */
      }
    });
    return { total, accounts };
  }

  /** List of accounts known to the node (derived from blocks, best effort). */
  async applyDeltas(deltas) {
    for (const d of deltas) {
      if (d.amount === undefined) throw new Error('delta missing amount');
      if (d.amount === 0n) continue;
      const a = addr(d.address);
      const acc = (await this.stateManager.getAccount(a)) ?? new Account(0n, 0n);
      const next = acc.balance + d.amount;
      if (next < 0n) {
        throw new ExecutionError(
          `protocol transition would make ${d.address} negative (balance ${acc.balance}, delta ${d.amount}, reason ${d.reason ?? 'n/a'})`,
          'PROTOCOL_UNDERFLOW'
        );
      }
      await this.stateManager.putAccount(a, new Account(acc.nonce, next));
    }
  }

  // ---------------------------------------------------------------- genesis

  /**
   * Build the genesis state: prefunded accounts, optional contract code, and
   * the genesis transactions that deploy the system asset contracts.
   */
  async applyGenesis(genesis) {
    await this.applyAlloc(genesis);
    return this.runGenesisTxs(genesis);
  }

  /** Credit genesis accounts (no code, no contract creation). */
  async applyAlloc(genesis) {
    return this.queue(async () => {
      for (const [address, entry] of Object.entries(genesis.alloc ?? {})) {
        const acc = new Account(BigInt(entry.nonce ?? 0), BigInt(entry.balance ?? 0));
        await this.stateManager.putAccount(addr(address), acc);
        if (entry.code && entry.code !== '0x') {
          const code = hexToBytes(entry.code);
          await this.stateManager.putCode(addr(address), code);
          const withCode = (await this.stateManager.getAccount(addr(address))) ?? acc;
          await this.stateManager.putAccount(addr(address), new Account(withCode.nonce, withCode.balance, undefined, keccak256(code)));
        }
        for (const [slot, value] of Object.entries(entry.storage ?? {})) {
          await this.stateManager.putStorage(addr(address), setLengthLeft(hexToBytes(slot), 32), setLengthLeft(hexToBytes(value), 32));
        }
      }
      return { stateRoot: await this.stateRoot() };
    });
  }

  /**
   * Execute the genesis transactions that deploy the system contracts. Run
   * after the ledger has minted the genesis allocation, because the deployer
   * pays real gas for them.
   */
  async runGenesisTxs(genesis) {
    return this.queue(async () => {
      const ctxBlock = this.contextBlock({
        number: 0n,
        timestamp: BigInt(Math.floor(new Date(genesis.genesis_time ?? Date.now()).getTime() / 1000)),
        gasLimit: BigInt(genesis.block_gas_limit ?? BLOCK.blockGasLimit),
      });
      const deployed = [];
      for (const raw of genesis.genesisTxs ?? []) {
        const tx = createTxFromRLP(hexToBytes(raw), { common: this.common });
        const res = await runTx(this.vm, { tx, block: ctxBlock, skipHardForkValidation: false });
        if (res.receipt.status !== 1) {
          throw new ExecutionError(
            `genesis transaction ${toHex(tx.hash())} failed (${res.execResult?.exceptionError?.error ?? 'reverted'}); refusing to start the network`,
            'GENESIS_TX'
          );
        }
        deployed.push({
          hash: toHex(tx.hash()),
          from: tx.getSenderAddress().toString(),
          contractAddress: res.createdAddress ? res.createdAddress.toString() : null,
          gasUsed: res.totalGasSpent.toString(),
        });
      }
      return { stateRoot: await this.stateRoot(), deployed };
    });
  }

  /** The EVM Block object that supplies block context (NUMBER, COINBASE, BASEFEE, ...). */
  contextBlock({ number, timestamp, gasLimit, coinbase, stateRoot, parentHash }) {
    const headerData = {
      number: BigInt(number),
      timestamp: BigInt(timestamp),
      gasLimit: BigInt(gasLimit ?? this.params.blockGasLimit ?? BLOCK.blockGasLimit),
      baseFeePerGas: 0n,
      coinbase: addr(coinbase ?? this.params.feeCollector ?? SYSTEM.feeCollectorAddress),
      difficulty: 0n,
      stateRoot: stateRoot ? hexToBytesIfHex(stateRoot) : undefined,
      parentHash: parentHash ?? new Uint8Array(32),
    };
    return createEmptyBlock(headerData, { common: this.common });
  }

  /** The EVM block object for the genesis state, used as the parent hash of block 1. */
  genesisBlock(genesis, stateRoot) {
    const headerData = {
      number: 0n,
      parentHash: new Uint8Array(32),
      timestamp: BigInt(Math.floor(new Date(genesis.genesis_time ?? Date.now()).getTime() / 1000)),
      gasLimit: BigInt(genesis.block_gas_limit ?? BLOCK.blockGasLimit),
      gasUsed: 0n,
      baseFeePerGas: 0n,
      coinbase: addr(genesis.fee_collector ?? SYSTEM.feeCollectorAddress),
      difficulty: 0n,
      mixHash: new Uint8Array(32),
      nonce: hexToBytes('0x0000000000000000'),
      stateRoot: hexToBytes(stateRoot),
      transactionsTrie: emptyTrieRoot(),
      receiptTrie: emptyTrieRoot(),
      logsBloom: new Uint8Array(256),
      extraData: new Uint8Array(0),
    };
    return createBlock({ header: headerData, transactions: [] }, { common: this.common, skipBlockValidation: true, freeze: false });
  }

  /**
   * The block object that gets published for RPC consumers: it carries the
   * real state root and, when the block has transactions, the real roots.
   */
  sealBlock({ parentBlock, txs, height, timestamp, gasUsed, stateRoot, receiptsRoot, transactionsRoot, logsBloom, extraData }) {
    const headerData = {
      number: BigInt(height),
      parentHash: parentBlock ? parentBlock.hash() : new Uint8Array(32),
      timestamp: BigInt(timestamp),
      gasLimit: BigInt(this.params.blockGasLimit ?? BLOCK.blockGasLimit),
      gasUsed: BigInt(gasUsed),
      baseFeePerGas: 0n,
      coinbase: addr(this.params.feeCollector ?? SYSTEM.feeCollectorAddress),
      difficulty: 0n,
      mixHash: new Uint8Array(32),
      nonce: hexToBytes('0x0000000000000000'),
      stateRoot: hexToBytesIfHex(stateRoot),
      transactionsTrie: transactionsRoot ? hexToBytesIfHex(transactionsRoot) : emptyTrieRoot(),
      receiptTrie: receiptsRoot ? hexToBytesIfHex(receiptsRoot) : emptyTrieRoot(),
      logsBloom: logsBloom ? hexToBytesIfHex(logsBloom) : new Uint8Array(256),
      extraData: extraData ? hexToBytesIfHex(extraData) : new Uint8Array(0),
    };
    return createBlock(
      { header: headerData, transactions: txs },
      { common: this.common, skipBlockValidation: true, freeze: false }
    );
  }

  // ------------------------------------------------------------ tx helpers

  decodeTx(raw, { strict = true } = {}) {
    const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw;
    if (bytes.length > BLOCK.maxTxBytes) {
      throw new ExecutionError(`transaction is ${bytes.length} bytes, above the ${BLOCK.maxTxBytes} byte protocol limit`, 'TX_TOO_LARGE');
    }
    let tx;
    try {
      tx = createTxFromRLP(bytes, { common: this.common });
    } catch (err) {
      throw new ExecutionError(`could not decode transaction: ${err.message}`, 'TX_DECODE');
    }
    if (!tx.isSigned()) throw new ExecutionError('transaction is not signed', 'TX_UNSIGNED');
    if (!tx.verifySignature()) throw new ExecutionError('transaction signature does not recover a sender', 'TX_SIGNATURE');
    if (strict) this.validateTxRules(tx);
    return tx;
  }

  /** Chain-level rules enforced outside the EVM: replay, fee floor, ceilings. */
  validateTxRules(tx) {
    if (tx.common.chainId() !== this.common.chainId()) {
      throw new ExecutionError(`wrong chain id ${tx.common.chainId()}, this node serves ${this.common.chainId()}`, 'WRONG_CHAIN_ID');
    }
    if (tx.gasLimit > GAS.maxTxGasLimit) {
      throw new ExecutionError(`gas limit ${tx.gasLimit} is above the per-transaction maximum ${GAS.maxTxGasLimit}`, 'GAS_LIMIT_TOO_HIGH');
    }
    if (tx.gasLimit < GAS.transferGas) {
      throw new ExecutionError(`gas limit ${tx.gasLimit} is below the intrinsic cost of a transfer`, 'GAS_LIMIT_TOO_LOW');
    }
    const gasPrice = tx.supports?.(Capability.EIP1559FeeMarket) ? tx.maxFeePerGas : tx.gasPrice;
    const floor = BigInt(this.params.minGasPrice ?? FEES.minGasPrice);
    if (gasPrice < floor) {
      throw new ExecutionError(`gas price ${gasPrice} is below the protocol floor ${floor}`, 'GAS_PRICE_TOO_LOW');
    }
    if (tx.type === 3) throw new ExecutionError('blob transactions are not enabled on this chain', 'TX_TYPE_UNSUPPORTED');
    if (tx.type === 4) throw new ExecutionError('EIP-7702 code authorization transactions are not enabled on this chain', 'TX_TYPE_UNSUPPORTED');
  }

  static effectiveGasPrice(tx, baseFee = 0n) {
    if (tx.supports?.(Capability.EIP1559FeeMarket)) {
      return baseFee + (tx.getEffectivePriorityFee(baseFee) ?? 0n);
    }
    return tx.gasPrice;
  }

  // ------------------------------------------------------ block execution

  /**
   * Execute a block body. Returns everything needed to seal it, and either
   * commits or reverts the state depending on `dryRun`.
   *
   * @param {object} opts
   * @param {object} opts.protocol  protocol state machine (src/protocol.js)
   * @param {Block}  [opts.parentBlock] EVM block used as the parent
   */
  executeBlock(opts) {
    return this.queue(() => this._executeBlock(opts));
  }

  /**
   * Execute a block *without* taking the queue. Callers that must do several
   * state operations atomically (validate, then apply, then index) call this
   * inside their own `queue()` section instead.
   */
  _executeBlock({ parentBlock, txs = [], height, timestamp, protocol, evidence = [], dryRun = false, gasLimit, coinbase, lastCommitSigners = null }) {
    const execute = async () => {
      const cap = BigInt(gasLimit ?? this.params.blockGasLimit ?? BLOCK.blockGasLimit);
      const ctxBlock = this.contextBlock({
        number: BigInt(height),
        timestamp: BigInt(timestamp),
        gasLimit: cap,
        coinbase: coinbase ?? this.params.feeCollector ?? SYSTEM.feeCollectorAddress,
        parentHash: parentBlock ? parentBlock.hash() : undefined,
      });

      // Checkpointing is done at the state-manager level on purpose: the EVM
      // journal resets its own height at the end of every runTx, so a
      // journal-level checkpoint spanning several transactions is not usable.
      await this.stateManager.checkpoint();
      // Exactly one snapshot per run, restored whenever the run does not end in
      // a committed block - including a real run that threw part way through.
      // Without this a failed commit would leave protocol state applied while the
      // EVM state was rolled back, which is silent state divergence.
      const protocolSnapshot = protocol.snapshotJSON();
      let restored = false;
      const restore = async () => {
        if (restored) return;
        restored = true;
        await this.stateManager.revert();
        protocol.restoreSnapshot(protocolSnapshot);
        if (process.env.FULLSTOP_DEBUG_RESTORE) {
          const now = protocol.snapshotJSON();
          if (now !== protocolSnapshot) {
            let i = 0;
            while (i < Math.max(now.length, protocolSnapshot.length) && now[i] === protocolSnapshot[i]) i++;
            console.log(`[restore-lossy] pos ${i}\n  want: ${protocolSnapshot.slice(Math.max(0, i - 120), i + 160)}\n  got : ${now.slice(Math.max(0, i - 120), i + 160)}`);
          } else {
            const rootNow = await this.stateRoot();
            if (rootNow !== preRoot) console.log(`[restore-lossy] state root ${preRoot.slice(0, 18)} -> ${rootNow.slice(0, 18)}`);
          }
        }
      };
      const preRoot = process.env.FULLSTOP_DEBUG_RESTORE ? await this.stateRoot() : null;
      const commitState = async () => {
        restored = true;
        await this.stateManager.commit();
      };
      try {
        const results = [];
        const included = [];
        let blockGas = 0n;
        let cumulative = 0n;
        const receipts = [];

        for (const rawOrTx of txs) {
          const tx = rawOrTx.tx ?? this.decodeTx(typeof rawOrTx === 'string' ? rawOrTx : rawOrTx.raw);
          if (included.length >= (this.params.maxBlockTxs ?? BLOCK.maxBlockTxs)) {
            throw new ExecutionError(`block exceeds the ${this.params.maxBlockTxs ?? BLOCK.maxBlockTxs} transaction limit`, 'BLOCK_TX_LIMIT');
          }
          if (blockGas + tx.gasLimit > cap) {
            throw new ExecutionError(`block gas limit exceeded at transaction ${included.length}`, 'BLOCK_GAS_LIMIT');
          }
          const res = await runTx(this.vm, { tx, block: ctxBlock, skipHardForkValidation: false });
          cumulative += res.totalGasSpent;
          receipts.push({ receipt: res.receipt, res, tx });
          included.push(tx);
          results.push(res);
          blockGas += res.totalGasSpent;
        }

        const feesCollected = receipts.reduce((acc, r) => acc + r.res.totalGasSpent * Execution.effectiveGasPrice(r.tx), 0n);

        const protocolResult = await protocol.applyBlock({
          height,
          execution: this,
          txs: included,
          results: receipts.map((r) => r.res),
          evidence,
          feesCollected,
          ctxBlock,
          lastCommitSigners,
        });

        const stateRoot = await this.stateRoot();
        const receiptRoots = await this.buildReceiptRoots(receipts);
        const sealBlock = this.sealBlock({
          parentBlock,
          txs: included,
          height,
          timestamp,
          gasUsed: blockGas,
          stateRoot,
          receiptsRoot: receiptRoots.receiptsRoot,
          transactionsRoot: receiptRoots.transactionsRoot,
          logsBloom: receiptRoots.logsBloom,
          extraData: protocolResult.appHash,
        });

        if (process.env.FULLSTOP_DEBUG_EXEC) {
          require('fs').writeFileSync(`/tmp/exec-${this.debugTag}-${height}-${dryRun ? 'dry' : 'real'}.json`, JSON.stringify(protocol.serialize(), null, 1));
        }
        const fullReceipts = receipts.map((r, i) =>
          buildReceipt(r.tx, r.res, sealBlock, i, { baseFeePerGas: 0n })
        );

        if (dryRun) {
          await restore();
        } else {
          await commitState();
        }

        return {
          evmBlock: sealBlock,
          transactions: included,
          receipts: fullReceipts,
          gasUsed: blockGas,
          stateRoot,
          appHash: protocolResult.appHash,
          validatorsHash: protocolResult.validatorsHash,
          feesCollected,
          protocol: protocolResult,
          receiptsRoot: receiptRoots.receiptsRoot,
          transactionsRoot: receiptRoots.transactionsRoot,
          logsBloom: receiptRoots.logsBloom,
        };
      } catch (err) {
        // A failed *real* execution must not leave half-applied state behind
        // either, so the revert is not limited to dry runs.
        await restore();
        throw err;
      }
    };
    return execute();
  }

  async buildReceiptRoots(receipts) {
    if (receipts.length === 0) {
      return {
        receiptsRoot: toHex(emptyTrieRoot()),
        transactionsRoot: toHex(emptyTrieRoot()),
        logsBloom: toHex(new Uint8Array(256)),
      };
    }
    const trie = new MerklePatriciaTrie({ common: this.common });
    const bloom = new Bloom(undefined, this.common);
    for (let i = 0; i < receipts.length; i++) {
      const { receipt, res, tx } = receipts[i];
      await trie.put(RLP.encode(i), encodeReceipt(receipt, tx.type));
      bloom.or(res.bloom);
    }
    const transactionsRoot = await genTransactionsTrieRoot(
      receipts.map((r) => r.tx),
      new MerklePatriciaTrie({ common: this.common })
    );
    return { receiptsRoot: toHex(trie.root()), logsBloom: toHex(bloom.bitvector), transactionsRoot: toHex(transactionsRoot) };
  }

  /** Re-run a proposed block without keeping any of its effects. */
  async verifyBlock({ parentBlock, txs, height, timestamp, protocol, evidence, gasLimit, lastCommitSigners }) {
    return this.executeBlock({ parentBlock, txs, height, timestamp, protocol, evidence, gasLimit, lastCommitSigners, dryRun: true });
  }

  // -------------------------------------------------------- view + estimate

  async call({ to, data, from, value, gas, atBlock }) {
    return this.queue(async () => {
      await this.stateManager.checkpoint();
      try {
        const result = await this.vm.evm.runCall({
          caller: addr(from ?? ZERO_ADDR),
          origin: addr(from ?? ZERO_ADDR),
          to: to ? addr(to) : undefined,
          data: data ? hexToBytes(data) : new Uint8Array(),
          gasLimit: BigInt(gas ?? this.params.blockGasLimit ?? BLOCK.blockGasLimit),
          value: BigInt(value ?? 0),
          block: atBlock ?? this.headBlock ?? undefined,
          skipBalance: true,
        });
        const err = result.execResult.exceptionError;
        return {
          returnValue: toHex(result.execResult.returnValue ?? new Uint8Array()),
          gasUsed: result.execResult.executionGasUsed ?? 0n,
          exception: err ? String(err.error ?? err) : null,
          revertReason: err?.error === 'revert' ? decodeRevert(result.execResult.returnValue) : null,
          logs: result.execResult.logs ?? [],
        };
      } finally {
        await this.stateManager.revert();
      }
    });
  }

  /**
   * Intrinsic gas of a transaction: the amount the EVM charges before any
   * opcode runs. Estimation below is done with a bare `runCall`, which does not
   * add this, so it is computed here and folded back in - otherwise every
   * estimate is ~21k gas short and wallets would consistently under-pay.
   */
  static intrinsicGas({ to, data, value = 0n, deploy = false }) {
    let gas = GAS.transferGas;
    if (deploy) gas += 32_000n;
    const bytes = data ? hexToBytes(data) : new Uint8Array();
    for (const b of bytes) gas += b === 0 ? GAS.calldataGasPerZeroByte : GAS.calldataGasPerNonZeroByte;
    if (to && BigInt(value) > 0n && !deploy) gas += 9000n; // EIP-150 transfer stipend
    return gas;
  }

  async estimate({ to, data, from, value, deploy = false }) {
    return this.queue(async () => {
      const intrinsic = Execution.intrinsicGas({ to, data, value, deploy });
      const cap = BigInt(this.params.blockGasLimit ?? BLOCK.blockGasLimit) - intrinsic;
      const probe = async (gasLimit) => {
        await this.stateManager.checkpoint();
        try {
          const result = await this.vm.evm.runCall({
            caller: addr(from ?? ZERO_ADDR),
            origin: addr(from ?? ZERO_ADDR),
            to: to ? addr(to) : undefined,
            data: data ? hexToBytes(data) : new Uint8Array(),
            gasLimit,
            value: BigInt(value ?? 0),
            block: this.headBlock ?? undefined,
            skipBalance: true,
          });
          const err = result.execResult.exceptionError;
          return { ok: !err || err.error === 'revert', reason: err ? String(err.error ?? err) : null, return: result.execResult.returnValue };
        } finally {
          await this.stateManager.revert();
        }
      };
      const top = await probe(cap);
      if (!top.ok) {
        if (top.reason === 'revert') {
          const why = decodeRevert(top.return);
          throw new ExecutionError(`execution reverted${why ? `: ${why}` : ''}`, 'REVERT');
        }
        throw new ExecutionError('gas required exceeds the block limit', 'GAS_TOO_HIGH');
      }
      let lo = 0n;
      let hi = cap;
      while (lo + 1n < hi) {
        const mid = (lo + hi) / 2n;
        if ((await probe(mid)).ok) hi = mid;
        else lo = mid;
      }
      // An estimate is an upper bound, not an exact figure: `runTx` charges a
      // little more than the bare `runCall` used here (transaction-level warm
      // accesses and access-list accounting), and state can change between the
      // estimate and inclusion. Under-quoting costs the caller a failed
      // transaction, so the margin is deliberate, and the candidate is verified
      // at the returned limit and grown until the simulated call succeeds.
      let candidate = intrinsic + hi + hi / 4n + 2100n;
      for (let i = 0; i < 8; i++) {
        if ((await probe(candidate - intrinsic)).ok) break;
        candidate = candidate + candidate / 4n;
      }
      return candidate;
    });
  }

  /** Deploy a contract from a funded EOA key. Test/tooling helper. */
  async deployFrom({ privateKey, bytecode, value = 0n, gasLimit = 30_000_000n, nonce, gasPrice }) {
    const wallet = new ethers.Wallet(privateKey);
    const raw = await wallet.signTransaction({
      to: null,
      data: bytecode,
      value,
      gasLimit,
      nonce,
      maxFeePerGas: gasPrice ?? FEES.suggestedGasPrice,
      maxPriorityFeePerGas: gasPrice ?? FEES.suggestedGasPrice,
      type: 2,
      chainId: Number(this.common.chainId()),
    });
    return raw;
  }

  static nextContractAddress(from, nonce) {
    return createContractAddress(addr(from), BigInt(nonce)).toString();
  }
}

function hexToBytesIfHex(value) {
  if (typeof value === 'string') return hexToBytes(value);
  return value;
}

function decodeRevert(returnValue) {
  try {
    const hex = ethers.hexlify(returnValue ?? new Uint8Array());
    if (hex.startsWith('0x08c379a0')) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10));
      return decoded[0];
    }
  } catch {
    /* not a standard revert payload */
  }
  return null;
}

function buildReceipt(tx, res, block, index, ctx) {
  const blockHash = toHex(block.hash());
  const logs = (res.execResult.logs ?? []).map((log, i) => ({
    address: ethers.getAddress(toHex(log[0])),
    topics: log[1].map((t) => toHex(t)),
    data: toHex(log[2]),
    blockNumber: Number(block.header.number),
    blockHash,
    transactionHash: toHex(tx.hash()),
    transactionIndex: '0x' + index.toString(16),
    logIndex: '0x' + i.toString(16),
    removed: false,
  }));
  // All numeric fields are decimal strings: receipts are persisted as JSON and
  // BigInt is not JSON-serialisable, so the receipt is normalised here rather
  // than at every write site.
  return {
    transactionHash: toHex(tx.hash()),
    transactionIndex: index,
    blockNumber: Number(block.header.number),
    blockHash,
    from: tx.getSenderAddress().toString(),
    to: tx.to ? tx.to.toString() : null,
    status: res.receipt.status,
    cumulativeGasUsed: res.receipt.cumulativeBlockGasUsed.toString(),
    gasUsed: res.totalGasSpent.toString(),
    gasLimit: tx.gasLimit.toString(),
    effectiveGasPrice: Execution.effectiveGasPrice(tx, ctx.baseFeePerGas ?? 0n).toString(),
    contractAddress: res.createdAddress ? res.createdAddress.toString() : null,
    logs,
    logsBloom: toHex(res.receipt.bitvector),
    type: tx.type,
    transactionIndexHex: '0x' + index.toString(16),
  };
}

module.exports = { Execution, ExecutionError, createChainCommon, addr, Address, EMPTY_CODE_HASH, toHex, zeroAddress: ZERO_ADDR };
