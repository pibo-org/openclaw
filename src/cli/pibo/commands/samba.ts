import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type SambaShareAddOptions = {
  path?: string;
  name?: string;
  hostsAllow?: string;
  dryRun?: boolean;
  apply?: boolean;
};

type SharePlan = {
  linuxUser: string;
  shareName: string;
  sharePath: string;
  smbConfPath: string;
  backupPath: string;
  block: string;
  existsAlready: boolean;
  smbdInstalled: boolean;
  testparmInstalled: boolean;
  userExists: boolean;
  pathExists: boolean;
  pathOwner?: string;
};

const DEFAULT_SMB_CONF = "/etc/samba/smb.conf";

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function commandExists(command: string): boolean {
  const result = spawnSync("bash", ["-lc", `command -v ${shellEscape(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureAbsolutePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  return path.resolve(inputPath);
}

function getUserHome(username: string): string {
  try {
    return (
      execFileSync("getent", ["passwd", username], { encoding: "utf8" }).split(":")[5] ||
      `/home/${username}`
    );
  } catch {
    return `/home/${username}`;
  }
}

function userExists(username: string): boolean {
  const result = spawnSync("id", [username], { stdio: "ignore" });
  return result.status === 0;
}

function getOwnerName(targetPath: string): string | undefined {
  try {
    return execFileSync("stat", ["-c", "%U", targetPath], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function shareHeaderRegex(shareName: string): RegExp {
  const escaped = shareName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[${escaped}\\]\\s*$`, "mi");
}

function buildShareBlock(
  shareName: string,
  sharePath: string,
  linuxUser: string,
  hostsAllow?: string,
): string {
  const lines = [
    `[${shareName}]`,
    `path = ${sharePath}`,
    `browseable = yes`,
    `read only = no`,
    `guest ok = no`,
    `valid users = ${linuxUser}`,
    `force user = ${linuxUser}`,
    `create mask = 0664`,
    `directory mask = 0775`,
  ];

  if (hostsAllow && hostsAllow.trim()) {
    lines.push(`hosts allow = ${hostsAllow.trim()}`);
  }

  return `${lines.join("\n")}\n`;
}

function planShare(linuxUser: string, opts: SambaShareAddOptions): SharePlan {
  const shareName = (opts.name || linuxUser).trim();
  const sharePath = ensureAbsolutePath(opts.path || getUserHome(linuxUser));
  const smbConfPath = DEFAULT_SMB_CONF;
  const backupPath = `${smbConfPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const block = buildShareBlock(shareName, sharePath, linuxUser, opts.hostsAllow);
  const smbConfContent = fileExists(smbConfPath) ? fs.readFileSync(smbConfPath, "utf8") : "";

  return {
    linuxUser,
    shareName,
    sharePath,
    smbConfPath,
    backupPath,
    block,
    existsAlready: shareHeaderRegex(shareName).test(smbConfContent),
    smbdInstalled: commandExists("smbd"),
    testparmInstalled: commandExists("testparm"),
    userExists: userExists(linuxUser),
    pathExists: fileExists(sharePath),
    pathOwner: fileExists(sharePath) ? getOwnerName(sharePath) : undefined,
  };
}

function printPlan(plan: SharePlan): void {
  console.log(`Linux user: ${plan.linuxUser}`);
  console.log(`Share name: ${plan.shareName}`);
  console.log(`Share path: ${plan.sharePath}`);
  console.log(`smb.conf: ${plan.smbConfPath}`);
  console.log(`Backup path: ${plan.backupPath}`);
  console.log(`User exists: ${plan.userExists ? "yes" : "no"}`);
  console.log(`Path exists: ${plan.pathExists ? "yes" : "no"}`);
  console.log(`Path owner: ${plan.pathOwner || "unknown"}`);
  console.log(`smbd installed: ${plan.smbdInstalled ? "yes" : "no"}`);
  console.log(`testparm installed: ${plan.testparmInstalled ? "yes" : "no"}`);
  console.log(`Share exists already: ${plan.existsAlready ? "yes" : "no"}`);
  console.log("");
  console.log("Planned share block:");
  console.log(plan.block.trimEnd());
  console.log("");
  console.log("Follow-up after apply:");
  console.log(`- Passwort für Samba setzen: sudo smbpasswd -a ${plan.linuxUser}`);
  console.log(`- Von Windows testen: \\\\${getLocalIpHint()}\\${plan.shareName}`);
}

function getLocalIpHint(): string {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const entry of list || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "<server-ip>";
}

function runChecked(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

function applyShare(plan: SharePlan): void {
  if (!fileExists(plan.smbConfPath)) {
    throw new Error(`smb.conf nicht gefunden: ${plan.smbConfPath}`);
  }
  if (plan.existsAlready) {
    throw new Error(`Share existiert bereits: [${plan.shareName}]`);
  }
  if (!plan.userExists) {
    throw new Error(`Linux-User existiert nicht: ${plan.linuxUser}`);
  }
  if (!plan.pathExists) {
    throw new Error(`Pfad existiert nicht: ${plan.sharePath}`);
  }
  if (!plan.testparmInstalled) {
    throw new Error("testparm ist nicht installiert oder nicht im PATH.");
  }

  fs.copyFileSync(plan.smbConfPath, plan.backupPath);
  const original = fs.readFileSync(plan.smbConfPath, "utf8");
  const next = `${original.trimEnd()}\n\n${plan.block}`;
  fs.writeFileSync(plan.smbConfPath, next, "utf8");

  try {
    runChecked("testparm", ["-s"]);
  } catch (error) {
    fs.copyFileSync(plan.backupPath, plan.smbConfPath);
    throw new Error(`testparm fehlgeschlagen. Rollback auf ${plan.backupPath} ausgeführt.`, {
      cause: error,
    });
  }

  const reload = spawnSync("systemctl", ["reload", "smbd"], { stdio: "inherit" });
  if (reload.status !== 0) {
    const restart = spawnSync("systemctl", ["restart", "smbd"], { stdio: "inherit" });
    if (restart.status !== 0) {
      throw new Error("Konnte smbd weder reloaden noch restarten.");
    }
  }
}

export function sambaShareAdd(linuxUser: string, opts: SambaShareAddOptions): void {
  const plan = planShare(linuxUser, opts);
  printPlan(plan);

  if (!opts.apply) {
    console.log("");
    console.log("Dry run only. Mit --apply wird die Änderung wirklich durchgeführt.");
    return;
  }

  applyShare(plan);
  console.log("");
  console.log(`✅ Samba-Share angelegt: [${plan.shareName}] -> ${plan.sharePath}`);
  console.log(`📦 Backup: ${plan.backupPath}`);
  console.log(`🔐 Nächster Schritt: sudo smbpasswd -a ${plan.linuxUser}`);
}
