# PIBo Chat

TanStack-Start-Chat-App im OpenClaw-Monorepo.

- Web-Login ueber `@pibo/shared-auth`
- eigentliche Chat-Verbindung ueber den bestehenden OpenClaw-Gateway-WebSocket-Vertrag
- Basepath-faehig fuer `/chat`
- Gateway-Default unter `/chat/__openclaw/gateway`

## Dev

- `pnpm --dir apps/chat dev`
- Standard-Port: `3010`
- Standard-Basepath: `/chat`

## Produktion

Produktionsartefakte im Repo:

- `server-prod.mjs`
- `ecosystem.config.cjs`
- `deploy/deploy-pibo-chat.sh`
- `../../deploy/nginx.pibo.schottech.de.conf.example`
- `deploy/nginx.chat.pibo.schottech.de.conf.example`

Gedachter Zielpfad auf dem Server:

- Checkout: `/var/www/openclaw`
- App: `/var/www/openclaw/apps/chat`
- PM2-App: `pibo-chat`
- interner Port: `3010`
- oeffentliche Hauptdomain: `https://pibo.schottech.de/chat`
- Gateway-Pfad: `https://pibo.schottech.de/chat/__openclaw/gateway`

Wichtige Invariante:

- Web-Login autorisiert den Menschen fuer die App
- Device Identity / Pairing autorisieren weiterhin den Browser fuer den Gateway
- die Runtime bleibt getrennt von `ui-pibo`; Nginx verteilt nur ueber den `/chat`-Subpath
