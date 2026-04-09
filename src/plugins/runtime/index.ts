import { resolveStateDir } from "../../config/paths.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeManagedSessions } from "./runtime-managed-sessions.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimePiboWorkflows } from "./runtime-pibo-workflows.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";
import type { PluginRuntime } from "./types.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("./runtime-tts.runtime.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("./runtime-media-understanding.runtime.js"),
);
const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  return {
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

type RuntimeImageGenerationModule = Pick<
  typeof import("../../plugin-sdk/image-generation-runtime.js"),
  "generateImage" | "listRuntimeImageGenerationProviders"
>;
let cachedRuntimeImageGenerationModule: RuntimeImageGenerationModule | null = null;

function loadRuntimeImageGenerationModule(): RuntimeImageGenerationModule {
  cachedRuntimeImageGenerationModule ??=
    loadBundledPluginPublicSurfaceModuleSync<RuntimeImageGenerationModule>({
      dirName: "image-generation-core",
      artifactBasename: "runtime-api.js",
    });
  return cachedRuntimeImageGenerationModule;
}

function createRuntimeImageGeneration(): PluginRuntime["imageGeneration"] {
  return {
    generate: (params) => loadRuntimeImageGenerationModule().generateImage(params),
    listProviders: (params) =>
      loadRuntimeImageGenerationModule().listRuntimeImageGenerationProviders(params),
  };
}

function createRuntimeModelAuth(): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveApiKeyForProvider,
  );
  return {
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
      }),
  };
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}

const GATEWAY_SUBAGENT_SYMBOL: unique symbol = Symbol.for(
  "openclaw.plugin.gatewaySubagentRuntime",
) as unknown as typeof GATEWAY_SUBAGENT_SYMBOL;

type GatewaySubagentState = {
  subagent: PluginRuntime["subagent"] | undefined;
};

const gatewaySubagentState = resolveGlobalSingleton<GatewaySubagentState>(
  GATEWAY_SUBAGENT_SYMBOL,
  () => ({
    subagent: undefined,
  }),
);

export function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void {
  gatewaySubagentState.subagent = subagent;
}

export function clearGatewaySubagentRuntime(): void {
  gatewaySubagentState.subagent = undefined;
}

function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
  allowGatewaySubagentBinding = false,
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;
  }

  const unavailable = createUnavailableSubagentRuntime();
  if (!allowGatewaySubagentBinding) {
    return unavailable;
  }

  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
  allowGatewaySubagentBinding?: boolean;
};

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const taskFlow = createRuntimeTaskFlow();
  const tasks = createRuntimeTasks({
    legacyTaskFlow: taskFlow,
  });
  const subagent = createLateBindingSubagent(
    _options.subagent,
    _options.allowGatewaySubagentBinding === true,
  );
  const runtime = {
    version: VERSION,
    config: createRuntimeConfig(),
    agent: createRuntimeAgent(),
    subagent,
    managedSessions: createRuntimeManagedSessions(subagent),
    piboWorkflows: createRuntimePiboWorkflows(),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    channel: createRuntimeChannel(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
    tasks,
    taskFlow,
  } satisfies Omit<
    PluginRuntime,
    "tts" | "mediaUnderstanding" | "stt" | "modelAuth" | "imageGeneration"
  > &
    Partial<
      Pick<PluginRuntime, "tts" | "mediaUnderstanding" | "stt" | "modelAuth" | "imageGeneration">
    >;

  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "stt", () => ({
    transcribeAudioFile: mediaUnderstanding.transcribeAudioFile,
  }));
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
  defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);

  return runtime as PluginRuntime;
}

export type { PluginRuntime } from "./types.js";
