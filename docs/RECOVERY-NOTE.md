'use strict';
/**
 * Recovery is implemented on Chain (`_recover`) rather than in a separate
 * module; this file documents the invariant it relies on and is imported by
 * nothing. Kept in the tree so the reasoning lives next to the code.
 *
 * A Lidex node does not persist the state trie. On restart it rebuilds the
 * state by replaying blocks.jsonl from genesis through the *same* execution
 * path used for live blocks, and compares every recomputed state root and
 * application hash with what the block headers claim. Consequences:
 *
 *  - malformed JSON, including a torn trailing write, is a hard recovery
 *    failure. The block and receipt logs are never truncated, rewritten, or
 *    partially accepted by recovery;
 *  - a node whose build differs from the network's rule set stops at the first
 *    mismatch instead of serving wrong data. Preserve the original data and
 *    diagnose only a separate copy; never delete or reset files to bypass a
 *    mismatch;
 *  - replay cost is linear in chain length, which is acceptable for test
 *    networks. A future production snapshot must carry a verifiable state
 *    root. Snapshot failure is also fail-closed and must not trigger mutation
 *    of the original logs.
 */
module.exports = {};
