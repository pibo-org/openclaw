import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

type TelegramSubagentHooksModule = typeof import("./api.js");

let telegramSubagentHooksPromise: Promise<TelegramSubagentHooksModule> | null = null;

function loadTelegramSubagentHooksModule() {
  telegramSubagentHooksPromise ??= import("./api.js");
  return telegramSubagentHooksPromise;
}

export default defineBundledChannelEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "telegramPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setTelegramRuntime",
  },
  registerFull(api) {
    api.on("subagent_spawning", async (event) => {
      const { handleTelegramSubagentSpawning } = await loadTelegramSubagentHooksModule();
      return await handleTelegramSubagentSpawning(api, event);
    });
    api.on("subagent_delivery_target", async (event) => {
      const { handleTelegramSubagentDeliveryTarget } = await loadTelegramSubagentHooksModule();
      return handleTelegramSubagentDeliveryTarget(event);
    });
    api.on("subagent_ended", async (event) => {
      const { handleTelegramSubagentEnded } = await loadTelegramSubagentHooksModule();
      handleTelegramSubagentEnded(event);
    });
  },
});
