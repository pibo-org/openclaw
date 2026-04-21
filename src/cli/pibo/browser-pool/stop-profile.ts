import { callBrowserRequest } from "../../../../extensions/browser/src/cli/browser-cli-shared.js";
import { BrowserPoolError, type DevBrowserProfileName } from "./types.js";

const BROWSER_POOL_STOP_TIMEOUT_MS = "30000";

export async function stopBrowserPoolProfile(
  profile: DevBrowserProfileName,
  deps?: {
    callBrowserRequestImpl?: typeof callBrowserRequest;
  },
): Promise<{ stopped: boolean }> {
  const callBrowserRequestImpl = deps?.callBrowserRequestImpl ?? callBrowserRequest;

  try {
    const result = await callBrowserRequestImpl<{ ok: true; stopped: boolean }>(
      {
        json: true,
        timeout: BROWSER_POOL_STOP_TIMEOUT_MS,
      },
      {
        method: "POST",
        path: "/stop",
        query: { profile },
      },
    );
    return { stopped: result.stopped };
  } catch (err) {
    if (err instanceof BrowserPoolError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (
      (message.includes("Profile") && message.includes("not found")) ||
      (message.includes("browser.request") && message.includes("not available"))
    ) {
      throw new BrowserPoolError(
        "PROFILE_NOT_READY",
        `Browser profile ${profile} is not configured or not available.`,
        { cause: err },
      );
    }
    throw new BrowserPoolError(
      "PROFILE_STOP_FAILED",
      `Failed to stop browser profile ${profile}.`,
      { cause: err },
    );
  }
}
