#!/usr/bin/env bash
#
# LIDEX public Mainnet deployment script.
#
# ACTIVATES Mainnet services. Requires explicit operator authorization.
# Run only after mainnet-init.sh and after all genesis artifacts are in place.
#
# Example:
#   sudo ./deploy/scripts/mainnet-deploy.sh
set -euo pipefail

BASEDIR="/srv/lidex/mainnet"
COMET_HOME="$BASEDIR/cometbft"
ABCI_DATADIR="$BASEDIR/abci"
GENESIS="$BASEDIR/genesis.json"
VALIDATOR_MAP="$BASEDIR/validator-map.json"

echo "==> LIDEX public Mainnet deployment"
echo "    WARNING: This activates Mainnet services. Ensure you are authorized."

# Verify prerequisites.
for f in "$GENESIS" "$VALIDATOR_MAP"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: Missing required file: $f (run mainnet-init.sh first)." >&2
    exit 2
  fi
done

if ! command -v cometbft >/dev/null 2>&1; then
  echo "ERROR: 'cometbft' binary not found on PATH." >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' not found on PATH." >&2
  exit 2
fi

# Copy service units.
install -m 0644 deploy/systemd/lidex-cometbft-mainnet.service /etc/systemd/system/
install -m 0644 deploy/systemd/lidex-abci-mainnet.service /etc/systemd/system/
install -m 0644 deploy/systemd/lidex-gateway-mainnet.service /etc/systemd/system/

# Install nginx config (enablement maps default to 0 / 503).
if [[ -f deploy/nginx/lidex-mainnet.conf ]] && command -v nginx >/dev/null 2>&1; then
  install -m 0644 deploy/nginx/lidex-mainnet.conf /etc/nginx/conf.d/lidex-mainnet.conf
  echo "==> Nginx config installed (enablement maps default to 0 / 503)."
fi

systemctl daemon-reload

echo "==> Starting CometBFT consensus node (Mainnet)..."
systemctl enable --now lidex-cometbft-mainnet.service
sleep 3
systemctl is-active --quiet lidex-cometbft-mainnet.service || { echo "ERROR: CometBFT failed." >&2; exit 2; }
echo "    CometBFT active."

echo "==> Starting LIDEX ABCI++ application (Mainnet)..."
systemctl enable --now lidex-abci-mainnet.service
sleep 3
systemctl is-active --quiet lidex-abci-mainnet.service || { echo "ERROR: ABCI app failed." >&2; exit 2; }
echo "    ABCI app active on 127.0.0.1:7301."

echo "==> Starting public API gateway (Mainnet)..."
systemctl enable --now lidex-gateway-mainnet.service
sleep 3
systemctl is-active --quiet lidex-gateway-mainnet.service || { echo "ERROR: Gateway failed." >&2; exit 2; }
echo "    Gateway active on 127.0.0.1:8081."

echo ""
echo "==> Mainnet services active. Public endpoints remain disabled (503) until"
echo "    you flip nginx enablement maps from 0 to 1 in lidex-mainnet.conf and reload."
echo "==> Do NOT flip enablement maps until you are authorized to launch Mainnet."
