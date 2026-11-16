# LIDEX Dual-Network Testnet Plan

**Project**: LIDEX Blockchain (`lidex-blockchain`)
**Status**: Plan only; no implementation or deployment has been performed.

## Technical Framework

- **Language/runtime**: JavaScript, Node.js >= 20, CommonJS
- **Build/package tooling**: npm
- **Node framework**: Express 5
- **Browser wallet/network integration**: static web UI, Reown AppKit, ethers 6
- **Chain model**: EVM-compatible Layer 1 with custom FSC consensus

## Overview

Prepare LIDEX for an independently configured, isolated testnet and a permanent
site network selector while preserving existing chain state, key material,
branding, and unrelated worktree changes. Establish testnet-only deployment and
operations artifacts, network-boundary testing, and explicit fail-closed
controls around any future mainnet path.

Mainnet is not part of this implementation scope. The assessment identified a
consensus-safety blocker: FSC lacks lock/lock-round safety and may fork at a
round boundary. This plan does not claim production consensus safety and does
not authorize mainnet startup, validator setup, genesis creation, or deployment.

## Assessment Findings in Scope

- The existing startup guard rejects the `mainnet` genesis label. Preserve this
  fail-closed behavior; do not remove or bypass it.
- The site currently consumes one `/network.json` and one AppKit network, and
  has no explicit confirmation before mainnet transactions.
- Static hosting makes same-origin network configuration and API origins an
  explicit deployment concern.
- Devnet scripts include destructive `--reset` behavior and plaintext test-key
  generation. Existing state and key material must not be overwritten; planned
  validation must use isolated temporary test data.
- No Docker/deployment infrastructure exists. RPC currently has permissive
  CORS and listens on `0.0.0.0`.
- The working tree contains extensive pre-existing changes, including branding,
  consensus, genesis, node, UI, and unrelated documentation/artifact changes.
  Keep the plan and any later implementation scoped; do not revert or normalize
  unrelated changes.

## Scope and Safety Boundaries

1. Make testnet identity/configuration and chain-state storage independent from
   any reserved mainnet namespace. Do not create mainnet genesis allocations,
   validator keys, credentials, or an active mainnet profile.
2. Provide a persistent site network selector. Mainnet selection must remain
   non-operational until a separate human authorization and readiness decision;
   any future mainnet transaction path must require an explicit confirmation.
3. Prepare and validate security, container, testnet deployment, and operations
   artifacts. Do not provision resources, deploy, or enable mainnet startup.
4. Preserve all pre-existing worktree edits, branding, chain data, and key
   material. Tests must use disposable fixtures/temporary paths and must not
   invoke destructive reset against existing data.

## Phased Outcomes

| Phase | Outcome |
|---|---|
| Network foundation | Testnet configuration and state are isolated; mainnet remains fail-closed. |
| Website behavior | The site selector is permanent; transactions are clearly network-bound and mainnet remains blocked pending authorization. |
| Verification and security | Automated tests prove network separation and guard behavior; public RPC exposure is constrained for testnet. |
| Testnet packaging | Docker and deployment instructions support a reproducible testnet package without deploying it. |
| Operations/readiness | Testnet runbooks and a mainnet blocker/evidence checklist exist without asserting consensus readiness. |

## Validation Expectations

- Build and existing tests pass after scoped changes; add tests for config/state
  isolation, site network selection, wallet chain mismatch, mainnet transaction
  blocking/confirmation behavior, RPC exposure settings, and container startup.
- Exercise reset, genesis, and storage behavior only in temporary test
  directories. Verify pre-existing chain state and key material remain unchanged.
- Test deployment artifacts locally or in an isolated test environment only.
  Do not deploy from this plan.
- Record the consensus-safety finding as a release blocker. A passing build,
  UI confirmation, or testnet deployment is not evidence that LIDEX is safe for
  mainnet.

## Explicitly Out of Scope

- Mainnet genesis allocations or genesis file generation; mainnet validator
  keys, credentials, or secret creation; mainnet startup or deployment.
- Removing the existing mainnet startup guard or treating a UI confirmation as
  sufficient mainnet authorization.
- Repairing or certifying the FSC consensus protocol, selecting governance or
  validator policy, or making production-safety claims.
- Any actual testnet deployment, cloud provisioning, destructive state reset,
  key rotation, or cleanup of existing project files.
- Reverting, restaging, or otherwise modifying unrelated pre-existing changes.

## Open Questions & Questionnaire

- [ ] Choose and review the testnet chain identifier and public RPC/site
  endpoints before producing environment-specific deployment configuration.
- [ ] Decide the testnet hosting/registry target and who owns deployment and
  rollback approvals. This plan does not assume a cloud provider.
- [ ] Define consensus protocol changes, formal safety evidence, validator
  membership/governance, and independent review needed to clear the mainnet
  consensus blocker.
- [ ] Any future mainnet work requires a separate explicit authorization and
  human decisions for genesis, chain identity, validator operations, secrets,
  and transaction signing. None are generated or enabled by this plan.
