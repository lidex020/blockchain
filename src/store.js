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
 * snapshot and much harder to get wrong: a malformed or truncated record
 * fails closed and leaves the original files untouched.
 */

const fs = require('fs');
const path = require('path');

const STORE_FILES = ['genesis.json', 'blocks.jsonl', 'receipts.jsonl', 'meta.json'];
const ALLOWED_STORE_ENTRIES = new Set([...STORE_FILES, 'node.lock']);
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
    let existing = false;
    try {
      fs.lstatSync(store.dir);
      existing = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (existing) {
      store._assertClassified();
      store.isFresh = false;
    } else {
      fs.mkdirSync(store.dir, { recursive: true });
      store.isFresh = true;
    }
    store._acquireLock();
    return store;
  }

  /**
   * Existing chain directories must be recognized as complete before startup
   * writes even the operational lock. An empty, partial, symlinked, or
   * otherwise unclassified directory is never a genesis-initialization target.
   */
  _assertClassified() {
    const reject = (reason) => {
      throw new Error(
        `existing chain store ${this.dir} is incomplete or unclassified (${reason}). ` +
        'Refusing to acquire a lock or initialize genesis; preserve the files and inspect only a separate copy.'
      );
    };

    let dirStat;
    try {
      dirStat = fs.lstatSync(this.dir);
    } catch (error) {
      reject(`cannot inspect directory: ${error.message}`);
    }
    if (!dirStat.isDirectory()) reject('chain path is not a regular directory');

    const entries = fs.readdirSync(this.dir);
    const unexpected = entries.filter((entry) => !ALLOWED_STORE_ENTRIES.has(entry));
    const missing = STORE_FILES.filter((file) => !entries.includes(file));
    const nonFiles = STORE_FILES.filter((file) => {
      try {
        return !fs.lstatSync(path.join(this.dir, file)).isFile();
      } catch {
        return true;
      }
    });
    let invalidLock = false;
    if (entries.includes('node.lock')) {
      try {
        invalidLock = !fs.lstatSync(path.join(this.dir, 'node.lock')).isFile();
      } catch {
        invalidLock = true;
      }
    }
    if (missing.length || nonFiles.length || unexpected.length || invalidLock) {
      reject([
        missing.length ? `missing ${missing.join(', ')}` : null,
        nonFiles.length ? `not regular files ${nonFiles.join(', ')}` : null,
        unexpected.length ? `unexpected entries ${unexpected.join(', ')}` : null,
        invalidLock ? 'node.lock is not a regular file' : null,
      ].filter(Boolean).join('; '));
    }

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    } catch (error) {
      reject(`metadata is unreadable: ${error.message}`);
    }
    if (
      !meta ||
      typeof meta !== 'object' ||
      Array.isArray(meta) ||
      typeof meta.chainId !== 'string' ||
      typeof meta.genesisHash !== 'string'
    ) {
      reject('metadata does not identify a chain and genesis');
    }
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
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), node: process.env.LIDEX_NODE_NAME ?? null }, null, 2));
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
    return STORE_FILES.every((file) => {
      try {
        return fs.lstatSync(path.join(this.dir, file)).isFile();
      } catch {
        return false;
      }
    });
  }

  saveGenesis(genesis) {
    if (fs.existsSync(this.genesisPath)) {
      const existing = fs.readFileSync(this.genesisPath, 'utf8');
      if (normalizeJson(existing) !== normalizeJson(JSON.stringify(genesis))) {
        throw new Error(
          `genesis.json in ${this.dir} does not match the genesis document provided. ` +
          'Refusing to run against a different chain. Preserve the data directory and inspect a separate copy; do not delete or replace the source.'
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
    // LidexBlock.withCommit), so a replay reads exactly one file and cannot
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

  /** Read all blocks strictly; malformed or torn records are never repaired in place. */
  readBlocks() {
    return this._readJsonLines(this.blocksPath);
  }

  readReceipts() {
    return this._readJsonLines(this.receiptsPath);
  }

  _readJsonLines(file) {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        const name = path.basename(file);
        throw new Error(
          `invalid ${name} record at line ${index + 1}; preserving source bytes and refusing recovery. ` +
          'Inspect only a separate copy; do not truncate or rewrite the source log.'
        );
      }
    }
    return out;
  }

  /** Explicitly reject the legacy repair API so callers cannot overwrite source history. */
  rewrite() {
    throw new Error(
      'Store.rewrite is disabled: non-destructive recovery never rewrites chain logs. ' +
      'Preserve the logs and investigate only an isolated copy.'
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
