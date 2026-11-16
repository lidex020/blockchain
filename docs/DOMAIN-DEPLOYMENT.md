# LIDEX public-domain deployment

## What this config does—and does not—provide

`deploy/nginx/lidex.conf` defines HTTPS virtual hosts for:

- `lidex.tech` — serves the existing `web/` application bundle.
- `explorer.lidex.tech` — serves that same bundle as the explorer.
- `rpc.lidex.tech` and `ws.lidex.tech` — reserved for the Mainnet RPC and
  WebSocket gateways.
- `testnet.lidex.tech` and `testnet-rpc.lidex.tech` — reserved for the separate
  Testnet portal and RPC.
- `docs.lidex.tech` — reserved for a generated developer-documentation site.

The existing repository has one explorer/site bundle and no distinct Testnet
portal or generated docs site. The chain backend is still the legacy custom
consensus node, Mainnet startup is explicitly disabled, and no verified
Testnet genesis or mapping exists. Therefore, chain API hosts intentionally
return `503 Service Unavailable` because their enable maps are `0`; the
explorer's live network descriptor and RPC/WebSocket calls also remain
unavailable. The Testnet portal and docs virtual hosts return `503` until
their respective static bundles are installed. The Nginx file does not create,
activate, or expose a Mainnet or Testnet node. This is a safe deployable edge
configuration, not a claim that the networks are ready.

The upstream port declarations (`7301` and `7302`) are reserved for future,
network-specific **public API gateway** processes. The proxy locations are
already defined, but the Mainnet RPC/WebSocket/explorer and Testnet RPC enable
maps are all `0`, so no chain request reaches an upstream. Do not bind a
legacy node or CometBFT ABCI socket to those gateway ports.

## DNS

Create these records with the DNS provider for `lidex.tech`:

| Name | Type | Value |
|---|---|---|
| `@` | A | Public IPv4 address of the HTTPS reverse-proxy host |
| `@` | AAAA | Public IPv6 address, only if IPv6 ingress is configured and tested |
| `explorer` | CNAME | `lidex.tech` |
| `rpc` | CNAME | `lidex.tech` |
| `ws` | CNAME | `lidex.tech` |
| `testnet` | CNAME | `lidex.tech` |
| `testnet-rpc` | CNAME | `lidex.tech` |
| `docs` | CNAME | `lidex.tech` |

Use the DNS provider's proxy/CDN only if its WebSocket support, RPC request
body limit, timeout, rate limit, and origin-certificate behavior have been
tested. Otherwise use DNS-only records and terminate TLS on the host. Do not
publish backend node, validator, or ABCI addresses in DNS.

## Host and TLS setup

Use a dedicated Linux host for the public reverse proxy. Keep validator
processes and chain data on separately secured hosts or private network
interfaces. Install Nginx and Certbot from the distribution's supported
packages. Copy the application bundle to `/srv/lidex/current/web` using a
versioned release directory and an atomic symlink switch; do not make the
repository or its data directories web-readable.

Create the ACME webroot and install the HTTP challenge server first:

```sh
sudo install -d -o root -g www-data -m 0755 /var/www/letsencrypt
sudo install -m 0644 deploy/nginx/acme-bootstrap.conf /etc/nginx/conf.d/lidex.conf
sudo nginx -t
sudo systemctl reload nginx
```

Issue one SAN certificate:

```sh
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d lidex.tech -d explorer.lidex.tech -d rpc.lidex.tech \
  -d ws.lidex.tech -d testnet.lidex.tech -d testnet-rpc.lidex.tech \
  -d docs.lidex.tech
```

Then install the complete `deploy/nginx/lidex.conf`, validate it, and reload:

```sh
sudo rm /etc/nginx/conf.d/lidex.conf
sudo install -m 0644 deploy/nginx/lidex.conf /etc/nginx/conf.d/lidex.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

The HSTS policy includes subdomains. Enable this only after every listed
hostname reliably serves HTTPS and certificate renewal has been tested. If
some subdomains are hosted elsewhere or not yet HTTPS-capable, remove
`includeSubDomains` until the whole namespace is ready.

## Firewall and private network policy

Public inbound policy:

- Allow TCP `80` only for ACME challenges and HTTP-to-HTTPS redirects.
- Allow TCP `443` for the named HTTPS services.
- Restrict SSH to an administrator VPN or fixed management addresses.
- Deny public access to application/backend ports, including `72131`, `72132`,
  `7301`, `7302`, `26656`, `26657`, `26658`, `26660`, and all validator signer
  or management ports.
- Do not forward the CometBFT ABCI socket (`26658`) or CometBFT P2P/RPC,
  validator, Prometheus, or remote-signer ports through Nginx.

Use a private WireGuard or equivalent authenticated mesh between validator,
execution, and API hosts. Restrict peer and internal application traffic to
that mesh. The ABCI app's current unauthenticated TCP transport must bind only
to loopback; its requests must only come from the trusted local CometBFT
process. Do not publish it, tunnel it to the public proxy, or allow arbitrary
local users/processes to access it.

The current legacy node combines JSON-RPC, WebSocket, static assets, and P2P
routes on one listener. The firewall must not expose that listener publicly.
The deployment must first provide a reviewed private peer path and a separate
public API gateway that only forwards approved RPC/WS requests; do not solve
this by opening the combined node port. Mainnet and Testnet require separate
process identities, ports, network namespaces or hosts, data directories,
genesis/configuration, and firewall rules.

## Reverse-proxy behavior and network isolation

The Nginx vhosts deliberately fail closed for unavailable services. Do not
enable a map or start an upstream until all applicable network readiness gates
are passed. Once the dedicated public API gateways are implemented:

1. Assign Mainnet and Testnet separate private loopback/private-mesh API
   addresses and bind only their respective gateway processes.
2. Keep the matching enable map at `0` until the service is released. After
   approval, change only that hostname's map value (`rpc.lidex.tech`,
   `ws.lidex.tech`, `explorer.lidex.tech`, or `testnet-rpc.lidex.tech`) to `1`.
   The proxy destinations are separate loopback upstreams on `7301` (Mainnet)
   and `7302` (Testnet). Never share an upstream between networks; if those
   dedicated public gateways do not exist, leave the maps at `0`.
3. For RPC, allow only `POST /`, cap request bodies, apply tested rate/connection
   limits, and hide the backend's permissive `Access-Control-Allow-Origin`
   header. Add the configured per-network allowlisted CORS origin from the
   maps at the top of the Nginx config. Reject invalid WebSocket `Origin`
   values and proxy only `/ws`.
4. Set `Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` at the proxy. The
   Node app trusts proxy metadata only from loopback. Configure
   `LIDEX_PUBLIC_RPC_URL`, `LIDEX_PUBLIC_WS_URL`, and `LIDEX_EXPLORER_URL` on
   the network's API process; values are validated as HTTPS/WSS URLs and
   emitted by `/network.json`. Mainnet must use `https://rpc.lidex.tech`,
   `wss://ws.lidex.tech/ws`, and `https://explorer.lidex.tech`; Testnet must
   use `https://testnet-rpc.lidex.tech`, `wss://testnet-rpc.lidex.tech/ws`,
   and `https://testnet.lidex.tech`. The app rejects public endpoint URLs
   assigned to a different configured network, and devnet cannot advertise
   production endpoint URLs.
5. Deny all other methods, paths, and hostnames. In particular, never route
   `/p2p/*`, `/metrics`, validator ports, CometBFT transports, or signer APIs
   from a public vhost. The `lidex.tech` root and `explorer.lidex.tech` serve
   the existing web bundle; install separate Testnet portal and docs bundles
   under `/srv/lidex/testnet-portal` and `/srv/lidex/docs-site`.
6. Validate the final configuration with `nginx -t`, external TLS/RPC/WS
   probes, direct-backend denial tests, CORS tests, and tests proving that
   Mainnet and Testnet return different chain IDs and never share state.

The current repository does not yet contain the dedicated gateways or
network-specific endpoint processes needed to complete steps 1–6. The public
hosts remain unavailable until those are implemented and released.

## Deployment and release sequence

1. Provision DNS, the hardened reverse proxy, certificate renewal, logging,
   OS updates, and monitoring. Confirm only ports 80/443 are externally open.
2. Publish the existing static bundle at `lidex.tech` and
   `explorer.lidex.tech`. Validate static assets and HTTPS. Do not represent a
   missing chain API as a live network.
3. Complete the CometBFT/ABCI++ migration and run the pinned development
   container plus actual CometBFT interoperability, multi-validator,
   restart/recovery, and adversarial consensus tests.
4. Create an independently reviewed Testnet genesis and obtain verified public
   validator mappings. Deploy Testnet with isolated state and private
   validator/peer transport. Install the portal bundle and enable only the
   Testnet RPC map after verifying chain ID and state separation.
5. Build and publish the developer docs site to `/srv/lidex/docs-site`, then
   replace only the `docs.lidex.tech` unavailable response with its static
   root. Test links, versioning, and security headers.
6. Integrate explorer and wallet configuration with the Testnet API. Do not
   advertise a Mainnet RPC URL while Mainnet remains unavailable.
7. Prepare Mainnet as a separate, inactive deployment. Preserve the existing
   validator identities and Mainnet state; independently verify every
   operator-to-Comet public-key mapping and run the exact migration against an
   isolated faithful copy. No Mainnet listener, DNS route, or endpoint is
   activated by the current config.
8. Enable Mainnet routes only after consensus/security sign-off, operator and
   governance authorization, state/identity reconciliation, operational
   drills, and a separately approved launch. Keep an abort and recovery plan
   available throughout cutover.

Keep the reverse-proxy configuration, DNS ownership, certificate renewal
records, firewall policy, service versions, and release approvals under change
control. Never store private keys, credentials, or certificate private keys in
the repository.
