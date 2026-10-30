'use strict';
/**
 * Ethereum JSON-RPC surface plus the `fs_` protocol namespace.
 *
 * The eth_ methods are implemented against the real execution state so that
 * ethers.js, viem, Hardhat and MetaMask work unmodified. The `fs_` namespace
 * exposes the protocol-level parts that an EVM node has no notion of: supply
 * accounting, the validator set, staking, community rewards and consensus
 * status.
 *
 * docs/COMPATIBILITY.md lists what is supported and what is deliberately not.
 */

const { ethers } = require('ethers');
const { COIN, SYSTEM, FEES, PROTOCOL, VERSION, CHAIN } = require('./constants');
const { createLogger } = require('./logger');

const log = createLogger('rpc');

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const hex = (value) => {
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (typeof value === 'number') return `0x${BigInt(value).toString(16)}`;
  if (typeof value === 'string' && value.startsWith('0x')) return value;
  // Decimal strings are how BigInt amounts are stored in receipts and reports.
  return `0x${BigInt(value ?? 0).toString(16)}`;
};

class RpcServer {
  /**
   * @param {object} deps
   * @param {Chain} deps.chain
   * @param {Consensus} [deps.consensus]
   * @param {object} [deps.node]
   */
  constructor({ chain, consensus, node }) {
    this.chain = chain;
    this.consensus = consensus;
    this.node = node;
    this.rate = new Map();
    this.methods = this.buildMethods();
  }

  buildMethods() {
    const chain = this.chain;
    const ex = chain.execution;
    const self = this;
    return {
      // ---- standard namespace -------------------------------------------
      web3_clientVersion: async () => `${VERSION.software}/${process.platform}-node${process.version}`,
      web3_sha3: async (data) => ethers.keccak256(data),

      net_version: async () => String(chain.chainId),
      net_listening: async () => true,
      net_peerCount: async () => hex(this.node?.peerCount() ?? 0),

      eth_protocolVersion: async () => VERSION.appVersion,
      eth_chainId: async () => hex(chain.chainId),
      eth_syncing: async () => (this.node?.isSyncing() ? { startingBlock: hex(this.node.syncStart), currentBlock: hex(chain.head.height), highestBlock: hex(this.node.syncTarget) } : false),
      eth_coinbase: async () => SYSTEM.feeCollectorAddress,
      eth_mining: async () => !!this.consensus?.isValidator,
      eth_hashrate: async () => '0x0',
      eth_gasPrice: async () => hex(chain.gasPrice()),
      eth_maxPriorityFeePerGas: async () => '0x0',
      eth_feeHistory: async (blockCount) => ({
        oldestBlock: hex(Math.max(0, chain.head.height - Number(blockCount) + 1)),
        baseFeePerGas: Array.from({ length: Number(blockCount) + 1 }, () => '0x0'),
        gasUsedRatio: Array.from({ length: Number(blockCount) }, () => 0.05),
        reward: Array.from({ length: Number(blockCount) }, () => ['0x0']),
      }),

      eth_blockNumber: async () => hex(chain.head.height),

      eth_getBalance: async (address, blockTag = 'latest') => {
        this.requireBlockTag(blockTag);
        return hex(await ex.balance(address));
      },
      eth_getTransactionCount: async (address, blockTag = 'latest') => {
        this.requireBlockTag(blockTag);
        const acc = await ex.account(address);
        return hex(acc.nonce);
      },
      eth_getCode: async (address, blockTag = 'latest') => {
        this.requireBlockTag(blockTag);
        return ex.getCode(address);
      },
      eth_getStorageAt: async (address, slot, blockTag = 'latest') => {
        this.requireBlockTag(blockTag);
        return ex.getStorageAt(address, slot);
      },
      eth_getProof: async () => {
        throw new RpcError(-32601, 'eth_getProof is not enabled on this node (see docs/COMPATIBILITY.md)');
      },

      eth_getBlockByNumber: async (tag, full) => self.renderBlockByTag(tag, full),
      eth_getBlockByHash: async (hash, full) => self.renderBlockByHash(hash, full),
      eth_getBlockTransactionCountByNumber: async (tag) => {
        const block = chain.getBlock(self.resolveTag(tag));
        if (!block) return null;
        return hex(block.header.txCount);
      },
      eth_getBlockTransactionCountByHash: async (hash) => {
        const block = chain.getBlock(String(hash).toLowerCase());
        if (!block) return null;
        return hex(block.header.txCount);
      },

      eth_sendRawTransaction: async (raw) => {
        const entry = await chain.pool.add(raw, { source: 'rpc' });
        return entry.hash;
      },
      eth_getTransactionByHash: async (hash) => self.renderTransaction(hash),
      eth_getTransactionReceipt: async (hash) => self.renderReceipt(hash),
      eth_getTransactionByBlockHashAndIndex: async (hash, index) => {
        const block = chain.getBlock(String(hash).toLowerCase());
        if (!block) return null;
        return this.renderTransactionFromRaw(block.txs[Number(index)], block, Number(index));
      },
      eth_getTransactionByBlockNumberAndIndex: async (tag, index) => {
        const block = chain.getBlock(this.resolveTag(tag));
        if (!block) return null;
        return this.renderTransactionFromRaw(block.txs[Number(index)], block, Number(index));
      },

      eth_call: async (txObj, blockTag = 'latest') => {
        this.requireBlockTag(blockTag);
        const res = await ex.call({
          from: txObj.from,
          to: txObj.to,
          data: txObj.data ?? txObj.input,
          value: txObj.value ? BigInt(txObj.value) : 0n,
          gas: txObj.gas ? BigInt(txObj.gas) : undefined,
        });
        if (res.exception && res.exception !== 'revert') throw new RpcError(3, `execution error: ${res.exception}`);
        if (res.exception === 'revert') throw new RpcError(3, res.return ? `execution reverted: ${res.return}` : 'execution reverted');
        return res.returnValue;
      },
      eth_estimateGas: async (txObj) => {
        const gas = await ex.estimate({
          from: txObj.from,
          to: txObj.to,
          data: txObj.data ?? txObj.input,
          value: txObj.value ? BigInt(txObj.value) : 0n,
          deploy: !txObj.to,
        });
        return hex(gas);
      },
      eth_createAccessList: async () => {
        throw new RpcError(-32601, 'eth_createAccessList is not enabled on this node');
      },
      eth_getLogs: async (filter = {}) => {
        const from = filter.fromBlock === undefined ? 0 : this.resolveTag(filter.fromBlock);
        const to = filter.toBlock === undefined ? chain.head.height : this.resolveTag(filter.toBlock);
        if (to - from > PROTOCOL.maxRangeQuery) {
          throw new RpcError(-32005, `log query spans ${to - from} blocks, the limit is ${PROTOCOL.maxRangeQuery}`);
        }
        return chain.getLogs({ fromBlock: from, toBlock: to, address: filter.address, topics: filter.topics });
      },
      eth_getFilterChanges: async () => {
        throw new RpcError(-32601, 'poll-based filters are not supported; use WebSocket subscriptions or eth_getLogs');
      },
      eth_unsubscribe: async () => false,
      eth_subscribe: async () => {
        throw new RpcError(-32601, 'subscriptions are available over the WebSocket endpoint, not JSON-RPC');
      },

      // ---- Full Stop protocol namespace ---------------------------------
      fs_status: async () => ({ ...chain.status(), consensus: this.consensus?.status() ?? null, peers: this.node?.peerStatus() ?? [] }),
      fs_genesis: async () => chain.genesis,
      /**
       * The parameters a client actually has to respect, read from the running
       * node rather than from a constant in the client. Everything here is a
       * genesis value, so two nodes on the same network always agree.
       */
      fs_params: async () => deepStringify({
        chainId: String(chain.chainId),
        appVersion: VERSION.appVersion,
        hardfork: chain.params.hardfork,
        blockGasLimit: chain.params.blockGasLimit.toString(),
        maxBlockTxs: chain.params.maxBlockTxs,
        minGasPriceWei: BigInt(chain.params.minGasPrice ?? FEES.minGasPrice).toString(),
        suggestedGasPriceWei: chain.gasPrice().toString(),
        burnBps: BigInt(chain.params.burnBps ?? 0n).toString(),
        validatorFeeBps: BigInt(chain.params.validatorFeeBps ?? 0n).toString(),
        blockSubsidy: BigInt(chain.params.blockSubsidy ?? 0n).toString(),
        maxSupply: BigInt(chain.params.maxSupply ?? COIN.maxSupply).toString(),
        decimals: COIN.decimals,
        ticker: COIN.ticker,
        staking: chain.protocol.staking.params,
        community: {
          roundBlocks: chain.params.communityRoundBlocks,
          roundBudget: BigInt(chain.params.communityRoundBudget ?? 0n).toString(),
          maxPerAddressPerRound: BigInt(chain.params.maxPerAddressPerRound ?? 0n).toString(),
          approvalQuorum: chain.params.communityApprovalQuorum,
        },
        moduleAddress: SYSTEM.moduleAddress,
        systemContracts: chain.genesis.system_contracts ?? {},
        consensus: {
          algorithm: 'FSC/0.1',
          blockTimeMs: chain.params.blockTimeMs ?? null,
          minBlockIntervalMs: BigInt(chain.params.minBlockIntervalMs ?? 0n).toString(),
        },
        limits: {
          maxRangeQuery: PROTOCOL.maxRangeQuery,
          rpcRequestsPerMinute: this.node?.rpcRateLimit ?? PROTOCOL.rpcRateLimit,
          maxPendingPerAccount: PROTOCOL.maxPendingPerAccount,
        },
      }),
      fs_supply: async () => chain.supplyReport(),
      fs_supplyAudit: async () => chain.protocol.supplyAudit(ex),
      fs_validators: async () => chain.validators(),
      fs_validator: async (address) => {
        const v = chain.protocol.staking.state.validators[String(address).toLowerCase()];
        if (!v) return null;
        return {
          operator: v.operator,
          consensusAddress: v.consensusAddress,
          moniker: v.moniker,
          status: v.status,
          commissionBps: v.commissionBps.toString(),
          selfStake: v.selfStake.toString(),
          totalStake: v.totalStake.toString(),
          delegators: Object.entries(v.delegators).map(([a, amt]) => ({ address: a, amount: amt.toString() })),
          missedBlocks: chain.protocol.staking.state.missed[v.operator] ?? 0,
        };
      },
      fs_delegations: async (address) => {
        const a = String(address).toLowerCase();
        const out = [];
        for (const v of Object.values(chain.protocol.staking.state.validators)) {
          const held = v.delegators[a];
          if (held) out.push({ operator: v.operator, moniker: v.moniker, amount: held.toString(), selfBond: v.operator === a });
        }
        const pending = chain.protocol.staking.state.unbonding
          .filter((u) => u.owner === a)
          .map((u) => ({ operator: u.operator, amount: u.amount.toString(), maturesAt: u.maturesAt }));
        return { bonded: out, unbonding: pending };
      },
      fs_stakingParams: async () => deepStringify({
        ...chain.protocol.staking.params,
        moduleAddress: SYSTEM.moduleAddress,
        escrowBalance: await ex.balance(SYSTEM.moduleAddress),
        escrowRequired: chain.protocol.requiredEscrow(),
      }),
      fs_communityClaims: async (args = {}) => {
        const claims = Object.values(chain.protocol.staking.state.claims);
        const filtered = args.status ? claims.filter((c) => c.status === args.status) : claims;
        return filtered
          .sort((a, b) => b.submittedAt - a.submittedAt)
          .slice(0, args.limit ?? 50)
          .map((c) => ({ ...c, amount: c.amount.toString() }));
      },
      fs_communityRound: async () => chain.protocol.ledger.state.communityRound && {
        index: chain.protocol.ledger.state.communityRound.index,
        spent: chain.protocol.ledger.state.communityRound.spent.toString(),
        claims: chain.protocol.ledger.state.communityRound.claims,
        budget: (chain.params.communityRoundBudget ?? COIN.unit * 100n).toString(),
      },
      fs_rewards: async () => deepStringify({
        validatorPool: await ex.balance(SYSTEM.validatorPoolAddress),
        communityPool: await ex.balance(SYSTEM.communityPoolAddress),
        vesting: await ex.balance(SYSTEM.vestingAddress),
        feeCollector: await ex.balance(SYSTEM.feeCollectorAddress),
        totals: chain.protocol.ledger.state.totals,
      }),
      fs_evidence: async () => chain.protocol.staking.state.evidence.slice(-50),
      fs_mempool: async (args = {}) => ({ ...chain.pool.stats(), transactions: chain.pool.list({ limit: args.limit ?? 50 }) }),
      fs_blocks: async (args = {}) => {
        const count = Math.min(args.count ?? 20, PROTOCOL.maxRangeQuery);
        const from = args.from === undefined ? Math.max(0, chain.head.height - count + 1) : args.from;
        const out = [];
        for (let h = Math.min(from, chain.head.height); h <= Math.min(from + count - 1, chain.head.height); h++) {
          const b = chain.blocks.get(h);
          if (b) out.push(blockSummary(b));
        }
        return out.reverse();
      },
      fs_account: async (address) => {
        const acc = await ex.account(address);
        return {
          address: acc.address,
          nonce: acc.nonce.toString(),
          balance: acc.balance.toString(),
          balanceFstop: formatFstop(acc.balance),
          isContract: await ex.isContract(address),
          codeHash: acc.codeHash,
        };
      },
      fs_addressTransactions: async (address, args = {}) => {
        const key = ethers.getAddress(String(address)).toLowerCase();
        const history = chain.addressTransactions.get(key) ?? [];
        const offset = Number(args.offset ?? 0);
        const limit = Number(args.limit ?? 25);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
          throw new RpcError(-32602, 'offset must be a non-negative integer and limit must be a positive integer');
        }
        const pageSize = Math.min(100, limit);
        const hashes = history.slice().reverse().slice(offset, offset + pageSize);
        const transactions = hashes.map((hash) => {
          const position = chain.txPosition.get(hash);
          const block = position && chain.blocks.get(position.blockNumber);
          const receipt = chain.receiptByTx.get(hash);
          const raw = block?.txs[position?.transactionIndex];
          if (!position || !block || !receipt || !raw) {
            throw new RpcError(-32000, `transaction index is inconsistent for ${hash}`);
          }
          const tx = ethers.Transaction.from(raw);
          return {
            hash,
            blockNumber: position.blockNumber,
            transactionIndex: position.transactionIndex,
            from: receipt.from,
            to: receipt.to,
            contractAddress: receipt.contractAddress,
            value: tx.value.toString(),
            gasUsed: receipt.gasUsed.toString(),
            status: receipt.status === 1 ? '0x1' : '0x0',
          };
        });
        return { total: String(history.length), offset, limit: pageSize, transactions };
      },
      /**
       * Assets recorded by the on-chain registry.
       *
       * There is no separate indexer process and no node-local asset table:
       * the registry contract *is* the index, so this reads it through the same
       * EVM call path a dapp would use and decodes the struct here for
       * convenience. That means the answer can never disagree with what a wallet
       * sees by calling the contract directly.
       */
      fs_assets: async (args = {}) => {
        const registry = chain.genesis.system_contracts?.asset_registry;
        if (!registry) return { total: '0', assets: [], note: 'this network has no asset registry' };
        const offset = Math.max(0, Number(args.offset ?? 0));
        const limit = Math.min(200, Math.max(1, Number(args.limit ?? 25)));
        const abi = ASSET_REGISTRY_ABI;
        const data = abi.encodeFunctionData('assets', [BigInt(offset), BigInt(limit)]);
        const res = await ex.call({ to: registry, data });
        if (res.exception) throw new RpcError(3, `the asset registry could not be read: ${res.exception}`);
        const [page, total] = abi.decodeFunctionResult('assets', res.returnValue);
        return {
          registry,
          total: total.toString(),
          offset,
          limit,
          assets: page.map((a) => ({
            contractAddress: a.contractAddress,
            kind: KIND_NAMES[Number(a.kind)] ?? `unknown(${a.kind})`,
            creator: a.creator,
            blockNumber: a.blockNumber.toString(),
            name: a.name,
            symbol: a.symbol,
          })),
        };
      },
      fs_asset: async (address) => {
        const registry = chain.genesis.system_contracts?.asset_registry;
        if (!registry) return null;
        const res = await ex.call({ to: registry, data: ASSET_REGISTRY_ABI.encodeFunctionData('assetOf', [ethers.getAddress(String(address))]) });
        if (res.exception) throw new RpcError(3, `the asset registry could not be read: ${res.exception}`);
        const [a, known] = ASSET_REGISTRY_ABI.decodeFunctionResult('assetOf', res.returnValue);
        if (!known) return null;
        return {
          contractAddress: a.contractAddress,
          kind: KIND_NAMES[Number(a.kind)] ?? `unknown(${a.kind})`,
          creator: a.creator,
          blockNumber: a.blockNumber.toString(),
          name: a.name,
          symbol: a.symbol,
        };
      },
      // One parameter on purpose: the faucet pays from the balance of the key it
      // holds, so there is no "which pool" to choose and no minting path.
      fs_faucet: async (address) => {
        if (!this.node?.faucet) throw new RpcError(-32601, 'this node does not run a faucet');
        return this.node.faucet.claim(String(address));
      },
      fs_faucetStatus: async () => {
        if (!this.node?.faucet) throw new RpcError(-32601, 'this node does not run a faucet');
        return this.node.faucet.status();
      },
      fs_rateLimitInfo: async () => ({
        limit: this.node?.rpcRateLimit ?? PROTOCOL.rpcRateLimit,
        windowMs: PROTOCOL.rpcRateWindowMs,
        default: PROTOCOL.rpcRateLimit,
      }),
    };
  }

  requireBlockTag(tag) {
    const t = String(tag);
    if (t !== 'latest' && t !== 'pending' && !/^0x[0-9a-f]+$/i.test(t) && !/^(earliest)$/.test(t)) {
      throw new RpcError(-32000, `unsupported block tag "${t}": historical state is served for the head only by this node build`);
    }
    if (t === 'earliest') throw new RpcError(-32000, 'earliest state is not retained by this node build');
  }

  resolveTag(tag) {
    if (tag === undefined || tag === 'latest' || tag === 'pending') return this.chain.head.height;
    if (tag === 'earliest') return 0;
    if (typeof tag === 'number') return tag;
    return Number(BigInt(String(tag)));
  }

  async renderBlockByTag(tag, full) {
    const height = this.resolveTag(tag);
    const block = this.chain.blocks.get(height);
    if (!block) return null;
    return this.renderBlock(block, full);
  }

  async renderBlockByHash(hash, full) {
    const block = this.chain.getBlock(String(hash).toLowerCase());
    if (!block) return null;
    return this.renderBlock(block, full);
  }

  async renderBlock(block, full) {
    const h = block.header;
    const evm = this.chain.evmHeaders.get(h.height) ?? {};
    const txList = full ? await Promise.all(block.txs.map((raw, i) => this.renderTransactionFromRaw(raw, block, i))) : block.txs.map((raw) => ethers.Transaction.from(raw).hash);
    return {
      number: hex(h.height),
      hash: h.height === 0 && !block.hash ? null : block.hash,
      parentHash: h.parentHash,
      mixHash: '0x' + '00'.repeat(32),
      nonce: '0x0000000000000000',
      sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
      logsBloom: evm.logsBloom ?? '0x' + '00'.repeat(256),
      transactionsRoot: evm.transactionsRoot ?? h.dataHash,
      stateRoot: h.stateRoot,
      receiptsRoot: evm.receiptsRoot ?? '0x' + '00'.repeat(32),
      miner: SYSTEM.feeCollectorAddress,
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: h.appHash,
      size: hex(JSON.stringify(block.toJSON()).length),
      gasLimit: hex(BigInt(h.gasLimit)),
      gasUsed: hex(BigInt(h.gasUsed)),
      timestamp: hex(BigInt(Math.floor(h.time / 1000))),
      transactions: txList,
      uncles: [],
      withdrawals: null,
      baseFeePerGas: '0x0',
      blobGasUsed: null,
      excessBlobGas: null,
      // Full Stop specific fields, ignored by standard tooling.
      fs: {
        appHash: h.appHash,
        proposer: h.proposer,
        round: h.round,
        validatorsHash: h.validatorsHash,
        consensusBlockHash: block.hash,
        evidenceCount: (block.evidence ?? []).length,
        software: h.software,
      },
    };
  }

  async renderTransaction(hash) {
    const key = String(hash).toLowerCase();
    const pos = this.chain.txPosition.get(key);
    if (!pos) {
      const pending = this.chain.pool.get(hash);
      if (!pending) return null;
      return txJson(pending.raw, null, null, pending.tx);
    }
    const block = this.chain.blocks.get(pos.blockNumber);
    if (!block) return null;
    return txJson(block.txs[pos.transactionIndex], block, pos.transactionIndex);
  }

  async renderTransactionFromRaw(raw, block, index) {
    if (!raw) return null;
    return txJson(raw, block, index);
  }

  async renderReceipt(hash) {
    const r = this.chain.getReceipt(hash);
    if (!r) return null;
    const blockHash = this.chain.blocks.get(r.blockNumber)?.hash ?? r.blockHash;
    return {
      transactionHash: r.transactionHash,
      transactionIndex: hex(r.transactionIndex),
      blockHash,
      blockNumber: hex(r.blockNumber),
      from: r.from,
      to: r.to,
      cumulativeGasUsed: hex(r.cumulativeGasUsed),
      gasUsed: hex(r.gasUsed),
      contractAddress: r.contractAddress,
      effectiveGasPrice: hex(r.effectiveGasPrice),
      logsBloom: r.logsBloom,
      logs: r.logs.map((l, i) => ({ ...l, blockHash, logIndex: hex(i), transactionIndex: hex(r.transactionIndex) })),
      status: r.status === 1 ? '0x1' : '0x0',
      type: hex(r.type),
      // The protocol records what it did with each system transaction; this is
      // not part of the Ethereum receipt shape so it lives under a prefix.
      ...(r.systemActions ? { fsProtocolActions: r.systemActions } : {}),
    };
  }
}

function txJson(raw, block, index, parsed) {
  const tx = parsed ?? ethers.Transaction.from(raw);
  const out = {
    blockHash: block ? block.hash : null,
    blockNumber: block ? hex(block.height) : null,
    from: tx.from,
    gas: hex(tx.gasLimit),
    gasPrice: tx.gasPrice !== null && tx.gasPrice !== undefined ? hex(tx.gasPrice) : null,
    maxFeePerGas: tx.maxFeePerGas != null ? hex(tx.maxFeePerGas) : null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas != null ? hex(tx.maxPriorityFeePerGas) : null,
    hash: tx.hash,
    input: tx.data,
    nonce: hex(tx.nonce),
    to: tx.to,
    value: hex(tx.value),
    chainId: hex(tx.chainId),
    type: hex(tx.type),
    accessList: tx.accessList ?? [],
    v: tx.signature?.v != null ? hex(tx.signature.v) : null,
    r: tx.signature?.r ?? null,
    s: tx.signature?.s ?? null,
    yParity: tx.signature?.yParity ?? null,
    transactionIndex: block ? hex(index) : null,
  };
  return out;
}

function blockSummary(block) {
  const h = block.header;
  return {
    height: h.height,
    hash: block.hash,
    parentHash: h.parentHash,
    time: new Date(h.time).toISOString(),
    proposer: h.proposer,
    round: h.round,
    txCount: h.txCount,
    gasUsed: h.gasUsed,
    gasLimit: h.gasLimit,
    appHash: h.appHash,
    stateRoot: h.stateRoot,
    evidence: (block.evidence ?? []).length,
    commits: block.lastCommit?.votes?.length ?? 0,
  };
}

const ASSET_REGISTRY_ABI = new ethers.Interface([
  'function assets(uint256 offset, uint256 limit) view returns (tuple(address contractAddress, uint8 kind, address creator, uint256 blockNumber, string name, string symbol)[] page, uint256 total)',
  'function assetOf(address contractAddress) view returns (tuple(address contractAddress, uint8 kind, address creator, uint256 blockNumber, string name, string symbol) a, bool known)',
  'function assetCount() view returns (uint256)',
]);
const KIND_NAMES = ['none', 'ERC-20', 'ERC-721', 'ERC-1155'];

/** BigInts anywhere in a params object become decimal strings: JSON-safe on the wire. */
function deepStringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(deepStringify);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepStringify(v);
    return out;
  }
  return value;
}

function mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

function formatFstop(amount) {
  return ethers.formatUnits(amount, COIN.decimals);
}

/**
 * Handle a single JSON-RPC request object (or batch).
 * @returns {Promise<object|null>} the response, or null for a notification
 */
async function handle(rpc, body, meta = {}) {
  const batch = Array.isArray(body);
  const requests = batch ? body : [body];
  const responses = [];
  for (const req of requests) {
    responses.push(await handleOne(rpc, req, meta));
  }
  const filtered = responses.filter(Boolean);
  if (batch) return filtered;
  return filtered[0] ?? null;
}

async function handleOne(rpc, req, meta) {
  if (!req || typeof req !== 'object' || !req.method) {
    return { jsonrpc: '2.0', error: { code: -32600, message: 'invalid request' }, id: req?.id ?? null };
  }
  const method = rpc.methods[req.method];
  if (!method) {
    return { jsonrpc: '2.0', error: { code: -32601, message: `method "${req.method}" not found` }, id: req.id ?? null };
  }
  try {
    const params = req.params ?? [];
    const result = await method(...(Array.isArray(params) ? params : [params]));
    if (req.jsonrpc === '2.0' && req.id === undefined) return null;
    return { jsonrpc: '2.0', result: result === undefined ? null : result, id: req.id ?? null };
  } catch (err) {
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', error: { code: err.code, message: err.message, data: err.data }, id: req.id ?? null };
    }
    log.warn('rpc error', { method: req.method, err: err.message });
    return { jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: req.id ?? null };
  }
}

module.exports = { RpcServer, RpcError, handle, hex, blockSummary, txJson };
