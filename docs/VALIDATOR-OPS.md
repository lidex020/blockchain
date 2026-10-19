# Validator Operations and Mainnet Release Gates

## Current status

**Mainnet is not ready. Do not launch a network with value.** The current node
uses the custom `src/consensus.js` engine, which explicitly lacks lock/lock-round
safety. Startup rejects a genesis marked `mainnet`; do not remove or bypass that
guard. CometBFT/ABCI++ is not yet wired to FullStop execution and persistence.

The development bootstrap (`scripts/init-devnet.js`) writes test keys in
plaintext. Those keys and the existing devnet genesis are not production
credentials or a production genesis.

## Key custody

Keep these key roles separate:

| Key role | Current handling | Production requirement |
|---|---|---|
| Consensus signing key | Used by the custom consensus implementation; current key loading accepts private key material in a JSON file | CometBFT validator key must be held by an isolated remote signer or HSM; the FullStop application must never receive or log the private key |
| Operator / staking identity | Loaded through `src/keys.js` and used by application features | Define a separate custody and recovery policy; do not reuse the consensus key |
| User transaction keys | Wallet/user responsibility | Never collect or persist user private keys in the validator process |

Before production:

1. Provision consensus keys independently for every validator. Never generate
   them from the devnet seed, copy a devnet key, or place them in source control,
   a shared genesis file, backups accessible to application hosts, or CI logs.
2. Configure CometBFT remote signing only after the CometBFT integration has
   been implemented and tested. Bind signer traffic to a private, access-
   controlled network; allow only the matching validator host; monitor signer
   availability and rejected/double-sign requests.
3. Use distinct operator identities and documented access controls. The
   existing plaintext key-file implementation is not an approved production
   custody solution.
4. Document key backup, signer replacement, validator rotation, compromise
   response, and recovery drills. A consensus key must not be restored to two
   concurrently signing hosts.
5. Confirm every validator's public key and derived address through an
   independent ceremony record before including it in genesis. Publish public
   keys only; never publish private material.

## Production genesis ceremony

Production genesis requires explicit human approval; do not infer tokenomics,
allocations, validator identities, or voting power from devnet settings.

1. Select and independently verify a new chain ID and network name. Do not reuse
   devnet chain history, keys, or state.
2. Agree on the initial validator set, consensus public keys, voting power,
   operator addresses, self-bonds, and recovery contacts.
3. Approve all initial issuance, allocations, vesting, protocol parameters,
   system-contract addresses, and contract artifact hashes.
4. Generate the genesis using a reviewed production-only process that does not
   generate or write private keys. Validate it with the exact release binary.
5. Each validator independently checks the genesis hash, chain ID, validator
   set, allocations, and deployed system-contract hashes. Require signed
   approvals from the participating validators before startup.
6. Start from empty data directories. Do not copy `data/devnet`, reuse its
   accounts, or attempt to migrate the custom-consensus chain history.

`scripts/init-devnet.js` is a development bootstrap, not a production genesis
ceremony. It writes test keys and must not be used to create a network with
value.

## Operations and recovery

Production deployment remains blocked until the CometBFT application lifecycle
has end-to-end tests for `InitChain`, transaction admission, proposal
preparation and validation, deterministic block execution, validator updates,
`FinalizeBlock`, durable `Commit`, restart, and state synchronization.

The existing recovery path replays blocks from genesis and is linear in chain
length. Before production, implement and verify state snapshots or state sync
with application-hash verification and a tested fallback to replay.

Before any launch, operators need reviewed procedures for:

- independent monitoring of consensus height, peer connectivity, signing
  latency, application hash, disk capacity, and RPC health;
- alert escalation, incident command, validator isolation, and safe restart;
- software upgrades with pinned binaries, release checksums, staged rollout,
  rollback criteria, and coordinated activation;
- database backup, restore, snapshot verification, and recovery from a
  corrupted or unavailable peer;
- firewall policy, RPC exposure, DDoS response, secrets access, and audit-log
  retention.

## Mandatory release gates

Do not enable mainnet startup until every item has reviewed evidence:

- CometBFT owns consensus and P2P; FullStop execution is connected through a
  deterministic ABCI++ application, with no fallback to the custom engine.
- Remote signer/HSM custody has passed key-isolation, failure, restart, and
  double-sign prevention tests.
- Multi-validator adversarial tests cover conflicting proposals, delayed and
  reordered messages, Byzantine voting power, validator-set changes, process
  restarts, and application-hash convergence.
- Fresh-genesis, commit/replay, snapshot/state-sync, and recovery tests pass on
  the release binary.
- The final production genesis and all allocations are approved by the
  validators and governance owners.
- Operations runbooks and monitoring are exercised in a production-like
  environment.
- Independent security and consensus reviews are complete, findings are
  resolved or explicitly accepted by accountable owners, and release artifacts
  are reproducible.
