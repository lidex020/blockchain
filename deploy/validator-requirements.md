# LIDEX Mainnet Validator Requirements

## Overview

LIDEX Mainnet requires independently operated validator nodes. Each validator:
- Runs CometBFT v0.39.4 (consensus + P2P + block production)
- Runs the LIDEX ABCI++ application (EVM execution + journal)
- Holds a validator operator EVM identity (preserved from existing records)
- Holds CometBFT consensus keys (generated independently, offline)
- Has voting power proportional to bonded LDX stake

## Validator specification (per validator)

| Field | Description | Source |
|-------|-------------|--------|
| Operator EVM address | Existing LIDEX validator operator identity | You (preserved records) |
| Consensus public key | CometBFT pubkey from `priv_validator_key.json` | Validator generates offline |
| Node ID | CometBFT node ID from `node_key.json` | Validator generates offline |
| Public IP | Reachable IPv4 address for P2P | You / validator operator |
| Voting power | Bonded LDX stake × power ratio | You / genesis allocation |
| Commission bps | Validator commission rate | You (default 1000 = 10%) |
| Moniker | Human-readable validator name | You |

## Server specifications (per validator node)

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 8 GB | 16+ GB |
| Storage | 100 GB NVMe SSD | 500+ GB NVMe SSD |
| Network | 1 Gbps | 10 Gbps |
| OS | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |

## Ports per validator (private, never public)

| Port | Purpose |
|------|---------|
| 26656 | CometBFT P2P (validator-to-validator) |
| 26657 | CometBFT RPC (local only) |
| 26658 | CometBFT ABCI socket (to LIDEX app) |
| 7301 | LIDEX ABCI RPC (local only, Mainnet) |

## Public ports (via nginx, 443 TLS only)

| Domain | Service |
|--------|---------|
| rpc.lidex.tech | JSON-RPC |
| ws.lidex.tech | WebSocket |
| api.lidex.tech | REST API |
| explorer.lidex.tech | Explorer |

## Validator set format (validator-map.json)

Schema: `lidex-comet-validator-map-v1`

```json
{
  "schema": "lidex-comet-validator-map-v1",
  "network": "mainnet",
  "validators": [
    {
      "operator_address": "0x...",
      "consensus_address": "0x...",
      "consensus_pubkey": "...",
      "node_id": "...",
      "moniker": "...",
      "self_stake": "50000000000000000000000",
      "commission_bps": "1000",
      "public_ip": "1.2.3.4",
      "website": "..."
    }
  ]
}
```

## Key generation (validator performs offline)

```bash
# On each validator's secure offline machine
cometbft init --home /tmp/cometbft-offline
# This generates:
#   config/priv_validator_key.json  -> keep secret, 0600
#   config/node_key.json             -> keep secret, 0600
# Extract:
#   priv_validator_key.json -> consensus public key
#   node_key.json           -> node ID
```

Never copy `priv_validator_key.json` or `node_key.json` between machines or over the network. Transfer only public keys and node IDs to the genesis ceremony coordinator.

## Testnet vs Mainnet separation

| Item | Testnet | Mainnet |
|------|---------|---------|
| Chain ID | Approved testnet ID | Approved mainnet ID |
| Genesis file | `/srv/lidex/testnet/genesis.json` | `/srv/lidex/mainnet/genesis.json` |
| Validator map | `/srv/lidex/testnet/validator-map.json` | `/srv/lidex/mainnet/validator-map.json` |
| CometBFT home | `/srv/lidex/testnet/cometbft` | `/srv/lidex/mainnet/cometbft` |
| ABCI datadir | `/srv/lidex/testnet/abci` | `/srv/lidex/mainnet/abci` |
| RPC port | 7302 | 7301 |
| Gateway port | 8080 | 8081 |
| Faucet | Enabled (test funds only) | Disabled |

## Pre-launch verification checklist

Before Mainnet activation (requires your explicit authorization):

- [ ] All validator keys generated offline, never shared
- [ ] Validator operator EVM addresses match existing records
- [ ] Consensus public keys mapped to operator addresses in validator-map.json
- [ ] Genesis file verified and hash recorded
- [ ] CometBFT v0.39.4 built and smoke-tested on each validator
- [ ] Testnet running stably with same software stack
- [ ] Block production verified on Testnet
- [ ] Transaction finality verified on Testnet
- [ ] Validator communication (P2P) verified on Testnet
- [ ] Node recovery tested on Testnet
- [ ] Firewall rules enforced (consensus ports private)
- [ ] TLS certificates issued for all Mainnet domains
- [ ] DNS records resolve to Mainnet server IPs
- [ ] Nginx enablement maps ready to flip (currently 0/503)
