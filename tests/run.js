#!/usr/bin/env node
'use strict';
/**
 * Test entry point: runs every suite in tests/*.test.js in order.
 *
 *   node tests/run.js            # all suites
 *   node tests/run.js network    # only suites whose file name matches
 *
 * These are not unit tests with mocks: the network suite starts real nodes
 * over an in-process bus and asserts on blocks that were actually executed and
 * voted on, and the protocol suites drive the same code paths a validator runs.
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./helpers.js');

async function main() {
  const filter = process.argv[2];
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filter || f.includes(filter))
    .sort();
  if (!files.length) {
    process.stderr.write(`no test files matched "${filter ?? ''}"\n`);
    process.exit(1);
  }
  let failed = 0;
  const started = Date.now();
  // Keep the loop alive so a hung test surfaces as a timeout failure instead of
  // the process quietly exiting with code 0.
  const keepAlive = setInterval(() => {}, 1000);
  for (const file of files) {
    const mod = require(path.join(__dirname, file));
    const suite = new Suite(mod.title ?? file);
    process.stdout.write(`\n=== ${mod.title ?? file} ===`);
    try {
      await mod.run(suite);
    } catch (err) {
      process.stdout.write(`\n  SUITE CRASHED: ${err.message}\n${err.stack}\n`);
      failed += 1;
    }
    failed += suite.summary();
  }
  process.stdout.write(`\nall suites finished in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  if (failed) {
    process.stdout.write(`RESULT: ${failed} suite(s) or test(s) failed\n`);
    process.exit(1);
  }
  clearInterval(keepAlive);
  process.stdout.write('RESULT: all tests passed\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
