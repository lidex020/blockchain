'use strict';
/**
 * Recovery is implemented on Chain (`_recover`) rather than in a separate
 * module; this file documents the invariant it relies on and is imported by
 * nothing. Kept in the tree so the reasoning lives next to the code.
 *
 * A Full Stop node does not persist the state trie. On restart it rebuilds the
 * state by replaying blocks.jsonl from genesis through the *same* execution
 * path used for live blocks, and compares every recomputed state root and
 * application hash with what the block headers claim. Consequences:
 *
 *  - a truncated or torn write at the tail of the log is detected and dropped,
 *    not silently trusted;
 *  - a node whose build differs from the network's rule set stops at the first
 *    mismatch instead of serving wrong data;
 *  - replay cost is linear in chain length, which is acceptable for test
 *    networks. A production deployment adds state snapshots; the snapshot must
 *    carry the state root so it can be verified the same way, and the node must
 *    fall back to replay when verification fails.
 */
module.exports = {};
