# PIBo Chat

TanStack-Start-Chat-App im OpenClaw-Monorepo.

- Web-Login ueber `@pibo/shared-auth`
- eigentliche Chat-Verbindung ueber den bestehenden OpenClaw-Gateway-WebSocket-Vertrag
- Dev-Proxy auf `/__openclaw/gateway` gegen den lokalen Gateway

## Dev

- `pnpm --dir apps/chat dev`
- Standard-Port: `3010`

## Produktion

Produktionsartefakte im Repo:

- `server-prod.mjs`
- `ecosystem.config.cjs`
- `deploy/deploy-pibo-chat.sh`
- `deploy/nginx.chat.pibo.schottech.de.conf.example`

Gedachter Zielpfad auf dem Server:

- Checkout: `/var/www/openclaw`
- App: `/var/www/openclaw/apps/chat`
- PM2-App: `pibo-chat`
- interner Port: `3010`
- oeffentliche Domain: `https://chat.pibo.schottech.de`

Wichtige Invariante:

- Web-Login autorisiert den Menschen fuer die App
- Device Identity / Pairing autorisieren weiterhin den Browser fuer den Gateway
