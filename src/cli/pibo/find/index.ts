import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import process from "process";

const MODEL = "minimax/MiniMax-M2.7-highspeed";
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
  error?: string;
}

export async function findRun(prompt: string, options: FindOptions): Promise<void> {
  const selectedTargets = getSelectedTargets(options);
  ensurePromptFilesExist(selectedTargets);

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

async function runTarget(target: FindTarget, userPrompt: string): Promise<RunResult> {
  const promptPath = path.join(getWorkspacePromptsDir(), target.promptFile);
  const basePrompt = fs.readFileSync(promptPath, "utf8").trim();
  const finalPrompt = `${basePrompt}\n\n${userPrompt}`;

  return new Promise<RunResult>((resolve) => {
    const child = spawn("opencode", ["run", "-m", MODEL, finalPrompt], {
      cwd: resolveTargetWorkdir(target),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      resolve({
        target,
        success: false,
        stdout,
        stderr,
        exitCode: null,
        error: error.message,
      });
    });

    child.on("close", (exitCode) => {
      resolve({
        target,
        success: exitCode === 0,
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}
