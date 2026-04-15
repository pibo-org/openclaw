import { defaultRuntime } from "../../runtime.js";
import {
  parseAgentsListRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parsePiboCommandsGetDirRouteArgs,
  parsePiboCommandsListRouteArgs,
  parsePiboCommandsSetDirRouteArgs,
  parsePiboCommandsShowRouteArgs,
  parsePiboFindInitRouteArgs,
  parsePiboWorkflowsDescribeRouteArgs,
  parsePiboWorkflowsListRouteArgs,
  parsePiboTodoCheckRouteArgs,
  parsePiboTodoInitRouteArgs,
  parsePiboTodoStatusRouteArgs,
  parsePiboTodoTokensRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

type RouteArgParser<TArgs> = (argv: string[]) => TArgs | null;

type ParsedRouteArgs<TParse extends RouteArgParser<unknown>> = Exclude<ReturnType<TParse>, null>;

export type RoutedCommandDefinition<TParse extends RouteArgParser<unknown>> = {
  parseArgs: TParse;
  runParsedArgs: (args: ParsedRouteArgs<TParse>) => Promise<void>;
};

export type AnyRoutedCommandDefinition = {
  parseArgs: RouteArgParser<unknown>;
  runParsedArgs: (args: never) => Promise<void>;
};

function defineRoutedCommand<TParse extends RouteArgParser<unknown>>(
  definition: RoutedCommandDefinition<TParse>,
): RoutedCommandDefinition<TParse> {
  return definition;
}

export const routedCommandDefinitions = {
  health: defineRoutedCommand({
    parseArgs: parseHealthRouteArgs,
    runParsedArgs: async (args) => {
      const { healthCommand } = await import("../../commands/health.js");
      await healthCommand(args, defaultRuntime);
    },
  }),
  status: defineRoutedCommand({
    parseArgs: parseStatusRouteArgs,
    runParsedArgs: async (args) => {
      if (args.json) {
        const { statusJsonCommand } = await import("../../commands/status-json.js");
        await statusJsonCommand(
          {
            deep: args.deep,
            all: args.all,
            usage: args.usage,
            timeoutMs: args.timeoutMs,
          },
          defaultRuntime,
        );
        return;
      }
      const { statusCommand } = await import("../../commands/status.js");
      await statusCommand(args, defaultRuntime);
    },
  }),
  "gateway-status": defineRoutedCommand({
    parseArgs: parseGatewayStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { runDaemonStatus } = await import("../daemon-cli/status.js");
      await runDaemonStatus(args);
    },
  }),
  sessions: defineRoutedCommand({
    parseArgs: parseSessionsRouteArgs,
    runParsedArgs: async (args) => {
      const { sessionsCommand } = await import("../../commands/sessions.js");
      await sessionsCommand(args, defaultRuntime);
    },
  }),
  "agents-list": defineRoutedCommand({
    parseArgs: parseAgentsListRouteArgs,
    runParsedArgs: async (args) => {
      const { agentsListCommand } = await import("../../commands/agents.js");
      await agentsListCommand(args, defaultRuntime);
    },
  }),
  "config-get": defineRoutedCommand({
    parseArgs: parseConfigGetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigGet } = await import("../config-cli.js");
      await runConfigGet(args);
    },
  }),
  "config-unset": defineRoutedCommand({
    parseArgs: parseConfigUnsetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigUnset } = await import("../config-cli.js");
      await runConfigUnset(args);
    },
  }),
  "models-list": defineRoutedCommand({
    parseArgs: parseModelsListRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsListCommand } = await import("../../commands/models.js");
      await modelsListCommand(args, defaultRuntime);
    },
  }),
  "models-status": defineRoutedCommand({
    parseArgs: parseModelsStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsStatusCommand } = await import("../../commands/models.js");
      await modelsStatusCommand(args, defaultRuntime);
    },
  }),
  "pibo-todo-init": defineRoutedCommand({
    parseArgs: parsePiboTodoInitRouteArgs,
    runParsedArgs: async () => {
      const { todoInit } = await import("../pibo/commands/todo.js");
      await todoInit({});
    },
  }),
  "pibo-todo-status": defineRoutedCommand({
    parseArgs: parsePiboTodoStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { todoStatus } = await import("../pibo/commands/todo.js");
      todoStatus({ max: args.max });
    },
  }),
  "pibo-todo-check": defineRoutedCommand({
    parseArgs: parsePiboTodoCheckRouteArgs,
    runParsedArgs: async (args) => {
      const { todoCheck } = await import("../pibo/commands/todo.js");
      todoCheck({ max: args.max });
    },
  }),
  "pibo-todo-tokens": defineRoutedCommand({
    parseArgs: parsePiboTodoTokensRouteArgs,
    runParsedArgs: async (args) => {
      const { todoTokens } = await import("../pibo/commands/todo.js");
      todoTokens({ max: args.max });
    },
  }),
  "pibo-commands-list": defineRoutedCommand({
    parseArgs: parsePiboCommandsListRouteArgs,
    runParsedArgs: async () => {
      const { formatRegistrySummary, listCommands } =
        await import("../pibo/commands/commands/index.js");
      console.log(formatRegistrySummary(listCommands()));
    },
  }),
  "pibo-commands-get-dir": defineRoutedCommand({
    parseArgs: parsePiboCommandsGetDirRouteArgs,
    runParsedArgs: async () => {
      const { getCommandDir } = await import("../pibo/commands/commands/index.js");
      console.log(getCommandDir());
    },
  }),
  "pibo-commands-show": defineRoutedCommand({
    parseArgs: parsePiboCommandsShowRouteArgs,
    runParsedArgs: async (args) => {
      const { getCommandPrompt } = await import("../pibo/commands/commands/index.js");
      const result = getCommandPrompt(args.name);
      if (!result) {
        console.error(`Command nicht gefunden: ${args.name}`);
        process.exit(1);
      }
      console.log(result.content);
    },
  }),
  "pibo-commands-set-dir": defineRoutedCommand({
    parseArgs: parsePiboCommandsSetDirRouteArgs,
    runParsedArgs: async (args) => {
      const { setCommandDir } = await import("../pibo/commands/commands/index.js");
      const registry = setCommandDir(args.dir);
      console.log(`✅ Command-Verzeichnis gesetzt: ${registry.commandDir}`);
    },
  }),
  "pibo-find-init": defineRoutedCommand({
    parseArgs: parsePiboFindInitRouteArgs,
    runParsedArgs: async () => {
      const { findInit } = await import("../pibo/find/index.js");
      findInit();
    },
  }),
  "pibo-workflows-list": defineRoutedCommand({
    parseArgs: parsePiboWorkflowsListRouteArgs,
    runParsedArgs: async (args) => {
      const { workflowsList } = await import("../pibo/workflows/read-only.js");
      workflowsList({ json: args.json });
    },
  }),
  "pibo-workflows-describe": defineRoutedCommand({
    parseArgs: parsePiboWorkflowsDescribeRouteArgs,
    runParsedArgs: async (args) => {
      const { workflowsDescribe } = await import("../pibo/workflows/read-only.js");
      workflowsDescribe(args.moduleId, { json: args.json });
    },
  }),
};
