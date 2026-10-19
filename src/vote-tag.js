'use strict';
/**
 * The canonical signable form of a consensus message.
 *
 * It lives in its own module because both the vote/block layer and the staking
 * module need it, and the staking module must be able to *recompute* the digest
 * a vote signed - never trust a digest a submitter hands over, or evidence could
 * be forged with a matching-but-wrong digest.
 */
const { hashObject } = require('./crypto.js');

function voteTag({ type, chainId, height, round, blockHash }) {
  return hashObject({
    type,
    chainId: String(chainId),
    height: Number(height),
    round: Number(round),
    blockHash,
  });
}

module.exports = { voteTag };
