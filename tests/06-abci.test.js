'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ethers } = require('ethers');

const { Chain } = require('../src/chain');
const { loadConfig } = require('../src/node');
const { toExecutionGenesis } = require('../src/genesis');
const { ABCIApplication, cometAddressForKey } = require('../src/abci/application');
const { ABCISocketServer, parseListenAddress } = require('../src/abci/socket-server');
const { decodeResponse, decodeVarint, requestFrame } = require('../src/abci/protobuf');
const { loadValidatorMappings, resolveProfileArgs } = require('../src/abci/serve');
const { buildMapping } = require('../scripts/export-devnet-comet-map');
const { Suite, assert, assertEqual, assertRejects } = require('./helpers');

const GENESIS_PATH = path.resolve(__dirname, '..', 'data', 'testnet', 'genesis.json');
const ACCOUNTS_PATH = path.join(path.dirname(GENESIS_PATH), 'accounts.json');

async function createContext() {
  const root = path.join(__dirname, `.abci-testdata-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(root);
  const genesis = JSON.parse(fs.readFileSync(GENESIS_PATH, 'utf8'));
  const config = loadConfig({ genesis: GENESIS_PATH, datadir: path.join(root, 'chain-data') });
  const chain = await Chain.create({
    genesis: toExecutionGenesis(config.genesis),
    datadir: config.datadir,
    params: config.params,
    mode: 'full',
  });
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  const profile = resolveProfileArgs({ profile: path.resolve(__dirname, '..', 'profiles', 'cometbft.devnet.json') });
  const mappings = loadValidatorMappings(profile.args['validator-map']);
  const stateFile = path.join(root, 'abci', 'blocks.jsonl');
  const app = await ABCIApplication.create({
    chain,
    network: config.genesis.network,
    validatorMappings: mappings,
    stateFile,
  });
  return { root, genesis: config.genesis, config, chain, accounts, mappings, stateFile, app };
}

function initValidators(app) {
  return app.activeMappings(app.chain.protocol.staking.activeSet()).map(({ mapping, power }) => ({
    pubKey: { [mapping.keyType]: mapping.publicKey },
    power: String(power),
  }));
}

function blockVotes(app) {
  return app.activeMappings(app.chain.protocol.staking.activeSet()).map(({ mapping, power }) => ({
    validator: {
      address: Buffer.from(mapping.cometAddress, 'hex'),
      votingPower: String(power),
    },
    blockIdFlag: 2,
  }));
}

async function connect(address) {
  const socket = net.createConnection(address.port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffer = Buffer.alloc(0);
  const responses = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const frame = decodeVarint(buffer, 0);
      if (!frame || buffer.length < frame.bytes + frame.value) return;
      const payload = buffer.subarray(frame.bytes, frame.bytes + frame.value);
      buffer = buffer.subarray(frame.bytes + frame.value);
      const response = decodeResponse(payload);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(response);
      else responses.push(response);
    }
  });
  socket.on('error', (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });
  const receive = () => new Promise((resolve, reject) => {
    const queued = responses.shift();
    if (queued) resolve(queued);
    else waiters.push({ resolve, reject });
  });
  return {
    socket,
    receive,
    send(request) {
      const result = receive();
      socket.write(requestFrame(request));
      return result;
    },
    close() {
      socket.end();
    },
  };
}

async function closeContext(context, server) {
  if (server) await server.close();
  context?.chain?.store?.releaseLock?.();
  if (context?.root && fs.existsSync(context.root)) fs.rmSync(context.root, { recursive: true, force: true });
}

async function run(suite) {
  suite.describe('ABCI++ socket, Comet validator mapping, and EthereumJS execution');

  await suite.test('restricts unauthenticated ABCI transport to loopback', async () => {
    assertEqual(parseListenAddress('tcp://127.0.0.1:26658').host, '127.0.0.1', 'IPv4 loopback bind');
    assertEqual(parseListenAddress('tcp://[::1]:26658').host, '::1', 'IPv6 loopback bind');
    await assertRejects(
      () => Promise.resolve(parseListenAddress('tcp://0.0.0.0:26658')),
      /must bind to the IPv4 or IPv6 loopback address/
    );
    await assertRejects(
      () => Promise.resolve(parseListenAddress('tcp://192.0.2.1:26658')),
      /must bind to the IPv4 or IPv6 loopback address/
    );
  });

  await suite.test('rejects malformed compressed CometBFT secp256k1 public keys', async () => {
    const invalidPublicKey = Buffer.alloc(33);
    invalidPublicKey[0] = 2;
    await assertRejects(
      () => Promise.resolve(cometAddressForKey('secp256k1', invalidPublicKey)),
      /invalid compressed CometBFT secp256k1 validator public key/
    );
  });

  await suite.test('serves framed protobuf requests across multiple concurrent connections', async () => {
    const context = await createContext();
    let server;
    const clients = [];
    try {
      server = new ABCISocketServer({ application: context.app, listen: 'tcp://127.0.0.1:0' });
      const address = await server.start();
      for (let i = 0; i < 4; i++) clients.push(await connect(address));
      const replies = await Promise.all(clients.map((client, index) =>
        client.send({ echo: { message: `connection-${index}` } })
      ));
      for (let i = 0; i < replies.length; i++) {
        assertEqual(replies[i].echo.message, `connection-${i}`, 'protobuf echo response');
      }
      const info = await clients[0].send({ info: {} });
      assertEqual(info.info.lastBlockHeight, '0', 'initial application height');
      assert(info.info.lastBlockAppHash.length > 0, 'genesis app hash is exposed through ABCI Info');
    } finally {
      for (const client of clients) client.close();
      await closeContext(context, server);
    }
  });

  await suite.test('parses coalesced requests by frame size rather than aggregate TCP chunk size', async () => {
    const context = await createContext();
    let server;
    let client;
    try {
      server = new ABCISocketServer({ application: context.app, listen: 'tcp://127.0.0.1:0', maxMessageBytes: 8 });
      const address = await server.start();
      client = await connect(address);
      const requests = Array.from({ length: 20 }, (_, index) => ({ echo: { message: String(index) } }));
      const replies = Promise.all(requests.map(() => client.receive()));
      client.socket.write(Buffer.concat(requests.map(requestFrame)));
      const responseMessages = await replies;
      assertEqual(responseMessages.length, requests.length, 'all coalesced protobuf frames receive replies');
      for (let index = 0; index < responseMessages.length; index++) {
        assertEqual(responseMessages[index].echo.message, String(index), `ordered response ${index}`);
      }
    } finally {
      client?.close();
      await closeContext(context, server);
    }
  });

  await suite.test('executes a signed EVM transfer via FinalizeBlock, commits durably, and replays identically', async () => {
    let context = await createContext();
    let server;
    let client;
    try {
      server = new ABCISocketServer({ application: context.app, listen: 'tcp://127.0.0.1:0' });
      const address = await server.start();
      client = await connect(address);
      const init = await client.send({
        initChain: {
          chainId: String(context.chain.chainId),
          validators: initValidators(context.app),
          initialHeight: '1',
        },
      });
      assert(init.initChain.appHash.length > 0, 'InitChain returns the genesis application hash');

      const user = context.accounts.users[0];
      const recipient = context.accounts.users[1].address;
      const initialRecipient = await context.chain.execution.account(recipient);
      const userKey = JSON.parse(fs.readFileSync(path.join(path.dirname(ACCOUNTS_PATH), user.key_file), 'utf8'));
      const wallet = new ethers.Wallet(userKey.privateKey);
      const signedTx = await wallet.signTransaction({
        to: recipient,
        value: 1n,
        nonce: 0,
        gasLimit: 21_000n,
        gasPrice: BigInt(context.genesis.protocol.min_gas_price),
        chainId: Number(context.genesis.chain_id),
      });
      const txBytes = Buffer.from(signedTx.slice(2), 'hex');
      const check = await client.send({ checkTx: { tx: txBytes, type: 0 } });
      assertEqual(check.checkTx.code, 0, 'CheckTx accepts an existing test-fixture transaction');
      const time = { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 };
      const proposal = await client.send({
        prepareProposal: { maxTxBytes: '1000000', height: '1', time, txs: [txBytes] },
      });
      assertEqual(proposal.prepareProposal.txs.length, 1, 'PrepareProposal retains the valid transaction');
      const process = await client.send({
        processProposal: { height: '1', time, txs: proposal.prepareProposal.txs, proposedLastCommit: { votes: [] } },
      });
      assertEqual(process.processProposal.status, 1, 'ProcessProposal deterministically accepts valid EVM execution');
      const finalized = await client.send({
        finalizeBlock: { height: '1', time, txs: proposal.prepareProposal.txs, decidedLastCommit: { votes: [] } },
      });
      assertEqual(finalized.finalizeBlock.txResults.length, 1, 'FinalizeBlock returns a result for the EVM transaction');
      assertEqual(finalized.finalizeBlock.txResults[0].code, 0, 'EVM transaction is included without an ABCI error');
      const firstCommittedHash = Buffer.from(finalized.finalizeBlock.appHash).toString('hex');
      const commit = await client.send({ commit: {} });
      assertEqual(commit.commit.retainHeight, '0', 'Commit persists the application state');

      const accountBeforeRestart = await client.send({ query: { path: `/account/${recipient}` } });
      const balanceBeforeRestart = JSON.parse(Buffer.from(accountBeforeRestart.query.value).toString('utf8')).balance;
      assertEqual(balanceBeforeRestart, (initialRecipient.balance + 1n).toString(), 'signed transaction changes the recipient EVM balance');

      const heightTwoVotes = blockVotes(context.app);
      const timeTwo = { seconds: String(Math.floor(Date.now() / 1000) + 1), nanos: 0 };
      const processTwo = await client.send({
        processProposal: {
          height: '2',
          time: timeTwo,
          txs: [],
          proposedLastCommit: { votes: heightTwoVotes },
        },
      });
      assertEqual(processTwo.processProposal.status, 1, 'mapped CometBFT quorum is accepted for attendance');
      const finalizedTwo = await client.send({
        finalizeBlock: {
          height: '2',
          time: timeTwo,
          txs: [],
          decidedLastCommit: { votes: heightTwoVotes },
        },
      });
      const secondCommittedHash = Buffer.from(finalizedTwo.finalizeBlock.appHash).toString('hex');
      await client.send({ commit: {} });
      assert(finalizedTwo.finalizeBlock.appHash.length > 0, 'second height produces a deterministic application hash');

      client.close();
      client = null;
      await server.close();
      server = null;
      context.chain.store.releaseLock();

      const config = loadConfig({
        genesis: GENESIS_PATH,
        datadir: path.join(context.root, 'chain-data'),
      });
      const recoveredChain = await Chain.create({
        genesis: toExecutionGenesis(config.genesis),
        datadir: config.datadir,
        params: config.params,
        mode: 'full',
      });
      const recoveredApp = await ABCIApplication.create({
        chain: recoveredChain,
        network: config.genesis.network,
        validatorMappings: context.mappings,
        stateFile: context.stateFile,
      });
      assertEqual(recoveredApp.height, 2, 'ABCI journal replays both committed heights');
      assertEqual(Buffer.from(recoveredApp.info().lastBlockAppHash).toString('hex'), String(recoveredApp.appHash).slice(2), 'replayed app hash');
      const recoveredAccount = await recoveredApp.query({ path: `/account/${recipient}` });
      const balanceAfterRestart = JSON.parse(Buffer.from(recoveredAccount.value).toString('utf8')).balance;
      assertEqual(balanceAfterRestart, balanceBeforeRestart, 'replayed EVM account state matches before restart');
      assertEqual(String(recoveredApp.appHash).slice(2), secondCommittedHash, 'replayed app hash matches the latest FinalizeBlock result');
      assert(firstCommittedHash.length > 0, 'first committed app hash is non-empty');
      recoveredChain.store.releaseLock();
      context.chain.store.releaseLock = null;
    } finally {
      client?.close();
      await closeContext(context, server);
    }
  });

  await suite.test('fails closed for missing validator mappings and any Mainnet application startup', async () => {
    const context = await createContext();
    try {
      await assertRejects(
        () => Promise.resolve(new ABCIApplication({
          chain: context.chain,
          network: 'testnet',
          validatorMappings: [],
          stateFile: context.stateFile,
        })),
        /at least one explicit testnet validator mapping/
      );
      await assertRejects(
        () => Promise.resolve(new ABCIApplication({
          chain: context.chain,
          network: 'mainnet',
          validatorMappings: context.mappings,
          stateFile: context.stateFile,
        })),
        /limited to explicit devnet\/testnet/
      );
    } finally {
      await closeContext(context);
    }
  });

  await suite.test('loads the checked-in devnet fixture profile and resolves its paths', async () => {
    const resolved = resolveProfileArgs({ profile: path.resolve(__dirname, '..', 'profiles', 'cometbft.devnet.json') });
    assertEqual(resolved.profileNetwork, 'devnet', 'profile network');
    assertEqual(path.basename(resolved.args.genesis), 'genesis.json', 'devnet genesis path');
    assertEqual(path.basename(resolved.args['validator-map']), 'cometbft.devnet.validators.json', 'public validator mapping path');
    assertEqual(resolved.args.listen, 'tcp://127.0.0.1:26658', 'profile socket endpoint');
    const checkedIn = JSON.parse(fs.readFileSync(resolved.args['validator-map'], 'utf8'));
    assertEqual(JSON.stringify(buildMapping()), JSON.stringify(checkedIn), 'public mapping is reproducibly derived from disposable fixtures');
  });
}

module.exports = { title: 'ABCI++ backend vertical slice', run };
