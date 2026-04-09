import { bold, ok, warn, info, run } from "./utils.js";

export function uninstallDocsSync(role: string) {
  console.log(bold("\n🧹 Docs Sync Uninstall"));
  console.log("═".repeat(50));

  if (role === "pibo") {
    const services = [
      "pibo-docs-notifier.service",
      "pibo-docs-watcher.service",
      "pibo-docs-tunnel.service",
    ];
    for (const svc of services) {
      run(`systemctl --user disable --now ${svc} || true`);
      run(`rm -f ~/.config/systemd/user/${svc}`);
      console.log(ok(`Entfernt: ${svc}`));
    }
    run(`systemctl --user daemon-reload || true`);
    console.log(warn("Scripts unter ~/docs-sync und Config/Tokens wurden NICHT automatisch gelöscht."));
    console.log(info("Optional manuell löschen: ~/docs-sync, ~/.pibo-docs-sync-config.json, ~/.pibo-docs-sync-token"));
    return;
  }

  if (role === "server") {
    run(`systemctl disable --now pibo-docs-server-watcher.service || true`);
    run(`rm -f /etc/systemd/system/pibo-docs-server-watcher.service`);
    run(`systemctl daemon-reload || true`);
    run(`crontab -l 2>/dev/null | grep -v 'pibo-docs-sync.sh' | crontab - || true`);
    console.log(ok("Server-Service und Cron-Eintrag entfernt"));
    console.log(warn("/root/bin/, /var/docs-remote und Tokens wurden NICHT automatisch gelöscht."));
    console.log(info("Optional manuell löschen: /root/bin/pibo-docs-*, /var/docs-remote, /root/.pibo-docs-*") );
    return;
  }

  console.log(warn("Unbekannte Rolle. Verwende: pibo docs-sync uninstall <pibo|server>"));
}
