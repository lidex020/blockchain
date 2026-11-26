#!/usr/bin/env bash
#
# LIDEX public Mainnet initialization script.
#
# PREPARATION ONLY. This script does NOT activate Mainnet. It prepares
# directories and validates inputs. Mainnet activation requires your
# explicit authorization and must be run separately after all artifacts
# are in place.
#
# Required inputs (from your offline genesis ceremony):
#   --chain-id       Approved Mainnet chain ID (required, no default)
#   --genesis        Path to approved mainnet genesis.json
#   --validator-map  Path to verified lidex-comet-validator-map-v1 file
#   --comet-home     CometBFT home directory (default: /srv/lidex/mainnet/cometbft)
#   --abci-datadir   ABCI dedicated data directory (default: /srv/lidex/mainnet/abci)
#
# Example:
#   sudo ./deploy/scripts/mainnet-init.sh \
#     --chain-id <APPROVED_MAINNET_ID> \
#     --genesis /srv/lidex/mainnet/genesis.json \
#     --validator-map /srv/lidex/mainnet/validator-map.json
#
# Mainnet activation (separate step, requires your explicit authorization):
#   sudo ./deploy/scripts/mainnet-deploy.sh
set -euo pipefail

CHAIN_ID=""
GENESIS=""
VALIDATOR_MAP=""
COMET_HOME="/srv/lidex/mainnet/cometbft"
ABCI_DATADIR="/srv/lidex/mainnet/abci"
BASEDIR="/srv/lidex/mainnet"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chain-id) CHAIN_ID="$2"; shift 2 ;;
    --genesis) GENESIS="$2"; shift 2 ;;
    --validator-map) VALIDATOR_MAP="$2"; shift 2 ;;
    --comet-home) COMET_HOME="$2"; shift 2 ;;
    --abci-datadir) ABCI_DATADIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$CHAIN_ID" ]]; then
  echo "ERROR: --chain-id is required (approved Mainnet chain ID, no default)." >&2
  exit 2
fi

# Reject devnet and testnet IDs.
if [[ "$CHAIN_ID" == "721220" ]]; then
  echo "ERROR: Refusing to initialize Mainnet on devnet chain ID 721220." >&2
  exit 2
fi

# Note: 72122 is the mainnet candidate in src/constants.js. It may be used
# only if you have explicitly approved it as the final Mainnet chain ID.
# The script does not reject it here because approval is your decision.

if [[ -z "$GENESIS" || ! -f "$GENESIS" ]]; then
  echo "ERROR: --genesis must point to an existing approved genesis.json file." >&2
  exit 2
fi

if [[ -z "$VALIDATOR_MAP" || ! -f "$VALIDATOR_MAP" ]]; then
  echo "ERROR: --validator-map must point to an existing verified validator-map.json file." >&2
  exit 2
fi

# Validate validator map schema.
VALIDATOR_MAP_SCHEMA=$(python3 -c "import json,sys; d=json.load(open('$VALIDATOR_MAP')); print(d.get('schema','MISSING'))" 2>/dev/null || echo "INVALID")
if [[ "$VALIDATOR_MAP_SCHEMA" != "lidex-comet-validator-map-v1" ]]; then
  echo "ERROR: Validator map must use schema 'lidex-comet-validator-map-v1', got '$VALIDATOR_MAP_SCHEMA'." >&2
  exit 2
fi

echo "==> LIDEX public Mainnet initialization (PREPARATION ONLY)"
echo "    Chain ID:          $CHAIN_ID"
echo "    Genesis:           $GENESIS"
echo "    Validator map:     $VALIDATOR_MAP"
echo "    CometBFT home:     $COMET_HOME"
echo "    ABCI data dir:     $ABCI_DATADIR"

# Validate genesis chain ID matches.
GENESIS_CHAIN_ID=$(python3 -c "import json,sys; print(json.load(open('$GENESIS'))['chain_id'])" 2>/dev/null || node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).chain_id)" "$GENESIS")
if [[ "$GENESIS_CHAIN_ID" != "$CHAIN_ID" ]]; then
  echo "ERROR: Genesis chain_id ($GENESIS_CHAIN_ID) does not match --chain-id ($CHAIN_ID)." >&2
  exit 2
fi

# Create directory structure (non-destructive).
install -d -o lidex -g lidex -m 0750 "$BASEDIR"
install -d -o lidex -g lidex -m 0700 "$COMET_HOME"
install -d -o lidex -g lidex -m 0700 "$ABCI_DATADIR"
install -d -o lidex -g lidex -m 0755 "$BASEDIR/explorer"
install -d -o lidex -g lidex -m 0755 "$BASEDIR/logs"

echo ""
echo "==> Mainnet directories prepared. NOT activated."
echo "==> Next steps (operator):"
echo "    1. Place CometBFT node keys into $COMET_HOME/config/"
echo "       - priv_validator_key.json (0600, lidex:lidex)"
echo "       - node_key.json (0600, lidex:lidex)"
echo "    2. Configure CometBFT config.toml (genesis, persistent_peers, addrs)"
echo "    3. When authorized, run: sudo ./deploy/scripts/mainnet-deploy.sh"
