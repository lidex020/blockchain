#!/usr/bin/env bash
#
# LIDEX public Testnet live health check.
#
# Verifies all Testnet endpoints against actual running services.
# Reports PASS/FAIL per endpoint. Does not fabricate results.
#
# Example:
#   sudo ./deploy/scripts/testnet-health-check.sh
set -euo pipefail

PASS=0
FAIL=0

check_http() {
  local name="$1" url="$2" expected_status="${3:-200}" method="${4:-GET}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
    --max-time 10 --connect-timeout 5 "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "$expected_status" ]]; then
    echo "PASS $name ($method $url) -> HTTP $code"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name ($method $url) -> HTTP $code (expected $expected_status)"
    FAIL=$((FAIL + 1))
  fi
}

check_json_rpc() {
  local name="$1" url="$2"
  local body
  body=$(curl -s --max-time 10 --connect-timeout 5 \
    -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"net_version","params":[]}' "$url" 2>/dev/null || echo "{}")
  if echo "$body" | grep -q '"jsonrpc"'; then
    echo "PASS $name (JSON-RPC net_version responded)"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name (JSON-RPC did not respond)"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> LIDEX public Testnet health check"
echo ""

# Local backend services (loopback).
echo "-- Backend services (loopback) --"
check_http "ABCI RPC /health" "http://127.0.0.1:7302/health"
check_http "Gateway /health" "http://127.0.0.1:8080/health"
check_http "Gateway /network.json" "http://127.0.0.1:8080/network.json"
check_json_rpc "Gateway JSON-RPC" "http://127.0.0.1:8080/"

# Public endpoints via nginx (require DNS + TLS to be operational).
echo ""
echo "-- Public endpoints (via nginx, require DNS/TLS) --"
check_http "rpc-testnet.lidex.tech" "https://rpc-testnet.lidex.tech/" || true
check_http "ws-testnet.lidex.tech (WS)" "https://ws-testnet.lidex.tech/ws" || true
check_http "api-testnet.lidex.tech" "https://api-testnet.lidex.tech/" || true
check_http "explorer-testnet.lidex.tech" "https://explorer-testnet.lidex.tech/" || true

echo ""
echo "==> $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
