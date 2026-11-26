# LIDEX public Testnet firewall rules (Contabo VPS 13.140.178.241)

## Ports to OPEN (public interface)

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22 | TCP | Admin IPs only | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP → HTTPS redirect + ACME challenges |
| 443 | TCP | 0.0.0.0/0 | HTTPS (all testnet subdomains) |

## Ports to OPEN (loopback / private VPC only — NEVER public)

| Port | Protocol | Purpose |
|------|----------|---------|
| 26656 | TCP | CometBFT P2P (loopback/private only) |
| 26657 | TCP | CometBFT RPC (loopback only) |
| 26658 | TCP | CometBFT ABCI socket (loopback only) |
| 7302 | TCP | LIDEX ABCI RPC (loopback only) |
| 8080 | TCP | Public API gateway (loopback only, behind nginx) |

## Ports to CLOSE / never expose publicly

- CometBFT P2P (26656), RPC (26657), ABCI (26658)
- LIDEX ABCI RPC (7302)
- Public gateway (8080)
- Any validator or signer ports

## Example (ufw)

```
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp        # restrict to admin IPs in production
ufw allow 80/tcp
ufw allow 443/tcp
# Do NOT ufw allow 26656, 26657, 26658, 7302, or 8080 to the public interface
```

## Example (iptables/nftables)

Drop all inbound to consensus/gateway ports except from 127.0.0.1:
```
iptables -A INPUT -p tcp --dport 26656 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 26656 -j DROP
iptables -A INPUT -p tcp --dport 26657 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 26657 -j DROP
iptables -A INPUT -p tcp --dport 26658 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 26658 -j DROP
iptables -A INPUT -p tcp --dport 7302 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 7302 -j DROP
iptables -A INPUT -p tcp --dport 8080 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 8080 -j DROP
```

## Nginx enablement maps

All maps in `deploy/nginx/lidex-testnet.conf` default to `0` (503).
Flip to `1` only after:
1. Chain ID approved and genesis ceremony complete.
2. Validator mappings verified.
3. CometBFT interop smoke-tested.
4. TLS certificate issued and reloading succeeds.

Then: `nginx -t && systemctl reload nginx`
