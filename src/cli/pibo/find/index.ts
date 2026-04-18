import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import process from "process";

const MODEL = "minimax/MiniMax-M2.7-highspeed";
const AGENT = "explore";
const FINDER_COMMAND = "opencode";
const HEARTBEAT_INTERVAL_MS = 10_000;
const DOCS_PROMPT = `Du bist ein Finder-Agent für das Dokumentenwesen in diesem Arbeitsverzeichnis.

Aufgabe:
- Finde die relevantesten Dateien oder Ordner für die Anfrage des Users.
- Nutze deine Such- und Dateitools frei, aber konzentriere dich auf Finden und Priorisieren, nicht auf breite Inhaltszusammenfassungen.
- Sortiere die Ergebnisse nach Relevanz: wichtigste zuerst.

Standard-Ausgabeformat:
- Pro Treffer genau diese vier Dinge:
  - Pfad
  - Kurze Beschreibung
  - Warum relevant
  - Confidence
- Kurze Beschreibung: genau ein kurzer Satz.
- Warum relevant: genau ein kurzer Satz.
- Confidence: kurz und klar, zum Beispiel high / medium / low.
- Antworte knapp und ohne Einleitung oder Schlussformel.

Wichtig:
- Wenn die User-Anfrage zusätzliche Anforderungen an Format, Anzahl, Tiefe oder Auswahl stellt, dann haben diese Vorrang.
- Erfinde keine Dateien.
- Wenn wenig Relevantes existiert, nenne lieber wenige gute Treffer als viele schwache.
`;

const CODE_PROMPT = `Du bist ein Finder-Agent für das Code-Verzeichnis in diesem Arbeitsverzeichnis.

Aufgabe:
- Finde die relevantesten Dateien oder Ordner für die Anfrage des Users.
- Nutze deine Such- und Dateitools frei, aber konzentriere dich auf Finden und Priorisieren, nicht auf breite Inhaltszusammenfassungen.
- Sortiere die Ergebnisse nach Relevanz: wichtigste zuerst.

Standard-Ausgabeformat:
- Pro Treffer genau diese vier Dinge:
  - Pfad
  - Kurze Beschreibung
  - Warum relevant
  - Confidence
- Kurze Beschreibung: genau ein kurzer Satz.
- Warum relevant: genau ein kurzer Satz.
- Confidence: kurz und klar, zum Beispiel high / medium / low.
- Antworte knapp und ohne Einleitung oder Schlussformel.

Wichtig:
- Wenn die User-Anfrage zusätzliche Anforderungen an Format, Anzahl, Tiefe oder Auswahl stellt, dann haben diese Vorrang.
- Erfinde keine Dateien.
- Wenn wenig Relevantes existiert, nenne lieber wenige gute Treffer als viele schwache.
`;

const DOCS_TARGET = {
  key: "docs" as const,
  label: "DOCS",
  workdirName: "docs",
  promptFile: "docs.md",
  defaultPrompt: DOCS_PROMPT,
};

const CODE_TARGET = {
  key: "code" as const,
  label: "CODE",
  workdirName: "code",
  promptFile: "code.md",
  defaultPrompt: CODE_PROMPT,
};

type FindTarget = typeof DOCS_TARGET | typeof CODE_TARGET;

function getWorkspacePromptsDir(): string {
  return path.join(process.env.HOME || "", ".openclaw/workspace/prompts/find");
}

function resolveTargetWorkdir(target: FindTarget): string {
  return path.join(process.env.HOME || "", target.workdirName);
}

interface FindOptions {
  docs?: boolean;
  code?: boolean;
}

interface RunResult {
  target: FindTarget;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  elapsedMs: number;
  error?: string;
}

export async function findRun(prompt: string, options: FindOptions): Promise<void> {
  const selectedTargets = getSelectedTargets(options);
  ensurePromptFilesExist(selectedTargets);
  ensureFinderCommandAvailable();

  const results = await Promise.all(selectedTargets.map((target) => runTarget(target, prompt)));
  let successCount = 0;

  for (const result of results) {
    if (result.success) {
      successCount++;
    }

    console.log(`=== ${result.target.label} ===`);

    if (result.success) {
      console.log(result.stdout.trim() || "(keine Ausgabe)");
    } else {
      console.log(`FEHLER: ${result.error || `OpenCode exit ${result.exitCode ?? "unknown"}`}`);
      const stderr = result.stderr.trim();
      if (stderr) {
        console.log("");
        console.log(stderr);
      }
    }

    if (result !== results[results.length - 1]) {
      console.log("");
    }
  }

  process.exit(successCount > 0 ? 0 : 1);
}

export function findInit(): void {
  const workspacePromptsDir = getWorkspacePromptsDir();
  fs.mkdirSync(workspacePromptsDir, { recursive: true });

  for (const target of [DOCS_TARGET, CODE_TARGET]) {
    const targetPath = path.join(workspacePromptsDir, target.promptFile);
    fs.writeFileSync(targetPath, target.defaultPrompt, "utf8");
    console.log(`✅ ${targetPath}`);
  }
}

function getSelectedTargets(options: FindOptions): FindTarget[] {
  const explicitDocs = !!options.docs;
  const explicitCode = !!options.code;

  if (explicitDocs && explicitCode) {
    return [DOCS_TARGET, CODE_TARGET];
  }
  if (explicitDocs) {
    return [DOCS_TARGET];
  }
  if (explicitCode) {
    return [CODE_TARGET];
  }
  return [DOCS_TARGET, CODE_TARGET];
}

function ensurePromptFilesExist(targets: FindTarget[]): void {
  const missing = targets
    .map((target) => path.join(getWorkspacePromptsDir(), target.promptFile))
    .filter((filePath) => !fs.existsSync(filePath));

  if (missing.length > 0) {
    const missingList = missing.map((filePath) => `- ${filePath}`).join("\n");
    throw new Error(
      `Find-Prompts fehlen. Bitte zuerst 'openclaw pibo find init' ausführen.\n${missingList}`,
    );
  }
}

function ensureFinderCommandAvailable(): void {
  const probe = spawnSync(FINDER_COMMAND, ["--version"], { stdio: "ignore" });
  if (!probe.error) {
    return;
  }

  const code =
    typeof probe.error === "object" && probe.error && "code" in probe.error
      ? String(probe.error.code)
      : "";

  if (code === "ENOENT") {
    throw new Error(
      `OpenCode CLI nicht gefunden: '${FINDER_COMMAND}' ist nicht im PATH. ` +
        "Bitte OpenCode installieren oder PATH korrigieren, bevor 'openclaw pibo find' gestartet wird.",
    );
  }

  throw new Error(`OpenCode CLI konnte nicht gestartet werden: ${probe.error.message}`);
}

function writeStatusLine(target: FindTarget, message: string): void {
  process.stderr.write(`[openclaw pibo find] ${target.label}: ${message}\n`);
}

function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, elapsedMs) / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

async function runTarget(target: FindTarget, userPrompt: string): Promise<RunResult> {
  const promptPath = path.join(getWorkspacePromptsDir(), target.promptFile);
  const basePrompt = fs.readFileSync(promptPath, "utf8").trim();
  const finalPrompt = `${basePrompt}\n\n${userPrompt}`;
  const startedAt = Date.now();

  writeStatusLine(target, `started in ${resolveTargetWorkdir(target)}`);

  return new Promise<RunResult>((resolve) => {
    const heartbeat = setInterval(() => {
      writeStatusLine(
        target,
        `still searching (${formatElapsedMs(Date.now() - startedAt)} elapsed)`,
      );
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    const child = spawn(FINDER_COMMAND, ["run", "--agent", AGENT, "-m", MODEL, finalPrompt], {
      cwd: resolveTargetWorkdir(target),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: Omit<RunResult, "elapsedMs">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(heartbeat);
      const elapsedMs = Date.now() - startedAt;
      const status = result.success ? "finished" : "failed";
      const detail =
        result.error || (!result.success ? `exit ${result.exitCode ?? "unknown"}` : undefined);
      writeStatusLine(
        target,
        `${status} in ${formatElapsedMs(elapsedMs)}${detail ? ` (${detail})` : ""}`,
      );
      resolve({ ...result, elapsedMs });
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish({
        target,
        success: false,
        stdout,
        stderr,
        exitCode: null,
        error: error.message,
      });
    });

    child.on("close", (exitCode) => {
      finish({
        target,
        success: exitCode === 0,
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}
