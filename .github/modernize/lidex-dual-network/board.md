## User Input

> Execute the plan at `.github/modernize/lidex-dual-network/plan.md` (tasks at `.github/modernize/lidex-dual-network/.metadata/tasks.json`) in workspace `C:\Users\hp\Desktop\lidexblockchain\lidex`, but only tasks safe for testnet deployment. Preserve all existing worktree edits, branding rename, old chain state/key material; do not activate, start, or deploy mainnet; do not generate mainnet genesis allocations, validator keys, or credentials; do not reset data dirs or remove security guards. Do not claim production-ready. Stop and report blocked rather than speculate on custom FSC consensus or governance design/security; its missing lock/lock-round safety and possible round-boundary fork preclude safe production mainnet. No deployment. Before any edit, inspect/report baseline worktree changes. Make only minimal safe changes, validate focused tests, and return exact files touched, commands/results, blockers, and required human governance/security review.

**Project started**: 2026-11-14T18:05:54Z

## Tasks

### Phase: Plan & Environment
- ⏳ t1 [devops] Prepare/verify the existing Node.js >=20 test environment (plan preflight)
- ⏳ t2 [dba] Define non-destructive testnet chain-state and genesis-storage boundaries

### Phase: Testnet Foundation
- ⏳ t3 [backend] Isolate testnet identity and chain state; preserve the mainnet startup guard [plan 001] [deps: t1, t2]

### Phase: Site Network Behavior
- ⏳ t4 [frontend] Add persistent network selector and fail-closed mainnet transaction path [plan 002] [deps: t1, t3]

### Phase: Regression Tests
- ⏳ t5 [tester] Verify network separation, state preservation, selector, and mainnet blocking [plan 003] [deps: t3, t4]

### Phase: Operations Documentation
- ⏳ t6 [devops] Document testnet operations and mainnet readiness blockers [plan 004] [deps: t5]

### Phase: Testnet Security Hardening
- ⏳ t7 [backend] Harden testnet RPC exposure and operational configuration [plan 005] [deps: t3, t4, t5, t6]

### Phase: Testnet Packaging
- ⏳ t8 [devops] Prepare local testnet-only Docker/package artifacts without deployment [plan 006] [deps: t7]

### Phase: Security Review & Smoke Test
- ⏳ t9 [security] Review testnet security boundaries and fail-closed controls [deps: t3, t4, t7, t8]
- ⏳ t10 [architect] Run isolated build/startup smoke verification; never start mainnet [deps: t1, t3, t4, t5, t6, t7, t8]

### Phase: Runtime Validation
- ⏳ t11 [tester] Run focused testnet-only runtime validation with temporary test data [deps: t9, t10]

### Phase: Conformance
- ⏳ t12 [teamlead] Verify plan conformance, evidence, and unresolved blockers [deps: t11]
