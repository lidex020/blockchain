#!/usr/bin/env bash
#
# LIDEX public Testnet deployment script.
#
# Starts CometBFT, the ABCI++ application, the public API gateway, and
# enables nginx. Requires testnet-init.sh to have been run first.
#
# Non-destructive for existing data directories (ABCI datadir marker guards
# against overwrite/adoption).
#
# Example:
#   sudo ./deploy/scripts/testnet-deploy.sh
set -euo pipefail

BASEDIR="/srv/lidex/testnet"
COMET_HOME="$BASEDIR/cometbft"
ABCI_DATADIR="$BASEDIR/abci"
GENESIS="$BASEDIR/genesis.json"
VALIDATOR_MAP="$BASEDIR/validator-map.json"

echo "==> LIDEX public Testnet deployment"

# Verify prerequisites.
for f in "$GENESIS" "$VALIDATOR_MAP"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: Missing required file: $f (run testnet-init.sh first)." >&2
    exit 2
  fi
done

if ! command -v cometbft >/dev/null 2>&1; then
  echo "ERROR: 'cometbft' binary not found on PATH. Install CometBFT first." >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' not found on PATH. Install Node.js >= 20 first." >&2
  exit 2
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "WARNING: 'nginx' not found. Install nginx before enabling public endpoints."
fi

# Copy service units into place.
install -m 0644 deploy/systemd/lidex-cometbft-testnet.service /etc/systemd/system/
install -m 0644 deploy/systemd/lidex-abci-testnet.service /etc/systemd/system/
install -m 0644 deploy/systemd/lidex-gateway-testnet.service /etc/systemd/system/

# Install nginx config if present.
if [[ -f deploy/nginx/lidex-testnet.conf ]] && command -v nginx >/dev/null 2>&1; then
  install -m 0644 deploy/nginx/lidex-testnet.conf /etc/nginx/conf.d/lidex-testnet.conf
  echo "==> Nginx config installed (enablement maps default to 0 / 503)."
fi

systemctl daemon-reload

echo "==> Starting CometBFT consensus node..."
systemctl enable --now lidex-cometbft-testnet.service
sleep 3
if ! systemctl is-active --quiet lidex-cometbft-testnet.service; then
  echo "ERROR: CometBFT failed to start. Check journalctl -u lidex-cometbft-testnet.service" >&2
  exit 2
fi
echo "    CometBFT active."

echo "==> Starting LIDEX ABCI++ application..."
systemctl enable --now lidex-abci-testnet.service
sleep 3
if ! systemctl is-active --quiet lidex-abci-testnet.service; then
  echo "ERROR: ABCI app failed to start. Check journalctl -u lidex-abci-testnet.service" >&2
  exit 2
fi
echo "    ABCI app active on 127.0.0.1:7302."

echo "==> Starting public API gateway..."
systemctl enable --now lidex-gateway-testnet.service
sleep 3
if ! systemctl is-active --quiet lidex-gateway-testnet.service; then
  echo "ERROR: Gateway failed to start. Check journalctl -u lidex-gateway-testnet.service" >&2
  exit 2
fi
echo "    Gateway active on 127.0.0.1:8080."

echo "==> Deployment complete. Services:"
systemctl is-active lidex-cometbft-testnet.service
systemctl is-active lidex-abci-testnet.service
systemctl is-active lidex-gateway-testnet.service

echo ""
echo "==> To enable public endpoints, flip nginx enablement maps in"
echo "    /etc/nginx/conf.d/lidex-testnet.conf from 0 to 1, then:"
echo "        nginx -t && systemctl reload nginx"
echo "==> Verify live endpoints with deploy/scripts/testnet-health-check.sh"
