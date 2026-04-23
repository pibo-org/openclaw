# PIBo Hauptdomain-Module

`pibo.schottech.de` ist als modulare Hauptdomain mit getrennten Runtimes aufgebaut:

- `/` laeuft auf `ui-pibo` und zeigt das PIBo-Modul-Menue.
- `/editor` laeuft ebenfalls auf `ui-pibo` und enthaelt den Markdown-Editor.
- `/chat` laeuft auf `apps/chat` auf eigener Runtime.
- `/chat/__openclaw/gateway` ist der namespacete Gateway-Pfad fuer die Chat-App.

## Runtimes

- `ui-pibo`: `127.0.0.1:3000`
- `apps/chat`: `127.0.0.1:3010`
- Gateway-Upstream hinter Nginx: `127.0.0.1:31879`

Die Runtimes bleiben absichtlich getrennt. Nginx verteilt nur ueber Subpaths; der Chat wird nicht
in `ui-pibo` hineinkopiert.

## Editor-Kompatibilitaet

Historische Editor-Deep-Links mit `/?doc=...` werden in `ui-pibo` serverseitig nach
`/editor?doc=...` weitergeleitet, damit bestehende Bookmarks weiter funktionieren.

## Deploy-Dateien

- Hauptdomain-vHost: `deploy/nginx.pibo.schottech.de.conf.example`
- alter Chat-Host als Redirect: `apps/chat/deploy/nginx.chat.pibo.schottech.de.conf.example`
- Webapp-Deploy: `ui-pibo/deploy/deploy-pibo-webapp.sh`
- Chat-Deploy: `apps/chat/deploy/deploy-pibo-chat.sh`

## Produktive Deploy-Realitaet

- produktiver Repo-Checkout auf dem Server: `/var/www/openclaw`
- `ui-pibo` laeuft unter PM2 als `pibo-app` aus `/var/www/openclaw/ui-pibo/server-prod.mjs` auf `127.0.0.1:3000`
- `apps/chat` laeuft unter PM2 separat als `pibo-chat` aus `/var/www/openclaw/apps/chat` auf `127.0.0.1:3010`
- kanonischer Webapp-Entrypoint auf dem Server: `/root/bin/deploy-pibo-webapp.sh` -> `/var/www/openclaw/ui-pibo/deploy/deploy-pibo-webapp.sh`
- kanonischer Chat-Entrypoint auf dem Server: `apps/chat/deploy/deploy-pibo-chat.sh` innerhalb desselben Checkouts
- Zielbild fuer Aenderungen bleibt Git -> `origin/main` -> normaler Deploy; direkte Checkout-Hotfixes sind nur kurzzeitige Recovery, nicht Source of Truth

## Modul-Onboarding

Neue Module folgen demselben Muster:

1. eigene Runtime oder eigenen Upstream anlegen
2. festen internen Port vergeben
3. Subpath reservieren
4. Modul im Root-Menue registrieren
5. Nginx um den neuen Pfad erweitern
