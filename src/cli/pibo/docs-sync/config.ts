import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export interface DocsSyncConfig {
  role: "pibo" | "server";
  version: string;
  createdAt: string;
  lastModified: string;
  server: {
    ip: string;
    user: string;
    sshKeyPath: string;
    notifyToken: string;
    remoteDocsPath: string;
  };
  pibo: {
    docsPath: string;
    notifyPort: number;
    notifyToken: string;
  };
  github: {
    backupRepo: string;
    webappRepo: string;
    deployKeyPath: string;
  };
}

const CONFIG_FILE_NAME = ".pibo-docs-sync-config.json";

function configCandidates(role: "pibo" | "server"): string[] {
  if (role === "server") return [join("/root", CONFIG_FILE_NAME)];
  return [
    join(homedir(), CONFIG_FILE_NAME),
    join(homedir(), ".config", CONFIG_FILE_NAME),
  ];
}

function configPath(role: "pibo" | "server"): string {
  return configCandidates(role)[0];
}

export function configExists(role: "pibo" | "server"): boolean {
  return configCandidates(role).some((p) => existsSync(p));
}

export function readConfig(role: "pibo" | "server"): DocsSyncConfig | null {
  for (const p of configCandidates(role)) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as DocsSyncConfig;
    } catch {
      continue;
    }
  }
  return null;
}

export function writeConfig(role: "pibo" | "server", cfg: DocsSyncConfig) {
  const p = configPath(role);
  cfg.lastModified = new Date().toISOString();
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}

export function defaultConfig(): Partial<DocsSyncConfig> {
  const home = homedir();
  return {
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    server: {
      ip: "", // MUSS gesetzt werden — Server-IP
      user: "root",
      sshKeyPath: join(home, ".ssh", "id_ed25519"),
      notifyToken: "",
      remoteDocsPath: "/var/lib/pibo-webapp/storage/docs",
    },
    pibo: {
      docsPath: join(home, "docs"),
      notifyPort: 3472,
      notifyToken: "",
    },
    github: {
      backupRepo: "", // MUSS gesetzt werden — git@github.com:user/repo.git
      webappRepo: "",
      deployKeyPath: "/root/.ssh/id_ed25519",
    },
  };
}
