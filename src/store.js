'use strict';
/**
 * On-disk chain store.
 *
 * Layout under <datadir>/chain/:
 *   genesis.json      the genesis document actually in use (immutable)
 *   blocks.jsonl      one JSON object per block, in height order
 *   receipts.jsonl    one JSON object per block: {height, receipts: [...]}
 *   meta.json         head pointer + running counters
 *
 * Recovery model: the state trie is *not* persisted. A restarting node
 * replays blocks.jsonl from genesis through the same deterministic execution
 * path it uses for live blocks, and verifies that every recomputed state root
 * and app hash matches what is recorded in the header. That is slower than a
 * snapshot and much harder to get wrong: a corrupted or truncated file shows up
 * as a root mismatch instead of as silent state divergence.
 */

const fs = require('fs');
const path = require('path');

const activeLockReleases = new Set();
let lockHandlersInstalled = false;

function releaseAllLocks() {
  for (const release of [...activeLockReleases]) release();
}

function installLockHandlers() {
  if (lockHandlersInstalled) return;
  lockHandlersInstalled = true;
  process.once('exit', releaseAllLocks);
  process.once('SIGINT', () => {
    releaseAllLocks();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    releaseAllLocks();
    process.exit(143);
  });
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.blocksPath = path.join(dir, 'blocks.jsonl');
    this.receiptsPath = path.join(dir, 'receipts.jsonl');
    this.metaPath = path.join(dir, 'meta.json');
    this.genesisPath = path.join(dir, 'genesis.json');
    this._buffer = [];
    this._receiptBuffer = [];
    this._flushing = false;
  }

  static open(dir) {
    const store = new Store(path.join(dir, 'chain'));
    fs.mkdirSync(store.dir, { recursive: true });
    store._acquireLock();
    return store;
  }

  /**
   * One process per data directory, enforced here instead of only in the docs.
   *
   * Two nodes sharing a directory interleave their appends into blocks.jsonl, and
   * the result is a log whose heights are out of order: neither node can replay
   * it, and the corruption is silent until a restart. That is easy to do by
   * accident with a devnet script (start it twice) and expensive to discover, so
   * the second process is refused at startup.
   *
   * The lock is advisory (a plain file holding the pid). A node killed with
   * SIGKILL leaves it behind, which is why a lock whose pid is gone is simply
   * taken over; if some unrelated process has since been given that pid the
   * message names the file, so the operator decides instead of the node guessing.
   */
  _acquireLock() {
    const file = path.join(this.dir, 'node.lock');
    const readHolder = () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    };
    const holder = readHolder();
    if (holder && holder.pid && holder.pid !== process.pid) {
      let alive = false;
      try {
        process.kill(holder.pid, 0);
        alive = true;
      } catch (err) {
        alive = err && err.code === 'EPERM'; // running, but not ours to signal
      }
      if (alive) {
        throw new Error(
          `this data directory is already in use: ${file} is held by pid ${holder.pid} (started ${holder.startedAt}). ` +
            'Two nodes must not share one data directory - stop that process first, or give this one its own --datadir.'
        );
      }
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), node: process.env.FULLSTOP_NODE_NAME ?? null }, null, 2));
    const release = () => {
      if (!activeLockReleases.delete(release)) return;
      try {
        if (readHolder()?.pid === process.pid) fs.rmSync(file, { force: true });
      } catch {
        /* nothing to do if the directory is already gone */
      }
    };
    activeLockReleases.add(release);
    installLockHandlers();
    this.releaseLock = release;
  }

  exists() {
    return fs.existsSync(this.blocksPath) && fs.existsSync(this.metaPath);
  }

  saveGenesis(genesis) {
    if (fs.existsSync(this.genesisPath)) {
      const existing = fs.readFileSync(this.genesisPath, 'utf8');
      if (normalizeJson(existing) !== normalizeJson(JSON.stringify(genesis))) {
        throw new Error(
          `genesis.json in ${this.dir} does not match the genesis document provided. ` +
          'Refusing to run a node against a different chain - delete the data directory to start a fresh one.'
        );
      }
      return;
    }
    fs.writeFileSync(this.genesisPath, JSON.stringify(genesis, null, 2));
  }

  loadGenesis() {
    if (!fs.existsSync(this.genesisPath)) return null;
    return JSON.parse(fs.readFileSync(this.genesisPath, 'utf8'));
  }

  meta() {
    if (!fs.existsSync(this.metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    } catch {
      return null;
    }
  }

  writeMeta(meta) {
    this._writeAtomic(this.metaPath, JSON.stringify(meta, null, 2));
  }

  _writeAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  /** Append a block and its receipts (buffered; call flush()). */
  append(block, receipts) {
    this._buffer.push(JSON.stringify(block));
    this._receiptBuffer.push(JSON.stringify({ height: block.header.height, receipts }));
    if (this._buffer.length >= 64) this.flush();
  }

  flush() {
    // There is no separate commit log on purpose: the commit that sealed a
    // height is part of that height's block record (see Chain.recordCommit and
    // FullStopBlock.withCommit), so a replay reads exactly one file and cannot
    // find a commit that belongs to a different block.
    if (this._buffer.length) {
      fs.appendFileSync(this.blocksPath, this._buffer.join('\n') + '\n');
      this._buffer = [];
    }
    if (this._receiptBuffer.length) {
      fs.appendFileSync(this.receiptsPath, this._receiptBuffer.join('\n') + '\n');
      this._receiptBuffer = [];
    }
  }

  /** Read all blocks, tolerating a partially written trailing line. */
  readBlocks() {
    if (!fs.existsSync(this.blocksPath)) return [];
    const raw = fs.readFileSync(this.blocksPath, 'utf8');
    const out = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Torn write at the tail: drop it and everything after it, then
        // rewrite the file so the next flush appends cleanly.
        fs.writeFileSync(this.blocksPath, out.map((b) => JSON.stringify(b)).join('\n') + (out.length ? '\n' : ''));
        return out;
      }
    }
    return out;
  }

  readReceipts() {
    if (!fs.existsSync(this.receiptsPath)) return [];
    const raw = fs.readFileSync(this.receiptsPath, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        break;
      }
    }
    return out;
  }

  /** Rewrite both logs, used after a replay repair. */
  rewrite(blocks, receiptsByHeight) {
    this.flush();
    this._buffer = [];
    this._receiptBuffer = [];
    fs.writeFileSync(this.blocksPath, blocks.map((b) => JSON.stringify(b)).join('\n') + (blocks.length ? '\n' : ''));
    fs.writeFileSync(
      this.receiptsPath,
      blocks.map((b) => JSON.stringify({ height: b.header.height, receipts: receiptsByHeight.get(b.header.height) ?? [] })).join('\n') +
        (blocks.length ? '\n' : '')
    );
  }

  sizes() {
    const stat = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    return {
      blocksBytes: stat(this.blocksPath),
      receiptsBytes: stat(this.receiptsPath),
    };
  }
}

function normalizeJson(s) {
  try {
    return JSON.stringify(JSON.parse(s));
  } catch {
    return s;
  }
}

module.exports = { Store };
