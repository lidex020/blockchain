'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const { LidexBlock } = require('../block');
const { evmHeaderFields } = require('../chain');

const BLOCK_ID_FLAG_ABSENT = 1;
const BLOCK_ID_FLAG_COMMIT = 2;
const BLOCK_ID_FLAG_NIL = 3;
const MAX_INT64 = (1n << 63n) - 1n;
const COMET_APP_VERSION = '0.1.0';

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new TypeError('expected an even-length 0x-prefixed byte string');
  }
  return Buffer.from(value.slice(2), 'hex');
}

function hex(value) {
  return Buffer.from(value ?? []).toString('hex');
}

function normalizedAddress(value) {
  return ethers.getAddress(String(value)).toLowerCase();
}

function cometAddressForKey(keyType, publicKey) {
  const key = Buffer.from(publicKey);
  if (keyType === 'ed25519' && key.length === 32) {
    return crypto.createHash('sha256').update(key).digest().subarray(0, 20).toString('hex');
  }
  if (keyType === 'secp256k1' && key.length === 33 && (key[0] === 2 || key[0] === 3)) {
    try {
      const canonical = ethers.SigningKey.computePublicKey(`0x${key.toString('hex')}`, true);
      if (canonical.toLowerCase() !== `0x${key.toString('hex')}`) throw new Error('non-canonical point');
    } catch {
      throw new Error('invalid compressed CometBFT secp256k1 validator public key');
    }
    return crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(key).digest()).digest().toString('hex');
  }
  throw new Error(`unsupported CometBFT validator public key type or length: ${keyType}/${key.length}`);
}

function safeNumber(value, label) {
  const n = Number(value?.toString?.() ?? value);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return n;
}

function createMapping(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('each validator mapping must be an object');
  const forbidden = Object.keys(raw).filter((key) => /private|secret|seed|priv_key/i.test(key));
  if (forbidden.length) throw new Error('validator mapping files may contain public keys only; secret fields are forbidden');
  const operator = normalizedAddress(raw.operator);
  const consensusAddress = normalizedAddress(raw.consensusAddress);
  const keyType = String(raw.keyType ?? '').toLowerCase();
  const publicKey = bytes(raw.publicKey);
  const cometAddress = cometAddressForKey(keyType, publicKey);
  if (raw.cometAddress !== undefined && String(raw.cometAddress).replace(/^0x/i, '').toLowerCase() !== cometAddress) {
    throw new Error(`CometBFT address does not match the configured public key for validator ${operator}`);
  }
  return { operator, consensusAddress, keyType, publicKey, cometAddress };
}

function publicKeyMessage(mapping) {
  return { [mapping.keyType]: mapping.publicKey };
}

function serializeVoteInfo(commitInfo) {
  return (commitInfo?.votes ?? []).map((vote) => ({
    address: hex(vote.validator?.address),
    power: String(vote.validator?.votingPower ?? ''),
    blockIdFlag: Number(vote.blockIdFlag ?? 0),
  }));
}

class ABCIApplication {
  constructor({ chain, network, validatorMappings, stateFile }) {
    if (!chain) throw new TypeError('a LIDEX Chain instance is required');
    const networkName = String(network ?? '').toLowerCase();
    if (networkName !== 'devnet' && networkName !== 'testnet') {
      throw new Error('the CometBFT ABCI application is limited to explicit devnet/testnet configurations');
    }
    if (!Array.isArray(validatorMappings)) throw new TypeError('an explicit validator public-key mapping array is required');
    this.chain = chain;
    this.network = networkName;
    this.stateFile = path.resolve(stateFile);
    this.height = 0;
    this.appHash = String(chain.appHash);
    this.pending = null;
    this.poisoned = null;
    this._queue = Promise.resolve();
    this.mappingsByOperator = new Map();
    this.mappingsByCometAddress = new Map();
    for (const raw of validatorMappings) {
      const mapping = createMapping(raw);
      if (this.mappingsByOperator.has(mapping.operator)) throw new Error(`duplicate operator mapping for ${mapping.operator}`);
      if (this.mappingsByCometAddress.has(mapping.cometAddress)) throw new Error(`duplicate CometBFT validator address ${mapping.cometAddress}`);
      this.mappingsByOperator.set(mapping.operator, mapping);
      this.mappingsByCometAddress.set(mapping.cometAddress, mapping);
    }
    if (!this.mappingsByOperator.size) throw new Error('at least one explicit testnet validator mapping is required');
  }

  static async create(options) {
    const app = new ABCIApplication(options);
    await app.recover();
    return app;
  }

  dispatch(request) {
    const run = () => this._dispatch(request);
    const result = this._queue.then(run, run);
    this._queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async _dispatch(request) {
    if (this.poisoned) throw new Error(`ABCI application is fail-stopped after a commit error: ${this.poisoned}`);
    const method = [
      'echo', 'flush', 'info', 'initChain', 'query', 'checkTx', 'commit',
      'listSnapshots', 'offerSnapshot', 'loadSnapshotChunk', 'applySnapshotChunk',
      'prepareProposal', 'processProposal', 'extendVote', 'verifyVoteExtension',
      'finalizeBlock', 'insertTx', 'reapTxs',
    ].find((name) => request[name] !== undefined);
    if (!method) throw new Error('ABCI request has no recognized v0.39.4 request variant');
    switch (method) {
      case 'echo': return { echo: { message: request.echo.message } };
      case 'flush': return { flush: {} };
      case 'info': return { info: this.info() };
      case 'initChain': return { initChain: this.initChain(request.initChain) };
      case 'query': return { query: await this.query(request.query) };
      case 'checkTx': return { checkTx: await this.checkTx(request.checkTx) };
      case 'commit': return { commit: await this.commit() };
      case 'listSnapshots': return { listSnapshots: { snapshots: [] } };
      case 'offerSnapshot': return { offerSnapshot: { result: 4 } };
      case 'loadSnapshotChunk': return { loadSnapshotChunk: { chunk: Buffer.alloc(0) } };
      case 'applySnapshotChunk': return { applySnapshotChunk: { result: 2 } };
      case 'prepareProposal': return { prepareProposal: this.prepareProposal(request.prepareProposal) };
      case 'processProposal': return { processProposal: await this.processProposal(request.processProposal) };
      case 'extendVote': return { extendVote: { voteExtension: Buffer.alloc(0) } };
      case 'verifyVoteExtension': return { verifyVoteExtension: { status: 1 } };
      case 'finalizeBlock': return { finalizeBlock: await this.finalizeBlock(request.finalizeBlock) };
      case 'insertTx': {
        const checked = await this.checkTx({ tx: request.insertTx.tx });
        return { insertTx: { code: checked.code } };
      }
      case 'reapTxs': return { reapTxs: this.reapTxs(request.reapTxs) };
      default: throw new Error(`ABCI request ${method} is not implemented`);
    }
  }

  info() {
    return {
      data: `lidex ethereumjs application ${COMET_APP_VERSION}`,
      version: COMET_APP_VERSION,
      appVersion: '1',
      lastBlockHeight: String(this.height),
      lastBlockAppHash: bytes(this.appHash),
    };
  }

  initChain(request) {
    if (String(request.chainId) !== String(this.chain.chainId)) throw new Error('CometBFT chain_id does not match the LIDEX execution chain id');
    if (this.height !== 0) throw new Error('InitChain is only valid before the first committed ABCI block');
    const requestedHeight = safeNumber(request.initialHeight ?? 0, 'initial_height');
    if (requestedHeight > 1) throw new Error('non-genesis initial heights require an independently verified state snapshot');
    const expected = this.activeMappings(this.chain.protocol.staking.activeSet());
    const supplied = (request.validators ?? []).map((entry) => this.mappingFromValidatorUpdate(entry));
    if (supplied.length !== expected.length) throw new Error('CometBFT InitChain validator set does not match the mapped LIDEX active set');
    const expectedByAddress = new Map(expected.map((entry) => [entry.mapping.cometAddress, entry]));
    for (const actual of supplied) {
      const wanted = expectedByAddress.get(actual.cometAddress);
      if (!wanted || wanted.mapping.keyType !== actual.keyType || !wanted.mapping.publicKey.equals(actual.publicKey) || wanted.power !== actual.power) {
        throw new Error('CometBFT InitChain contains a public key or voting power without an exact LIDEX mapping');
      }
      expectedByAddress.delete(actual.cometAddress);
    }
    if (expectedByAddress.size) throw new Error('CometBFT InitChain omitted a mapped LIDEX active validator');
    return { validators: [], appHash: bytes(this.appHash) };
  }

  mappingFromValidatorUpdate(update) {
    const pubKey = update.pubKey ?? {};
    const keyType = ['ed25519', 'secp256k1'].find((name) => pubKey[name] !== undefined);
    if (!keyType) throw new Error('CometBFT InitChain contains an unsupported validator public-key type');
    const publicKey = bytes(pubKey[keyType]);
    const cometAddress = cometAddressForKey(keyType, publicKey);
    return { keyType, publicKey, cometAddress, power: BigInt(update.power?.toString?.() ?? update.power ?? 0) };
  }

  activeMappings(activeSet) {
    return activeSet.map((validator) => {
      const operator = normalizedAddress(validator.operator);
      const mapping = this.mappingsByOperator.get(operator);
      if (!mapping) throw new Error(`no independently supplied CometBFT public-key mapping for active LIDEX validator ${operator}`);
      if (normalizedAddress(validator.consensusAddress) !== mapping.consensusAddress) {
        throw new Error(`LIDEX consensus address changed for mapped operator ${operator}; an operator-approved mapping update is required`);
      }
      const power = BigInt(validator.power);
      if (power <= 0n || power > MAX_INT64) throw new Error(`LIDEX voting power is outside CometBFT int64 range for ${operator}`);
      return { mapping, power };
    });
  }

  signersFromCommit(commitInfo, height) {
    if (height === 1) {
      if ((commitInfo?.votes ?? []).length) throw new Error('the first ABCI block must not invent a previous-height commit');
      return null;
    }
    const active = this.activeMappings(this.chain.protocol.staking.activeSet());
    const byAddress = new Map(active.map((entry) => [entry.mapping.cometAddress, entry]));
    const votes = commitInfo?.votes;
    if (!Array.isArray(votes) || votes.length !== active.length) {
      throw new Error('ABCI decided_last_commit must account for every validator in the previous LIDEX active set');
    }
    let signedPower = 0n;
    const signers = [];
    const seen = new Set();
    for (const vote of votes) {
      const validator = vote.validator ?? {};
      const address = hex(validator.address);
      const mapped = byAddress.get(address);
      if (!mapped || seen.has(address)) throw new Error('ABCI commit contains an unknown or duplicate CometBFT validator address');
      seen.add(address);
      const power = BigInt(validator.votingPower?.toString?.() ?? validator.votingPower ?? 0);
      if (power !== mapped.power) throw new Error(`CometBFT voting power differs from LIDEX for validator ${mapped.mapping.operator}`);
      const flag = Number(vote.blockIdFlag ?? 0);
      if (![BLOCK_ID_FLAG_ABSENT, BLOCK_ID_FLAG_COMMIT, BLOCK_ID_FLAG_NIL].includes(flag)) {
        throw new Error('ABCI commit contains an unknown block ID flag');
      }
      if (flag === BLOCK_ID_FLAG_COMMIT) {
        signedPower += power;
        signers.push(mapped.mapping.operator);
      }
    }
    const totalPower = active.reduce((sum, entry) => sum + entry.power, 0n);
    const quorum = (totalPower * 2n) / 3n + 1n;
    if (signedPower < quorum) throw new Error('ABCI previous-height commit does not contain a CometBFT quorum');
    return signers;
  }

  timestampSeconds(time) {
    if (!time) throw new Error('ABCI block timestamp is required');
    const seconds = BigInt(time.seconds?.toString?.() ?? time.seconds ?? 0);
    const nanos = Number(time.nanos ?? 0);
    if (seconds < 0n || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) {
      throw new Error('ABCI block timestamp is invalid');
    }
    if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ABCI block timestamp exceeds the safe execution range');
    return Number(seconds);
  }

  normalizeTxs(txs) {
    if (!Array.isArray(txs)) throw new TypeError('ABCI transaction list must be an array');
    return txs.map((tx) => `0x${hex(tx)}`);
  }

  /**
   * Resolve a CometBFT proposer address to the mapped LIDEX operator EVM
   * address. CometBFT v0.38+ always sends proposer_address; older test
   * clients may omit it, in which case the zero address is recorded rather
   * than inventing a proposer. An address with no mapping is a hard error:
   * only mapped validators may propose.
   */
  proposerOperator(proposerAddress) {
    if (proposerAddress === undefined || proposerAddress === null) {
      return '0x0000000000000000000000000000000000000000';
    }
    const cometAddress = hex(proposerAddress);
    if (!cometAddress) return '0x0000000000000000000000000000000000000000';
    const mapping = this.mappingsByCometAddress.get(cometAddress);
    if (!mapping) throw new Error(`ABCI proposer address ${cometAddress} has no LIDEX validator mapping`);
    return mapping.operator;
  }

  async simulate({ height, time, txs, commitInfo, misbehavior = [], proposerAddress }) {
    if (misbehavior.length) {
      throw new Error('CometBFT misbehavior has no verified LIDEX evidence mapping in this vertical slice');
    }
    const blockHeight = safeNumber(height, 'block height');
    if (blockHeight !== this.height + 1) throw new Error(`ABCI block height ${blockHeight} is not the next height ${this.height + 1}`);
    const timestamp = this.timestampSeconds(time);
    const lastCommitSigners = this.signersFromCommit(commitInfo, blockHeight);
    const proposer = this.proposerOperator(proposerAddress);
    const round = safeNumber(commitInfo?.round ?? 0, 'commit round');
    const outcome = await this.chain.execution.queue(() => this.chain.execution._executeBlock({
      parentBlock: this.chain.headEvmBlock,
      txs: txs.map((raw) => ({ raw })),
      height: blockHeight,
      timestamp,
      protocol: this.chain.protocol,
      evidence: [],
      dryRun: true,
      gasLimit: this.chain.params.blockGasLimit,
      lastCommitSigners,
    }));
    this.activeMappings((outcome.activeValidators ?? []).map((validator) => ({
      operator: validator.operator,
      consensusAddress: validator.consensusAddress,
      power: BigInt(validator.power),
    })));
    return { height: blockHeight, timestamp, txs, commitVotes: serializeVoteInfo(commitInfo), outcome, proposer, round };
  }

  prepareProposal(request) {
    if ((request.misbehavior ?? []).length) {
      throw new Error('CometBFT misbehavior has no verified LIDEX evidence mapping in this vertical slice');
    }
    const maximumBytes = BigInt(request.maxTxBytes?.toString?.() ?? request.maxTxBytes ?? 0);
    if (maximumBytes < 0n) throw new Error('negative max_tx_bytes is not supported');
    const txs = [];
    let size = 0n;
    const maxTxs = BigInt(this.chain.params.maxBlockTxs);
    for (const tx of request.txs ?? []) {
      if (BigInt(txs.length) >= maxTxs) break;
      const txSize = BigInt(bytes(tx).length);
      if (size + txSize > maximumBytes) break;
      txs.push(bytes(tx));
      size += txSize;
    }
    return { txs };
  }

  async processProposal(request) {
    try {
      await this.simulate({
        height: request.height,
        time: request.time,
        txs: this.normalizeTxs(request.txs ?? []),
        commitInfo: request.proposedLastCommit,
        misbehavior: request.misbehavior,
      });
      return { status: 1 };
    } catch {
      return { status: 2 };
    }
  }

  validatorUpdates(previousSet, nextSet) {
    const previous = new Map(this.activeMappings(previousSet).map(({ mapping, power }) => [mapping.operator, { mapping, power }]));
    const next = new Map(this.activeMappings(nextSet).map(({ mapping, power }) => [mapping.operator, { mapping, power }]));
    const updates = [];
    for (const [operator, oldEntry] of previous) {
      const newEntry = next.get(operator);
      if (!newEntry) updates.push({ pubKey: publicKeyMessage(oldEntry.mapping), power: '0' });
      else if (oldEntry.power !== newEntry.power) updates.push({ pubKey: publicKeyMessage(newEntry.mapping), power: String(newEntry.power) });
    }
    for (const [operator, newEntry] of next) {
      if (!previous.has(operator)) updates.push({ pubKey: publicKeyMessage(newEntry.mapping), power: String(newEntry.power) });
    }
    return updates;
  }

  finalizeTxResults(outcome) {
    return outcome.receipts.map((receipt, index) => {
      const tx = outcome.transactions[index];
      return {
        code: 0,
        data: Buffer.from(tx.hash()),
        gasWanted: String(tx.gasLimit),
        gasUsed: String(receipt.gasUsed ?? 0),
      };
    });
  }

  async finalizeBlock(request) {
    if (this.pending) throw new Error(`ABCI height ${this.pending.height} has not been committed yet`);
    if ((request.misbehavior ?? []).length) {
      throw new Error('CometBFT misbehavior has no verified LIDEX evidence mapping in this vertical slice');
    }
    const txs = this.normalizeTxs(request.txs ?? []);
    const result = await this.simulate({
      height: request.height,
      time: request.time,
      txs,
      commitInfo: request.decidedLastCommit,
      proposerAddress: request.proposerAddress,
    });
    const previousSet = this.chain.protocol.staking.activeSet();
    const nextSet = (result.outcome.activeValidators ?? []).map((validator) => ({
      operator: validator.operator,
      consensusAddress: validator.consensusAddress,
      power: BigInt(validator.power),
    }));
    const updates = this.validatorUpdates(previousSet, nextSet);
    this.pending = result;
    return {
      events: [],
      txResults: this.finalizeTxResults(result.outcome),
      validatorUpdates: updates,
      appHash: bytes(result.outcome.appHash),
    };
  }

  async checkTx(request) {
    try {
      const entry = await this.chain.pool.add(`0x${hex(request.tx)}`, { source: 'cometbft-abci', gossip: false });
      return { code: 0, data: Buffer.from(entry.tx.hash()), gasWanted: String(entry.gasLimit), codespace: '' };
    } catch (error) {
      return { code: 1, log: String(error.message), codespace: String(error.code ?? 'LIDEX') };
    }
  }

  reapTxs(request) {
    const maxBytes = BigInt(request.maxBytes?.toString?.() ?? request.maxBytes ?? 0);
    const maxGas = BigInt(request.maxGas?.toString?.() ?? request.maxGas ?? 0);
    const txs = [];
    let byteCount = 0n;
    let gasCount = 0n;
    for (const entry of this.chain.pool.entries.values()) {
      const tx = bytes(entry.raw);
      if (BigInt(txs.length) >= BigInt(this.chain.params.maxBlockTxs)) break;
      if (maxBytes > 0n && byteCount + BigInt(tx.length) > maxBytes) break;
      if (maxGas > 0n && gasCount + BigInt(entry.gasLimit) > maxGas) break;
      txs.push(tx);
      byteCount += BigInt(tx.length);
      gasCount += BigInt(entry.gasLimit);
    }
    return { txs };
  }

  async query(request) {
    const pathName = String(request.path ?? '');
    try {
      let value;
      if (pathName === '/status') {
        value = { height: this.height, appHash: this.appHash };
      } else if (pathName === '/supply') {
        value = this.chain.protocol.ledger.supplyReport();
      } else if (pathName.startsWith('/account/')) {
        value = await this.chain.execution.account(normalizedAddress(pathName.slice('/account/'.length)));
      } else {
        return { code: 1, log: `unsupported LIDEX ABCI query path: ${pathName}`, codespace: 'LIDEX' };
      }
      return {
        code: 0,
        key: Buffer.from(pathName),
        value: Buffer.from(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)),
        height: String(this.height),
      };
    } catch (error) {
      return { code: 1, log: String(error.message), codespace: 'LIDEX' };
    }
  }

  appendJournal(record) {
    const directory = path.dirname(this.stateFile);
    fs.mkdirSync(directory, { recursive: true });
    const descriptor = fs.openSync(this.stateFile, 'a');
    try {
      fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, null, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  readJournal() {
    if (!fs.existsSync(this.stateFile)) return [];
    const raw = fs.readFileSync(this.stateFile, 'utf8');
    if (raw && !raw.endsWith('\n')) {
      throw new Error(`ABCI state journal ${this.stateFile} has a torn final record; preserve the file and diagnose a separate copy`);
    }
    const records = [];
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`ABCI state journal ${this.stateFile} has malformed record ${index + 1}; preserve the file and diagnose a separate copy`);
      }
      if (!Number.isSafeInteger(record.height) || record.height !== records.length + 1 || !Array.isArray(record.txs) || !Array.isArray(record.commitVotes)) {
        throw new Error(`ABCI state journal ${this.stateFile} is inconsistent at record ${index + 1}; preserve the file and diagnose a separate copy`);
      }
      records.push(record);
    }
    return records;
  }

  voteInfoFromRecord(record) {
    return {
      votes: record.commitVotes.map((vote) => ({
        validator: { address: Buffer.from(vote.address, 'hex'), votingPower: vote.power },
        blockIdFlag: vote.blockIdFlag,
      })),
    };
  }

  async executeCommitted(record, commitInfo) {
    const outcome = await this.chain.execution.queue(() => this.chain.execution._executeBlock({
      parentBlock: this.chain.headEvmBlock,
      txs: record.txs.map((raw) => ({ raw })),
      height: record.height,
      timestamp: record.timestamp,
      protocol: this.chain.protocol,
      evidence: [],
      dryRun: false,
      gasLimit: this.chain.params.blockGasLimit,
      lastCommitSigners: this.signersFromCommit(commitInfo, record.height),
    }));
    if (String(outcome.appHash).toLowerCase() !== String(record.appHash).toLowerCase()) {
      throw new Error(`ABCI replay app-hash mismatch at height ${record.height}; preserve the journal and diagnose a separate copy`);
    }
    this.publishCommittedState(record.height, outcome, record);
    return outcome;
  }

  /**
   * Publish a committed block to the Chain indexes that RPC, WebSocket and
   * explorer reads depend on (blocks, receipts, head, EVM headers) and fire
   * the same onCommitted hooks the custom-consensus path fires. Without
   * this, an ABCI-driven node executes blocks but serves stale reads:
   * eth_blockNumber would stay at genesis while CometBFT advances.
   *
   * Persistence deliberately stays in the ABCI journal (see commit()): the
   * Chain block log is not appended here, so a restart replays genesis from
   * the Chain store and then the journal, exactly once each.
   */
  publishCommittedState(height, outcome, record = {}) {
    this.height = height;
    this.appHash = String(outcome.appHash);
    const block = LidexBlock.assemble({
      chainId: String(this.chain.chainId),
      height,
      time: Number(record.timestamp ?? 0) * 1000,
      round: Number(record.round ?? 0),
      proposer: record.proposer ?? '0x0000000000000000000000000000000000000000',
      parentHash: this.chain.head.hash,
      txs: record.txs ?? outcome.transactions.map((tx) => ethers.hexlify(tx.serialize())),
      evidence: [],
      lastCommit: null,
      stateRoot: String(outcome.stateRoot),
      appHash: String(outcome.appHash),
      validatorsHash: ethers.hexlify(outcome.validatorsHash),
      gasUsed: outcome.gasUsed,
      gasLimit: this.chain.params.blockGasLimit,
    });
    this.chain._register(block, outcome.receipts);
    this.chain.evmHeaders.set(height, outcome.evmHeader ?? evmHeaderFields(outcome));
    this.chain.head = block;
    this.chain.headEvmBlock = outcome.evmBlock;
    this.chain.execution.headBlock = outcome.evmBlock;
    this.chain.stateRoot = String(outcome.stateRoot);
    this.chain.appHash = String(outcome.appHash);
    this.chain.validatorsHash = ethers.hexlify(outcome.validatorsHash);
    const confirmed = outcome.transactions.map((tx) => ethers.hexlify(tx.hash()));
    this.chain.pool.afterCommit(confirmed, outcome.transactions.map((tx) => [
      normalizedAddress(tx.getSenderAddress().toString()),
      Number(tx.nonce) + 1,
    ]));
    for (const tx of outcome.transactions) {
      this.chain.nonceCache.set(normalizedAddress(tx.getSenderAddress().toString()), Number(tx.nonce) + 1);
    }
    for (const hook of this.chain._committedHooks) {
      try {
        hook(block, outcome, 'cometbft-abci');
      } catch {
        // Hook failures (e.g. a closed WebSocket) must not fail the commit.
      }
    }
  }

  async commit() {
    if (!this.pending) return { retainHeight: '0' };
    const pending = this.pending;
    const record = {
      height: pending.height,
      timestamp: pending.timestamp,
      txs: pending.txs.map((raw) => raw.toLowerCase()),
      commitVotes: pending.commitVotes,
      proposer: pending.proposer,
      round: pending.round,
      appHash: String(pending.outcome.appHash),
    };
    try {
      this.appendJournal(record);
      const outcome = await this.executeCommitted(record, this.voteInfoFromRecord(record));
      if (String(outcome.stateRoot).toLowerCase() !== String(pending.outcome.stateRoot).toLowerCase()) {
        throw new Error(`ABCI execution changed between FinalizeBlock and Commit at height ${record.height}`);
      }
      this.pending = null;
      return { retainHeight: '0' };
    } catch (error) {
      this.poisoned = error.message;
      throw error;
    }
  }

  async recover() {
    for (const record of this.readJournal()) {
      if (record.height !== this.height + 1) throw new Error(`ABCI journal height ${record.height} does not follow ${this.height}`);
      const outcome = await this.executeCommitted(record, this.voteInfoFromRecord(record));
      if (String(outcome.appHash).toLowerCase() !== String(record.appHash).toLowerCase()) {
        throw new Error(`ABCI journal app-hash mismatch at height ${record.height}; preserve the journal and diagnose a separate copy`);
      }
    }
  }
}

module.exports = { ABCIApplication, cometAddressForKey };
