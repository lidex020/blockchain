# LIDEX public Testnet monitoring and health checks

## Health check endpoints

| Service | Endpoint | Method | Expected |
|---------|----------|--------|----------|
| ABCI RPC | `http://127.0.0.1:7302/health` | GET | HTTP 200, JSON `{ok:true,height:N,...}` |
| Gateway | `http://127.0.0.1:8080/health` | GET | HTTP 200 |
| Gateway | `http://127.0.0.1:8080/network.json` | GET | HTTP 200, genesis network descriptor |
| Gateway | `http://127.0.0.1:8080/` | POST (JSON-RPC `net_version`) | HTTP 200, JSON-RPC response |
| Nginx public | `https://rpc-testnet.lidex.tech/` | POST | HTTP 200 (after enablement) |
| Nginx public | `https://ws-testnet.lidex.tech/ws` | WS upgrade | HTTP 101 (after enablement) |
| Nginx public | `https://api-testnet.lidex.tech/health` | GET | HTTP 200 (after enablement) |
| Nginx public | `https://explorer-testnet.lidex.tech/` | GET | HTTP 200 (after enablement) |

Run: `deploy/scripts/testnet-health-check.sh`

## Metrics

The ABCI RPC exposes Prometheus-compatible metrics at `http://127.0.0.1:7302/metrics`:
- `lidex_height` — current chain height
- `lidex_peer_count` — connected peers (0 in ABCI-only mode; CometBFT reports its own)
- `lidex_validators` — active validator count
- `lidex_mempool_size` — transactions in local mempool
- `lidex_rpc_requests_total` / `lidex_rpc_errors_total` — RPC traffic
- `lidex_blocks_applied_total` — committed blocks via ABCI
- `lidex_supply_issued_wei` / `lidex_supply_burned_wei` / `lidex_supply_max_wei` — LDX supply
- `lidex_power` — total consensus power

CometBFT exposes its own metrics on its RPC port (26657, loopback only).

## Logs

- CometBFT: `journalctl -u lidex-cometbft-testnet.service`
- ABCI app: `journalctl -u lidex-abci-testnet.service`
- Gateway: `journalctl -u lidex-gateway-testnet.service`
- Nginx: `/var/log/nginx/error.log`, `/var/log/nginx/access.log`

## Alerting thresholds (operator-defined)

Suggested initial thresholds:
- Chain height not increasing for > 2 × block_time_ms → alert
- RPC error rate > 5% over 5 minutes → alert
- Mempool size > 80% of max_block_txs → alert
- Any service not active → alert

## Block production verification

Verify blocks are being produced:
```
curl -s -X POST http://127.0.0.1:7302/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```
The `result` hex value should increase over time.

## Transaction acceptance verification

Submit a signed EVM transaction via the public gateway and confirm inclusion:
```
curl -s -X POST https://rpc-testnet.lidex.tech/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x..."]}'
```
