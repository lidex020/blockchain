# LIDEX Mainnet Preparation Status

## Authorization status

**Mainnet is NOT activated.** Mainnet activation requires your explicit authorization.
Nothing in this section initializes, starts, or deploys Mainnet services.

## What is prepared (local files, ready to use)

| File | Purpose | Status |
|------|---------|--------|
| `deploy/scripts/mainnet-init.sh` | Directory setup + input validation | Ready |
| `deploy/scripts/mainnet-deploy.sh` | Start Mainnet services | Ready (not run) |
| `deploy/systemd/lidex-cometbft-mainnet.service` | CometBFT consensus (Mainnet) | Ready |
| `deploy/systemd/lidex-abci-mainnet.service` | ABCI++ app + RPC (Mainnet) | Ready |
| `deploy/systemd/lidex-gateway-mainnet.service` | Public API gateway (Mainnet) | Ready |
| `deploy/nginx/lidex-mainnet.conf` | Nginx reverse proxy (Mainnet) | Ready |
| `deploy/validator-requirements.md` | Validator specification | Ready |

## What is required from YOU before Mainnet initialization

| Item | Description |
|------|-------------|
| Approved Mainnet chain ID | Distinct from devnet 721220 and mainnet candidate 72122 |
| Validator operator EVM addresses | Existing identities to preserve |
| CometBFT consensus public keys | Generated offline by each validator |
| Voting power / stake per validator | In Lidex (LDX) |
| Validator public IPs | For persistent_peers |
| Genesis file | From offline genesis ceremony |

## What the scripts will NOT do

- Generate validator keys (you do this offline)
- Invent validator identities or voting power
- Activate Mainnet without your authorization
- Fabricate test results

## Mainnet activation procedure (requires your authorization)

1. You provide approved chain ID + genesis artifacts + validator keys
2. Run `mainnet-init.sh` on each validator server
3. Configure CometBFT `persistent_peers` with validator IPs
4. Run `mainnet-deploy.sh` (starts CometBFT + ABCI + gateway)
5. Verify block production, transaction finality, validator communication
6. Flip nginx enablement maps from 0 to 1
7. `nginx -t && systemctl reload nginx`

## Testnet vs Mainnet parity

The same software stack runs on both networks:
- CometBFT v0.39.4 consensus
- LIDEX ABCI++ application
- Public API gateway (fails closed)
- Nginx reverse proxy with TLS

Testnet should be run and verified first as a dress rehearsal for Mainnet.
