# Pinned x86_64 Linux dev environment for the LIDEX ABCI++ integration.
# CometBFT v0.39.4 declares Go 1.25.0 in its tagged go.mod.
FROM --platform=linux/amd64 golang:1.25.0-bookworm@sha256:ebd54034f076819b3054f155db53660ded951612bb4dfd277f933e62059e5d5a AS comet-build

WORKDIR /build
COPY tools/install-protoc.go ./tools/install-protoc.go
COPY src/abci/types.proto ./src/abci/types.proto

RUN GOTOOLCHAIN=local go run ./tools/install-protoc.go /usr/local/bin/protoc \
    && protoc --proto_path=src/abci --descriptor_set_out=/build/lidex-abci.pb src/abci/types.proto \
    && GOTOOLCHAIN=local go install github.com/cometbft/cometbft/cmd/cometbft@v0.39.4 \
    && test "$(go env GOVERSION)" = "go1.25.0" \
    && test "$(/usr/local/bin/protoc --version)" = "libprotoc 29.5" \
    && /go/bin/cometbft version | grep -q "0.39.4"

FROM --platform=linux/amd64 node:24.11.1-bookworm@sha256:fe306151aeafaf7c94e03dd3aff2435c91621f71a58bba3a09579c89d3ba730e AS node-runtime

FROM --platform=linux/amd64 golang:1.25.0-bookworm@sha256:ebd54034f076819b3054f155db53660ded951612bb4dfd277f933e62059e5d5a AS devcontainer
COPY --from=node-runtime /usr/local/ /usr/local/
COPY --from=comet-build /go/bin/cometbft /usr/local/bin/cometbft
COPY --from=comet-build /usr/local/bin/protoc /usr/local/bin/protoc

ENV GOTOOLCHAIN=local
ENV PATH="/usr/local/go/bin:/go/bin:${PATH}"
WORKDIR /workspaces/lidex

RUN test "$(go env GOVERSION)" = "go1.25.0" \
    && test "$(node --version)" = "v24.11.1" \
    && test "$(protoc --version)" = "libprotoc 29.5" \
    && cometbft version | grep -q "0.39.4" \
    && command -v make \
    && command -v gcc \
    && command -v g++ \
    && command -v git
