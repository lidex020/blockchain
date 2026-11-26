#!/usr/bin/env bash
#
# LIDEX public Testnet rollback script.
#
# Stops services in reverse order and disables public endpoints. Does NOT
# delete data directories, genesis files, or validator keys (non-destructive).
#
# Example:
#   sudo ./deploy/scripts/testnet-rollback.sh
set -euo pipefail

echo "==> LIDEX public Testnet rollback"

echo "==> Disabling public endpoints (nginx maps -> 0)..."
if [[ -f /etc/nginx/conf.d/lidex-testnet.conf ]]; then
  sed -i 's/rpc-testnet\.lidex\.tech 1/rpc-testnet.lidex.tech 0/' /etc/nginx/conf.d/lidex-testnet.conf
  sed -i 's/ws-testnet\.lidex\.tech 1/ws-testnet.lidex.tech 0/' /etc/nginx/conf.d/lidex-testnet.conf
  sed -i 's/api-testnet\.lidex\.tech 1/api-testnet.lidex.tech 0/' /etc/nginx/conf.d/lidex-testnet.conf
  sed -i 's/explorer-testnet\.lidex\.tech 1/explorer-testnet.lidex.tech 0/' /etc/nginx/conf.d/lidex-testnet.conf
  nginx -t && systemctl reload nginx || echo "WARNING: nginx reload failed"
fi

echo "==> Stopping services..."
systemctl stop lidex-gateway-testnet.service 2>/dev/null || true
systemctl stop lidex-abci-testnet.service 2>/dev/null || true
systemctl stop lidex-cometbft-testnet.service 2>/dev/null || true

echo "==> Disabling services..."
systemctl disable lidex-gateway-testnet.service 2>/dev/null || true
systemctl disable lidex-abci-testnet.service 2>/dev/null || true
systemctl disable lidex-cometbft-testnet.service 2>/dev/null || true

echo "==> Rollback complete. Data preserved under /srv/lidex/testnet/."
