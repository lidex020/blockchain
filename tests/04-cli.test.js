'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Suite, assert } = require('./helpers.js');
const { isWithinDirectory } = require('../src/cli.js');
const { assertSupportedNetwork } = require('../src/node.js');
const { Store } = require('../src/store.js');

async function run(suite) {
  const root = path.resolve('workspace');

  await suite.test('key output path checks reject parent and prefix-sibling directories', async () => {
    assert(isWithinDirectory(root, root), 'the workspace root should be allowed');
    assert(isWithinDirectory(root, path.join(root, 'keys')), 'a child directory should be allowed');
    assert(!isWithinDirectory(root, path.resolve(`${root}-outside`)), 'a sibling sharing the workspace name prefix must be rejected');
    assert(!isWithinDirectory(root, path.dirname(root)), 'a parent directory must be rejected');
  });

  await suite.test('opening many stores installs only one set of shutdown handlers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-store-handlers-'));
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    const stores = [];
    try {
      for (let i = 0; i < 12; i++) stores.push(Store.open(path.join(root, `node-${i}`)));
      assert(process.listenerCount('exit') <= before.exit + 1, 'store instances registered duplicate exit handlers');
      assert(process.listenerCount('SIGINT') <= before.sigint + 1, 'store instances registered duplicate SIGINT handlers');
      assert(process.listenerCount('SIGTERM') <= before.sigterm + 1, 'store instances registered duplicate SIGTERM handlers');
    } finally {
      for (const store of stores) store.releaseLock();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('mainnet node startup is blocked while custom consensus is testnet-only', async () => {
    let error;
    try {
      assertSupportedNetwork({ network: 'mainnet' });
    } catch (caught) {
      error = caught;
    }
    assert(error && /mainnet startup is disabled/.test(error.message), 'unsupported mainnet configuration was not rejected');
    assertSupportedNetwork({ network: 'devnet' });
  });
}

module.exports = { title: 'CLI safety', run };
