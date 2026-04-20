import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../../../../extensions/browser/src/control-service.js";
import { BrowserPoolError, type DevBrowserProfileName } from "./types.js";

export async function stopBrowserPoolProfile(
  profile: DevBrowserProfileName,
  deps?: {
    startBrowserControlServiceFromConfigImpl?: typeof startBrowserControlServiceFromConfig;
    createBrowserControlContextImpl?: typeof createBrowserControlContext;
  },
): Promise<{ stopped: boolean }> {
  const startBrowserControlServiceFromConfigImpl =
    deps?.startBrowserControlServiceFromConfigImpl ?? startBrowserControlServiceFromConfig;
  const createBrowserControlContextImpl =
    deps?.createBrowserControlContextImpl ?? createBrowserControlContext;

  let state;
  try {
    state = await startBrowserControlServiceFromConfigImpl();
  } catch (err) {
    throw new BrowserPoolError(
      "PROFILE_NOT_READY",
      `Failed to start the browser control service for profile ${profile}.`,
      { cause: err },
    );
  }

  if (!state) {
    throw new BrowserPoolError(
      "PROFILE_NOT_READY",
      `Browser control service is unavailable for profile ${profile}.`,
    );
  }

  try {
    const result = await createBrowserControlContextImpl().forProfile(profile).stopRunningBrowser();
    return { stopped: result.stopped };
  } catch (err) {
    if (err instanceof BrowserPoolError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Profile") && message.includes("not found")) {
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
