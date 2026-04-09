import { chromium } from "playwright-core";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const CDP_URL = "http://127.0.0.1:18800";
const STATE_PATH = path.join(
  process.env.HOME || "",
  ".openclaw/workspace/state/twitter/last_check_heartbeat.json"
);
const BROWSER_USER_DATA_DIR = path.join(
  process.env.HOME || "",
  ".openclaw/browser/openclaw/user-data/Default"
);

// ── Konstanten ─────────────────────────────────────────────────

/** Maximale Tweets, die pro Run gescannt werden */
const MAX_TWEETS_SCANNED = 50;

/** Nach diesem Limit wird abgebrochen (genug neue Tweets gefunden) */
const NEW_TWEETS_LIMIT = 20;

/** Scroll-Schritte zwischen Status-Checks */
const SCROLL_PASSES = 25;

// ── Kategorie & TL;DR ──────────────────────────────────────────

const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/ai\b|llm|gpt|claude|gemini|openai|anthropic|hugging ?face|gemma|o\d|grok|mistral|deepseek|chatbot|artificial intelligence/i, "AI"],
  [/code|dev|api|sdk|npm|github|repo|library|framework|typescript|javascript|python|react\b|node\.?js|docker|k8s|kubernetes/i, "Dev"],
  [/launch|release|launch|introducing|announc|new version|v\d+\.\d+|update.*mode|upgrade/i, "Release"],
  [/meme|joke|funny|hot people|slop|lmao|😂|💀|cartoon|comedy/i, "Humor"],
  [/money|funding|ipo|revenue|acquisition|valuation|stock|earnings|billion|trillion|market cap|acquired|buy/i, "Business"],
  [/research|study|paper|find|experiment|benchmark|eval|science|data set|dataset/i, "Research"],
  [/image|photo|picture|video|generate|prompt|creative\b|art\b|design|visual/i, "Media"],
  [/elon|tesla|spacex|starship|mars|rocket|boring|hyperloop|neuralink|x\b/i, "Elon"],
  [/regulation|europe|eu|government|law|policy|ban|censor|free?speech/i, "Politics"],
  [/crypto|bitcoin|eth|solana|web3|nft|defi|token|blockchain/i, "Crypto"],
];

function classifyTweet(text: string): string {
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(text)) return cat;
  }
  if (text.length < 20) return "Short";
  return "General";
}

function generateTldr(text: string): string {
  if (text.length <= 100) return text.replace(/\n+/g, " · ");
  const sentences = text.split(/(?<=[.!?:])\s+/);
  const first = sentences[0] || text;
  if (sentences.length > 3) return first.replace(/\n+/g, " · ") + " …";
  return first.replace(/\n+/g, " · ");
}

// ── Typen ──────────────────────────────────────────────────────

interface Tweet {
  author: string;
  text: string;
  statusId: string;
  url: string;
  repostedFrom: string | null;
  tldr: string;
  category: string;
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

// ── State I/O ──────────────────────────────────────────────────

function readState(): State {
  if (!fs.existsSync(STATE_PATH)) {
    return { lastCheck: null, seen: [], lastTweetCount: 0, lastNewTweetCount: 0, status: "initialized", notes: "" };
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

/**
 * Führt Browser-CDP-Recovery durch (aus Known-Issues).
 * Killt Zombie-Prozesse, räumt Lock-Files auf.
 */
async function recoverBrowser(): Promise<boolean> {
  console.log("🔧 Browser-Recovery wird ausgeführt...");

  try {
    // 1. Chrome-Prozesse mit CDP-Port killen
    try {
      const { stdout } = await execAsync(`lsof -ti:18800 2>/dev/null || true`);
      const pids = stdout.trim().split("\n").filter(Boolean);
      if (pids.length > 0) {
        console.log(`   Kill PID(s): ${pids.join(", ")}`);
        for (const pid of pids) {
          try {
            process.kill(parseInt(pid), "SIGKILL");
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {}

    // 2. Lock-Files entfernen
    const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    for (const lock of lockFiles) {
      const lockPath = path.join(BROWSER_USER_DATA_DIR, lock);
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
          console.log(`   Entfernt: ${lock}`);
        }
      } catch {}
    }

    console.log("✅ Recovery abgeschlossen.");
    return true;
  } catch (err) {
    console.error(`⚠️ Recovery fehlgeschlagen: ${err}`);
    return false;
  }
}

// ── Browser ────────────────────────────────────────────────────

/** Prüft, ob der native Browser läuft. Falls nicht: starten. */
async function ensureBrowserRunning(): Promise<boolean> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    browser.close();
    console.log("✅ Browser läuft bereits.");
    return true;
  } catch {
    console.log("🚀 Browser nicht erreichbar — starte...");
    try {
      // Erst Recovery versuchen
      await recoverBrowser();

      execSync("openclaw browser stop", { stdio: "pipe", timeout: 5000 });
      await new Promise((r) => setTimeout(r, 2000));

      execSync("openclaw browser start", { stdio: "pipe", timeout: 30000 });
      
      // Kurz warten, bis CDP-Port bereit ist
      let attempts = 0;
      while (attempts < 15) {
        try {
          const browser = await chromium.connectOverCDP(CDP_URL);
          browser.close();
          console.log("✅ Browser gestartet.");
          return true;
        } catch {
          attempts++;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      throw new Error("Browser startete nicht innerhalb von 30s");
    } catch (err) {
      console.error(`❌ Browser konnte nicht gestartet werden: ${err}`);
      console.error("\n💡 Tipp: Führe 'openclaw browser restart' aus oder starte Chrome manuell neu.");
      return false;
    }
  }
}

async function connectBrowser() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0]!;
  const page = ctx.pages().find((p) => p.url().includes("x.com")) ?? ctx.pages()[0]!;
  return { browser, page };
}

async function feedReadyCheck(page: any): Promise<boolean> {
  return page.evaluate(
    () => document.querySelectorAll("article[data-testid=tweet]").length > 0
  );
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
  page: any,
  knownHashes: string[]
): Promise<{ tweets: Tweet[]; totalScanned: number; newHashes: string[]; allIds: string[] }> {
  const result = await page.evaluate(
    async ({ knownSet, maxScanned, newLimit }: { knownSet: string[]; maxScanned: number; newLimit: number }) => {
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

      const blockedWords = [
        "compose","explore","notifications","home","i","settings","profile",
        "bookmarks","lists","communities","premium","jobs","connect_people",
        "chat","grok","jf","creators"
      ];

      for (let pass = 0; pass < maxScanned; pass++) {
        window.scrollBy(0, 1000);
        await new Promise((r) => setTimeout(r, 1500));

        const articles = document.querySelectorAll(
          "article[data-testid=tweet]"
        );

        for (const a of articles) {
          // ── PHASE 1: NUR statusId lesen (minimaler DOM-Zugriff) ──
          const statusLink = a.querySelector("a[href*='/status/']");
          const href = statusLink?.getAttribute("href") || "";
          const statusMatch = href.match(/\/status\/(\d+)/);
          const statusId = statusMatch ? statusMatch[1] : "";
          if (!statusId) continue;

          totalScanned++;

          // Duplikate auf dieser Seite ignorieren
          if (allIds.includes(statusId)) {
            totalScanned = Math.max(totalScanned, allIds.length);
            continue;
          }
          allIds.push(statusId);

          // ── PHASE 2: Hash-Check — bekannt? SOFORT überspringen! ──
          if (known.has(statusId)) continue;

          // ── PHASE 3: NEUER Tweet — JETZT erst vollen Content parsen ──
          const tt = a.querySelector("[data-testid=tweetText]");
          if (!tt) continue;
          const text = tt.textContent!.trim();

          // Text-Duplikat-Check
          if (allSeenText.has(text)) continue;
          allSeenText.add(text);

          // Repost erkennen
          const hasRepost = Array.from(a.querySelectorAll("span")).some(
            (el: Element) => {
              const t = (el as HTMLElement).textContent || "";
              return t.match(/reposted$/);
            }
          );

          // Links/Handles sammeln
          const links = a.querySelectorAll("a[role=link]");
          const hrefs: string[] = [];
          for (const l of links) {
            const h = (l as HTMLAnchorElement).getAttribute("href") || "";
            const m = h.match(/^\/([^\/]{1,30})$/);
            if (m && !blockedWords.includes(m[1].toLowerCase()) && !m[1].startsWith("status")) {
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

          tweets.push({ author: handle, text: text.substring(0, 200), statusId, url, repostedFrom });
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
    { knownSet: knownHashes, maxScanned: MAX_TWEETS_SCANNED, newLimit: NEW_TWEETS_LIMIT }
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
        console.error("❌ Feed nicht bereit nach 6s — Browser-Verbindung steht, aber X zeigt keinen Feed.");
        console.error("💡 Mögliche Ursachen: X-Session abgelaufen, Login erforderlich, oder Chrome-Crash.");
        console.error("💡 Versuche 'openclaw browser restart' oder Known-Issues: browser-cdp-failure.md");
        state.status = "browser-error";
        state.notes = "Feed not ready after 6s — possible session expired or Chrome crash";
        state.lastCheck = new Date().toISOString();
        writeState(state);
        process.exit(1);
      }
    }

    console.log("✅ Feed ready — Hash-Scan startet...\n");

    const { tweets, totalScanned, newHashes, allIds } = await extractTweetsHash(
      page,
      knownHashes
    );

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
      const t = tweets[i]!;
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

export async function twitterReset(noConfirm: boolean) {
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
