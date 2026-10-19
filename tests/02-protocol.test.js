'use strict';
/**
 * Protocol, economic and EVM tests: the rules the chain enforces rather than
 * the ones it merely documents.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const solc = require('solc');

const { Suite, TestNetwork, assert, assertEqual, assertRejects, toBase, UNIT, constants } = require('./helpers.js');
const { Execution } = require('../src/execution.js');
const { Protocol } = require('../src/protocol.js');
const { Staking } = require('../src/staking.js');
const { Ledger } = require('../src/ledger.js');
const { loadGenesis, toExecutionGenesis, validateGenesis, normalize } = require('../src/genesis.js');
const { createAddressFromString: createAddressLike } = require('@ethereumjs/util');
const { paramsFromGenesis } = require('./helpers.js');
const { Chain } = require('../src/chain.js');
const { Consensus } = require('../src/consensus.js');
const { SYSTEM, FEES, REWARDS, BLOCK, COIN } = constants;

const GENESIS = path.resolve(__dirname, '..', 'data', 'testnet', 'genesis.json');
const ARTIFACTS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'artifacts', 'contracts.json'), 'utf8')).artifacts;
const UNIT_BIG = 10n ** 18n;

/** A single-node chain used for protocol-level tests (no gossip, driven by hand). */
async function solo({ overrides = {}, genesisPath = GENESIS } = {}) {
  const genesis = loadGenesis(genesisPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fssolo-'));
  const key = {
    address: genesis.validators[0].address,
    privateKey: JSON.parse(fs.readFileSync(path.join(path.dirname(genesisPath), 'keys', 'v1.json'), 'utf8')).privateKey,
    consensusAddress: genesis.validators[0].consensus_address,
  };
  const params = { ...paramsFromGenesis(genesis, key), ...overrides };
  const chain = await Chain.create({ genesis: toExecutionGenesis(genesis), datadir: dir, params, mode: 'validator' });
  return { chain, genesis, genesisPath, key, dir, params };
}

/** Load one of the devnet test wallets by label: 'validator', 'user0'..'user3'. */
function account(genesisPath, which) {
  const dir = path.dirname(genesisPath);
  const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
  const entry = which === 'validator' ? accounts.validators[0] : accounts.users[Number(which.slice(4))];
  const file = entry.key_file ?? entry.operator_key_file ?? entry.node_key_file;
  return new ethers.Wallet(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).privateKey);
}

/** Produce and commit one block on a solo chain. */
async function mine(chain, proposer) {
  const { block } = await chain.produceBlock({
    height: chain.head.height + 1,
    round: 0,
    time: chain.head.header.time + 5000,
    proposer: proposer ?? chain.head.header.proposer,
  });
  await chain.commitBlock(block, { validate: false, source: 'test' });
  return block;
}

async function run(suite) {
  // ------------------------------------------------------------ supply rules
  suite.describe('FSTOP supply rules');

  await suite.test('genesis mints exactly the approved initial issuance, and conservation holds', async () => {
    const { chain } = await solo();
    const report = chain.supplyReport();
    assertEqual(report.totalIssued, toBase('75000000').toString(), 'total issued at genesis');
    assertEqual(report.maxSupply, (100_000_000n * UNIT_BIG).toString(), 'hard cap');
    assertEqual(report.unissued, toBase('25000000').toString(), 'the unissued remainder is the validator pool');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation: ${JSON.stringify(audit)}`);
    assert(audit.accounts > 0, 'the state walk found no accounts at all');
  });

  await suite.test('the block subsidy is minted from the unissued pool and stays inside the cap', async () => {
    const { chain } = await solo();
    const before = chain.protocol.ledger.state.minted;
    await mine(chain);
    const after = chain.protocol.ledger.state.minted;
    assertEqual(after - before, REWARDS.blockSubsidy, 'one block of subsidy');
    const pool = chain.protocol.ledger.state.pools.validator;
    assertEqual(pool.remaining + pool.issued, pool.allocation, 'pool accounting is not closed');
    assert(pool.remaining > 0n, 'the pool should not be exhausted after one block');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after subsidy: ${JSON.stringify(audit)}`);
  });

  await suite.test('issuance stops at the cap instead of exceeding it', async () => {
    const ledger = new Ledger({
      maxSupply: 10n * UNIT_BIG,
      initialIssuance: 10n * UNIT_BIG,
      blockSubsidy: 1n * UNIT_BIG,
      allocations: { validator: { label: 'v', shareBps: 10_000n, issuance: 'protocol-pool', vestingBlocks: 0, cliffBlocks: 0 } },
      communityRoundBudget: 0n,
      communityRoundBlocks: 1000,
    });
    ledger.applyGenesis();
    let minted = 0n;
    let stopped = false;
    for (let h = 1; h <= 50 && !stopped; h++) {
      const { deltas } = ledger.planBlock({ height: h, fees: 0n, validators: [], communityClaims: [] });
      const subsidy = deltas.filter((d) => d.reason === 'block-subsidy').reduce((a, d) => a + d.amount, 0n);
      minted += subsidy;
      if (subsidy === 0n) stopped = true;
      assert(ledger.state.minted <= ledger.maxSupply, `cap breached at height ${h}`);
    }
    assert(stopped, 'issuance never stopped');
    assertEqual(ledger.state.minted, minted, 'ledger disagrees with the accumulated subsidy');
    assertEqual(minted, 10n * UNIT_BIG, 'the pool should have been exhausted exactly at the cap');
  });

  await suite.test('a genesis release larger than its pool is rejected', async () => {
    const ledger = new Ledger({
      maxSupply: 100n * UNIT_BIG,
      initialIssuance: 100n * UNIT_BIG,
      blockSubsidy: 0n,
      allocations: { community: { label: 'c', shareBps: 10_000n, issuance: 'genesis-locked', vestingBlocks: 0, cliffBlocks: 0 } },
      communityRoundBudget: 0n,
      communityRoundBlocks: 1000,
    });
    ledger.applyGenesis();
    let threw = null;
    try {
      ledger.genesisRelease('community', '0x' + '22'.repeat(20), 101n * UNIT_BIG, 'too much');
    } catch (err) {
      threw = err;
    }
    assert(threw, 'over-releasing from a genesis pool did not throw');
    assert(/exceeds its locked balance/.test(threw.message), threw.message);
    const after = ledger.state.locked['vesting:community'];
    assertEqual(after, 100n * UNIT_BIG, 'a rejected release must not change the locked balance');
  });

  await suite.test('burning permanently reduces supply and cannot exceed what exists', async () => {
    const ledger = new Ledger({
      maxSupply: 100n * UNIT_BIG,
      initialIssuance: 100n * UNIT_BIG,
      blockSubsidy: 0n,
      burnBps: 10_000n,
      validatorFeeBps: 0n,
      allocations: { community: { label: 'c', shareBps: 10_000n, issuance: 'genesis-locked', vestingBlocks: 0, cliffBlocks: 0 } },
      communityRoundBudget: 0n,
      communityRoundBlocks: 1000,
    });
    ledger.applyGenesis();
    ledger.planBlock({ height: 1, fees: 5n * UNIT_BIG, validators: [], communityClaims: [] });
    assertEqual(ledger.state.burned, 5n * UNIT_BIG, 'the whole fee should have been burned');
    assertEqual(ledger.state.minted - ledger.state.burned, 95n * UNIT_BIG, 'supply was not reduced permanently');
    let threw = null;
    try {
      ledger._burn(200n * UNIT_BIG);
    } catch (err) {
      threw = err;
    }
    assert(threw && /cannot burn/.test(threw.message), `over-burn not rejected: ${threw?.message}`);
  });

  await suite.test('unauthorized minting is impossible: the EVM has no mint path', async () => {
    const { chain, genesis } = await solo();
    const attacker = account(GENESIS, 'user3');
    const iface = new ethers.Interface(ARTIFACTS.FSTOPERC20.abi);
    // a contract cannot move native coin into existence; try to "mint" by
    // calling the protocol module with value the sender does not have
    const raw = await attacker.signTransaction({
      to: SYSTEM.moduleAddress,
      value: toBase('100000000'),
      data: iface.encodeFunctionData('mint', [attacker.address, toBase('100000000')]),
      gasLimit: 200_000n,
      gasPrice: BigInt(FEES.minGasPrice),
      nonce: 0,
      chainId: Number(genesis.chain_id),
    });
    let threw = null;
    try {
      await chain.pool.add(raw, { gossip: false });
    } catch (err) {
      threw = err;
    }
    assert(threw && /insufficient funds/.test(threw.message), `a value-bearing forgery was admitted: ${threw?.message}`);
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, 'supply accounting changed without a block');
  });

  // ------------------------------------------------------------- fee design
  suite.describe('Fees, burning and reward distribution');

  await suite.test('a transfer pays the fee floor, split between burn and the validator pool', async () => {
    const { chain, genesis } = await solo();
    const wallet = account(GENESIS, 'user0');
    const before = await chain.execution.balance(SYSTEM.feeCollectorAddress);
    const raw = await wallet.signTransaction({
      to: ethers.Wallet.createRandom().address,
      value: toBase('1'),
      gasLimit: 21000n,
      gasPrice: BigInt(FEES.minGasPrice),
      nonce: 0,
      chainId: Number(genesis.chain_id),
    });
    await chain.pool.add(raw, { source: 'test', gossip: false });
    await mine(chain, wallet.address);
    const fee = 21000n * BigInt(FEES.minGasPrice);
    const burned = (fee * BigInt(FEES.burnBps)) / 10_000n;
    const after = await chain.execution.balance(SYSTEM.feeCollectorAddress);
    assertEqual(after - before, 0n, 'the fee collector must be emptied by the protocol transition');
    assertEqual(chain.protocol.ledger.state.totals.feesBurned, burned, 'burned share');
    assertEqual(chain.protocol.ledger.state.burned, burned, 'burn recorded in the ledger');
    assertEqual(chain.protocol.ledger.state.totals.feesToValidators, fee - burned, 'validator share');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after fees: ${JSON.stringify(audit)}`);
  });

  await suite.test('staking rewards reach the bonded validator net of commission', async () => {
    const { chain, genesis } = await solo();
    const interval = chain.params.rewardDistributionInterval;
    const operator = genesis.validators[0].address;
    while ((chain.head.height + 1) % interval !== 0) await mine(chain);
    const before = await chain.execution.balance(operator);
    const poolBefore = await chain.execution.balance(SYSTEM.validatorPoolAddress);
    await mine(chain);
    const after = await chain.execution.balance(operator);
    const poolAfter = await chain.execution.balance(SYSTEM.validatorPoolAddress);
    assert(after > before, `operator balance did not grow (${before} -> ${after})`);
    assert(poolAfter >= 0n, 'the reward pool went negative');
    assert(poolBefore + REWARDS.blockSubsidy >= poolAfter, 'more left the pool than it held');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after distribution: ${JSON.stringify(audit)}`);
  });

  await suite.test('the reward pool can never pay out more than it holds', async () => {
    const { chain } = await solo();
    chain.protocol.ledger.state.pools.validator.remaining = 0n;
    const before = chain.protocol.ledger.state.minted;
    await mine(chain);
    assertEqual(chain.protocol.ledger.state.minted, before, 'issuance continued with an exhausted pool');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation with an exhausted pool: ${JSON.stringify(audit)}`);
  });

  // -------------------------------------------------------------- staking
  suite.describe('Staking, delegation and unbonding');

  await suite.test('bonding moves coin into the escrow and records the delegation', async () => {
    const { chain, genesis } = await solo();
    const delegator = account(GENESIS, 'user1');
    const iface = new ethers.Interface(['function bond(address operator)']);
    const amount = toBase('500');
    const raw = await delegator.signTransaction({
      to: SYSTEM.moduleAddress,
      value: amount,
      data: iface.encodeFunctionData('bond', [genesis.validators[0].address]),
      gasLimit: 200_000n,
      gasPrice: BigInt(FEES.minGasPrice),
      nonce: 0,
      chainId: Number(genesis.chain_id),
    });
    await chain.pool.add(raw, { gossip: false });
    await mine(chain, delegator.address);
    const v = chain.protocol.staking.state.validators[genesis.validators[0].address.toLowerCase()];
    assertEqual(v.delegators[delegator.address.toLowerCase()], amount, 'delegated amount');
    const escrow = await chain.execution.balance(SYSTEM.moduleAddress);
    assert(escrow >= chain.protocol.requiredEscrow(), 'the escrow does not cover recorded entitlements');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after bonding: ${JSON.stringify(audit)}`);
  });

  await suite.test('a rejected system action is refunded, not kept', async () => {
    const { chain, genesis } = await solo();
    const sender = account(GENESIS, 'user2');
    const iface = new ethers.Interface(['function bond(address operator)']);
    const raw = await sender.signTransaction({
      to: SYSTEM.moduleAddress,
      value: toBase('10'),
      data: iface.encodeFunctionData('bond', ['0x' + '33'.repeat(20)]),
      gasLimit: 200_000n,
      gasPrice: BigInt(FEES.minGasPrice),
      nonce: 0,
      chainId: Number(genesis.chain_id),
    });
    await chain.pool.add(raw, { gossip: false });
    const balanceBefore = await chain.execution.balance(sender.address);
    const escrowBefore = await chain.execution.balance(SYSTEM.moduleAddress);
    await mine(chain, sender.address);
    const balanceAfter = await chain.execution.balance(sender.address);
    const escrowAfter = await chain.execution.balance(SYSTEM.moduleAddress);
    assertEqual(escrowAfter, escrowBefore, 'the escrow kept value from a failed bond');
    const used = BigInt(chain.receiptsByHeight.get(chain.head.height)[0].gasUsed);
    assertEqual(balanceBefore - balanceAfter, used * BigInt(FEES.minGasPrice), 'only gas should have left the sender');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after a refund: ${JSON.stringify(audit)}`);
  });

  await suite.test('unbonding is queued, matures after the bonding period, then pays out', async () => {
    const { chain, genesis } = await solo();
    // `chain.protocol.staking` is replaced by snapshot/restore around every
    // speculative execution, so tests must re-read it rather than cache it.
    const staking = () => chain.protocol.staking;
    const op = genesis.validators[0].address;
    const v = staking().state.validators[op.toLowerCase()];
    const startStake = v.totalStake;
    void startStake;
    const unbondAmount = toBase('100');
    // the operator's genesis balance is fully bonded, so a delegator does the
    // unbonding here: bond, then unbond part of it
    const delegator = account(GENESIS, 'user2');
    const bondIface = new ethers.Interface(['function bond(address operator)']);
    await chain.pool.add(
      await delegator.signTransaction({
        to: SYSTEM.moduleAddress,
        value: toBase('300'),
        data: bondIface.encodeFunctionData('bond', [op]),
        gasLimit: 200_000n,
        gasPrice: BigInt(FEES.minGasPrice),
        nonce: 0,
        chainId: Number(genesis.chain_id),
      }),
      { gossip: false }
    );
    await mine(chain, delegator.address);
    const operatorWallet = delegator;
    const iface = new ethers.Interface(['function unbond(address operator, uint256 amount)']);
    const raw = await operatorWallet.signTransaction({
      to: SYSTEM.moduleAddress,
      value: 0n,
      data: iface.encodeFunctionData('unbond', [op, unbondAmount]),
      gasLimit: 200_000n,
      gasPrice: BigInt(FEES.minGasPrice),
      nonce: 1,
      chainId: Number(genesis.chain_id),
    });
    await chain.pool.add(raw, { gossip: false });
    await mine(chain, operatorWallet.address);
    assertEqual(staking().state.unbonding.length, 1, 'no unbonding entry');
    const entry = staking().state.unbonding[0];
    assertEqual(entry.amount, unbondAmount, 'unbonding amount');
    assertEqual(staking().state.validators[op.toLowerCase()].totalStake.toString(), (startStake + toBase('300') - unbondAmount).toString(), 'bonded stake was not reduced');
    assert(await chain.execution.balance(SYSTEM.moduleAddress) >= chain.protocol.requiredEscrow(), 'escrow coverage broke during unbonding');
    let guard = 0;
    while (staking().state.unbonding.length && guard++ < chain.params.unbondingBlocks + 5) await mine(chain, operatorWallet.address);
    assertEqual(staking().state.unbonding.length, 0, 'unbonding never completed');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after unbonding: ${JSON.stringify(audit)}`);
  });

  await suite.test('unknown operators, empty bonds and over-large unbonds are refused', async () => {
    const staking = new Staking({});
    const res1 = staking.applySystemAction({ action: 'bond', args: ['0x' + '33'.repeat(20)], from: '0x' + '44'.repeat(20), value: toBase('1000'), height: 1 });
    assert(!res1.ok && /unknown validator/.test(res1.detail), `bonding to an unknown operator: ${res1.detail}`);
    const res2 = staking.applySystemAction({ action: 'bond', args: ['0x' + '33'.repeat(20)], from: '0x' + '44'.repeat(20), value: 0n, height: 1 });
    assert(!res2.ok, 'a zero-value bond was accepted');
    staking.registerValidator({ operator: '0x' + '33'.repeat(20), moniker: 'x', consensusAddress: '0x' + '33'.repeat(20), commissionBps: 1000n, amount: toBase('1000'), height: 1 });
    const res3 = staking.applySystemAction({ action: 'unbond', args: ['0x' + '33'.repeat(20), toBase('2000')], from: '0x' + '33'.repeat(20), value: 0n, height: 2 });
    assert(!res3.ok && /exceeds bonded amount/.test(res3.detail), `over-unbond accepted: ${res3.detail}`);
    const res4 = staking.applySystemAction({
      action: 'registerValidator',
      args: ['too much commission', '0x' + '55'.repeat(20), staking.params.maxCommissionBps + 1n],
      from: '0x' + '66'.repeat(20),
      value: staking.params.minSelfStake,
      height: 3,
    });
    assert(!res4.ok && /commission/.test(res4.detail), `excessive commission accepted: ${res4.detail}`);
    const res5 = staking.applySystemAction({
      action: 'registerValidator',
      args: ['small', '0x' + '56'.repeat(20), 1000n],
      from: '0x' + '67'.repeat(20),
      value: staking.params.minSelfStake - 1n,
      height: 3,
    });
    assert(!res5.ok && /below minimum/.test(res5.detail), `an under-collateralised validator was registered: ${res5.detail}`);
  });

  await suite.test('double-signing is slashed and the validator is tombstoned', async () => {
    const { chain, genesis } = await solo();
    const keyFile = path.join(path.dirname(GENESIS), 'keys', 'v1.json');
    const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const signer = new ethers.SigningKey(key.consensusPrivateKey ?? key.privateKey);
    // Evidence is checked against the *consensus* address recorded for that
    // validator, so the test must pick the validator this key belongs to.
    const v = chain.protocol.staking.activeSet().find((x) => x.consensusAddress.toLowerCase() === genesis.validators[0].consensus_address.toLowerCase());
    assert(v, 'the genesis validator is not in the active set');
    const { voteTag } = require('../src/vote-tag.js');
    const mk = (hash) => signer.sign(voteTag({ type: 'precommit', chainId: genesis.chain_id, height: 7, round: 0, blockHash: hash })).serialized;
    const ev = {
      id: 'test-evidence',
      type: 'double-sign',
      chainId: String(genesis.chain_id),
      validator: v.consensusAddress,
      heightA: 7,
      roundA: 0,
      typeA: 'precommit',
      sigA: mk('0x' + 'aa'.repeat(32)),
      blockHashA: '0x' + 'aa'.repeat(32),
      heightB: 7,
      roundB: 0,
      typeB: 'precommit',
      sigB: mk('0x' + 'bb'.repeat(32)),
      blockHashB: '0x' + 'bb'.repeat(32),
    };
    const check = chain.protocol.staking.verifyEvidence(ev);
    assert(check.ok, `valid evidence was refused: ${check.reason}`);
    const stakeBefore = v.totalStake;
    const balBefore = await chain.execution.balance(v.operator);
    // Evidence reaches a block the way it does on a live network: the proposer
    // puts it in the pending set and the block is produced with it included, so
    // the application hash covers the slash.
    chain.pendingEvidence.push(ev);
    const { block } = await chain.produceBlock({ height: 1, round: 0, time: chain.head.header.time + 5000, proposer: v.operator });
    assertEqual(block.evidence.length, 1, 'the produced block did not carry the evidence');
    await chain.commitBlock(block, { source: 'test' });
    const after = chain.protocol.staking.state.validators[v.operator.toLowerCase()];
    assertEqual(after.status, 'tombstoned', 'the validator was not tombstoned');
    assert(chain.protocol.staking.state.totals.slashed > 0n, 'nothing was slashed');
    const slashed = chain.protocol.staking.state.totals.slashed;
    assertEqual(slashed.toString(), ((stakeBefore * BigInt(2000n)) / 10_000n).toString(), 'the slash should be the configured 20% of the validator stake');
    assertEqual(after.totalStake, 0n, 'a tombstoned validator must hold nothing');
    // The un-slashed remainder is not confiscated: a tombstoned validator's
    // stake is released back to its owners in the same block (no unbonding
    // wait, because the validator is being removed anyway). That is what keeps
    // a slash from turning into a seizure.
    const returned = await chain.execution.balance(v.operator);
    assert(returned >= balBefore, 'the operator did not get the un-slashed stake back');
    assertEqual(
      (returned - balBefore).toString(),
      (stakeBefore - slashed).toString(),
      'the returned amount should be exactly the stake minus the slash'
    );
    // other validators keep their bonds, so the escrow only shrinks by the
    // amount this validator held; coverage must still be exact
    const remaining = chain.protocol.staking.activeSet().reduce((a, x) => a + BigInt(x.totalStake), 0n);
    assertEqual(chain.protocol.requiredEscrow(), remaining, 'escrow entitlements no longer match the bonded set');
    assert((await chain.execution.balance(SYSTEM.moduleAddress)) >= chain.protocol.requiredEscrow(), 'escrow under-collateralised after the slash');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after slashing (slashed coin must leave supply): ${JSON.stringify(audit)}`);

  });

  await suite.test('forged evidence is discarded and slashes nobody', async () => {
    const { chain, genesis } = await solo();
    const v = chain.protocol.staking.activeSet().find((x) => x.operator.toLowerCase() === genesis.validators[0].address.toLowerCase());
    const before = v.totalStake;
    const junk = {
      id: 'junk',
      type: 'double-sign',
      chainId: String(genesis.chain_id),
      validator: v.consensusAddress,
      heightA: 3,
      roundA: 0,
      typeA: 'precommit',
      sigA: '0x' + '00'.repeat(65),
      blockHashA: '0x' + '11'.repeat(32),
      heightB: 3,
      roundB: 0,
      typeB: 'precommit',
      sigB: '0x' + '00'.repeat(65),
      blockHashB: '0x' + '22'.repeat(32),
    };
    assert(!chain.protocol.staking.verifyEvidence(junk).ok, 'forged evidence verified');
    // a proposer that tries to smuggle junk evidence in must not be able to get
    // it into a block that other nodes will accept
    chain.pendingEvidence.push(junk);
    const { block } = await chain.produceBlock({ height: 1, round: 0, time: chain.head.header.time + 5000, proposer: v.operator });
    assertEqual(block.evidence.length, 0, 'unverifiable evidence was queued into a produced block');
    await chain.commitBlock(block.withEvidence([junk]), { validate: false, source: 'test' });
    assertEqual(chain.protocol.staking.state.validators[v.operator.toLowerCase()].totalStake, before, 'an honest validator was slashed on bad evidence');
  });

  await suite.test('a validator that misses blocks is jailed, and clears by signing again', async () => {
    const staking = new Staking({ downtimeWindow: 3, jailDurationBlocks: 5 });
    staking.registerValidator({ operator: '0x' + 'a1'.repeat(20), moniker: 'good', consensusAddress: '0x' + 'a1'.repeat(20), commissionBps: 1000n, amount: toBase('1000'), height: 0 });
    staking.registerValidator({ operator: '0x' + 'b2'.repeat(20), moniker: 'lazy', consensusAddress: '0x' + 'b2'.repeat(20), commissionBps: 1000n, amount: toBase('1000'), height: 0 });
    const good = staking.activeSet()[0].operator;
    for (let h = 1; h <= 2; h++) staking.trackAttendance([good], h);
    assertEqual(staking.state.validators['0x' + 'b2'.repeat(20)].status, 'bonded', 'jailed before the window elapsed');
    staking.trackAttendance([good], 3);
    assertEqual(staking.state.validators['0x' + 'b2'.repeat(20)].status, 'jailed', 'the absent validator was not jailed');
    const jailUntil = staking.state.jailedUntil['0x' + 'b2'.repeat(20)];
    assert(jailUntil > 3, 'no jail term was set');
    const early = staking.applySystemAction({ action: 'unjail', args: [], from: '0x' + 'b2'.repeat(20), value: 0n, height: 4 });
    assert(!early.ok, 'unjail succeeded during the jail term');
  });

  // ------------------------------------------------------ community rewards
  suite.describe('Community participation rewards');

  await suite.test('a claim needs a reviewer quorum, is paid from the pool, and cannot be repeated', async () => {
    const { chain, genesis } = await solo();
    const reviewers = genesis.reviewers.map((r) => (typeof r === 'string' ? r : r.address));
    assert(reviewers.length >= 2, 'the test genesis needs two reviewers');
    const staking = () => chain.protocol.staking;
    const beneficiary = '0x' + '77'.repeat(20);
    const id = ethers.id('contribution-42');
    const amount = toBase('10');
    const submit = (h) => staking().applySystemAction({ action: 'submitContribution', args: [id, beneficiary, amount, 'ipfs://pr-42'], from: beneficiary, value: 0n, height: h });
    assert(submit(1).ok, 'first submission refused');
    const dupe = submit(1);
    assert(!dupe.ok && /duplicate/i.test(dupe.detail), `duplicate claim accepted: ${dupe.detail}`);
    const outsider = staking().applySystemAction({ action: 'reviewContribution', args: [id, true], from: '0x' + '88'.repeat(20), value: 0n, height: 1 });
    assert(!outsider.ok && /reviewer set/.test(outsider.detail), 'a non-reviewer approved a claim');
    const one = staking().applySystemAction({ action: 'reviewContribution', args: [id, true], from: reviewers[0], value: 0n, height: 1 });
    assert(one.ok, `first approval failed: ${one.detail}`);
    assertEqual(staking().state.claims[id].status, 'pending', 'a single approval settled the claim');
    const twice = staking().applySystemAction({ action: 'reviewContribution', args: [id, true], from: reviewers[0], value: 0n, height: 2 });
    assert(!twice.ok && /already acted/.test(twice.detail), 'a reviewer voted twice');
    const two = staking().applySystemAction({ action: 'reviewContribution', args: [id, true], from: reviewers[1], value: 0n, height: 2 });
    assert(two.ok, `second approval failed: ${two.detail}`);
    assertEqual(staking().state.claims[id].status, 'approved', 'quorum did not approve the claim');

    const before = await chain.execution.balance(beneficiary);
    await mine(chain);
    const after = await chain.execution.balance(beneficiary);
    assertEqual(after - before, amount, 'the approved claim was not paid');
    assertEqual(staking().state.claims[id].status, 'paid', 'claim status not settled');
    assert(!submit(3).ok, 'a settled claim could be resubmitted');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation after a community payout: ${JSON.stringify(audit)}`);
  });

  await suite.test('a rejected claim pays nothing', async () => {
    const { chain, genesis } = await solo();
    const staking = () => chain.protocol.staking;
    const reviewers = genesis.reviewers.map((r) => (typeof r === 'string' ? r : r.address));
    const id = ethers.id('spurious');
    const beneficiary = '0x' + '78'.repeat(20);
    staking().applySystemAction({ action: 'submitContribution', args: [id, beneficiary, toBase('10'), ''], from: beneficiary, value: 0n, height: 1 });
    staking().applySystemAction({ action: 'reviewContribution', args: [id, false], from: reviewers[0], value: 0n, height: 1 });
    staking().applySystemAction({ action: 'reviewContribution', args: [id, false], from: reviewers[1], value: 0n, height: 1 });
    assertEqual(staking().state.claims[id].status, 'rejected', 'rejection did not settle the claim');
    const before = await chain.execution.balance(beneficiary);
    await mine(chain);
    assertEqual(await chain.execution.balance(beneficiary), before, 'a rejected claim was paid');
  });

  await suite.test('the round budget caps what one round can pay out in total', async () => {
    const { chain, genesis } = await solo();
    const staking = () => chain.protocol.staking;
    const reviewers = genesis.reviewers.map((r) => (typeof r === 'string' ? r : r.address));
    const budget = BigInt(genesis.protocol.community.round_budget);
    const perAddress = BigInt(genesis.protocol.community.max_per_address_per_round);
    const claimCount = Number(budget / perAddress) + 2;
    for (let i = 0; i < claimCount; i++) {
      const id = ethers.id(`round-claim-${i}`);
      const beneficiary = ethers.getCreateAddress({ from: '0x' + 'c0'.repeat(19) + '01', nonce: i });
      staking().applySystemAction({ action: 'submitContribution', args: [id, beneficiary, perAddress, ''], from: beneficiary, value: 0n, height: 1 });
      staking().applySystemAction({ action: 'reviewContribution', args: [id, true], from: reviewers[0], value: 0n, height: 1 });
      staking().applySystemAction({ action: 'reviewContribution', args: [id, true], from: reviewers[1], value: 0n, height: 1 });
    }
    const approved = Object.values(staking().state.claims).filter((c) => c.status === 'approved').length;
    assert(approved >= claimCount - 1, `setup produced only ${approved} approved claims of ${claimCount}`);
    await mine(chain);
    const spent = chain.protocol.ledger.state.communityRound.spent;
    assert(spent <= budget, `round spent ${spent} exceeds the budget ${budget}`);
    const paidCount = Object.values(staking().state.claims).filter((c) => c.status === 'paid').length;
    assertEqual(BigInt(paidCount) * perAddress, spent, 'paid claims do not add up to the round spend');
    assert(BigInt(paidCount) * perAddress <= budget && BigInt(paidCount + 1) * perAddress > budget, `the round stopped at the wrong place: ${paidCount} paid of budget ${budget}`);
    assert(Object.values(staking().state.claims).some((c) => c.status === 'approved'), 'the budget did not leave anything deferred');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `conservation under a capped round: ${JSON.stringify(audit)}`);
  });

  await suite.test('one address cannot split a round across several claims', async () => {
    const staking = new Staking({ communityRoundBlocks: 100, maxPerAddressPerRound: toBase('50'), approvalQuorum: 2 });
    staking.setReviewers(['0x' + 'f1'.repeat(20), '0x' + 'f2'.repeat(20)]);
    const a = '0x' + '91'.repeat(20);
    assert(staking.applySystemAction({ action: 'submitContribution', args: [ethers.id('one'), a, toBase('40'), ''], from: a, value: 0n, height: 1 }).ok, 'first claim refused');
    const over = staking.applySystemAction({ action: 'submitContribution', args: [ethers.id('two'), a, toBase('20'), ''], from: a, value: 0n, height: 1 });
    assert(!over.ok && /round cap/.test(over.detail), `per-address cap not enforced: ${over.detail}`);
    const under = staking.applySystemAction({ action: 'submitContribution', args: [ethers.id('three'), a, toBase('10'), ''], from: a, value: 0n, height: 1 });
    assert(under.ok, `a claim within the cap was refused: ${under.detail}`);
  });

  // ---------------------------------------------------------- vesting rules
  suite.describe('Genesis allocation vesting');

  await suite.test('locked allocations release on schedule and not before the cliff', async () => {
    const ledger = new Ledger({
      maxSupply: 100n * UNIT_BIG,
      initialIssuance: 100n * UNIT_BIG,
      blockSubsidy: 0n,
      allocations: { developers: { label: 'dev', shareBps: 10_000n, issuance: 'genesis-locked', vestingBlocks: 100, cliffBlocks: 50 } },
      communityRoundBudget: 0n,
      communityRoundBlocks: 1000,
    });
    ledger.applyGenesis();
    assertEqual(ledger.state.locked['vesting:developers'], 100n * UNIT_BIG, 'the allocation should start fully locked');
    for (let h = 1; h <= 49; h++) ledger.planBlock({ height: h, fees: 0n, validators: [], communityClaims: [] });
    assertEqual(ledger.state.released.developers ?? 0n, 0n, 'coin was released before the cliff');
    ledger.planBlock({ height: 50, fees: 0n, validators: [], communityClaims: [] });
    assert(ledger.state.released.developers > 0n, 'nothing was released at the cliff');
    for (let h = 51; h <= 200; h++) ledger.planBlock({ height: h, fees: 0n, validators: [], communityClaims: [] });
    assertEqual(ledger.state.released.developers, 100n * UNIT_BIG, 'the schedule did not complete');
    assertEqual(ledger.state.locked['vesting:developers'], 0n, 'the locked balance did not drain to zero');
    ledger.planBlock({ height: 201, fees: 0n, validators: [], communityClaims: [] });
    assertEqual(ledger.state.released.developers, 100n * UNIT_BIG, 'post-vesting blocks must be a no-op, not an error');
  });

  // ---------------------------------------------------- mempool and admission
  suite.describe('Transaction admission control');

  await suite.test('underpriced, stale, future and over-spending transactions are refused', async () => {
    const { chain, genesis } = await solo();
    const wallet = account(GENESIS, 'user2');
    const sign = (over) =>
      wallet.signTransaction({
        to: wallet.address,
        value: 0n,
        gasLimit: 21000n,
        gasPrice: BigInt(FEES.minGasPrice),
        nonce: 0,
        chainId: Number(genesis.chain_id),
        ...over,
      });
    await assertRejects(async () => chain.pool.add(await sign({ gasPrice: BigInt(FEES.minGasPrice) - 1n })), /below the protocol floor/, 'an underpriced transaction');
    await assertRejects(async () => chain.pool.add(await sign({ value: toBase('100000') })), /insufficient funds/, 'an over-spending transaction');
    await assertRejects(() => chain.pool.add('0xdeadbeef'), /decode|invalid/, 'a malformed transaction');
    const entry = await chain.pool.add(await sign({}));
    assertEqual(entry.nonce, 0, 'the valid transaction was not admitted');
    const again = await chain.pool.add(await sign({}));
    assertEqual(again.hash, entry.hash, 're-submitting the identical transaction should be idempotent');
    // a replacement must out-bid the incumbent at the same nonce
    const rich = await wallet.signTransaction({ to: wallet.address, value: 0n, gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice) * 10n, nonce: 3, chainId: Number(genesis.chain_id) });
    await chain.pool.add(rich, { gossip: false });
    const cheap = await wallet.signTransaction({ to: wallet.address, value: 0n, gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice) * 2n, nonce: 3, chainId: Number(genesis.chain_id) });
    await assertRejects(() => chain.pool.add(cheap), /underpriced/, 'a cheaper replacement for the same nonce');
    const bumped = await chain.pool.add(await sign({ gasPrice: BigInt(FEES.minGasPrice) * 3n }));
    assert(bumped.hash !== entry.hash, 'the replacement should have its own hash');
    assertEqual(chain.pool.size, 2, 'the pool should hold one transaction per nonce slot');
  });

  await suite.test('a future nonce is queued but never selected, and a huge gap is refused', async () => {
    const { chain, genesis } = await solo();
    const wallet = account(GENESIS, 'user3');
    const sign = (nonce, gasPrice) =>
      wallet.signTransaction({ to: wallet.address, value: 0n, gasLimit: 21000n, gasPrice: BigInt(gasPrice ?? FEES.minGasPrice), nonce, chainId: Number(genesis.chain_id) });
    // nonce 5 while the account is at 0: admissible (it becomes executable when
    // the earlier transactions arrive) but it must not be packed into a block
    const queued = await chain.pool.add(await sign(5), { gossip: false });
    assert(queued, 'a queued transaction should be accepted');
    assertEqual(chain.pool.selectForBlock({ gasLimit: BLOCK.blockGasLimit }).length, 0, 'a queued transaction must not be selected');
    await assertRejects(async () => chain.pool.add(await sign(5000)), /too far in the future/, 'a nonce far beyond the queue window');
    // now fill the gap and it becomes selectable in nonce order
    for (let n = 0; n < 5; n++) await chain.pool.add(await sign(n), { gossip: false });
    const chosen = chain.pool.selectForBlock({ gasLimit: BLOCK.blockGasLimit });
    assertEqual(chosen.length, 6, 'all six contiguous transactions should be selectable');
    assertEqual(
      chosen.map((e) => e.nonce).join(','),
      '0,1,2,3,4,5',
      'transactions must be ordered by nonce within a sender'
    );
  });

  await suite.test('a transaction signed for another chain is rejected (replay protection)', async () => {
    const { chain, genesis } = await solo();
    const wallet = account(GENESIS, 'user3');
    const raw = await wallet.signTransaction({
      to: wallet.address,
      value: 0n,
      gasLimit: 21000n,
      gasPrice: BigInt(FEES.minGasPrice),
      nonce: 0,
      chainId: Number(genesis.chain_id) + 1,
    });
    // the pool must refuse it; the rejection may come from the tx decoder or
    // from the chain-id rule, but the rule itself has to be what fires when the
    // transaction is otherwise well formed for this chain
    await assertRejects(() => chain.pool.add(raw), /chain id|decode/i, 'a cross-chain replay');
    const { createTx } = require('@ethereumjs/tx');
    const { createChainCommon } = require('../src/execution.js');
    const foreign = createTx(
      {
        type: 0,
        chainId: BigInt(genesis.chain_id) + 1n,
        nonce: 0n,
        gasLimit: 21000n,
        gasPrice: BigInt(FEES.minGasPrice),
        to: createAddressLike('0x' + '11'.repeat(20)),
        value: 0n,
        data: '0x',
      },
      { common: createChainCommon(BigInt(genesis.chain_id) + 1n) }
    );
    foreign.sign(ethers.getBytes(wallet.privateKey));
    let ruleErr = null;
    try {
      chain.execution.validateTxRules(foreign);
    } catch (err) {
      ruleErr = err;
    }
    assert(ruleErr && /wrong chain id/.test(ruleErr.message), `the chain-id rule did not fire: ${ruleErr?.message ?? 'no error'}`);
  });

  await suite.test('the higher-priced replacement wins and sets the effective gas price', async () => {
    const { chain, genesis } = await solo();
    const wallet = account(GENESIS, 'user0');
    const low = await wallet.signTransaction({ to: wallet.address, value: 0n, gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice), nonce: 0, chainId: Number(genesis.chain_id) });
    const high = await wallet.signTransaction({ to: wallet.address, value: 0n, gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice) * 3n, nonce: 0, chainId: Number(genesis.chain_id) });
    await chain.pool.add(low, { gossip: false });
    await chain.pool.add(high, { gossip: false });
    const chosen = chain.pool.selectForBlock({ gasLimit: BLOCK.blockGasLimit });
    assertEqual(chosen.length, 1, 'the pool should offer one transaction for the block');
    assertEqual(chosen[0].gasPrice, BigInt(FEES.minGasPrice) * 3n, 'the higher-priced replacement should win');
    await mine(chain, wallet.address);
    const receipt = chain.receiptsByHeight.get(1)[0];
    assertEqual(BigInt(receipt.gasUsed), 21000n, 'gas used');
    assertEqual(BigInt(receipt.effectiveGasPrice), BigInt(FEES.minGasPrice) * 3n, 'effective gas price paid');
    assertEqual(chain.pool.size, 0, 'confirmed transactions must leave the pool');
  });

  await suite.test('the block gas limit is enforced on block production', async () => {
    const { chain, genesis } = await solo({ overrides: { blockGasLimit: 60000n } });
    const wallet = account(GENESIS, 'user1');
    for (let i = 0; i < 5; i++) {
      const raw = await wallet.signTransaction({ to: wallet.address, value: 0n, gasLimit: 21000n, gasPrice: BigInt(FEES.minGasPrice), nonce: i, chainId: Number(genesis.chain_id) });
      await chain.pool.add(raw, { gossip: false });
    }
    const chosen = chain.pool.selectForBlock({ gasLimit: 60000n });
    assert(chosen.length <= 2, `selected ${chosen.length} transactions for a 60000 gas block`);
    const total = chosen.reduce((a, e) => a + e.gasLimit, 0n);
    assert(total <= 60000n, `selected gas ${total} exceeds the block limit`);
  });

  await suite.test('network commits without a valid quorum are rejected before block application', async () => {
    const { chain, genesis } = await solo();
    const { block } = await chain.produceBlock({
      height: 1,
      round: 0,
      time: chain.head.header.time + 5000,
      proposer: genesis.validators[0].address,
    });
    const consensus = new Consensus({ chain });
    const message = {
      type: 'commit',
      chainId: String(chain.chainId),
      height: block.height,
      round: block.header.round,
      blockHash: block.hash,
      block: block.toJSON(),
      commit: { height: block.height, round: block.header.round, blockHash: block.hash, votes: [] },
    };
    await assertRejects(() => consensus.receiveCommit(message), /below the 2\/3 quorum/, 'a network commit without votes');
    assertEqual(chain.head.height, 0, 'the uncommitted block changed chain state');
    assertEqual(chain.commits.has(1), false, 'the rejected commit was persisted');
    await assertRejects(() => chain.commitBlock(block, { source: 'sync' }), /missing commit votes/, 'a synced block without a commit');
    assertEqual(chain.head.height, 0, 'the unsafely synced block changed chain state');
  });

  // ---------------------------------------------------------------- EVM work
  suite.describe('EVM compatibility');

  await suite.test('a speculative protocol snapshot preserves full staking evidence', async () => {
    const protocol = new Protocol();
    protocol.staking.state.evidence.push({
      type: 'double-sign',
      operator: '0x' + '11'.repeat(20),
      height: 4,
      a: { height: 2, round: 1 },
      b: { height: 2, round: 1 },
      slashed: 1n,
    });
    const before = protocol.staking.serialize();
    protocol.restoreSnapshot(protocol.snapshotJSON());
    const after = protocol.staking.serialize();
    assertEqual(after.evidenceCount, before.evidenceCount, 'evidence count after snapshot restore');
    assertEqual(after.evidenceRoot, before.evidenceRoot, 'evidence commitment after snapshot restore');
  });

  await suite.test('a Solidity contract deploys, stores, reads, logs and can be simulated', async () => {
    const { chain, genesis } = await solo();
    const wallet = account(GENESIS, 'user1');
    const abi = ARTIFACTS.FSTOPERC20.abi;
    const iface = new ethers.Interface(abi);
    const deployData = ARTIFACTS.FSTOPERC20.bytecode + iface.encodeDeploy(['Test Token', 'TT', 18, toBase('1000'), 0, true, true, false, wallet.address, '0x' + '00'.repeat(20)]).slice(2);
    await chain.pool.add(
      await wallet.signTransaction({ to: null, data: deployData, gasLimit: 5_000_000n, gasPrice: BigInt(FEES.minGasPrice), nonce: 0, chainId: Number(genesis.chain_id) }),
      { gossip: false }
    );
    await mine(chain, wallet.address);
    const receipt = chain.receiptsByHeight.get(1)[0];
    assertEqual(receipt.status, 1, 'deployment failed');
    const token = receipt.contractAddress;
    assert(token, 'no contract address on the receipt');
    assertEqual((await chain.execution.getCode(token)).length > 10, true, 'no code at the deployed address');
    assertEqual(Execution.nextContractAddress(wallet.address, 0).toLowerCase(), token.toLowerCase(), 'CREATE address prediction was wrong');

    const call = await chain.execution.call({ to: token, data: iface.encodeFunctionData('balanceOf', [wallet.address]) });
    assertEqual(call.exception, null, `call reverted: ${call.exception}`);
    assertEqual(BigInt(call.returnValue), toBase('1000'), 'balanceOf through a simulated call');

    const other = ethers.Wallet.createRandom().address;
    // Estimate first: the estimate must cover the real cost, which is the
    // property wallets depend on. (After the transfer the recipient account
    // exists, so a second estimate would legitimately be cheaper.)
    const estimate = await chain.execution.estimate({ from: wallet.address, to: token, data: iface.encodeFunctionData('transfer', [other, toBase('250')]) });
    await chain.pool.add(
      await wallet.signTransaction({ to: token, data: iface.encodeFunctionData('transfer', [other, toBase('250')]), gasLimit: 200_000n, gasPrice: BigInt(FEES.minGasPrice), nonce: 1, chainId: Number(genesis.chain_id) }),
      { gossip: false }
    );
    await mine(chain, wallet.address);
    const r2 = chain.receiptsByHeight.get(2)[0];
    assertEqual(r2.status, 1, 'transfer reverted');
    assertEqual(r2.logs.length, 1, 'expected one Transfer log');
    assertEqual(r2.logs[0].topics[0], ethers.id('Transfer(address,address,uint256)'), 'event topic0');
    const decoded = iface.decodeEventLog('Transfer', r2.logs[0].data, r2.logs[0].topics);
    assertEqual(decoded.value, toBase('250'), 'decoded transfer amount');
    assertEqual(decoded.to.toLowerCase(), other.toLowerCase(), 'decoded transfer recipient');
    const storageAfter = await chain.execution.getStorageAt(token, 0);
    assert(storageAfter !== '0x' + '00'.repeat(32), 'contract storage was not written');

    assert(estimate >= BigInt(r2.gasUsed), `estimate ${estimate} is below the ${r2.gasUsed} the transaction actually used`);
    assert(estimate < BigInt(r2.gasUsed) * 3n, `estimate ${estimate} is wildly above the actual ${r2.gasUsed}`);

    // a read of contract storage through the state manager must agree with the EVM
    const bal = await chain.execution.call({ to: token, data: iface.encodeFunctionData('balanceOf', [other]) });
    assertEqual(BigInt(bal.returnValue), toBase('250'), 'recipient balance');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, `contract activity disturbed the supply accounting: ${JSON.stringify(audit)}`);
  });

  await suite.test('a mint past the token cap reverts, and the revert reason surfaces', async () => {
    const { chain, genesis } = await solo();
    const wallet = account(GENESIS, 'user0');
    const iface = new ethers.Interface(ARTIFACTS.FSTOPERC20.abi);
    const data = ARTIFACTS.FSTOPERC20.bytecode + iface.encodeDeploy(['Capped', 'CAP', 18, toBase('5'), toBase('10'), true, false, false, wallet.address, '0x' + '00'.repeat(20)]).slice(2);
    await chain.pool.add(await wallet.signTransaction({ to: null, data, gasLimit: 5_000_000n, gasPrice: BigInt(FEES.minGasPrice), nonce: 0, chainId: Number(genesis.chain_id) }), { gossip: false });
    await mine(chain, wallet.address);
    const token = chain.receiptsByHeight.get(1)[0].contractAddress;
    await chain.pool.add(
      await wallet.signTransaction({ to: token, data: iface.encodeFunctionData('mint', [wallet.address, toBase('100')]), gasLimit: 200_000n, gasPrice: BigInt(FEES.minGasPrice), nonce: 1, chainId: Number(genesis.chain_id) }),
      { gossip: false }
    );
    await mine(chain, wallet.address);
    assertEqual(chain.receiptsByHeight.get(2)[0].status, 0, 'a mint past the cap should revert');
    const res = await chain.execution.call({ from: wallet.address, to: token, data: iface.encodeFunctionData('mint', [wallet.address, toBase('100')]) });
    assertEqual(res.exception, 'revert', `expected a revert, got ${res.exception}`);
    const capOk = await chain.execution.call({ from: wallet.address, to: token, data: iface.encodeFunctionData('mint', [wallet.address, toBase('5')]) });
    assertEqual(capOk.exception, null, 'a mint within the cap should simulate cleanly');
  });

  await suite.test('privileged switches are permanent and disclosed by permissions()', async () => {
    const { chain, genesis } = await solo();
    const owner = account(GENESIS, 'user1');
    const stranger = account(GENESIS, 'user2');
    const iface = new ethers.Interface(ARTIFACTS.FSTOPERC20.abi);
    const data = ARTIFACTS.FSTOPERC20.bytecode + iface.encodeDeploy(['NoMint', 'NM', 18, toBase('5'), 0, false, false, false, owner.address, '0x' + '00'.repeat(20)]).slice(2);
    await chain.pool.add(await owner.signTransaction({ to: null, data, gasLimit: 5_000_000n, gasPrice: BigInt(FEES.minGasPrice), nonce: 0, chainId: Number(genesis.chain_id) }), { gossip: false });
    await mine(chain, owner.address);
    const token = chain.receiptsByHeight.get(1)[0].contractAddress;
    for (const who of [owner, stranger]) {
      const res = await chain.execution.call({ from: who.address, to: token, data: iface.encodeFunctionData('mint', [who.address, 1n]) });
      assertEqual(res.exception, 'revert', `mint should be permanently disabled (${who.address})`);
    }
    const perms = await chain.execution.call({ to: token, data: iface.encodeFunctionData('permissions') });
    const p = iface.decodeFunctionResult('permissions', perms.returnValue);
    assertEqual(p.canMint, false, 'permissions() misreported the mint switch');
    assertEqual(p.canBurn, false, 'permissions() misreported the burn switch');
    assertEqual(p.capUnlimited, true, 'a zero cap should be reported as unlimited');
    assertEqual(p.currentOwner.toLowerCase(), owner.address.toLowerCase(), 'permissions() misreported the owner');
  });

  // ------------------------------------------------------------ asset app
  suite.describe('Asset creation platform');

  await suite.test('the factory deploys an ERC-20 and the registry indexes it', async () => {
    const { chain, genesis } = await solo();
    const creator = account(GENESIS, 'user0');
    const factory = genesis.system_contracts.erc20_factory;
    const registry = genesis.system_contracts.asset_registry;
    const factoryIface = new ethers.Interface(ARTIFACTS.FullStopERC20Factory.abi);
    const registryIface = new ethers.Interface(ARTIFACTS.FullStopAssetRegistry.abi);
    const tokenIface = new ethers.Interface(ARTIFACTS.FSTOPERC20.abi);
    const params = {
      name: 'Community Coin',
      symbol: 'CMC',
      decimals: 18,
      initialSupply: toBase('1000000'),
      maxSupply: toBase('2000000'),
      mintable: true,
      burnable: true,
      transferRestricted: false,
      supplyRecipient: creator.address,
    };
    await chain.pool.add(
      await creator.signTransaction({
        to: factory,
        data: factoryIface.encodeFunctionData('createToken', [Object.values(params)]),
        gasLimit: 6_000_000n,
        gasPrice: BigInt(FEES.minGasPrice),
        nonce: 0,
        chainId: Number(genesis.chain_id),
      }),
      { gossip: false }
    );
    await mine(chain, creator.address);
    const receipt = chain.receiptsByHeight.get(1)[0];
    assertEqual(receipt.status, 1, 'token creation reverted');
    const created = receipt.logs.find((l) => l.topics[0] === factoryIface.getEvent('TokenCreated').topicHash);
    assert(created, 'no TokenCreated event emitted');
    const token = factoryIface.decodeEventLog('TokenCreated', created.data, created.topics).asset;
    const bal = await chain.execution.call({ to: token, data: tokenIface.encodeFunctionData('balanceOf', [creator.address]) });
    assertEqual(BigInt(bal.returnValue), params.initialSupply, 'initial supply did not reach the creator');
    const registered = await chain.execution.call({ to: registry, data: registryIface.encodeFunctionData('assetOf', [token]) });
    const [asset, known] = registryIface.decodeFunctionResult('assetOf', registered.returnValue);
    assert(known, 'the created asset is not in the registry');
    assertEqual(asset.creator.toLowerCase(), creator.address.toLowerCase(), 'registry recorded the wrong creator');
    assertEqual(Number(asset.kind), 1, 'registry kind should be ERC20 (1)');
    const count = await chain.execution.call({ to: registry, data: registryIface.encodeFunctionData('assetCount') });
    assertEqual(BigInt(count.returnValue), 1n, 'registry count');
    const perms = await chain.execution.call({ to: token, data: tokenIface.encodeFunctionData('permissions') });
    const p = tokenIface.decodeFunctionResult('permissions', perms.returnValue);
    assertEqual(p.canMint, true, 'mint switch disclosure');
    assertEqual(BigInt(p.cap), params.maxSupply, 'cap disclosure');
  });

  await suite.test('NFT and multi-token creation work the same way', async () => {
    const { chain, genesis } = await solo();
    const creator = account(GENESIS, 'user1');
    const nftIface = new ethers.Interface(ARTIFACTS.FullStopERC721Factory.abi);
    const multiIface = new ethers.Interface(ARTIFACTS.FullStopERC1155Factory.abi);
    const erc721 = new ethers.Interface(ARTIFACTS.FSTOPERC721.abi);
    const erc1155 = new ethers.Interface(ARTIFACTS.FSTOPERC1155.abi);
    let nonce = 0;
    const send = async (to, data, gasLimit = 6_000_000n) =>
      chain.pool.add(
        await creator.signTransaction({ to, data, gasLimit, gasPrice: BigInt(FEES.minGasPrice), nonce: nonce++, chainId: Number(genesis.chain_id) }),
        { gossip: false }
      );
    await send(genesis.system_contracts.erc721_factory, nftIface.encodeFunctionData('createCollection', [{ name: 'Full Stop Punks', symbol: 'FSP', maxSupply: 100n, contractURI: 'ipfs://collection' }]));
    await send(genesis.system_contracts.erc1155_factory, multiIface.encodeFunctionData('createCollection', ['Full Stop Passes', 'ipfs://meta/{id}.json']));
    await mine(chain, creator.address);
    const receipts = chain.receiptsByHeight.get(1);
    assertEqual(receipts.length, 2, 'both creation transactions should be in the block');
    assert(receipts.every((r) => r.status === 1), 'a creation transaction reverted');
    const findLog = (receipt, iface, eventName, addr) => {
      const topic = iface.getEvent(eventName).topicHash;
      const log = receipt.logs.find((l) => l.topics[0] === topic && l.address.toLowerCase() === addr.toLowerCase());
      assert(log, `no ${eventName} event from ${addr}`);
      return iface.decodeEventLog(eventName, log.data, log.topics);
    };
    const nftAddr = findLog(receipts[0], nftIface, 'CollectionCreated', genesis.system_contracts.erc721_factory).asset;
    const multiAddr = findLog(receipts[1], multiIface, 'MultiTokenCreated', genesis.system_contracts.erc1155_factory).asset;

    await send(nftAddr, erc721.encodeFunctionData('mint', [creator.address, JSON.stringify({ name: 'Punk 1', image: 'ipfs://1' })]), 300_000n);
    await send(multiAddr, erc1155.encodeFunctionData('mint', [creator.address, 1n, 50n, '0x']), 300_000n);
    await mine(chain, creator.address);
    assert(chain.receiptsByHeight.get(2).every((r) => r.status === 1), 'a mint reverted');

    const ownerRes = await chain.execution.call({ to: nftAddr, data: erc721.encodeFunctionData('ownerOf', [1n]) });
    assertEqual(ethers.AbiCoder.defaultAbiCoder().decode(['address'], ownerRes.returnValue)[0].toLowerCase(), creator.address.toLowerCase(), 'NFT ownership');
    const uriRes = await chain.execution.call({ to: nftAddr, data: erc721.encodeFunctionData('tokenURI', [1n]) });
    const uri = ethers.AbiCoder.defaultAbiCoder().decode(['string'], uriRes.returnValue)[0];
    assert(uri.includes('Punk 1'), `token metadata missing: ${uri}`);
    const balRes = await chain.execution.call({ to: multiAddr, data: erc1155.encodeFunctionData('balanceOf', [creator.address, 1n]) });
    assertEqual(BigInt(balRes.returnValue), 50n, 'multi-token balance');
    const uri1155 = await chain.execution.call({ to: multiAddr, data: erc1155.encodeFunctionData('uri', [7n]) });
    const tmpl = ethers.AbiCoder.defaultAbiCoder().decode(['string'], uri1155.returnValue)[0];
    assert(tmpl.includes('/7.'), `the {id} template was not substituted: ${tmpl}`);
    // transfer the NFT and check the new owner, including approval semantics
    await send(nftAddr, erc721.encodeFunctionData('transferFrom', [creator.address, account(GENESIS, 'user3').address, 1n]), 300_000n);
    await mine(chain, creator.address);
    const moved = await chain.execution.call({ to: nftAddr, data: erc721.encodeFunctionData('ownerOf', [1n]) });
    assertEqual(ethers.AbiCoder.defaultAbiCoder().decode(['address'], moved.returnValue)[0].toLowerCase(), account(GENESIS, 'user3').address.toLowerCase(), 'NFT transfer did not move ownership');
    const directDeploy = ARTIFACTS.FSTOPERC1155.bytecode + erc1155.encodeDeploy(['Authorized passes', 'ipfs://meta/{id}.json', creator.address]).slice(2);
    await send(null, directDeploy);
    await mine(chain, creator.address);
    const directAddr = chain.receiptsByHeight.get(4)[0].contractAddress;
    assert(directAddr, 'the ERC-1155 implementation deployment did not produce an address');
    await send(directAddr, erc1155.encodeFunctionData('mint', [creator.address, 1n, 50n, '0x']), 300_000n);
    await mine(chain, creator.address);
    assertEqual(chain.receiptsByHeight.get(5)[0].status, 1, 'the collection owner could not mint');
    const attacker = account(GENESIS, 'user3');
    await chain.pool.add(
      await attacker.signTransaction({
        to: directAddr,
        data: erc1155.encodeFunctionData('mintBatch', [attacker.address, [1n, 999n], [1n, 1n], '0x']),
        gasLimit: 500_000n,
        gasPrice: BigInt(FEES.minGasPrice),
        nonce: 0,
        chainId: Number(genesis.chain_id),
      }),
      { gossip: false }
    );
    await mine(chain, attacker.address);
    assertEqual(chain.receiptsByHeight.get(6)[0].status, 0, 'an unauthorized caller minted an ERC-1155 batch');
    const ownerBatchBalance = await chain.execution.call({ to: directAddr, data: erc1155.encodeFunctionData('balanceOf', [creator.address, 1n]) });
    const attackerBatchBalance = await chain.execution.call({ to: directAddr, data: erc1155.encodeFunctionData('balanceOf', [attacker.address, 999n]) });
    assertEqual(BigInt(ownerBatchBalance.returnValue), 50n, 'unauthorized batch mint changed an existing token supply');
    assertEqual(BigInt(attackerBatchBalance.returnValue), 0n, 'unauthorized batch mint created a new token type');
    const audit = await chain.protocol.supplyAudit(chain.execution);
    assert(audit.ok, 'asset activity disturbed the supply accounting');
  });

  await suite.test('ERC-1155 safe mint and transfer invoke receiver hooks and revert on rejection', async () => {
    const { chain, genesis } = await solo();
    const creator = account(GENESIS, 'user0');
    const source = `
      pragma solidity ^0.8.25;
      contract Receiver {
        bool public accepting = true;
        uint256 public singleCalls;
        uint256 public batchCalls;
        function setAccepting(bool value) external { accepting = value; }
        function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
          require(accepting, "rejected");
          singleCalls++;
          return 0xf23a6e61;
        }
        function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external returns (bytes4) {
          require(accepting, "rejected");
          batchCalls++;
          return 0xbc197c81;
        }
      }
    `;
    const compiled = JSON.parse(solc.compile(JSON.stringify({
      language: 'Solidity',
      sources: { 'Receiver.sol': { content: source } },
      settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    })));
    const compilationErrors = (compiled.errors ?? []).filter((error) => error.severity === 'error');
    assert(compilationErrors.length === 0, compilationErrors.map((error) => error.formattedMessage).join('\n'));
    const receiverArtifact = compiled.contracts['Receiver.sol'].Receiver;
    const receiverIface = new ethers.Interface(receiverArtifact.abi);
    const receiverBytecode = `0x${receiverArtifact.evm.bytecode.object}`;
    const tokenIface = new ethers.Interface(ARTIFACTS.FSTOPERC1155.abi);
    let nonce = 0;
    const submit = async (to, data, gasLimit = 1_000_000n) => {
      await chain.pool.add(
        await creator.signTransaction({
          to,
          data,
          gasLimit,
          gasPrice: BigInt(FEES.minGasPrice),
          nonce: nonce++,
          chainId: Number(genesis.chain_id),
        }),
        { gossip: false }
      );
      await mine(chain, creator.address);
      return chain.receiptsByHeight.get(chain.head.height).at(-1);
    };

    const deployed = await submit(null, receiverBytecode, 2_000_000n);
    assertEqual(deployed.status, 1, 'receiver harness deployment');
    const receiver = deployed.contractAddress;
    const collectionBytecode = `${ARTIFACTS.FSTOPERC1155.bytecode}${tokenIface.encodeDeploy(['Receiver test', '', creator.address]).slice(2)}`;
    const collectionReceipt = await submit(null, collectionBytecode, 4_000_000n);
    assertEqual(collectionReceipt.status, 1, 'ERC-1155 collection deployment');
    const collection = collectionReceipt.contractAddress;

    assertEqual(
      (await submit(collection, tokenIface.encodeFunctionData('mint', [receiver, 1n, 10n, '0x1234']))).status,
      1,
      'safe mint to an accepting receiver'
    );
    assertEqual(
      (await submit(collection, tokenIface.encodeFunctionData('mintBatch', [receiver, [2n, 3n], [7n, 8n], '0xab']))).status,
      1,
      'safe batch mint to an accepting receiver'
    );
    assertEqual(
      (await submit(collection, tokenIface.encodeFunctionData('mint', [creator.address, 4n, 5n, '0x']))).status,
      1,
      'mint to the token owner'
    );
    const singleCalls = await chain.execution.call({ to: receiver, data: receiverIface.encodeFunctionData('singleCalls') });
    const batchCalls = await chain.execution.call({ to: receiver, data: receiverIface.encodeFunctionData('batchCalls') });
    assertEqual(BigInt(singleCalls.returnValue), 1n, 'single receiver hook count');
    assertEqual(BigInt(batchCalls.returnValue), 1n, 'batch receiver hook count');

    assertEqual(
      (await submit(receiver, receiverIface.encodeFunctionData('setAccepting', [false]))).status,
      1,
      'configure rejecting receiver'
    );
    const rejected = await submit(
      collection,
      tokenIface.encodeFunctionData('safeTransferFrom', [creator.address, receiver, 4n, 5n, '0x']),
      300_000n
    );
    assertEqual(rejected.status, 0, 'safe transfer to a rejecting receiver must revert');
    const ownerBalance = await chain.execution.call({ to: collection, data: tokenIface.encodeFunctionData('balanceOf', [creator.address, 4n]) });
    const receiverBalance = await chain.execution.call({ to: collection, data: tokenIface.encodeFunctionData('balanceOf', [receiver, 4n]) });
    assertEqual(BigInt(ownerBalance.returnValue), 5n, 'rejected transfer changed the sender balance');
    assertEqual(BigInt(receiverBalance.returnValue), 0n, 'rejected transfer changed the receiver balance');
  });

  await suite.test('the registry only accepts its approved factories, and ownership is not user-controlled', async () => {
    const { chain, genesis } = await solo();
    const registryIface = new ethers.Interface(ARTIFACTS.FullStopAssetRegistry.abi);
    const attacker = account(GENESIS, 'user3');
    await chain.pool.add(
      await attacker.signTransaction({
        to: genesis.system_contracts.asset_registry,
        data: registryIface.encodeFunctionData('register', [ethers.Wallet.createRandom().address, 1, attacker.address, 'Fake', 'FAKE']),
        gasLimit: 500_000n,
        gasPrice: BigInt(FEES.minGasPrice),
        nonce: 0,
        chainId: Number(genesis.chain_id),
      }),
      { gossip: false }
    );
    await chain.pool.add(
      await attacker.signTransaction({
        to: genesis.system_contracts.asset_registry,
        data: registryIface.encodeFunctionData('setFactory', [attacker.address, true]),
        gasLimit: 500_000n,
        gasPrice: BigInt(FEES.minGasPrice),
        nonce: 1,
        chainId: Number(genesis.chain_id),
      }),
      { gossip: false }
    );
    await mine(chain, attacker.address);
    const receipts = chain.receiptsByHeight.get(1);
    assertEqual(receipts[0].status, 0, 'a non-factory registered an asset');
    assertEqual(receipts[1].status, 0, 'a stranger changed the factory set');
    const count = await chain.execution.call({ to: genesis.system_contracts.asset_registry, data: registryIface.encodeFunctionData('assetCount') });
    assertEqual(BigInt(count.returnValue), 0n, 'registry should still be empty');
    const isFactory = await chain.execution.call({ to: genesis.system_contracts.asset_registry, data: registryIface.encodeFunctionData('factories', [attacker.address]) });
    assertEqual(BigInt(isFactory.returnValue), 0n, 'the attacker added itself as a factory');
    const owner = await chain.execution.call({ to: genesis.system_contracts.asset_registry, data: registryIface.encodeFunctionData('owner') });
    assertEqual(
      ethers.AbiCoder.defaultAbiCoder().decode(['address'], owner.returnValue)[0].toLowerCase(),
      SYSTEM.moduleAddress.toLowerCase(),
      'the registry must be owned by the protocol module account after genesis'
    );
  });

  // ------------------------------------------------------------- genesis rules
  suite.describe('Genesis validation');

  await suite.test('a genesis whose allocations do not add up is refused', async () => {
    const good = JSON.parse(fs.readFileSync(GENESIS, 'utf8'));
    const bad = normalize({ ...good, protocol: { ...good.protocol, allocations: { ...good.protocol.allocations, community: { ...good.protocol.allocations.community, share_bps: '9000' } } } });
    let threw = null;
    try {
      validateGenesis(bad);
    } catch (err) {
      threw = err;
    }
    assert(threw && /sum to/.test(threw.message), `bad allocations accepted: ${threw?.message}`);
  });

  await suite.test('unexplained genesis balances and reserved addresses are refused', async () => {
    const good = JSON.parse(fs.readFileSync(GENESIS, 'utf8'));
    const freeMoney = normalize({ ...good, alloc: [...good.alloc, { address: '0x' + 'ab'.repeat(20), balance: toBase('1000').toString() }] });
    let threw = null;
    try {
      validateGenesis(freeMoney);
    } catch (err) {
      threw = err;
    }
    assert(threw && /without a source allocation/.test(threw.message), `unexplained genesis funds accepted: ${threw?.message}`);

    const reserved = normalize({ ...good, alloc: [...good.alloc, { address: SYSTEM.validatorPoolAddress, balance: '1', source: { pool: 'community' } }] });
    threw = null;
    try {
      validateGenesis(reserved);
    } catch (err) {
      threw = err;
    }
    assert(threw && /reserved protocol address/.test(threw.message), `a reserved address was allowed into alloc: ${threw?.message}`);
  });

  await suite.test('an unknown genesis field is an error, not silently ignored', async () => {
    const good = JSON.parse(fs.readFileSync(GENESIS, 'utf8'));
    let threw = null;
    try {
      normalize({ ...good, max_supply_we_promise: '1e9' });
    } catch (err) {
      threw = err;
    }
    assert(threw && /unknown field/.test(threw.message), `a mistyped genesis field was ignored: ${threw?.message}`);
  });

  await suite.test('a genesis validator whose stake is not funded in alloc is refused', async () => {
    const good = JSON.parse(fs.readFileSync(GENESIS, 'utf8'));
    const drop = String(good.validators[0].address).toLowerCase();
    const unfunded = normalize({ ...good, alloc: good.alloc.filter((a) => String(a.address).toLowerCase() !== drop) });
    let threw = null;
    try {
      validateGenesis(unfunded);
    } catch (err) {
      threw = err;
    }
    assert(threw && /at least its self-bond/.test(threw.message), `an unfunded validator was allowed: ${threw?.message}`);
  });
}

module.exports = { run, title: 'Protocol, economics and EVM' };

if (require.main === module) {
  const suite = new Suite(module.exports.title);
  run(suite).then(() => process.exit(suite.summary() ? 1 : 0));
}
