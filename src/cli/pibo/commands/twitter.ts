import { exec, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { chromium, type Page } from "playwright-core";

const execAsync = promisify(exec);
const CDP_URL = "http://127.0.0.1:18800";

export const TWITTER_DEFAULT_NEW_TWEETS = 20;
export const TWITTER_DEFAULT_MAX_SCANNED = 1000;
export const TWITTER_STATE_SEEN_LIMIT = 5000;
export const TWITTER_STAGNATION_PASS_LIMIT = 3;

const TWITTER_STATE_SCHEMA_VERSION = 1;
const RECOVERY_WAIT_MS = 1500;
const TASK_DRAIN_TIMEOUT_MS = 10000;
const SAFE_RESTART_HOUR_START = 2;
const SAFE_RESTART_HOUR_END = 6;
const FEED_READY_WAIT_MS = 3000;
const FEED_SCROLL_WAIT_MS = 1500;

export type TwitterFeed = "following" | "for-you";
export type TwitterStopReason =
  | "target_reached"
  | "max_scanned_reached"
  | "stagnated"
  | "feed_not_ready"
  | "browser_error";

export interface Tweet {
  statusId: string;
  url: string;
  author: string;
  text: string;
  feed: TwitterFeed;
  repostedFrom: string | null;
}

interface ExtractedTweetCandidate {
  statusId: string;
  url?: string;
  author: string;
  text: string;
  repostedFrom: string | null;
}

export interface TwitterState {
  schemaVersion: number;
  feed: TwitterFeed;
  lastCheck: string | null;
  seen: string[];
  lastTweetCount: number;
  lastNewTweetCount: number;
  status: string;
  notes: string;
  lastStopReason: TwitterStopReason | null;
}

interface TwitterCheckCliOptions {
  new?: number | string;
  maxScanned?: number | string;
  ignoreState?: boolean;
  noWriteState?: boolean;
  stateless?: boolean;
  json?: boolean;
}

interface ResolvedTwitterCheckOptions {
  requestedNewCount: number;
  maxScanned: number;
  ignoreState: boolean;
  writeState: boolean;
  json: boolean;
}

export interface TwitterCheckResult {
  feed: TwitterFeed;
  requestedNewCount: number;
  maxScanned: number;
  usedState: boolean;
  wroteState: boolean;
  totalScanned: number;
  newTweetsFound: number;
  stopReason: TwitterStopReason;
  tweets: Tweet[];
}

export interface TwitterScrapeLoopResult {
  tweets: Tweet[];
  totalScanned: number;
  stopReason: Extract<TwitterStopReason, "target_reached" | "max_scanned_reached" | "stagnated">;
  scannedStatusIds: string[];
}

interface CollectTweetsFromPassesParams {
  feed: TwitterFeed;
  knownStatusIds: string[];
  requestedNewCount: number;
  maxScanned: number;
  stagnationPassLimit?: number;
  loadPass: () => Promise<ExtractedTweetCandidate[]>;
  advance: () => Promise<void>;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getTwitterStateDir(): string {
  return path.join(process.env.HOME || "", ".openclaw/workspace/state/twitter");
}

export function getTwitterStatePath(feed: TwitterFeed): string {
  return path.join(getTwitterStateDir(), `${feed}.json`);
}

export function getLegacyTwitterLegacyStatePath(): string {
  return path.join(getTwitterStateDir(), "last_check_heartbeat.json");
}

export function normalizeTwitterFeed(feed: string): TwitterFeed {
  switch (feed.trim().toLowerCase()) {
    case "following":
      return "following";
    case "for-you":
    case "for_you":
    case "foryou":
      return "for-you";
    default:
      throw new Error(`Unsupported Twitter feed: ${feed}`);
  }
}

export function createEmptyTwitterState(feed: TwitterFeed): TwitterState {
  return {
    schemaVersion: TWITTER_STATE_SCHEMA_VERSION,
    feed,
    lastCheck: null,
    seen: [],
    lastTweetCount: 0,
    lastNewTweetCount: 0,
    status: "initialized",
    notes: "",
    lastStopReason: null,
  };
}

function normalizeSeenStatusIds(statusIds: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const statusId of statusIds) {
    const normalized = statusId.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped.slice(Math.max(0, deduped.length - TWITTER_STATE_SEEN_LIMIT));
}

function parseTwitterStateFromDisk(feed: TwitterFeed, raw: unknown): TwitterState {
  const source =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    schemaVersion:
      typeof source.schemaVersion === "number"
        ? source.schemaVersion
        : TWITTER_STATE_SCHEMA_VERSION,
    feed,
    lastCheck: typeof source.lastCheck === "string" ? source.lastCheck : null,
    seen: normalizeSeenStatusIds(
      Array.isArray(source.seen)
        ? source.seen.filter((value): value is string => typeof value === "string")
        : Array.isArray(source.recentBuffer)
          ? source.recentBuffer.filter((value): value is string => typeof value === "string")
          : [],
    ),
    lastTweetCount: typeof source.lastTweetCount === "number" ? source.lastTweetCount : 0,
    lastNewTweetCount: typeof source.lastNewTweetCount === "number" ? source.lastNewTweetCount : 0,
    status: typeof source.status === "string" ? source.status : "initialized",
    notes: typeof source.notes === "string" ? source.notes : "",
    lastStopReason:
      typeof source.lastStopReason === "string"
        ? (source.lastStopReason as TwitterStopReason)
        : null,
  };
}

function readStateFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function readTwitterState(feed: TwitterFeed): TwitterState {
  const statePath = getTwitterStatePath(feed);
  if (fs.existsSync(statePath)) {
    return parseTwitterStateFromDisk(feed, readStateFile(statePath));
  }

  if (feed === "following") {
    const legacyPath = getLegacyTwitterLegacyStatePath();
    if (fs.existsSync(legacyPath)) {
      const migrated = parseTwitterStateFromDisk(feed, readStateFile(legacyPath));
      if (!migrated.notes) {
        migrated.notes = "Loaded from legacy Twitter state";
      }
      return migrated;
    }
  }

  return createEmptyTwitterState(feed);
}

export function writeTwitterState(feed: TwitterFeed, state: TwitterState): void {
  fs.mkdirSync(path.dirname(getTwitterStatePath(feed)), { recursive: true });
  fs.writeFileSync(
    getTwitterStatePath(feed),
    JSON.stringify(
      {
        ...state,
        schemaVersion: TWITTER_STATE_SCHEMA_VERSION,
        feed,
        seen: normalizeSeenStatusIds(state.seen),
      },
      null,
      2,
    ) + "\n",
  );
}

function parsePositiveIntegerOption(
  name: "--new" | "--max-scanned",
  value: number | string | undefined,
  fallback: number,
): number {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function normalizeTwitterCheckOptions(
  opts: TwitterCheckCliOptions = {},
): ResolvedTwitterCheckOptions {
  const stateless = Boolean(opts.stateless);
  return {
    requestedNewCount: parsePositiveIntegerOption("--new", opts.new, TWITTER_DEFAULT_NEW_TWEETS),
    maxScanned: parsePositiveIntegerOption(
      "--max-scanned",
      opts.maxScanned,
      TWITTER_DEFAULT_MAX_SCANNED,
    ),
    ignoreState: stateless || Boolean(opts.ignoreState),
    writeState: !(stateless || Boolean(opts.noWriteState)),
    json: opts.json ?? true,
  };
}

export function buildTweetUrl(author: string, statusId: string): string {
  if (!statusId) {
    return "";
  }
  if (author.startsWith("@") && author.length > 1) {
    return `https://x.com/${author.slice(1)}/status/${statusId}`;
  }
  return `https://x.com/i/web/status/${statusId}`;
}

function normalizeTweetText(text: string): string {
  return text
    .replace(/\u00A0/g, " ")
    .replace(/\r/g, "")
    .trim();
}

export async function collectTweetsFromPasses(
  params: CollectTweetsFromPassesParams,
): Promise<TwitterScrapeLoopResult> {
  const knownStatusIds = new Set(params.knownStatusIds);
  const scannedStatusIds = new Set<string>();
  const tweets: Tweet[] = [];
  const stagnationPassLimit = params.stagnationPassLimit ?? TWITTER_STAGNATION_PASS_LIMIT;
  let totalScanned = 0;
  let stopReason: TwitterScrapeLoopResult["stopReason"] = "stagnated";

  for (let stagnantPasses = 0; ; ) {
    const candidates = await params.loadPass();
    let passProgress = 0;

    for (const candidate of candidates) {
      const statusId = candidate.statusId.trim();
      if (!statusId || scannedStatusIds.has(statusId)) {
        continue;
      }

      scannedStatusIds.add(statusId);
      totalScanned += 1;
      passProgress += 1;

      if (!knownStatusIds.has(statusId)) {
        tweets.push({
          statusId,
          url: candidate.url?.trim() || buildTweetUrl(candidate.author, statusId),
          author: candidate.author.trim(),
          text: normalizeTweetText(candidate.text),
          feed: params.feed,
          repostedFrom: candidate.repostedFrom,
        });

        if (tweets.length >= params.requestedNewCount) {
          stopReason = "target_reached";
          return {
            tweets,
            totalScanned,
            stopReason,
            scannedStatusIds: [...scannedStatusIds],
          };
        }
      }

      if (totalScanned >= params.maxScanned) {
        stopReason = "max_scanned_reached";
        return {
          tweets,
          totalScanned,
          stopReason,
          scannedStatusIds: [...scannedStatusIds],
        };
      }
    }

    stagnantPasses = passProgress === 0 ? stagnantPasses + 1 : 0;
    if (stagnantPasses >= stagnationPassLimit) {
      return {
        tweets,
        totalScanned,
        stopReason,
        scannedStatusIds: [...scannedStatusIds],
      };
    }

    await params.advance();
  }
}

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
            removed += 1;
            console.error(`Removed browser lock: ${lockPath}`);
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

async function hasAutomationActivity(): Promise<RestartDecision | null> {
  const recentCronLines = await getRecentCronSessions();
  if (recentCronLines.length > 0) {
    return {
      allowed: false,
      reason: `recognizable cron/background session activity (${recentCronLines.length} session line(s) in openclaw status)`,
    };
  }
  return null;
}

async function canSafelyRestartGateway(): Promise<RestartDecision> {
  if (!isInSafeRestartWindow()) {
    return {
      allowed: false,
      reason: `outside safe window ${SAFE_RESTART_HOUR_START}:00-${SAFE_RESTART_HOUR_END}:00`,
    };
  }

  const runningTasks = await getRunningTaskCount();
  if (runningTasks == null) {
    return {
      allowed: false,
      reason: "could not reliably determine running task count",
    };
  }

  if (runningTasks > 0) {
    return {
      allowed: false,
      reason: `${runningTasks} background task(s) still running`,
    };
  }

  const automationActivity = await hasAutomationActivity();
  if (automationActivity) {
    return automationActivity;
  }

  return {
    allowed: true,
    reason: "no running background tasks and inside safe window",
  };
}

async function tryGatewayRestartRecovery(): Promise<boolean> {
  const decision = await canSafelyRestartGateway();
  if (!decision.allowed) {
    console.error(`Gateway restart skipped: ${decision.reason}`);
    return false;
  }

  console.error(`Gateway restart allowed: ${decision.reason}`);

  try {
    execSync("openclaw gateway restart", { stdio: "pipe", timeout: 45000 });
  } catch (err) {
    console.error(`Gateway restart failed: ${formatUnknownError(err)}`);
    return false;
  }

  await wait(5000);

  const browserRestored = await recoverBrowser();
  if (!browserRestored) {
    console.error("Browser remained unreachable after gateway restart.");
    return false;
  }

  return true;
}

async function recoverBrowser(): Promise<boolean> {
  console.error("Running browser recovery...");

  try {
    const pidsBefore = await getCdpPidList();
    if (pidsBefore.length > 0) {
      console.error(`CDP PIDs before recovery: ${pidsBefore.join(", ")}`);
    }

    console.error("Recovery step 1/4: openclaw browser stop");
    await commandSucceeds("openclaw browser stop", 10000);
    await wait(RECOVERY_WAIT_MS);

    const pidsAfterStop = await getCdpPidList();
    if (pidsAfterStop.length > 0) {
      console.error(
        `Recovery step 2/4: force killing lingering CDP PIDs: ${pidsAfterStop.join(", ")}`,
      );
      for (const pid of pidsAfterStop) {
        try {
          process.kill(Number.parseInt(pid, 10), "SIGKILL");
        } catch {}
      }
      await wait(RECOVERY_WAIT_MS);
    } else {
      console.error("Recovery step 2/4: no lingering CDP PIDs");
    }

    console.error("Recovery step 3/4: removing singleton lock files");
    const removedLocks = await removeBrowserLockFiles();
    if (removedLocks === 0) {
      console.error("No browser lock files found");
    }

    console.error("Recovery step 4/4: openclaw browser start");
    execSync("openclaw browser start", { stdio: "pipe", timeout: 45000 });

    const ready = await waitForBrowserReachable(45000);
    if (ready) {
      console.error("Browser recovery succeeded.");
      return true;
    }

    console.error("Browser recovery did not restore CDP reachability.");
    return false;
  } catch (err) {
    console.error(`Browser recovery failed: ${formatUnknownError(err)}`);
    return false;
  }
}

async function ensureBrowserRunning(): Promise<boolean> {
  if (await isBrowserReachable()) {
    console.error("Browser is already reachable.");
    return true;
  }

  console.error("Browser is not reachable. Starting recovery...");
  const recovered = await recoverBrowser();
  if (recovered) {
    return true;
  }

  console.error("Local recovery was not enough. Checking gateway restart policy...");

  const restarted = await tryGatewayRestartRecovery();
  if (restarted) {
    console.error("Browser became reachable after gateway restart.");
    return true;
  }

  console.error("Browser could not be restored automatically.");
  return false;
}

async function connectBrowser() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error("No browser context available over CDP");
  }
  const page = context.pages().find((entry) => entry.url().includes("x.com")) ?? context.pages()[0];
  if (!page) {
    return { browser, page: await context.newPage() };
  }
  return { browser, page };
}

async function feedReadyCheck(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelectorAll("article[data-testid=tweet]").length > 0);
}

async function selectFeedTab(page: Page, feed: TwitterFeed): Promise<void> {
  const tabName = feed === "for-you" ? "For you" : "Following";
  const roleTab = page.getByRole("tab", { name: new RegExp(`^${tabName}$`, "i") }).first();

  if ((await roleTab.count()) === 0) {
    throw new Error(`Twitter feed tab not found: ${tabName}`);
  }

  if ((await roleTab.getAttribute("aria-selected")) !== "true") {
    await roleTab.click();
    await page.waitForTimeout(FEED_READY_WAIT_MS);
  }
}

async function navigateToFeed(page: Page, feed: TwitterFeed): Promise<void> {
  if (!page.url().includes("x.com/home")) {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(FEED_READY_WAIT_MS);
  }

  await selectFeedTab(page, feed);
}

async function extractVisibleTweetCandidates(page: Page): Promise<ExtractedTweetCandidate[]> {
  return page.evaluate(() => {
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

    const articles = Array.from(document.querySelectorAll("article[data-testid=tweet]"));

    return articles
      .map((article) => {
        const statusLink = article.querySelector("a[href*='/status/']");
        const href = statusLink?.getAttribute("href") ?? "";
        const statusMatch = href.match(/\/([^/?#]+)\/status\/(\d+)/);
        const statusId = statusMatch?.[2] ?? "";
        if (!statusId) {
          return null;
        }

        const statusAuthor = statusMatch?.[1] ? `@${statusMatch[1]}` : "";
        const tweetText = (
          article.querySelector("[data-testid=tweetText]")?.textContent ?? ""
        ).trim();
        const handles: string[] = [];

        for (const link of article.querySelectorAll("a[role=link]")) {
          const profileHref = (link as HTMLAnchorElement).getAttribute("href") ?? "";
          const handleMatch = profileHref.match(/^\/([^/?#]{1,30})$/);
          if (!handleMatch) {
            continue;
          }

          const handle = handleMatch[1].trim();
          if (!handle || blockedWords.has(handle.toLowerCase())) {
            continue;
          }

          const normalizedHandle = `@${handle}`;
          if (!handles.includes(normalizedHandle)) {
            handles.push(normalizedHandle);
          }
        }

        const hasRepost = Array.from(article.querySelectorAll("span")).some((element) =>
          /reposted$/i.test((element.textContent ?? "").trim()),
        );

        let author = statusAuthor || handles[0] || "";
        let repostedFrom: string | null = null;

        if (hasRepost && handles.length >= 2) {
          author = statusAuthor || handles[1] || handles[0] || "";
          repostedFrom = handles.find((handle) => handle !== author) ?? null;
        }

        const url = author
          ? `https://x.com/${author.replace(/^@/, "")}/status/${statusId}`
          : `https://x.com/i/web/status/${statusId}`;

        return {
          statusId,
          url,
          author,
          text: tweetText,
          repostedFrom,
        };
      })
      .filter((candidate): candidate is ExtractedTweetCandidate => Boolean(candidate));
  });
}

async function collectTweetsFromPage(
  page: Page,
  feed: TwitterFeed,
  knownStatusIds: string[],
  requestedNewCount: number,
  maxScanned: number,
): Promise<TwitterScrapeLoopResult> {
  return collectTweetsFromPasses({
    feed,
    knownStatusIds,
    requestedNewCount,
    maxScanned,
    loadPass: async () => extractVisibleTweetCandidates(page),
    advance: async () => {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(FEED_SCROLL_WAIT_MS);
    },
  });
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function updateTwitterStateAfterRun(
  state: TwitterState,
  loopResult: Pick<
    TwitterScrapeLoopResult,
    "totalScanned" | "stopReason" | "scannedStatusIds" | "tweets"
  >,
): TwitterState {
  return {
    ...state,
    lastCheck: new Date().toISOString(),
    seen: normalizeSeenStatusIds([...state.seen, ...loopResult.scannedStatusIds]),
    lastTweetCount: loopResult.totalScanned,
    lastNewTweetCount: loopResult.tweets.length,
    status: loopResult.tweets.length > 0 ? "success" : "idle",
    notes: "",
    lastStopReason: loopResult.stopReason,
  };
}

function updateTwitterStateForFailure(
  state: TwitterState,
  status: "feed_not_ready" | "browser_error",
  notes: string,
): TwitterState {
  return {
    ...state,
    lastCheck: new Date().toISOString(),
    status,
    notes,
    lastStopReason: status,
  };
}

export async function twitterCheckFeed(feedInput: string, opts: TwitterCheckCliOptions = {}) {
  const feed = normalizeTwitterFeed(feedInput);
  const normalizedOptions = normalizeTwitterCheckOptions(opts);
  const state = normalizedOptions.ignoreState
    ? createEmptyTwitterState(feed)
    : readTwitterState(feed);
  const knownStatusIds = normalizedOptions.ignoreState ? [] : state.seen;

  if (!(await ensureBrowserRunning())) {
    if (normalizedOptions.writeState) {
      writeTwitterState(
        feed,
        updateTwitterStateForFailure(
          state,
          "browser_error",
          "Browser CDP connection failed after recovery",
        ),
      );
    }
    throw new Error("Browser not available for Twitter feed scraping");
  }

  const { browser, page } = await connectBrowser();

  try {
    await navigateToFeed(page, feed);

    if (!(await feedReadyCheck(page))) {
      await page.waitForTimeout(FEED_READY_WAIT_MS);
      if (!(await feedReadyCheck(page))) {
        if (normalizedOptions.writeState) {
          writeTwitterState(
            feed,
            updateTwitterStateForFailure(
              state,
              "feed_not_ready",
              `Twitter ${feed} feed did not become ready`,
            ),
          );
        }
        throw new Error(`Twitter ${feed} feed not ready`);
      }
    }

    const loopResult = await collectTweetsFromPage(
      page,
      feed,
      knownStatusIds,
      normalizedOptions.requestedNewCount,
      normalizedOptions.maxScanned,
    );

    if (normalizedOptions.writeState) {
      writeTwitterState(feed, updateTwitterStateAfterRun(state, loopResult));
    }

    const result: TwitterCheckResult = {
      feed,
      requestedNewCount: normalizedOptions.requestedNewCount,
      maxScanned: normalizedOptions.maxScanned,
      usedState: !normalizedOptions.ignoreState,
      wroteState: normalizedOptions.writeState,
      totalScanned: loopResult.totalScanned,
      newTweetsFound: loopResult.tweets.length,
      stopReason: loopResult.stopReason,
      tweets: loopResult.tweets,
    };

    emitJson(result);
    return result;
  } catch (error) {
    if (normalizedOptions.writeState && error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes("browser")) {
        writeTwitterState(
          feed,
          updateTwitterStateForFailure(state, "browser_error", error.message),
        );
      } else if (message.includes("feed")) {
        writeTwitterState(
          feed,
          updateTwitterStateForFailure(state, "feed_not_ready", error.message),
        );
      }
    }
    throw error;
  } finally {
    await browser.close();
  }
}

export async function twitterCheckDeprecatedAlias(
  feed: TwitterFeed,
  opts: TwitterCheckCliOptions = {},
) {
  console.error(
    "Deprecated: `openclaw pibo twitter check` now defaults to `openclaw pibo twitter check following`.",
  );
  return twitterCheckFeed(feed, opts);
}

export async function twitterStatus(opts: { feed?: string } = {}) {
  const feed = normalizeTwitterFeed(opts.feed ?? "following");
  emitJson(readTwitterState(feed));
}

export async function twitterReset(opts: { feed?: string; y?: boolean } = {}) {
  const feed = normalizeTwitterFeed(opts.feed ?? "following");
  const state = createEmptyTwitterState(feed);
  state.notes = "Manually reset";
  writeTwitterState(feed, state);
  console.log(`Reset Twitter state for ${feed}.`);
}
