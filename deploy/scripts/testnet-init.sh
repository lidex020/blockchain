#!/usr/bin/env bash
#
# LIDEX public Testnet initialization script.
#
# Non-destructive: prepares directories and validates inputs. Does NOT
# generate a genesis, does NOT create validator keys, does NOT start services.
#
# Required inputs (operator-provided, from the offline genesis ceremony):
#   --chain-id       Approved public Testnet chain ID (required, no default)
#   --genesis        Path to approved testnet genesis.json
#   --validator-map  Path to verified lidex-comet-validator-map-v1 file
#   --comet-home     CometBFT home directory (default: /srv/lidex/testnet/cometbft)
#   --abci-datadir   ABCI dedicated data directory (default: /srv/lidex/testnet/abci)
#
# Example:
#   sudo ./deploy/scripts/testnet-init.sh \
#     --chain-id <APPROVED_ID> \
#     --genesis /srv/lidex/testnet/genesis.json \
#     --validator-map /srv/lidex/testnet/validator-map.json
set -euo pipefail

CHAIN_ID=""
GENESIS=""
VALIDATOR_MAP=""
COMET_HOME="/srv/lidex/testnet/cometbft"
ABCI_DATADIR="/srv/lidex/testnet/abci"
BASEDIR="/srv/lidex/testnet"

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
  echo "ERROR: --chain-id is required (approved public Testnet chain ID, no default)." >&2
  exit 2
fi

# Reject devnet and mainnet candidate IDs.
if [[ "$CHAIN_ID" == "721220" || "$CHAIN_ID" == "72122" ]]; then
  echo "ERROR: Refusing to initialize Testnet on devnet (721220) or mainnet candidate (72122) chain ID." >&2
  exit 2
fi

if [[ -z "$GENESIS" || ! -f "$GENESIS" ]]; then
  echo "ERROR: --genesis must point to an existing approved genesis.json file." >&2
  exit 2
fi

if [[ -z "$VALIDATOR_MAP" || ! -f "$VALIDATOR_MAP" ]]; then
  echo "ERROR: --validator-map must point to an existing verified validator-map.json file." >&2
  exit 2
fi

echo "==> LIDEX public Testnet initialization"
echo "    Chain ID:          $CHAIN_ID"
echo "    Genesis:           $GENESIS"
echo "    Validator map:     $VALIDATOR_MAP"
echo "    CometBFT home:     $COMET_HOME"
echo "    ABCI data dir:     $ABCI_DATADIR"

# Create directory structure (non-destructive: does not overwrite existing data).
install -d -o lidex -g lidex -m 0750 "$BASEDIR"
install -d -o lidex -g lidex -m 0700 "$COMET_HOME"
install -d -o lidex -g lidex -m 0700 "$ABCI_DATADIR"
install -d -o lidex -g lidex -m 0755 "$BASEDIR/explorer"
install -d -o lidex -g lidex -m 0755 "$BASEDIR/logs"

# Validate genesis references the supplied chain ID.
GENESIS_CHAIN_ID=$(python3 -c "import json,sys; print(json.load(open('$GENESIS'))['chain_id'])" 2>/dev/null || node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).chain_id)" "$GENESIS")
if [[ "$GENESIS_CHAIN_ID" != "$CHAIN_ID" ]]; then
  echo "ERROR: Genesis chain_id ($GENESIS_CHAIN_ID) does not match --chain-id ($CHAIN_ID)." >&2
  exit 2
fi

# Copy genesis and validator map into place (operator must place them first;
# this script only validates and records locations).
echo "==> Genesis and validator map validated."
echo "==> Next: place CometBFT node keys (priv_validator_key.json, node_key.json)"
echo "    into $COMET_HOME/config/ from the offline genesis ceremony."
echo "==> Next: configure CometBFT config.toml (genesis, persistent_peers, addrs)."
echo "==> Next: run deploy/scripts/testnet-deploy.sh to start services."
