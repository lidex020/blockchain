'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite, assert, assertEqual, assertRejects, paramsFromGenesis } = require('./helpers.js');
const { Chain } = require('../src/chain.js');
const { loadGenesis, toExecutionGenesis } = require('../src/genesis.js');
const { Store } = require('../src/store.js');

const GENESIS_PATH = path.resolve(__dirname, '..', 'data', 'testnet', 'genesis.json');

async function run(suite) {
  await suite.test('malformed block log fails closed without truncating its source bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lidex-recovery-blocks-'));
    try {
      const store = new Store(root);
      fs.mkdirSync(root, { recursive: true });
      const contents = Buffer.from('{"header":{"height":0}}\n{"header":\n', 'utf8');
      fs.writeFileSync(store.blocksPath, contents);

      await assertRejects(() => store.readBlocks(), /blocks\.jsonl.*line 2.*preserv/i);
      assert(fs.readFileSync(store.blocksPath).equals(contents), 'malformed block log bytes changed during read');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('malformed receipt log fails closed instead of returning a partial prefix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lidex-recovery-receipts-'));
    try {
      const store = new Store(root);
      const contents = Buffer.from('{"height":0,"receipts":[]}\n{"height":\n', 'utf8');
      fs.writeFileSync(store.receiptsPath, contents);

      await assertRejects(() => store.readReceipts(), /receipts\.jsonl.*line 2.*preserv/i);
      assert(fs.readFileSync(store.receiptsPath).equals(contents), 'malformed receipt log bytes changed during read');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('partial existing chain store is rejected without creating or changing files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lidex-recovery-partial-store-'));
    try {
      const chainDir = path.join(root, 'chain');
      fs.mkdirSync(chainDir);
      const blocksPath = path.join(chainDir, 'blocks.jsonl');
      const blocks = Buffer.from('preserve this partial chain history\n', 'utf8');
      fs.writeFileSync(blocksPath, blocks);

      const genesis = loadGenesis(GENESIS_PATH);
      const error = await assertRejects(
        () => Chain.create({
          genesis: toExecutionGenesis(genesis),
          datadir: root,
          params: paramsFromGenesis(genesis, {}),
          mode: 'observer',
        }),
        /existing chain store.*incomplete or unclassified.*preserv/i
      );
      assert(/refusing.*initializ/i.test(error.message), 'partial-store error does not explicitly refuse initialization');
      assert(fs.readFileSync(blocksPath).equals(blocks), 'partial store block bytes changed');
      assert(
        JSON.stringify(fs.readdirSync(chainDir).sort()) === JSON.stringify(['blocks.jsonl']),
        'partial store gained files such as a startup lock or genesis metadata'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('unclassified existing chain directory is rejected without writing a lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lidex-recovery-unclassified-store-'));
    try {
      const chainDir = path.join(root, 'chain');
      fs.mkdirSync(chainDir);
      const markerPath = path.join(chainDir, 'operator-note.txt');
      const marker = Buffer.from('unclassified operator data\n', 'utf8');
      fs.writeFileSync(markerPath, marker);

      const genesis = loadGenesis(GENESIS_PATH);
      await assertRejects(
        () => Chain.create({
          genesis: toExecutionGenesis(genesis),
          datadir: root,
          params: paramsFromGenesis(genesis, {}),
          mode: 'observer',
        }),
        /existing chain store.*incomplete or unclassified.*preserv/i
      );
      assert(fs.readFileSync(markerPath).equals(marker), 'unclassified store marker bytes changed');
      assert(
        JSON.stringify(fs.readdirSync(chainDir).sort()) === JSON.stringify(['operator-note.txt']),
        'unclassified store gained files such as a startup lock or genesis metadata'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('complete existing chain store still recovers from its durable records', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lidex-recovery-complete-store-'));
    let first;
    let reopened;
    try {
      const genesis = loadGenesis(GENESIS_PATH);
      const options = {
        genesis: toExecutionGenesis(genesis),
        datadir: root,
        params: paramsFromGenesis(genesis, {}),
        mode: 'observer',
      };
      first = await Chain.create(options);
      const expectedHeight = first.head.height;
      const expectedHash = first.head.hash;
      const expectedStateRoot = first.stateRoot;
      const blocksBefore = fs.readFileSync(first.store.blocksPath);
      const receiptsBefore = fs.readFileSync(first.store.receiptsPath);
      first.store.releaseLock();

      reopened = await Chain.create(options);
      assertEqual(reopened.head.height, expectedHeight, 'complete store recovery preserves head height');
      assertEqual(reopened.head.hash, expectedHash, 'complete store recovery preserves head hash');
      assertEqual(reopened.stateRoot, expectedStateRoot, 'complete store recovery preserves state root');
      assert(fs.readFileSync(reopened.store.blocksPath).equals(blocksBefore), 'complete store recovery changed block history');
      assert(fs.readFileSync(reopened.store.receiptsPath).equals(receiptsBefore), 'complete store recovery changed receipt history');
    } finally {
      first?.store?.releaseLock();
      reopened?.store?.releaseLock();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('legacy log rewrite is disabled and leaves both logs unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lidex-recovery-rewrite-'));
    try {
      const store = new Store(root);
      const blocks = Buffer.from('keep-block-log\n');
      const receipts = Buffer.from('keep-receipt-log\n');
      fs.writeFileSync(store.blocksPath, blocks);
      fs.writeFileSync(store.receiptsPath, receipts);

      await assertRejects(
        () => store.rewrite([], new Map()),
        /non-destructive recovery.*disabled|preserve.*logs/i
      );
      assert(fs.readFileSync(store.blocksPath).equals(blocks), 'rewrite changed blocks.jsonl');
      assert(fs.readFileSync(store.receiptsPath).equals(receipts), 'rewrite changed receipts.jsonl');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('replay root mismatch stops without modifying the block log or advising deletion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lidex-recovery-root-mismatch-'));
    let created;
    try {
      const genesis = loadGenesis(GENESIS_PATH);
      const execGenesis = toExecutionGenesis(genesis);
      const params = paramsFromGenesis(genesis, {});
      created = await Chain.create({ genesis: execGenesis, datadir: root, params, mode: 'observer' });
      created.store.releaseLock();

      const blocksPath = created.store.blocksPath;
      const records = fs.readFileSync(blocksPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      records[0].header.stateRoot = `0x${'00'.repeat(32)}`;
      fs.writeFileSync(blocksPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
      const before = fs.readFileSync(blocksPath);

      const error = await assertRejects(
        () => Chain.create({ genesis: execGenesis, datadir: root, params, mode: 'observer' }),
        /genesis state root mismatch on recovery.*preserv.*copy/i
      );
      assert(/do not delete, truncate or rewrite/i.test(error.message), 'recovery error omits non-destructive handling guidance');
      assert(!/delete .*instead|start from a fresh data directory/i.test(error.message), 'recovery error recommends destructive reset');
      assert(fs.readFileSync(blocksPath).equals(before), 'root mismatch recovery changed blocks.jsonl');
      // Chain.create acquires its startup lock before replay fails. Release it
      // through the isolated temporary test store before cleaning up.
      const cleanupStore = Store.open(root);
      cleanupStore.releaseLock();
    } finally {
      created?.store?.releaseLock();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

module.exports = { title: 'Non-destructive recovery', run };
