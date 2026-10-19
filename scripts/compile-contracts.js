#!/usr/bin/env node
'use strict';
/**
 * Compile the Full Stop system contracts with solc and write artifacts.
 *
 * Artifacts (ABI + bytecode) are committed alongside the source so that a node
 * can deploy the genesis asset factory without a toolchain, and so a reviewer
 * can verify that the deployed code matches the source by re-running
 * `npm run compile` and comparing `artifacts/contracts.json`.
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { keccak256 } = require('ethereum-cryptography/keccak');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'contracts');
const OUT = path.join(ROOT, 'artifacts');

const sources = {};
for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.sol'))) {
  sources[f] = { content: fs.readFileSync(path.join(SRC, f), 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'storageLayout'] } },
  },
};

function findImports(name) {
  const file = path.join(SRC, name.replace(/^\.\//, ''));
  if (fs.existsSync(file)) return { contents: fs.readFileSync(file, 'utf8') };
  return { error: `not found: ${name}` };
}

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
const warnings = (out.errors ?? []).filter((e) => e.severity !== 'error');
for (const w of warnings) process.stdout.write(`warning: ${w.formattedMessage}\n`);
if (errors.length) {
  for (const e of errors) process.stderr.write(`${e.formattedMessage}\n`);
  process.exit(1);
}

const artifacts = {};
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    artifacts[name] = {
      source: file,
      abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object,
      deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      deployedCodeHash: ethers.hexlify(Buffer.from(keccak256(ethers.getBytes('0x' + c.evm.deployedBytecode.object)))),
      storageLayout: c.storageLayout,
    };
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'contracts.json'), JSON.stringify({ compiler: `solc ${solc.version()}`, artifacts }, null, 2));
process.stdout.write(`compiled ${Object.keys(artifacts).length} contracts -> artifacts/contracts.json\n`);
