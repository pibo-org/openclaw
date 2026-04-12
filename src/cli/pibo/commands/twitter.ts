import { execSync } from "child_process";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { chromium, type Page } from "playwright-core";

const execAsync = promisify(exec);
const CDP_URL = "http://127.0.0.1:18800";
const STATE_PATH = path.join(
  process.env.HOME || "",
  ".openclaw/workspace/state/twitter/last_check_heartbeat.json",
);
function getBrowserProfileDirs(): string[] {
  const home = process.env.HOME || "";
  const candidates = [
    path.join(home, ".openclaw/browser/openclaw/user-data"),
    path.join(home, ".openclaw/browser-openclaw-profile"),
  ];

  try {
    const configPath = path.join(home, ".openclaw/openclaw.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        browser?: { profiles?: Record<string, { userDataDir?: string }> };
      };
      const configured = raw.browser?.profiles?.openclaw?.userDataDir;
      if (typeof configured === "string" && configured.trim()) {
        candidates.unshift(configured.trim());
      }
    }
  } catch {}

  return [...new Set(candidates)];
}

// ── Konstanten ─────────────────────────────────────────────────

/** Maximale Tweets, die pro Run gescannt werden */
const MAX_TWEETS_SCANNED = 50;

/** Nach diesem Limit wird abgebrochen (genug neue Tweets gefunden) */
const NEW_TWEETS_LIMIT = 20;

// ── Kategorie & TL;DR ──────────────────────────────────────────

const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [
    /ai\b|llm|gpt|claude|gemini|openai|anthropic|hugging ?face|gemma|o\d|grok|mistral|deepseek|chatbot|artificial intelligence/i,
    "AI",
  ],
  [
    /code|dev|api|sdk|npm|github|repo|library|framework|typescript|javascript|python|react\b|node\.?js|docker|k8s|kubernetes/i,
    "Dev",
  ],
  [
    /launch|release|launch|introducing|announc|new version|v\d+\.\d+|update.*mode|upgrade/i,
    "Release",
  ],
  [/meme|joke|funny|hot people|slop|lmao|😂|💀|cartoon|comedy/i, "Humor"],
  [
    /money|funding|ipo|revenue|acquisition|valuation|stock|earnings|billion|trillion|market cap|acquired|buy/i,
    "Business",
  ],
  [/research|study|paper|find|experiment|benchmark|eval|science|data set|dataset/i, "Research"],
  [/image|photo|picture|video|generate|prompt|creative\b|art\b|design|visual/i, "Media"],
  [/elon|tesla|spacex|starship|mars|rocket|boring|hyperloop|neuralink|x\b/i, "Elon"],
  [/regulation|europe|eu|government|law|policy|ban|censor|free?speech/i, "Politics"],
  [/crypto|bitcoin|eth|solana|web3|nft|defi|token|blockchain/i, "Crypto"],
];

function classifyTweet(text: string): string {
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(text)) {
      return cat;
    }
  }
  if (text.length < 20) {
    return "Short";
  }
  return "General";
}

function generateTldr(text: string): string {
  if (text.length <= 100) {
    return text.replace(/\n+/g, " · ");
  }
  const sentences = text.split(/(?<=[.!?:])\s+/);
  const first = sentences[0] || text;
  if (sentences.length > 3) {
    return first.replace(/\n+/g, " · ") + " …";
  }
  return first.replace(/\n+/g, " · ");
}

// ── Typen ──────────────────────────────────────────────────────

interface Tweet {
  author: string;
  text: string;
  statusId: string;
  url: string;
  repostedFrom: string | null;
}

interface State {
  lastCheck: string | null;
  /** Hash-basierter Seen-Set — alle je gesehenen statusIds */
  seen: string[];
  lastTweetCount: number;
  lastNewTweetCount: number;
  status: string;
  notes: string;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── State I/O ──────────────────────────────────────────────────

function readState(): State {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      lastCheck: null,
      seen: [],
      lastTweetCount: 0,
      lastNewTweetCount: 0,
      status: "initialized",
      notes: "",
    };
  }
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  // Migration: Alte State-Dateien haben maxStatusId/recentBuffer statt seen
  return {
    lastCheck: raw.lastCheck ?? null,
    seen: raw.seen ?? raw.recentBuffer ?? [],
    lastTweetCount: raw.lastTweetCount ?? 0,
    lastNewTweetCount: raw.lastNewTweetCount ?? 0,
    status: raw.status ?? "initialized",
    notes: raw.notes ?? "",
  };
}

function writeState(state: State): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ── Browser Recovery ───────────────────────────────────────────

const RECOVERY_WAIT_MS = 1500;
const TASK_DRAIN_TIMEOUT_MS = 10000;
const SAFE_RESTART_HOUR_START = 2;
const SAFE_RESTART_HOUR_END = 6;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function commandSucceeds(command: string, timeout = 15000): Promise<boolean> {
  try {
    await execAsync(command, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function getCdpPidList(): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`lsof -ti:18800 2>/dev/null || true`, { timeout: 5000 });
    return stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function removeBrowserLockFiles(): Promise<number> {
  const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  let removed = 0;

  for (const rootDir of getBrowserProfileDirs()) {
    for (const dir of [rootDir, path.join(rootDir, "Default")]) {
      for (const lock of lockFiles) {
        const lockPath = path.join(dir, lock);
        try {
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            removed++;
            console.log(`   Entfernt: ${lockPath}`);
          }
        } catch {}
      }
    }
  }

  return removed;
}

async function isBrowserReachable(): Promise<boolean> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    void browser.close();
    return true;
  } catch {
    return false;
  }
}

async function waitForBrowserReachable(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBrowserReachable()) {
      return true;
    }
    await wait(1500);
  }
  return false;
}

type RestartDecision = {
  allowed: boolean;
  reason: string;
};

function isInSafeRestartWindow(now = new Date()): boolean {
  const hour = now.getHours();
  return hour >= SAFE_RESTART_HOUR_START && hour < SAFE_RESTART_HOUR_END;
}

async function getRunningTaskCount(): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`openclaw tasks list --status running --json`, {
      timeout: TASK_DRAIN_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout) as { count?: unknown };
    return typeof parsed.count === "number" ? parsed.count : null;
  } catch {
    return null;
  }
}

async function getRecentCronSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `openclaw status --all 2>/dev/null | grep 'agent:main:cron:' || true`,
      { timeout: TASK_DRAIN_TIMEOUT_MS },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function hasCronOrHeartbeatActivity(): Promise<RestartDecision | null> {
  const recentCronLines = await getRecentCronSessions();
  if (recentCronLines.length > 0) {
    return {
      allowed: false,
      reason: `erkennbare Cron-/Heartbeat-Session-Aktivität (${recentCronLines.length} Session-Zeile(n) in openclaw status)`,
    };
  }
  return null;
}

async function canSafelyRestartGateway(): Promise<RestartDecision> {
  if (!isInSafeRestartWindow()) {
    return {
      allowed: false,
      reason: `außerhalb Safe-Window ${SAFE_RESTART_HOUR_START}:00-${SAFE_RESTART_HOUR_END}:00`,
    };
  }

  const runningTasks = await getRunningTaskCount();
  if (runningTasks == null) {
    return {
      allowed: false,
      reason: "running-task-Zustand konnte nicht sicher bestimmt werden",
    };
  }

  if (runningTasks > 0) {
    return {
      allowed: false,
      reason: `${runningTasks} laufende Background-Task(s) aktiv`,
    };
  }

  const cronOrHeartbeatActivity = await hasCronOrHeartbeatActivity();
  if (cronOrHeartbeatActivity) {
    return cronOrHeartbeatActivity;
  }

  return {
    allowed: true,
    reason: "keine laufenden Background-Tasks und im Safe-Window",
  };
}

async function tryGatewayRestartRecovery(): Promise<boolean> {
  const decision = await canSafelyRestartGateway();
  if (!decision.allowed) {
    console.log(`   Gateway-Restart übersprungen: ${decision.reason}`);
    return false;
  }

  console.log(`   Gateway-Restart freigegeben: ${decision.reason}`);

  try {
    execSync("openclaw gateway restart", { stdio: "pipe", timeout: 45000 });
  } catch (err) {
    console.error(`⚠️ Gateway-Restart fehlgeschlagen: ${formatUnknownError(err)}`);
    return false;
  }

  await wait(5000);

  const browserRestored = await recoverBrowser();
  if (!browserRestored) {
    console.error("⚠️ Browser blieb auch nach Gateway-Restart nicht erreichbar.");
    return false;
  }

  return true;
}

/**
 * Führt Browser-CDP-Recovery durch.
 * Wichtige Einsicht: Locks liegen im Profil-Root, nicht in Default/.
 * Außerdem reicht nur Port-Kill oft nicht, weil der Browser-Control-Pfad hängen kann.
 */
async function recoverBrowser(): Promise<boolean> {
  console.log("🔧 Browser-Recovery wird ausgeführt...");

  try {
    const pidsBefore = await getCdpPidList();
    if (pidsBefore.length > 0) {
      console.log(`   CDP PID(s) vor Recovery: ${pidsBefore.join(", ")}`);
    }

    console.log("   Schritt 1/4: openclaw browser stop");
    await commandSucceeds("openclaw browser stop", 10000);
    await wait(RECOVERY_WAIT_MS);

    const pidsAfterStop = await getCdpPidList();
    if (pidsAfterStop.length > 0) {
      console.log(
        `   Schritt 2/4: harte Kills für verbliebene CDP PID(s): ${pidsAfterStop.join(", ")}`,
      );
      for (const pid of pidsAfterStop) {
        try {
          process.kill(parseInt(pid, 10), "SIGKILL");
        } catch {}
      }
      await wait(RECOVERY_WAIT_MS);
    } else {
      console.log("   Schritt 2/4: keine verbliebenen CDP-PIDs");
    }

    console.log("   Schritt 3/4: Singleton-/Lock-Files entfernen");
    const removedLocks = await removeBrowserLockFiles();
    if (removedLocks === 0) {
      console.log("   Keine Lock-Files gefunden");
    }

    console.log("   Schritt 4/4: Browser neu starten");
    execSync("openclaw browser start", { stdio: "pipe", timeout: 45000 });

    const ready = await waitForBrowserReachable(45000);
    if (ready) {
      console.log("✅ Browser-Recovery erfolgreich.");
      return true;
    }

    console.error("⚠️ Recovery hat den Browser nicht wieder erreichbar gemacht.");
    return false;
  } catch (err) {
    console.error(`⚠️ Recovery fehlgeschlagen: ${formatUnknownError(err)}`);
    return false;
  }
}

// ── Browser ────────────────────────────────────────────────────

/** Prüft, ob der native Browser läuft. Falls nicht: starten. */
async function ensureBrowserRunning(): Promise<boolean> {
  if (await isBrowserReachable()) {
    console.log("✅ Browser läuft bereits.");
    return true;
  }

  console.log("🚀 Browser nicht erreichbar — Recovery-Strategie startet...");
  const recovered = await recoverBrowser();
  if (recovered) {
    return true;
  }

  console.warn("⚠️ Lokale Recovery hat nicht gereicht.");
  console.log("🛟 Prüfe Safe-Restart-Gate für Gateway-Eskalation...");

  const restarted = await tryGatewayRestartRecovery();
  if (restarted) {
    console.log("✅ Browser nach Gateway-Restart wieder erreichbar.");
    return true;
  }

  console.error("❌ Browser konnte nicht automatisch wiederhergestellt werden.");
  console.error(
    "💡 Auto-Restart wurde entweder blockiert oder hat nicht gereicht. Bitte später im Leerlauf erneut versuchen oder manuell eingreifen.",
  );
  return false;
}

async function connectBrowser() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("x.com")) ?? ctx.pages()[0];
  return { browser, page };
}

async function feedReadyCheck(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelectorAll("article[data-testid=tweet]").length > 0);
}

// ── Hash-basierte Extraktion ───────────────────────────────────
//
// Prinzip: statusId ist der Hash-Key
// 1. Erst NUR statusId lesen (minimaler DOM-Zugriff)
// 2. Hash-Check: Ist die ID im Seen-Set?
//    ✅ JA  → SOFORT überspringen. Kein Text, kein Parse, nichts.
//    ❌ NEU → Erst JETZT vollen Content parsen
// 3. Max MAX_TWEETS_SCANNED scannen, dann abbruch
// 4. Nur NEUE Tweets werden über die Bridge zurückgegeben

async function extractTweetsHash(
  page: Page,
  knownHashes: string[],
): Promise<{ tweets: Tweet[]; totalScanned: number; newHashes: string[]; allIds: string[] }> {
  const result = await page.evaluate(
    async ({
      knownSet,
      maxScanned,
      newLimit,
    }: {
      knownSet: string[];
      maxScanned: number;
      newLimit: number;
    }) => {
      const known = new Set(knownSet);
      const tweets: Array<{
        author: string;
        text: string;
        statusId: string;
        url: string;
        repostedFrom: string | null;
      }> = [];
      const allSeenText = new Set<string>();
      const allIds: string[] = [];
      const newHashes: string[] = [];
      let totalScanned = 0;
      let newCount = 0;

      const blockedWords = new Set([
        "compose",
        "explore",
        "notifications",
        "home",
        "i",
        "settings",
        "profile",
        "bookmarks",
        "lists",
        "communities",
        "premium",
        "jobs",
        "connect_people",
        "chat",
        "grok",
        "jf",
        "creators",
      ]);

      for (let pass = 0; pass < Math.min(maxScanned, 25); pass++) {
        window.scrollBy(0, 1000);
        await new Promise((r) => setTimeout(r, 1500));

        const articles = document.querySelectorAll("article[data-testid=tweet]");

        for (const a of articles) {
          // ── PHASE 1: NUR statusId lesen (minimaler DOM-Zugriff) ──
          const statusLink = a.querySelector("a[href*='/status/']");
          const href = statusLink?.getAttribute("href") || "";
          const statusMatch = href.match(/\/status\/(\d+)/);
          const statusId = statusMatch ? statusMatch[1] : "";
          if (!statusId) {
            continue;
          }

          totalScanned++;

          // Duplikate auf dieser Seite ignorieren
          if (allIds.includes(statusId)) {
            totalScanned = Math.max(totalScanned, allIds.length);
            continue;
          }
          allIds.push(statusId);

          // ── PHASE 2: Hash-Check — bekannt? SOFORT überspringen! ──
          if (known.has(statusId)) {
            continue;
          }

          // ── PHASE 3: NEUER Tweet — JETZT erst vollen Content parsen ──
          const tt = a.querySelector("[data-testid=tweetText]");
          if (!tt) {
            continue;
          }
          const text = tt.textContent.trim();

          // Text-Duplikat-Check
          if (allSeenText.has(text)) {
            continue;
          }
          allSeenText.add(text);

          // Repost erkennen
          const hasRepost = Array.from(a.querySelectorAll("span")).some((el: Element) => {
            const t = (el as HTMLElement).textContent || "";
            return t.match(/reposted$/);
          });

          // Links/Handles sammeln
          const links = a.querySelectorAll("a[role=link]");
          const hrefs: string[] = [];
          for (const l of links) {
            const h = (l as HTMLAnchorElement).getAttribute("href") || "";
            const m = h.match(/^\/([^/]{1,30})$/);
            if (m && !blockedWords.has(m[1].toLowerCase()) && !m[1].startsWith("status")) {
              hrefs.push("@" + m[1]);
            }
          }

          let handle = "";
          let repostedFrom: string | null = null;

          if (hasRepost && hrefs.length >= 2) {
            handle = hrefs[1]!;
            repostedFrom = hrefs[0]!;
          } else if (hrefs.length >= 1) {
            handle = hrefs[0]!;
          }

          const urlHandle = repostedFrom || handle;
          const url = urlHandle
            ? `https://x.com/${urlHandle.replace("@", "")}/status/${statusId}`
            : "";

          tweets.push({
            author: handle,
            text: text.substring(0, 200),
            statusId,
            url,
            repostedFrom,
          });
          newHashes.push(statusId);
          newCount++;

          // Early Exit: Genug neue Tweets gefunden
          if (newCount >= newLimit) {
            return { tweets, totalScanned, newHashes, allIds };
          }
        }

        // Early Exit: Maximum gescannt
        if (allIds.length >= maxScanned + 10) {
          break;
        }
      }

      return { tweets, totalScanned, newHashes, allIds };
    },
    { knownSet: knownHashes, maxScanned: MAX_TWEETS_SCANNED, newLimit: NEW_TWEETS_LIMIT },
  );

  return result;
}

// ── Commands ───────────────────────────────────────────────────

export async function twitterCheck(opts: { coldStart?: boolean; verbose?: boolean }) {
  console.log("🐦 Twitter Following Feed — Check (Hash-System)\n");

  const state = readState();
  const knownHashes = opts.coldStart ? [] : state.seen;

  console.log(`📦 Known Hashes: ${knownHashes.length}`);

  // Prüfen ob Browser läuft, sonst starten
  const browserOk = await ensureBrowserRunning();
  if (!browserOk) {
    console.error("\n❌ FATAL: Browser nicht verfügbar.");
    state.status = "browser-error";
    state.notes = "Browser CDP connection failed after recovery";
    state.lastCheck = new Date().toISOString();
    writeState(state);
    process.exit(1);
  }

  console.log("🌐 Browser verbinden...");
  const { browser, page } = await connectBrowser();

  try {
    if (!page.url().includes("x.com")) {
      console.log("📍 Navigiere zu x.com/home...");
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
    }

    const ready = await feedReadyCheck(page);
    if (!ready) {
      console.log("⏳ Warte auf Feed...");
      await page.waitForTimeout(3000);
      const ready2 = await feedReadyCheck(page);
      if (!ready2) {
        console.error(
          "❌ Feed nicht bereit nach 6s — Browser-Verbindung steht, aber X zeigt keinen Feed.",
        );
        console.error(
          "💡 Mögliche Ursachen: X-Session abgelaufen, Login erforderlich, oder Chrome-Crash.",
        );
        console.error(
          "💡 Versuche 'openclaw browser restart' oder Known-Issues: browser-cdp-failure.md",
        );
        state.status = "browser-error";
        state.notes = "Feed not ready after 6s — possible session expired or Chrome crash";
        state.lastCheck = new Date().toISOString();
        writeState(state);
        process.exit(1);
      }
    }

    console.log("✅ Feed ready — Hash-Scan startet...\n");

    const { tweets, totalScanned, allIds } = await extractTweetsHash(page, knownHashes);

    // Neue Hashes zum Set hinzufügen
    const updatedSeen = [...new Set([...knownHashes, ...allIds])];

    // Limitiere Seen-Set auf 5000 Einträge (älteste entfernen)
    const trimmedSeen = updatedSeen.slice(Math.max(0, updatedSeen.length - 5000));

    // State aktualisieren
    state.lastCheck = new Date().toISOString();
    state.seen = trimmedSeen;
    state.lastTweetCount = totalScanned;
    state.lastNewTweetCount = tweets.length;
    state.status = tweets.length > 0 ? "success" : "feed-empty";
    state.notes = opts.coldStart ? "Cold Start done" : "";
    writeState(state);

    // Ausgabe
    console.log(`📦 Known Hashes (vorher): ${knownHashes.length}`);
    console.log(`📊 Tweets gescannt: ${totalScanned}`);
    console.log(`📊 Neue Tweets: ${tweets.length}`);
    console.log(`📦 Known Hashes (nachher): ${state.seen.length}`);

    if (tweets.length === 0) {
      console.log("\n✅ Keine neuen Tweets.");
      process.exit(0);
    }

    console.log("\n─── Neue Tweets ───\n");
    const limit = opts.verbose ? tweets.length : Math.min(tweets.length, 10);
    for (let i = 0; i < limit; i++) {
      const t = tweets[i];
      const category = classifyTweet(t.text);
      const tldr = generateTldr(t.text);

      if (t.repostedFrom) {
        console.log(`${t.author} (Repost von ${t.repostedFrom})`);
      } else {
        console.log(t.author);
      }
      console.log(`  "${tldr}"`);
      console.log(`  📂 ${category}  🔗 ${t.url}`);
      console.log("");
    }
    if (!opts.verbose && tweets.length > 10) {
      console.log(`... und ${tweets.length - 10} weitere.`);
    }
  } finally {
    await browser.close();
  }
}

export async function twitterStatus() {
  const state = readState();
  console.log(JSON.stringify(state, null, 2));
}

export async function twitterReset(_noConfirm: boolean) {
  const state: State = {
    lastCheck: null,
    seen: [],
    lastTweetCount: 0,
    lastNewTweetCount: 0,
    status: "initialized",
    notes: "Manuell zurückgesetzt",
  };
  writeState(state);
  console.log("✅ Twitter Heartbeat State zurückgesetzt.");
}
