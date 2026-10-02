Forge on gtrnd000

Server directory: /home/goat/forge-deploy
Release image: ghcr.io/goat-robotics/forge:f44fc962569c5eb1efcbb226f207d9313cbef7a6
Fresh data volume; same Entra application and environment configuration as local Forge, with PUBLIC_URL/PUBLIC_URLS set to https://forge.goat-robotics.com and COOKIE_SECURE=true.

Manual network configuration:
- Reserve 10.0.0.39 for gtrnd000 in DHCP.
- Forward WAN TCP 80 to 10.0.0.39 TCP 8180.
- Forward WAN TCP 443 to 10.0.0.39 TCP 8444.
- Cloudflare DNS: A record forge pointing at 117.250.232.153 (WAN IP supplied by user on 2026-10-01), DNS only initially. Remove any stale conflicting A/AAAA records for forge.
- Caddy requests the public TLS certificate automatically once DNS and forwarding work.
- If enabling Cloudflare proxy later, use Full (strict) TLS.
- Do not expose the application port 8100 or database/data volume.

Verification after forwarding:
  curl -f https://forge.goat-robotics.com/api/health
  curl -f https://forge.goat-robotics.com/api/auth/providers

Public-IP changes require updating DNS. If the router WAN address differs from the observed public IP, upstream NAT must also be forwarded before inbound access can work.
