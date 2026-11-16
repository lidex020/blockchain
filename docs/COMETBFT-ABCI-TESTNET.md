# LIDEX CometBFT ABCI++ devnet fixture slice

## Status and scope

This is a devnet/testnet-only ABCI++ adapter around the existing EthereumJS
execution engine. It exposes the CometBFT v0.39.4 length-delimited protobuf
ABCI socket protocol and has local socket tests for `Info`, `InitChain`,
`CheckTx`, proposal processing, `FinalizeBlock`, `Commit`, and journal replay.
It is a bounded integration slice, **not** a production CometBFT deployment or
a completed LIDEX consensus migration:

- The existing Node startup, RPC, wallet, explorer, and custom-consensus paths
  have not been switched to CometBFT.
- Existing block persistence/indexes are not migrated to CometBFT. The ABCI
  journal belongs in a new, dedicated data directory and replays its own
  committed transactions.
- CometBFT snapshot/state sync and LIDEX-to-Comet evidence/misbehavior mapping
  are not implemented. Unsupported evidence is rejected.
- A CometBFT binary is included in the pinned development image, but an
  interoperability run against that binary has not been verified in this
  environment. Local tests exercise the real protobuf socket transport using
  a test client.
- Mainnet is rejected by the ABCI bootstrap and is not activated or deployed.
  No Mainnet validator records, identities, credentials, balances, supply,
  allocations, or state are changed by this slice.

Do not point the adapter at an existing LIDEX or CometBFT data directory. It
will only initialize a new empty directory or reopen one carrying a matching
LIDEX ABCI marker; it never resets or adopts unmarked contents.

## Pinned development environment

`.devcontainer/Dockerfile` pins the amd64 Go and Node base images by digest,
builds the official CometBFT `v0.39.4` command, and installs official `protoc`
29.5 only after checking the release archive's SHA-256. Go 1.25.0 is selected
because the CometBFT v0.39.4 module declares that version. The Docker build
checks the resolved Go, Node, protoc, and CometBFT versions and checks for
`make`, `gcc`, `g++`, and `git`.

Build/open the `.devcontainer` with a Docker-compatible development-container
runtime. In the container, from the repository directory:

```sh
npm ci
npm run build
npm test
```

The host used to author this slice did not have Docker/Podman, Go, protoc, or
CometBFT available, so the image build and CometBFT-binary interoperability
test remain unverified. Do not treat the pinned image declaration as proof
that the environment has been built or that Mainnet is ready.

## Disposable network bootstrap

Prerequisites:

1. Use a disposable devnet/testnet genesis and a **new empty** ABCI data
   directory. Do not reuse the existing node, wallet, or chain data directory.
2. Provide an explicit public-only validator mapping file with schema
   `lidex-comet-validator-map-v1`. Every active LIDEX validator must have a
   verified mapping; mapping validation checks the Comet address derived from
   the supplied public key and derives voting power from the LIDEX active set.
3. Use only disposable test fixtures or independently verified testnet
   enrollment records. Never infer a Comet public key from an EVM address.
   Never place a private key, seed, credential, or secret in the mapping file.
   The loader rejects secret-like field names.

Mapping file shape (public fields only; populate values from verified test
records, not from this illustrative template):

```json
{
  "schema": "lidex-comet-validator-map-v1",
  "validators": [
    {
      "operator": "0x<existing-operator-EVM-address>",
      "consensusAddress": "0x<existing-LIDEX-consensus-address>",
      "keyType": "secp256k1",
      "publicKey": "0x<compressed-CometBFT-public-key>",
      "cometAddress": "<CometBFT-address-hex>"
    }
  ]
}
```

For an independently provisioned testnet, start with explicit dedicated paths
and its verified testnet genesis and public mapping:

```sh
npm run abci:testnet -- \
  --genesis /absolute/path/to/testnet/genesis.json \
  --validator-map /absolute/path/to/testnet-public-validator-map.json \
  --datadir /absolute/path/to/new-empty-lidex-abci-data \
  --listen tcp://127.0.0.1:26658
```

The available fixture under `data/testnet` currently declares `network:
"devnet"`; no testnet genesis is present in this workspace. The checked-in
profile `profiles/cometbft.devnet.json` accurately pins that devnet genesis,
the public validator mapping, dedicated ABCI data directory, and local socket
address. The mapping is public-only and was derived from the existing
disposable fixture keys. Rebuild or verify that file with:

```sh
npm run abci:devnet:map
```

The exporter verifies the fixture operator and LIDEX consensus identities. It
only writes public keys and addresses, refuses to replace a different existing
mapping, and never prints or serializes private-key material. The profile can
then be used directly:

```sh
npm run abci:devnet
```

Command-line `--genesis`, `--validator-map`, `--datadir`, and `--listen`
options override profile values; environment `LIDEX_ABCI_LISTEN` overrides
the profile socket address. This profile requires a devnet genesis and cannot
be used to bypass the Mainnet startup guard. A future testnet deployment must
provide an independently verified testnet genesis and mapping, then use an
explicit testnet profile; this workspace does not claim that a testnet has
been bootstrapped.

The wrapper starts the LIDEX ABCI socket application only. It does not create
or start a CometBFT node, rewrite CometBFT genesis, or change the ordinary
LIDEX `start`/`devnet` consensus selection.

The ABCI TCP transport is unauthenticated and therefore accepts only
`127.0.0.1` or `::1` bind addresses. Do not expose it through a public
interface, reverse proxy, or port-forward. Treat access by other local
processes as trusted; run the app and CometBFT under an appropriately isolated
OS account/container.

## Mainnet enrollment and coordinated migration procedure

This is an operator procedure for a future, separately approved migration.
It is not a transition authorization or a claim that the current adapter can
run Mainnet.

1. **Freeze and inventory.** Take independently verified, read-only snapshots
   of the canonical Mainnet genesis, validator set, balances, supply,
   allocations, chain state, and operator identity records. Keep originals
   immutable and record hashes. No one edits or regenerates Mainnet state as
   part of enrollment.
2. **Enroll each operator.** The operator supplies a CometBFT consensus
   public key from an authenticated key-management process. Extract only its
   public portion on the operator's secure host. Do not export, email, paste,
   log, upload, or commit private keys or seeds. Record the key type, public
   key, and Comet address alongside (not in place of) the operator's existing
   EVM address and existing LIDEX consensus address.
3. **Verify identity and key ownership.** Verify the association through the
   existing authoritative chain/genesis records and a separately authenticated
   operator enrollment/signature ceremony. Independently recompute the Comet
   address from the supplied public key and compare it with the operator's
   proof of control. An EVM address is not evidence of a Comet public key.
   If any record, key ownership, or association is unavailable or ambiguous,
   mark that validator unmapped and stop; never guess or silently substitute.
4. **Reconcile validator power.** At the explicitly approved finalized
   transition height, compare every active LIDEX validator and its voting
   power with the verified mapping. Require a one-to-one mapping for the
   complete active set, no duplicate Comet addresses, and documented
   handling for inactive/jailed validators. Preserve all operator EVM
   addresses and all account/state data. Any mismatch blocks the transition.
5. **Publish a reviewable mapping manifest.** Store only public mapping
   material in the controlled change record. Have independent operators
   verify key/address recomputation, validator membership, voting power,
   genesis/state hashes, and the complete diff against the frozen baseline.
   Never place Mainnet credentials or private keys in the manifest.
6. **Approve a coordinated cutover separately.** Require explicit governance
   and operator approval for a maintenance window, final height, state/genesis
   conversion, CometBFT configuration, binary versions, RPC/API rollout,
   monitoring, and abort/rollback criteria. Dry-run the exact procedure on a
   faithful isolated copy and reconcile state/root and all validator records.
   Do not announce or perform the Mainnet transition until all evidence and
   independent sign-offs are complete.
7. **Execute only under that approval.** Coordinate a halt at the approved
   height, verify final snapshots and hashes, apply the reviewed migration,
   verify validator identities/powers and state before opening the network,
   then resume with monitored operator agreement. If any check differs, keep
   Mainnet halted and follow the approved recovery plan; do not improvise,
   reset, or replace records.

The current implementation cannot perform steps 1, 4–7: it has no verified
Mainnet key-mapping source, state/index migration, snapshot transfer, or
production rollout path. Those are explicit blockers for a future authorized
Mainnet migration.
