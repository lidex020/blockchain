'use strict';
/**
 * Peer-to-peer transport.
 *
 * Nodes gossip over plain HTTP with JSON bodies and EdDSA-sealed payloads: the
 * *authenticity* of every message comes from the validator's signature checked
 * against the bonded key set, not from the transport. That keeps the network
 * layer simple, inspectable and easy to run behind a load balancer or over a
 * tunnel, at the cost of not encrypting the gossip itself - a production
 * deployment is expected to run peer traffic over mTLS or a wireguard mesh, and
 * the transport is deliberately separated from the consensus logic so that can
 * be swapped without touching block processing.
 *
 * Sync: a node that is behind its peers downloads blocks in order and applies
 * them through the same verification path used for live proposals, so there is
 * no "trusted sync" code path that skips execution.
 */

const { MessageType } = require('./block');
const { FullStopBlock } = require('./block');
const { createLogger } = require('./logger');
const { PROTOCOL } = require('./constants');

const log = createLogger('p2p');

class P2P {
  /**
   * @param {object} opts
   * @param {Chain} opts.chain
   * @param {Consensus} opts.consensus
   * @param {string[]} opts.peers base URLs, e.g. http://127.0.0.1:72131
   * @param {number} opts.port this node's port (for the self-reported status)
   */
  constructor({ chain, consensus, peers = [], port, nodeId, moniker }) {
    this.chain = chain;
    this.consensus = consensus;
    this.port = port;
    this.nodeId = nodeId;
    this.moniker = moniker ?? 'node';
    this.staticPeers = peers.filter((p) => p && !p.includes(`:${port}`)).map(normalizeUrl);
    /** url -> {url, lastSeen, status} */
    this.peers = new Map();
    this.inflight = new Set();
    this.syncing = false;
    this.syncStart = 0;
    this.syncTarget = 0;
    this.lastBlockSeen = new Map();
    this.stats = { sent: 0, received: 0, rejected: 0, syncApplied: 0, failures: 0 };
    this._gossipQueue = Promise.resolve();
    this.outbox = [];
    this.peerRefreshTimer = null;
    this.maxFailuresBeforeDrop = 5;
    this.failures = new Map();
  }

  // ------------------------------------------------------------ peer lists

  peerCount() {
    return [...this.peers.values()].filter((p) => Date.now() - p.lastSeen < 30_000).length;
  }

  peerStatus() {
    return [...this.peers.values()].map((p) => ({
      url: p.url,
      height: p.status?.height ?? null,
      moniker: p.status?.moniker ?? null,
      nodeId: p.status?.nodeId ?? null,
      secondsSinceSeen: Math.round((Date.now() - p.lastSeen) / 1000),
      inSync: p.status ? p.status.height >= this.chain.head.height : false,
    }));
  }

  /** Static peers plus any peer a remote told us about. */
  knownPeers() {
    const urls = new Set(this.staticPeers);
    for (const p of this.peers.values()) if (p.status?.peers) for (const u of p.status.peers) urls.add(normalizeUrl(u));
    urls.delete(normalizeUrl(`http://127.0.0.1:${this.port}`));
    return [...urls].filter((u) => !u.includes(`127.0.0.1:${this.port}`));
  }

  start() {
    this.tick();
    this.peerRefreshTimer = setInterval(() => this.tick(), 2000);
    if (this.peerRefreshTimer.unref) this.peerRefreshTimer.unref();
  }

  stop() {
    if (this.peerRefreshTimer) clearInterval(this.peerRefreshTimer);
    this.peerRefreshTimer = null;
  }

  tick() {
    this._gossipQueue = this._gossipQueue
      .then(async () => {
        await this.refreshPeers();
        await this.maybeSync();
      })
      .catch((err) => log.debug('peer tick failed', { err: err.message }));
  }

  async refreshPeers() {
    for (const url of this.knownPeers()) {
      try {
        const status = await this.call(url, 'GET', '/p2p/status');
        const existing = this.peers.get(url) ?? { url, failures: 0 };
        this.peers.set(url, { ...existing, url, status, lastSeen: Date.now(), failures: 0 });
      } catch (err) {
        const entry = this.peers.get(url) ?? { url, lastSeen: 0, failures: 0 };
        entry.failures = (entry.failures ?? 0) + 1;
        this.peers.set(url, entry);
        if (entry.failures > this.maxFailuresBeforeDrop) this.peers.delete(url);
      }
    }
  }

  // ------------------------------------------------------------- sync

  highestPeerHeight() {
    let best = this.chain.head.height;
    for (const p of this.peers.values()) if (p.status?.height > best) best = p.status.height;
    return best;
  }

  isSyncing() {
    return this.syncing;
  }

  async maybeSync() {
    if (this.chain.head === null) return;
    const target = this.highestPeerHeight();
    if (target <= this.chain.head.height) {
      if (this.syncing) {
        this.syncing = false;
        log.info('synchronisation finished', { height: this.chain.head.height });
        this.consensus?.enterHeight(this.chain.head.height + 1);
        this.consensus?.start();
      }
      return;
    }
    if (this.syncing && target === this.syncTarget && Date.now() - this.syncStartedAt < 15_000) return;
    this.syncing = true;
    this.syncTarget = target;
    this.syncStart = this.chain.head.height;
    this.syncStartedAt = Date.now();
    this.consensus?.stop();
    log.info('synchronising', { from: this.chain.head.height, to: target });

    const fromPeer = this.pickSyncPeer();
    if (!fromPeer) return;
    let applied = 0;
    while (this.chain.head.height < target && applied < 500) {
      const from = this.chain.head.height + 1;
      let records;
      try {
        records = await this.call(fromPeer, 'GET', `/p2p/blocks?from=${from}&limit=100`);
      } catch (err) {
        log.warn('sync fetch failed', { peer: fromPeer, err: err.message });
        break;
      }
      if (!records?.length) break;
      for (const rec of records) {
        if (rec.header.height !== this.chain.head.height + 1) {
          log.warn('sync returned an out-of-order block, stopping', { got: rec.header.height, want: this.chain.head.height + 1 });
          break;
        }
        try {
          const block = FullStopBlock.fromJSON(rec);
          // Same verification path as a live proposal: sync never trusts a peer.
          await this.chain.commitBlock(block, { source: 'sync' });
          this.stats.syncApplied += 1;
          applied += 1;
        } catch (err) {
          log.error('synced block failed verification', { height: rec.header.height, err: err.message });
          this.stats.failures += 1;
          this.syncing = false;
          return;
        }
      }
    }
    if (this.chain.head.height >= this.highestPeerHeight()) {
      this.syncing = false;
      log.info('synchronisation finished', { height: this.chain.head.height });
      if (this.consensus?.isValidator) {
        this.consensus.enterHeight(this.chain.head.height + 1);
        this.consensus.start();
      }
    }
  }

  pickSyncPeer() {
    const candidates = [...this.peers.values()]
      .filter((p) => p.status?.height > this.chain.head.height)
      .sort((a, b) => b.status.height - a.status.height);
    return candidates[0]?.url ?? null;
  }

  // ------------------------------------------------------------ broadcast

  /** Fire-and-forget a consensus or transaction message to every known peer. */
  broadcast(msg) {
    this._gossipQueue = this._gossipQueue
      .then(async () => {
        const peers = this.knownPeers();
        await Promise.all(
          peers.map(async (url) => {
            try {
              await this.call(url, 'POST', '/p2p/broadcast', msg);
              this.stats.sent += 1;
            } catch (err) {
              log.debug('gossip delivery failed', { url, err: err.message });
            }
          })
        );
      })
      .catch(() => {});
    return this._gossipQueue;
  }

  /** Inbound message from a peer. */
  async handleBroadcast(msg) {
    this.stats.received += 1;
    if (msg.type === MessageType.Tx) {
      try {
        await this.chain.pool.add(msg.raw, { source: 'peer', gossip: false });
      } catch (err) {
        this.stats.rejected += 1;
        log.debug('peer tx rejected', { err: err.message });
      }
      return { ok: true };
    }
    try {
      await this.consensus?.handleMessage(msg, { from: 'peer' });
      return { ok: true };
    } catch (err) {
      this.stats.rejected += 1;
      return { ok: false, reason: err.message };
    }
  }

  // -------------------------------------------------------------- client

  async call(url, method, path, body) {
    const key = `${url}${path}${body ? JSON.stringify(body).slice(0, 40) : ''}`;
    if (this.inflight.has(key)) return null;
    this.inflight.add(key);
    try {
      const res = await fetch(new URL(path, url), {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(method === 'GET' ? 5000 : 2500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}${path}`);
      const ct = res.headers.get('content-type') ?? '';
      return ct.includes('json') ? await res.json() : await res.text();
    } finally {
      this.inflight.delete(key);
    }
  }

  statusPayload() {
    return {
      nodeId: this.nodeId,
      moniker: this.moniker,
      chainId: String(this.chain.chainId),
      height: this.chain.head.height,
      blockHash: this.chain.head.hash,
      appHash: this.chain.appHash,
      genesisHash: this.chain.genesisHash,
      peers: this.knownPeers(),
      syncing: this.syncing,
      address: `http://127.0.0.1:${this.port}`,
    };
  }
}

function normalizeUrl(u) {
  const s = String(u).trim().replace(/\/$/, '');
  return s.startsWith('http') ? s : `http://${s}`;
}

module.exports = { P2P, normalizeUrl };
