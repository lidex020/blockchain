# LIDEX production runtime image.
#
# Builds the wallet bundle and installs production dependencies, then copies
# everything into a slim runtime image. The LIDEX process (Node + custom
# consensus + ABCI application) runs here.
#
# IMPORTANT (operator): CometBFT is the consensus engine and is NOT part of
# this image. The CometBFT binary must be provided by the operator (bind-mounted
# or copied in) and run as a separate loopback-only service; consensus/P2P
# ports must never be published. Consensus binary interop is unverified in this
# repo — pin a specific CometBFT release before production use.
#
# This Dockerfile has NOT been built in this sandbox (docker is unavailable).
# Verify `docker build` and pin base-image digests before deploying.
#
#   docker build -t lidex:latest -f deploy/Dockerfile .
#   docker run --rm -p 7301:7301 -p 7302:7302 \
#     -v /srv/lidex/testnet:/workspaces/lidex/data/testnet \
#     lidex:latest node src/abci/serve.js --profile profiles/cometbft.testnet.json --rpc-port 7302

FROM node:22-bookworm AS builder

WORKDIR /workspaces/lidex

# Install production dependencies first (better layer caching).
COPY package.json ./
RUN npm ci --omit=dev

# Copy the application and build the self-contained wallet/explorer bundle.
COPY . .
RUN npm run build:wallet

# Runtime stage: slim image, non-root user.
FROM node:22-bookworm-slim

WORKDIR /workspaces/lidex

RUN groupadd -r lidex && useradd -r -g lidex -d /workspaces/lidex -s /sbin/nologin lidex

COPY --from=builder /workspaces/lidex/node_modules ./node_modules
COPY --from=builder /workspaces/lidex/src ./src
COPY --from=builder /workspaces/lidex/web ./web
COPY --from=builder /workspaces/lidex/scripts ./scripts
COPY --from=builder /workspaces/lidex/profiles ./profiles
COPY --from=builder /workspaces/lidex/package.json ./package.json

ENV NODE_ENV=production
ENV LIDEX_NETWORK=testnet

# Public API / RPC ports (nginx upstreams point here). Consensus/P2P ports are
# NOT exposed — they remain loopback-only on the host.
EXPOSE 7301 7302

# Health check: the /health endpoint is served by the ABCI RPC process on the
# configured rpc-port. Adjust the port to match the network being run.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const http=require('http');http.get('http://127.0.0.1:7302/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER lidex

# Default command runs the devnet-style node; override per network:
#   mainnet: node src/node.js
#   testnet ABCI: node src/abci/serve.js --profile profiles/cometbft.testnet.json --rpc-port 7302
CMD ["node", "src/node.js"]
