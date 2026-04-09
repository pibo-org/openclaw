import { writeFileSync, rmSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { readConfig } from "./config.js";
import { bold, ok, fail, warn, info, run } from "./utils.js";

const TEST_ROOT = "sync-test";
const LOCAL_FILE = `${TEST_ROOT}/from-pibo.md`;
const MOVED_FILE = `${TEST_ROOT}/moved/from-pibo.md`;
const REMOTE_FILE = `${TEST_ROOT}/from-server.md`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs: number, intervalMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

function ssh(sshKey: string, serverIp: string, cmd: string) {
  return run(
    `ssh -i ${sshKey} -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@${serverIp} ${JSON.stringify(cmd)} 2>/dev/null`,
  );
}

function remoteExists(sshKey: string, serverIp: string, serverDocs: string, file: string) {
  return ssh(sshKey, serverIp, `test -f ${serverDocs}/${file} && echo yes || echo no`) === "yes";
}

export async function runTest() {
  const piboCfg = readConfig("pibo");
  if (!piboCfg) {
    console.log(warn("Keine Config gefunden. Erst 'pibo docs-sync setup' ausführen."));
    return;
  }

  const docsPath = piboCfg.pibo.docsPath;
  const serverIp = piboCfg.server.ip;
  const sshKey = piboCfg.server.sshKeyPath || join(homedir(), ".ssh", "id_ed25519");
  const serverDocs = piboCfg.server.remoteDocsPath;

  console.log(bold("\n🧪 Docs-Sync Integrationstest"));
  console.log("═".repeat(50));
  console.log(info(`Testpfad: ${TEST_ROOT}/`));

  // Cleanup before start
  rmSync(join(docsPath, TEST_ROOT), { recursive: true, force: true });
  ssh(sshKey, serverIp, `rm -rf ${serverDocs}/${TEST_ROOT}`);
  run(
    `cd ${docsPath} && git add -A && (git commit -m "test: cleanup sync-test" >/dev/null 2>&1 || true)`,
  );
  await sleep(2000);

  // 1) Local -> server create
  console.log(`\n[1/5] Lokal erstellen → Server/WebApp sichtbar`);
  mkdirSync(join(docsPath, TEST_ROOT), { recursive: true });
  writeFileSync(join(docsPath, LOCAL_FILE), `# Local create\n\n${new Date().toISOString()}\n`);

  const createdRemote = await waitUntil(
    () => remoteExists(sshKey, serverIp, serverDocs, LOCAL_FILE),
    45000,
    1000,
  );
  console.log(
    createdRemote
      ? ok("Lokale Datei kam auf dem Server an")
      : fail("Lokale Datei kam NICHT auf dem Server an"),
  );
  if (!createdRemote) {
    return;
  }

  // 2) Local move -> old path gone, new path exists remotely
  console.log(`\n[2/5] Lokal verschieben → Server darf keine Copy hinterlassen`);
  mkdirSync(join(docsPath, dirname(MOVED_FILE)), { recursive: true });
  run(`cd ${docsPath} && mv ${LOCAL_FILE} ${MOVED_FILE}`);

  const movedRemote = await waitUntil(
    () =>
      remoteExists(sshKey, serverIp, serverDocs, MOVED_FILE) &&
      !remoteExists(sshKey, serverIp, serverDocs, LOCAL_FILE),
    45000,
    1000,
  );
  console.log(
    movedRemote
      ? ok("Move wurde korrekt als Move synchronisiert")
      : fail("Move blieb auf dem Server als Copy/Altdatei hängen"),
  );
  if (!movedRemote) {
    return;
  }

  // 3) Server/WebApp side create -> local immediate pull
  console.log(`\n[3/5] Server/WebApp-Seite erstellen → lokal sichtbar`);
  ssh(
    sshKey,
    serverIp,
    `mkdir -p ${serverDocs}/${TEST_ROOT} && printf '# Server create\n\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${serverDocs}/${REMOTE_FILE}`,
  );

  const remoteToLocal = await waitUntil(
    () => run(`test -f ${join(docsPath, REMOTE_FILE)} && echo yes || echo no`) === "yes",
    20000,
    1000,
  );
  console.log(
    remoteToLocal
      ? ok("Server-Änderung wurde lokal schnell übernommen")
      : fail("Server-Änderung kam nicht zeitnah lokal an"),
  );
  if (!remoteToLocal) {
    return;
  }

  // 4) Server/WebApp move -> local old path gone, new path exists
  console.log(`\n[4/5] Server/WebApp-Seite verschieben → lokal kein Copy-Effekt`);
  ssh(
    sshKey,
    serverIp,
    `mkdir -p ${serverDocs}/${TEST_ROOT}/server-moved && mv ${serverDocs}/${REMOTE_FILE} ${serverDocs}/${TEST_ROOT}/server-moved/from-server.md`,
  );

  const serverMoveLocal = await waitUntil(
    () =>
      run(
        `test -f ${join(docsPath, TEST_ROOT, "server-moved/from-server.md")} && echo yes || echo no`,
      ) === "yes" && run(`test -f ${join(docsPath, REMOTE_FILE)} && echo yes || echo no`) === "no",
    20000,
    1000,
  );
  console.log(
    serverMoveLocal
      ? ok("Server-Move wurde lokal korrekt gespiegelt")
      : fail("Server-Move blieb lokal als Copy/Altdatei hängen"),
  );
  if (!serverMoveLocal) {
    return;
  }

  // 5) Bidirectional delete
  console.log(`\n[5/5] Löschen in beide Richtungen`);
  rmSync(join(docsPath, MOVED_FILE), { force: true });
  const localDeleteRemote = await waitUntil(
    () => !remoteExists(sshKey, serverIp, serverDocs, MOVED_FILE),
    45000,
    1000,
  );
  console.log(
    localDeleteRemote
      ? ok("Lokales Löschen wurde auf dem Server übernommen")
      : fail("Lokales Löschen wurde auf dem Server NICHT übernommen"),
  );
  if (!localDeleteRemote) {
    return;
  }

  ssh(sshKey, serverIp, `rm -f ${serverDocs}/${TEST_ROOT}/server-moved/from-server.md`);
  const remoteDeleteLocal = await waitUntil(
    () =>
      run(
        `test -f ${join(docsPath, TEST_ROOT, "server-moved/from-server.md")} && echo yes || echo no`,
      ) === "no",
    20000,
    1000,
  );
  console.log(
    remoteDeleteLocal
      ? ok("Server-Löschen wurde lokal übernommen")
      : fail("Server-Löschen wurde lokal NICHT übernommen"),
  );

  // Cleanup
  rmSync(join(docsPath, TEST_ROOT), { recursive: true, force: true });
  ssh(sshKey, serverIp, `rm -rf ${serverDocs}/${TEST_ROOT}`);

  console.log(
    "\n" +
      (remoteDeleteLocal
        ? bold("✅ Docs-Sync-Test erfolgreich")
        : bold("⚠️ Docs-Sync-Test mit Fehlern beendet")),
  );
}
