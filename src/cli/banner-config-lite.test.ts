import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import { readCliBannerTaglineMode } from "./banner-config-lite.js";

const createConfigIOMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    createConfigIO: createConfigIOMock,
  };
});

describe("readCliBannerTaglineMode", () => {
  beforeEach(() => {
    createConfigIOMock.mockReset();
  });

  it("reads cli.banner.taglineMode from the raw config file without loadConfig", () => {
    withTempDirSync({ prefix: "banner-config-lite-" }, (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        `{
          cli: {
            banner: {
              taglineMode: "off",
            },
          },
        }`,
      );

      const mode = readCliBannerTaglineMode({
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      });

      expect(mode).toBe("off");
      expect(createConfigIOMock).not.toHaveBeenCalled();
    });
  });

  it("falls back to undefined when the raw config does not expose a supported tagline mode", () => {
    withTempDirSync({ prefix: "banner-config-lite-" }, (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      fs.writeFileSync(configPath, `{ cli: { banner: { taglineMode: "${"{BANNER_MODE}"}" } } }`);

      const mode = readCliBannerTaglineMode({
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      });

      expect(mode).toBeUndefined();
      expect(createConfigIOMock).not.toHaveBeenCalled();
    });
  });
});
