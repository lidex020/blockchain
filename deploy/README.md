# LIDEX deployment — Testnet and Mainnet preparation

## Authorization status

| Network | Status |
|---------|--------|
| Testnet | Prepared, not activated (awaiting your chain ID + genesis artifacts) |
| Mainnet | **Prepared only, NOT activated** (requires your explicit authorization) |

Nothing here initializes or activates Mainnet. Mainnet activation is under your explicit authorization only.

## Service architecture (per network, all backends loopback only)

```
Public internet (443 TLS)
        |
    Nginx (reverse proxy)
        |
    127.0.0.1:808x  Public API gateway (gateway.js)
        |
    127.0.0.1:730x  LIDEX ABCI++ RPC (serve.js)
        |
    127.0.0.1:26658 ABCI socket <-> CometBFT (node)
        |
    127.0.0.1:26657 CometBFT RPC
    127.0.0.1:26656 CometBFT P2P
```

## Port assignments

| Service | Testnet | Mainnet |
|---------|---------|---------|
| CometBFT P2P | 26656 | 26656 |
| CometBFT RPC | 26657 | 26657 |
| ABCI socket | 26658 | 26658 |
| LIDEX ABCI RPC | 7302 | 7301 |
| Public gateway | 8080 | 8081 |

## Deployment artifacts

| File | Purpose |
|------|---------|
| `deploy/scripts/testnet-init.sh` | Testnet directory setup + validation |
| `deploy/scripts/testnet-deploy.sh` | Start Testnet services |
| `deploy/scripts/mainnet-init.sh` | Mainnet directory setup + validation |
| `deploy/scripts/mainnet-deploy.sh` | Start Mainnet services |
| `deploy/systemd/*-testnet.service` | Testnet systemd units |
| `deploy/systemd/*-mainnet.service` | Mainnet systemd units |
| `deploy/nginx/lidex-testnet.conf` | Testnet nginx config |
| `deploy/nginx/lidex-mainnet.conf` | Mainnet nginx config |
| `deploy/validator-requirements.md` | Validator specification |
| `deploy/monitoring.md` | Health checks and metrics |
| `deploy/dns-tls.md` | DNS and TLS requirements |
| `deploy/firewall.md` | Firewall rules |
| `deploy/cometbft-setup.md` | CometBFT v0.39.4 build |

## Release gates (Mainnet)

Before Mainnet public endpoints are enabled:

1. Approved Mainnet chain ID supplied
2. Offline genesis ceremony complete (genesis.json + validator-map.json)
3. Validator operator EVM addresses verified against existing records
4. CometBFT v0.39.4 built and smoke-tested on each validator
5. Testnet running stably with identical software
6. Block production, transaction finality, validator communication verified
7. TLS certificates issued for lidex.tech subdomains
8. DNS records resolve to Mainnet server IPs
9. Nginx enablement maps flipped from 0 to 1 (your authorization)
10. `nginx -t && systemctl reload nginx`

## Code verification

- `npm run build`: exit 0 (ABCI syntax checks)
- `npm test`: 37/37 passed

## What requires your action

1. Approve Mainnet chain ID (not 721220, not 72122 unless explicitly approved)
2. Provide validator operator EVM addresses
3. Provide CometBFT consensus public keys (generated offline by validators)
4. Provide genesis file from ceremony
5. Authorize Mainnet activation when ready
