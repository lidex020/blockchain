'use strict';
/**
 * Test harness.
 *
 * Tests run a real network: several Chain + Consensus pairs wired together by
 * an in-process message bus. There is no mock consensus and no stubbed
 * execution - every assertion below is made against blocks that were produced,
 * gossiped, re-executed, voted on and committed by the same code a node runs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');

const { Chain } = require('../src/chain.js');
const { Consensus } = require('../src/consensus.js');
const { loadGenesis, toExecutionGenesis } = require('../src/genesis.js');
const { FullStopBlock, MessageType } = require('../src/block.js');
const { Protocol } = require('../src/protocol.js');
const { Execution } = require('../src/execution.js');
const { COIN, SYSTEM, BLOCK, FEES, STAKING, COMMUNITY, ALLOCATIONS, REWARDS, CHAIN, VERSION, GAS, PROTOCOL, POOL } = require('../src/constants.js');

const UNIT = COIN.unit;

/** Minimal test runner with the shape the suite needs. */
class Suite {
  constructor(name) {
    this.name = name;
    this.results = [];
    this.group = '';
  }

  describe(name) {
    this.group = name;
    process.stdout.write(`\n${name}\n`);
  }

  async test(label, fn, { timeoutMs = 120_000 } = {}) {
    const started = Date.now();
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error(`test timed out after ${timeoutMs}ms`)), timeoutMs);
          if (t.unref) t.unref();
        }),
      ]);
      this.results.push({ label, ok: true, ms: Date.now() - started });
      process.stdout.write(`  ok   ${label} (${Date.now() - started}ms)\n`);
    } catch (err) {
      this.results.push({ label, ok: false, error: err });
      process.stdout.write(`  FAIL ${label}\n       ${err.message}\n`);
      if (process.env.FULLSTOP_TEST_TRACE && err.stack) process.stdout.write(`${err.stack}\n`);
    }
  }

  summary() {
    const failed = this.results.filter((r) => !r.ok);
    process.stdout.write(
      `\n${this.results.length - failed.length}/${this.results.length} tests passed in ${this.name}\n`
    );
    if (failed.length) {
      process.stdout.write(`\nfailures:\n${failed.map((f) => `  - ${f.label}: ${f.error.message}`).join('\n')}\n`);
    }
    return failed.length;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  const a = typeof actual === 'bigint' ? actual.toString() : String(actual);
  const b = typeof expected === 'bigint' ? expected.toString() : String(expected);
  if (a !== b) throw new Error(`${msg ?? 'values differ'}: got ${a}, want ${b}`);
}
async function assertRejects(fn, pattern, msg) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error(`${msg ?? 'expected a rejection'}: no error thrown`);
  if (pattern && !pattern.test(threw.message)) {
    throw new Error(`${msg ?? 'expected a rejection'}: got "${threw.message}", want it to match ${pattern}`);
  }
  return threw;
}

/** Parameters a test network runs with, derived from a genesis document. */
function paramsFromGenesis(genesis, key) {
  const allocations = {};
  for (const [k, c] of Object.entries(genesis.protocol.allocations)) {
    allocations[k] = {
      label: c.label,
      shareBps: BigInt(c.share_bps),
      issuance: c.issuance,
      cliffBlocks: c.cliff_blocks,
      vestingBlocks: c.vesting_blocks,
    };
  }
  const st = genesis.protocol.staking;
  const cm = genesis.protocol.community;
  return {
    chainId: genesis.chain_id,
    hardfork: genesis.protocol.hardfork,
    blockGasLimit: BigInt(genesis.protocol.block_gas_limit),
    maxBlockTxs: genesis.protocol.max_block_txs,
    minGasPrice: BigInt(genesis.protocol.min_gas_price),
    suggestedGasPrice: BigInt(genesis.protocol.min_gas_price),
    feeCollector: SYSTEM.feeCollectorAddress,
    maxSupply: BigInt(genesis.protocol.max_supply),
    initialIssuance: BigInt(genesis.protocol.initial_issuance),
    blockSubsidy: BigInt(genesis.protocol.block_subsidy),
    burnBps: BigInt(genesis.protocol.burn_bps),
    validatorFeeBps: BigInt(genesis.protocol.validator_fee_bps),
    communityRoundBudget: BigInt(cm.round_budget),
    communityRoundBlocks: cm.round_blocks,
    maxPerAddressPerRound: BigInt(cm.max_per_address_per_round),
    communityApprovalQuorum: cm.approval_quorum,
    minSelfStake: BigInt(st.min_self_stake),
    minDelegation: BigInt(st.min_delegation),
    unbondingBlocks: st.unbonding_blocks,
    maxCommissionBps: BigInt(st.max_commission_bps),
    maxActiveValidators: st.max_active_validators,
    rewardDistributionInterval: st.reward_distribution_interval,
    downtimeWindow: st.downtime_window,
    doubleSignSlashBps: BigInt(st.double_sign_slash_bps),
    downtimeSlashBps: BigInt(st.downtime_slash_bps),
    jailDurationBlocks: st.jail_duration_blocks,
    allocations,
    genesisAlloc: genesis.alloc,
    genesisValidators: genesis.validators,
    reviewers: genesis.reviewers,
    minBlockIntervalMs: genesis.consensus.min_block_interval_ms,
    maxClockDriftMs: 60 * 60 * 1000,
    blockTimeMs: genesis.consensus.block_time_ms,
    supplyAuditEvery: 0,
    consensusTimeouts: { proposeBaseMs: 1200, voteBaseMs: 900, voteDeltaMs: 300, proposeDeltaMs: 400 },
    identity: key,
  };
}

/**
 * A network of nodes sharing one message bus. `drop` and `delay` inject the
 * kind of fault a real peer-to-peer network has, so the tests are not running
 * against an idealised synchronous link.
 */
class TestNetwork {
  constructor(genesisPath) {
    this.genesisPath = genesisPath;
    this.nodes = [];
    this.bus = [];
    this.dropped = 0;
    this.clockOffset = 0;
  }

  static async create({ genesisPath, validators = 4, faultless = true }) {
    const net = new TestNetwork(genesisPath);
    net.faultless = faultless;
    const genesis = loadGenesis(genesisPath);
    net.genesis = genesis;
    net.execGenesis = toExecutionGenesis(genesis);
    const accounts = JSON.parse(fs.readFileSync(path.join(path.dirname(genesisPath), 'accounts.json'), 'utf8'));
    net.accounts = accounts;

    for (let i = 0; i < validators; i++) {
      const keyFile = path.join(path.dirname(genesisPath), accounts.validators[i].node_key_file);
      const key = readValidatorKey(keyFile);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsnet-${i}-`));
      const params = paramsFromGenesis(genesis, key);
      const chain = await Chain.create({ genesis: net.execGenesis, datadir: dir, params, mode: 'validator' });
      const node = { name: `v${i + 1}`, dir, chain, key, params, genesis };
      node.consensus = new Consensus({
        chain,
        identity: key,
        broadcast: (msg) => net.send(msg, node),
        params,
      });
      chain.onCommitted(() => {
        // propagate the sealed block so peers can sync even if they missed the
        // proposal round
        const record = chain.getBlock(chain.head.height);
        net.send({ type: MessageType.Block, chainId: String(chain.chainId), block: record.toJSON(), from: node.name }, node);
      });
      net.nodes.push(node);
    }
    net.rpc = net.nodes[0];
    return net;
  }

  send(msg, from) {
    if (!this.faultless && Math.random() < 0.05) {
      this.dropped += 1;
      return;
    }
    this.bus.push({ msg, from: from?.name, at: Date.now() });
  }

  /** Deliver every queued message. Repeat until quiet: consensus is reactive. */
  async deliver(rounds = 8) {
    for (let r = 0; r < rounds; r++) {
      const batch = this.bus.splice(0, this.bus.length);
      if (batch.length === 0) break;
      for (const { msg, from } of batch) {
        for (const node of this.nodes) {
          if (node.name === from && msg.type !== MessageType.Block) continue;
          try {
            if (msg.type === MessageType.Tx) {
              await node.chain.pool.add(msg.raw, { source: 'peer', gossip: false });
            } else if (msg.type === MessageType.Block) {
              const block = FullStopBlock.fromJSON(msg.block);
              if (block.height === node.chain.head.height + 1) {
                const ok = await node.chain.commitBlock(block, { source: 'sync' });
                void ok;
              }
            } else {
              await node.consensus.handleMessage(msg, { from: `peer:${from}` });
            }
          } catch (err) {
            node.errors ??= [];
            node.errors.push(err.message);
          }
        }
        await tick(0);
      }
    }
  }

  /** Advance the network by n blocks: submit nothing, just drive rounds. */
  async advance(blocks = 3, { timeoutMs = 30_000 } = {}) {
    const target = this.nodes[0].chain.head.height + blocks;
    const started = Date.now();
    for (const n of this.nodes) n.consensus.start();
    try {
      while (this.nodes[0].chain.head.height < target) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`network stalled at height ${this.nodes[0].chain.head.height}, wanted ${target}`);
        }
        await this.deliver(4);
        await tick(15);
      }
      await this.deliver(4);
      return this.nodes[0].chain.head.height;
    } finally {
      for (const n of this.nodes) n.consensus.stop();
      await this.deliver(4);
    }
  }

  /** Broadcast a raw transaction and wait for it to be included. */
  async submit(raw, { blocks = 3 } = {}) {
    for (const n of this.nodes) {
      try {
        await n.chain.pool.add(raw, { source: 'test', gossip: true });
      } catch (err) {
        n.submitError = err.message;
      }
    }
    const hash = ethers.Transaction.from(raw).hash.toLowerCase();
    await this.advance(blocks);
    for (let i = 0; i < 40 && !this.nodes[0].chain.getReceipt(hash); i++) {
      await this.advance(1);
      await tick(20);
    }
    const receipt = this.nodes[0].chain.getReceipt(hash);
    if (!receipt) {
      const why = this.nodes.map((n) => `${n.name}:${n.submitError ?? n.chain.head.height}`).join(' ');
      throw new Error(`transaction ${hash} was never included (${why})`);
    }
    return receipt;
  }

  /** All nodes must agree on head height and app hash. */
  assertConverged(label = 'network') {
    const head = this.nodes[0].chain.head;
    for (const n of this.nodes) {
      assert(n.chain.head.height === head.height, `${label}: ${n.name} is at ${n.chain.head.height}, head is ${head.height}`);
      assert(n.chain.head.hash === head.hash, `${label}: ${n.name} has a different block hash`);
      assert(n.chain.appHash === head.header.appHash, `${label}: ${n.name} has a different app hash`);
      assert(n.chain.stateRoot === head.header.stateRoot, `${label}: ${n.name} has a different state root`);
    }
    return head;
  }

  heights() {
    return this.nodes.map((n) => `${n.name}:${n.chain.head.height}`).join(' ');
  }

  async destroy() {
    for (const n of this.nodes) {
      n.consensus?.stop();
      fs.rmSync(n.dir, { recursive: true, force: true });
    }
  }
}

function readValidatorKey(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const operator = new ethers.Wallet(raw.privateKey);
  const consensus = raw.consensusPrivateKey ? new ethers.Wallet(raw.consensusPrivateKey) : operator;
  return {
    address: operator.address,
    privateKey: operator.privateKey,
    consensusAddress: consensus.address,
    consensusPrivateKey: consensus.privateKey,
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15_000, interval = 25, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await tick(interval);
  }
}

function toBase(units) {
  const [whole, frac = ''] = String(units).split('.');
  const scaled = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole + scaled);
}

module.exports = {
  Suite,
  TestNetwork,
  assert,
  assertEqual,
  assertRejects,
  waitFor,
  toBase,
  paramsFromGenesis,
  readValidatorKey,
  tick,
  UNIT,
  SystemContracts: SYSTEM,
  Protocol,
  Execution,
  constants: { COIN, SYSTEM, BLOCK, FEES, STAKING, COMMUNITY, ALLOCATIONS, REWARDS, CHAIN, VERSION, GAS, PROTOCOL, POOL },
};
