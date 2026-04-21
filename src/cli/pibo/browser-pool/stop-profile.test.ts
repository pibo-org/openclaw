import { describe, expect, it, vi } from "vitest";
import { stopBrowserPoolProfile } from "./stop-profile.js";

type CallBrowserRequest =
  typeof import("../../../../extensions/browser/src/cli/browser-cli-shared.js").callBrowserRequest;

function createCallBrowserRequestStub(params: {
  result?: { ok: true; stopped: boolean };
  error?: Error;
}): {
  callBrowserRequestImpl: CallBrowserRequest;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (..._args: Parameters<CallBrowserRequest>) => {
    if (params.error) {
      throw params.error;
    }
    return params.result ?? { ok: true, stopped: true };
  });
  const callBrowserRequestImpl: CallBrowserRequest = async function <T>(
    ...args: Parameters<CallBrowserRequest>
  ): Promise<T> {
    return (await spy(...args)) as T;
  };
  return { callBrowserRequestImpl, spy };
}

describe("stopBrowserPoolProfile", () => {
  it("stops the profile through browser.request /stop", async () => {
    const { callBrowserRequestImpl, spy } = createCallBrowserRequestStub({
      result: { ok: true, stopped: true },
    });

    await expect(
      stopBrowserPoolProfile("dev-01", {
        callBrowserRequestImpl,
      }),
    ).resolves.toEqual({ stopped: true });

    expect(spy).toHaveBeenCalledWith(
      {
        browserProfile: "dev-01",
        json: true,
        timeout: "30000",
      },
      {
        method: "POST",
        path: "/stop",
      },
    );
  });

  it("maps missing profile errors to PROFILE_NOT_READY", async () => {
    const { callBrowserRequestImpl } = createCallBrowserRequestStub({
      error: new Error("Profile dev-02 not found"),
    });

    await expect(
      stopBrowserPoolProfile("dev-02", {
        callBrowserRequestImpl,
      }),
    ).rejects.toMatchObject({
      code: "PROFILE_NOT_READY",
      message: "Browser profile dev-02 is not configured or not available.",
    });
  });

  it("maps gateway availability failures to PROFILE_NOT_READY", async () => {
    const { callBrowserRequestImpl } = createCallBrowserRequestStub({
      error: new Error("browser.request method not available on gateway"),
    });

    await expect(
      stopBrowserPoolProfile("dev-03", {
        callBrowserRequestImpl,
      }),
    ).rejects.toMatchObject({
      code: "PROFILE_NOT_READY",
      message: "Browser profile dev-03 is not configured or not available.",
    });
  });

  it("maps other stop failures to PROFILE_STOP_FAILED", async () => {
    const { callBrowserRequestImpl } = createCallBrowserRequestStub({
      error: new Error("gateway timeout"),
    });

    await expect(
      stopBrowserPoolProfile("dev-01", {
        callBrowserRequestImpl,
      }),
    ).rejects.toMatchObject({
      code: "PROFILE_STOP_FAILED",
      message: "Failed to stop browser profile dev-01.",
    });
  });
});
