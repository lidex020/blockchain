# LIDEX public Testnet DNS and TLS requirements

## DNS records (to be configured at the domain registrar / DNS provider)

Domain: `lidex.tech`

| Record | Type | Value | TTL | Purpose |
|--------|------|-------|-----|---------|
| rpc-testnet.lidex.tech | A | 13.140.178.241 | 300 | JSON-RPC endpoint |
| ws-testnet.lidex.tech | A | 13.140.178.241 | 300 | WebSocket endpoint |
| api-testnet.lidex.tech | A | 13.140.178.241 | 300 | REST API gateway |
| explorer-testnet.lidex.tech | A | 13.140.178.241 | 300 | Explorer application |

## TLS certificates (Let's Encrypt)

All four subdomains share a single SAN certificate or individual certs:

- `rpc-testnet.lidex.tech`
- `ws-testnet.lidex.tech`
- `api-testnet.lidex.tech`
- `explorer-testnet.lidex.tech`

### Certificate issuance

1. Place `deploy/nginx/acme-bootstrap.conf` (HTTP-only) in `/etc/nginx/conf.d/`
2. `nginx -t && systemctl reload nginx`
3. Run certbot:
   ```
   certbot certonly --webroot -w /var/www/letsencrypt \
     -d rpc-testnet.lidex.tech -d ws-testnet.lidex.tech \
     -d api-testnet.lidex.tech -d explorer-testnet.lidex.tech
   ```
4. Remove `acme-bootstrap.conf`, install `deploy/nginx/lidex-testnet.conf`
5. `nginx -t && systemctl reload nginx`

### Certificate paths used by nginx config

- `/etc/letsencrypt/live/lidex.tech/fullchain.pem`
- `/etc/letsencrypt/live/lidex.tech/privkey.pem`

If individual certificates are used, update the `ssl_certificate` and
`ssl_certificate_key` paths in each server block accordingly.

## Verification (not yet complete)

DNS is operational when:
```
dig +short rpc-testnet.lidex.tech   # => 13.140.178.241
dig +short ws-testnet.lidex.tech    # => 13.140.178.241
dig +short api-testnet.lidex.tech   # => 13.140.178.241
dig +short explorer-testnet.lidex.tech # => 13.140.178.241
```

TLS is operational when:
```
curl -I https://rpc-testnet.lidex.tech/   # => HTTP 200 or 503 (service gate)
```

Do not claim DNS/TLS operational until these resolve and certificates verify.
