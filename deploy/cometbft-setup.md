# CometBFT v0.39.4 setup for LIDEX public Testnet

## Compatibility requirements

| Component | Requirement | Status in sandbox |
|-----------|-------------|-------------------|
| Go | 1.25.0 (CometBFT v0.39.4 go.mod) | Not available |
| Node.js | >= 20 | Available (v22.22.3) |
| CometBFT binary | v0.39.4 | Source-only; binary download blocked in sandbox |
| protoc | 29.5 | Not available |
| gcc / make | Required for build | Available |

This sandbox cannot build CometBFT v0.39.4 (no Go, no Docker, binary
download host blocked). The CometBFT binary must be built or obtained
on the target Contabo VPS.

## Build from source (on the VPS)

1. Install Go 1.25.0 on the VPS.
2. Clone CometBFT v0.39.4:
   ```
   git clone https://github.com/cometbft/cometbft.git
   cd cometbft && git checkout v0.39.4
   ```
3. Build:
   ```
   go install ./cmd/cometbft
   ```
4. Verify:
   ```
   cometbft version | grep -q "0.39.4"
   ```

## Alternative: prebuilt binary

If a prebuilt `cometbft_0.39.4_linux_amd64.tar.gz` is available from a
trusted mirror, download and install:
```
tar -xzf cometbft_0.39.4_linux_amd64.tar.gz
install -m 0755 cometbft /usr/local/bin/cometbft
```

## Node initialization (after binary installed)

```
cometbft init --home /srv/lidex/testnet/cometbft
```

This creates `config/config.toml`, `config/genesis.json`,
`config/priv_validator_key.json`, `config/node_key.json`.

Then:
1. Replace `config/genesis.json` with the approved testnet genesis.
2. Replace `config/priv_validator_key.json` with the ceremony-generated key.
3. Replace `config/node_key.json` with the ceremony-generated key.
4. Set `persistent_peers` to approved testnet validators.
5. Ensure `laddr` for RPC and P2P bind loopback only (`127.0.0.1`).

## Interop verification

Before enabling public endpoints:
1. Start CometBFT and confirm it produces blocks.
2. Start the LIDEX ABCI app and confirm it connects via the ABCI socket.
3. Submit a transaction via `eth_sendRawTransaction` and confirm it appears
   in a committed block.
4. Verify `cometbft status` shows healthy consensus.

## Go 1.25 toolchain

The `.devcontainer/Dockerfile` pins Go 1.25.0 with digest
`sha256:ebd54034f076819b3054f155db53660ded951612bb4dfd277f933e62059e5d5a`
and protoc 29.5. This is reference documentation only; the sandbox
cannot verify it.
