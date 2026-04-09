import { execSync, execFileSync } from "child_process";

export async function agentsTask(prompt: string) {
  const now = execSync('TZ="Europe/Berlin" date -Iseconds').toString().trim();

  console.log(`⏳ Erzeuge Cron-Job: ${prompt}`);

  execFileSync("openclaw", [
    "cron", "add",
    "--name", "Agents Task",
    "--announce", "--channel", "telegram", "--to", "6214977845",
    "--at", now,
    "--session", "isolated",
    "--model", "minimax/MiniMax-M2.7-highspeed",
    "--message", prompt,
    "--keep-after-run",
  ], { stdio: "inherit" });

  console.log("✅ Cron-Job erstellt — Ergebnis kommt per Telegram.");
}
