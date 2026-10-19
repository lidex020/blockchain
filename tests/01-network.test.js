'use strict';
/**
 * Network-level tests: four independent nodes, real consensus messages over an
 * in-process bus, real execution on each side.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const { Suite, TestNetwork, assert, assertEqual, waitFor, toBase, UNIT, constants } = require('./helpers.js');
const { FullStopBlock, MessageType, ZERO_HASH, makeVote, verifyVote } = require('../src/block.js');
const { Chain } = require('../src/chain.js');
const { loadGenesis, toExecutionGenesis } = require('../src/genesis.js');
const { paramsFromGenesis, readValidatorKey } = require('./helpers.js');

function readKeyFile(dir, rel) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  return raw.privateKey;
}

const GENESIS = path.resolve(__dirname, '..', 'data', 'testnet', 'genesis.json');

async function run(suite) {
  const net = await TestNetwork.create({ genesisPath: GENESIS, validators: 4 });
  try {
    await suite.test('four validators reach agreement and advance together', async () => {
      await net.advance(4);
      const head = net.assertConverged('advance');
      assert(head.height >= 4, `expected at least 4 blocks, got ${head.height}`);
      assert(head.header.txCount >= 0, 'txCount missing');
    });

    await suite.test('a validator catches up to a valid proposal from a later round', async () => {
      const producer = net.nodes[0];
      const receiver = net.nodes[1];
      const height = receiver.chain.head.height + 1;
      const round = 1;
      const expected = receiver.chain.protocol.staking.proposerFor(height, round);
      const { block } = await producer.chain.produceBlock({
        height,
        round,
        time: Math.max(Date.now(), producer.chain.head.header.time + receiver.chain.params.minBlockIntervalMs),
        proposer: expected.operator,
      });
      receiver.consensus.running = true;
      receiver.consensus.enterHeight(receiver.chain.head.height + 1);
      try {
        await receiver.consensus.receiveProposal({
          type: MessageType.Proposal,
          chainId: String(receiver.chain.chainId),
          height,
          round,
          block: block.toJSON(),
          proposer: expected.operator,
        }, { from: 'peer' });
      } finally {
        receiver.consensus.stop();
      }
      assertEqual(receiver.consensus.round, round, 'receiver advanced to the proposal round');
      assertEqual(
        receiver.consensus.signedVotes.get(`${height}:${round}:${MessageType.Prevote}`),
        block.hash,
        'receiver prevoted in the proposal round'
      );
      receiver.consensus._precommitNil();
      const prevoteKey = `${height}:${round}:${MessageType.Prevote}`;
      const prevotes = receiver.consensus.votes.get(prevoteKey);
      for (const peer of net.nodes.filter((n) => n !== receiver).slice(0, 2)) {
        prevotes.set(peer.key.address.toLowerCase(), { validator: peer.key.address, blockHash: block.hash });
      }
      receiver.consensus._tally(MessageType.Prevote);
      assertEqual(receiver.consensus.step, 'precommit', 'late prevote quorum cannot move a validator back to prevote');
      assertEqual(
        receiver.consensus.signedVotes.get(`${height}:${round}:${MessageType.Precommit}`),
        ZERO_HASH,
        'validator does not replace its nil precommit with a block precommit'
      );
    });

    await suite.test('blocks arrive linked, with the proposer recorded and a commit attached', async () => {
      for (let h = Math.max(1, net.nodes[0].chain.head.height - 3); h <= net.nodes[0].chain.head.height; h++) {
        const b = net.nodes[0].chain.blocks.get(h);
        assert(b, `missing block ${h}`);
        const parent = net.nodes[0].chain.blocks.get(h - 1);
        assertEqual(b.header.parentHash, parent.hash, `block ${h} parent link`);
        assert(b.header.proposer && b.header.proposer !== constants.SYSTEM.moduleAddress, 'block has no proposer');
        if (h > 1) {
          assert(b.lastCommit?.votes?.length > 0, `block ${h} carries no commit for the previous height`);
        }
        assert(/^0x[0-9a-f]{64}$/.test(b.header.appHash), 'app hash is missing or malformed');
        assert(/^0x[0-9a-f]{64}$/.test(b.header.stateRoot), 'state root is missing or malformed');
      }
    });

    await suite.test('every validator signs more than two thirds of the power in each commit', async () => {
      const head = net.nodes[0].chain.head;
      const commit = net.nodes[0].chain.commits.get(head.height) ?? head.lastCommit;
      const votes = commit.votes;
      const power = (addr) => {
        const v = net.nodes[0].chain.protocol.staking.activeSet().find((x) => x.operator.toLowerCase() === addr || x.consensusAddress.toLowerCase() === addr);
        return v ? v.power : 0n;
      };
      const total = net.nodes[0].chain.protocol.staking.activeSet().reduce((a, v) => a + v.power, 0n);
      const signed = votes.reduce((a, v) => a + power(String(v.validator).toLowerCase()), 0n);
      assert(signed * 3n > total * 2n, `commit power ${signed} of ${total} is not more than 2/3`);
      for (const v of votes) assert(verifyVote(v, net.nodes[0].chain.chainId), `vote signature invalid for ${v.validator}`);
    });

    await suite.test('a node that misses a proposal still converges by syncing the block', async () => {
      const late = net.nodes[3];
      const before = late.chain.head.height;
      // detach the late node from the bus, advance the others, then reconnect
      const saved = net.nodes.slice();
      net.nodes = net.nodes.filter((n) => n !== late);
      await net.advance(2);
      net.nodes = saved;
      // hand the missing blocks over directly, exactly as block sync does
      for (let h = late.chain.head.height + 1; h <= net.nodes[0].chain.head.height; h++) {
        const rec = net.nodes[0].chain.blocks.get(h).toJSON();
        await late.chain.commitBlock(FullStopBlock.fromJSON(rec), { source: 'sync' });
      }
      assert(late.chain.head.height === net.nodes[0].chain.head.height, `${late.name} did not catch up (${late.chain.head.height} vs ${net.nodes[0].chain.head.height})`);
      assertEqual(late.chain.appHash, net.nodes[0].chain.appHash, 'app hash after sync');
      void before;
    });

    await suite.test('proposer selection is stake weighted and reproducible', async () => {
      const chain = net.nodes[0].chain;
      const height = chain.head.height + 500;
      const seen = new Map();
      for (let h = height; h < height + 400; h++) {
        const p = chain.protocol.staking.proposerFor(h, 0);
        seen.set(p.operator, (seen.get(p.operator) ?? 0) + 1);
      }
      const counts = [...seen.values()];
      const active = net.nodes[0].chain.protocol.staking.activeSet().length;
      assert(counts.length === active, `expected ${active} distinct proposers, saw ${counts.length}`);
      // equal stake, so each validator should propose a comparable share
      const min = Math.min(...counts);
      const max = Math.max(...counts);
      assert(max - min <= counts.length * 2, `proposer distribution is skewed: ${counts.join('/')}`);
      // and it must be a pure function of (height, round, set)
      for (let h = height; h < height + 20; h++) {
        const a = chain.protocol.staking.proposerFor(h, 0).operator;
        const b = net.nodes[1].chain.protocol.staking.proposerFor(h, 0).operator;
        assertEqual(a, b, `proposer for height ${h} differs between nodes`);
      }
    });

    await suite.test('a block with a tampered state root is rejected by every peer', async () => {
      const chain = net.nodes[0].chain;
      const { block } = await chain.produceBlock({
        height: chain.head.height + 1,
        round: 0,
        time: chain.head.header.time + chain.params.minBlockIntervalMs + 50,
        proposer: chain.head.header.proposer,
      });
      const tamperedRoot = new FullStopBlock({
        header: { ...block.header, stateRoot: '0x' + '11'.repeat(32) },
        txs: block.txs,
        evidence: block.evidence,
        lastCommit: block.lastCommit,
      });
      const tamperedApp = new FullStopBlock({
        header: { ...block.header, appHash: '0x' + '22'.repeat(32) },
        txs: block.txs,
        evidence: block.evidence,
        lastCommit: block.lastCommit,
      });
      // a forged transaction list must not survive the data-root check
      const extraTx = net.nodes[1].chain.genesis.genesisTxs?.[0] ?? null;
      for (const node of net.nodes.slice(1)) {
        const v1 = await node.chain.validateBlock(tamperedRoot, { checkCommit: false });
        assert(!v1.ok, 'peer accepted a block with a forged state root');
        assert(/state root|app hash/.test(v1.reason), `unexpected rejection reason: ${v1.reason}`);
        const v2 = await node.chain.validateBlock(tamperedApp, { checkCommit: false });
        assert(!v2.ok, 'peer accepted a block with a forged app hash');
        assert(/app hash/.test(v2.reason), `unexpected rejection reason: ${v2.reason}`);
      }
      if (extraTx) {
        const inflated = new FullStopBlock({ header: block.header, txs: [...block.txs, extraTx], evidence: block.evidence, lastCommit: block.lastCommit });
        const v3 = await net.nodes[1].chain.validateBlock(inflated, { checkCommit: false });
        assert(!v3.ok, 'a block whose transaction list does not match its data root was accepted');
        assert(/data hash/i.test(v3.reason), `unexpected reason: ${v3.reason}`);
      }
      // and the honest block is still accepted, so the test is not vacuous
      const ok = await net.nodes[1].chain.validateBlock(block, { checkCommit: false });
      assert(ok.ok, `the untampered block should validate, got: ${ok.reason}`);
    });

    await suite.test('a block with no commit is rejected (except the first after genesis)', async () => {
      const chain = net.nodes[0].chain;
      const height = chain.head.height + 1;
      assert(height > 1, 'test needs at least one committed block');
      const { block } = await chain.produceBlock({ height, round: 0, time: chain.head.header.time + 2000, proposer: chain.head.header.proposer });
      const rebuilt = new FullStopBlock({ header: block.header, txs: block.txs, evidence: block.evidence, lastCommit: null });
      const verdict = await net.nodes[1].chain.validateBlock(rebuilt, { checkCommit: true });
      assert(!verdict.ok, 'an uncommitted block was accepted');
      assert(/commit/i.test(verdict.reason), `unexpected reason: ${verdict.reason}`);
    });

    await suite.test('a vote signed by a non-validator contributes nothing', async () => {
      const chain = net.nodes[1].chain;
      const stranger = ethers.Wallet.createRandom();
      const vote = makeVote({
        validatorKey: { privateKey: stranger.privateKey, address: stranger.address },
        type: MessageType.Precommit,
        chainId: chain.chainId,
        height: chain.head.height + 1,
        round: 0,
        blockHash: chain.head.hash,
        timestamp: Date.now(),
      });
      assert(verifyVote(vote, chain.chainId), 'self-consistent signature should verify');
      const verdict = chain._checkLastCommit(
        { height: chain.head.height + 1, hash: chain.head.hash, lastCommit: { height: chain.head.height, round: 0, blockHash: chain.head.hash, votes: [vote] } },
        chain.currentCommitSet()
      );
      assert(!verdict.ok, 'a commit of non-validator votes was accepted');
    });

    await suite.test('a block that changes the validator set is accepted by every peer', async () => {
      // Regression test for a chain-halting mistake: a delegation changes each
      // validator's power, so the validator set hash of the block that includes it
      // differs from its parent's. Peers used to compare the proposal against the
      // set they agreed on at the *parent*, which no block could satisfy, and since
      // the offending transaction stays in the pool the network rejected block after
      // block forever. A proposal must instead be checked against the hash each node
      // derives by executing it - still impossible to forge, but satisfiable.
      const user = new ethers.Wallet(readKeyFile(path.dirname(GENESIS), net.accounts.users[0].key_file));
      const operator = net.genesis.validators[0].address.toLowerCase();
      const iface = new ethers.Interface(['function bond(address operator)']);
      const nonce = Number((await net.nodes[0].chain.execution.account(user.address)).nonce);
      const raw = await user.signTransaction({
        to: constants.SYSTEM.moduleAddress,
        value: toBase('100'),
        data: iface.encodeFunctionData('bond', [operator]),
        gasLimit: 200_000n,
        gasPrice: BigInt(constants.FEES.minGasPrice),
        nonce,
        chainId: Number(net.genesis.chain_id),
      });
      const receipt = await net.submit(raw, { blocks: 2 });
      assertEqual(Number(BigInt(receipt.status)), 1, 'the delegation reverted');
      const included = Number(BigInt(receipt.blockNumber));
      net.assertConverged('after a delegation');
      for (const n of net.nodes) {
        const v = n.chain.protocol.staking.state.validators[operator];
        assertEqual(v.delegators[user.address.toLowerCase()], toBase('100'), `${n.name}: the delegation is recorded`);
        const block = n.chain.blocks.get(included);
        const parent = n.chain.blocks.get(included - 1);
        assert(block.header.validatorsHash !== parent.header.validatorsHash, `${n.name}: the block that changed the set must carry a different set hash from its parent`);
        assertEqual(block.header.validatorsHash, n.chain.validatorsHash, `${n.name}: the agreed head commits to the set hash this node derived`);
      }
      // The check is not merely relaxed: a proposal that *claims* a validator set
      // its own execution did not produce is still refused. Consensus is stopped
      // after advance(), so the freshly built block is the next height on every
      // node and the only thing wrong with it is the set hash in its header.
      const producer = net.nodes[0];
      const head = producer.chain.head;
      const { block: proposal } = await producer.chain.produceBlock({
        height: head.height + 1,
        round: 0,
        time: Math.max(Date.now(), head.header.time + 600),
        proposer: producer.key.address,
      });
      assert(proposal, 'a valid next-height block could not be produced for the negative control');
      const forgedJson = { ...proposal.toJSON(), header: { ...proposal.header } };
      forgedJson.header.validatorsHash = `0x${'11'.repeat(32)}`;
      const verdict = await net.nodes[1].chain.validateBlock(FullStopBlock.fromJSON(forgedJson), { checkCommit: false });
      assert(!verdict.ok, 'a block claiming a validator set it did not execute was accepted');
      assert(/validator set hash/i.test(verdict.reason), `rejected for the wrong reason: ${verdict.reason}`);
    });

    await suite.test('the network keeps producing blocks under load from an external sender', async () => {
      const user = new ethers.Wallet(readKeyFile(path.dirname(GENESIS), net.accounts.users[0].key_file));
      const start = net.nodes[0].chain.head.height;
      for (let i = 0; i < 6; i++) {
        const nonce = Number((await net.nodes[0].chain.execution.account(user.address)).nonce);
        const raw = await user.signTransaction({
          to: ethers.Wallet.createRandom().address,
          value: toBase('1'),
          gasLimit: 21000n,
          gasPrice: BigInt(constants.FEES.minGasPrice),
          nonce,
          chainId: Number(net.genesis.chain_id),
        });
        await net.submit(raw, { blocks: 1 });
      }
      const end = net.nodes[0].chain.head.height;
      assert(end > start, `no blocks produced under load (${start} -> ${end})`);
      net.assertConverged('load');
    });

    await suite.test('restarting a node replays its log and rejoins at the same app hash', async () => {
      const node = net.nodes[0];
      await net.advance(2);
      const height = node.chain.head.height;
      const appHash = node.chain.appHash;
      const stateRoot = node.chain.stateRoot;
      // Model a restart by handing a *copy* of the data directory to a fresh
      // node, so the running one cannot interfere with the replay.
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'fsrestart-'));
      const datadir = path.join(copy, 'chain-node');
      fs.mkdirSync(datadir, { recursive: true });
      fs.cpSync(path.join(node.dir, 'chain'), path.join(datadir, 'chain'), { recursive: true });
      const genesis = net.genesis;
      const execGenesis = net.execGenesis;
      const key = readValidatorKey(path.join(path.dirname(GENESIS), 'keys', 'v1.json'));
      const reopened = await Chain.create({
        genesis: execGenesis,
        datadir,
        params: paramsFromGenesis(genesis, key),
        mode: 'validator',
      });
      fs.rmSync(copy, { recursive: true, force: true });
      assertEqual(reopened.head.height, height, 'height after restart');
      assertEqual(reopened.appHash, appHash, 'app hash after restart');
      assertEqual(reopened.stateRoot, stateRoot, 'state root after restart');
      void node;
    });
  } finally {
    await net.destroy();
  }
}

module.exports = { run, title: 'Network and consensus' };

if (require.main === module) {
  const suite = new Suite('Network and consensus');
  run(suite).then((code) => {
    process.exit(suite.summary() ? 1 : 0);
  });
}
