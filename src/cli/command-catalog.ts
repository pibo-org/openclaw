export type CliCommandPluginLoadPolicy = "never" | "always" | "text-only";
export type CliRouteConfigGuardPolicy = "never" | "always" | "when-suppressed";
export type CliRoutedCommandId =
  | "health"
  | "status"
  | "gateway-status"
  | "sessions"
  | "agents-list"
  | "config-get"
  | "config-unset"
  | "models-list"
  | "models-status"
  | "pibo-todo-init"
  | "pibo-todo-status"
  | "pibo-todo-check"
  | "pibo-todo-tokens"
  | "pibo-commands-list"
  | "pibo-commands-get-dir"
  | "pibo-commands-show"
  | "pibo-commands-set-dir"
  | "pibo-find-init"
  | "pibo-workflows-list"
  | "pibo-workflows-describe";

export type CliCommandPathPolicy = {
  bypassConfigGuard: boolean;
  routeConfigGuard: CliRouteConfigGuardPolicy;
  loadPlugins: CliCommandPluginLoadPolicy;
  hideBanner: boolean;
  ensureCliPath: boolean;
};

export type CliCommandCatalogEntry = {
  commandPath: readonly string[];
  exact?: boolean;
  policy?: Partial<CliCommandPathPolicy>;
  route?: {
    id: CliRoutedCommandId;
    preloadPlugins?: boolean;
  };
};

export const cliCommandCatalog: readonly CliCommandCatalogEntry[] = [
  { commandPath: ["agent"], policy: { loadPlugins: "always" } },
  { commandPath: ["message"], policy: { loadPlugins: "always" } },
  { commandPath: ["channels"], policy: { loadPlugins: "always" } },
  { commandPath: ["directory"], policy: { loadPlugins: "always" } },
  { commandPath: ["agents"], policy: { loadPlugins: "always" } },
  { commandPath: ["configure"], policy: { loadPlugins: "always" } },
  { commandPath: ["pibo", "workflows"], policy: { loadPlugins: "always" } },
  {
    commandPath: ["pibo", "workflows", "list"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false, loadPlugins: "never" },
    route: { id: "pibo-workflows-list" },
  },
  {
    commandPath: ["pibo", "workflows", "describe"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false, loadPlugins: "never" },
    route: { id: "pibo-workflows-describe" },
  },
  {
    commandPath: ["status"],
    policy: {
      loadPlugins: "text-only",
      routeConfigGuard: "when-suppressed",
      ensureCliPath: false,
    },
    route: { id: "status", preloadPlugins: true },
  },
  {
    commandPath: ["health"],
    policy: { loadPlugins: "text-only", ensureCliPath: false },
    route: { id: "health", preloadPlugins: true },
  },
  {
    commandPath: ["gateway", "status"],
    exact: true,
    policy: { routeConfigGuard: "always" },
    route: { id: "gateway-status" },
  },
  {
    commandPath: ["sessions"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "sessions" },
  },
  {
    commandPath: ["agents", "list"],
    route: { id: "agents-list" },
  },
  {
    commandPath: ["config", "get"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "config-get" },
  },
  {
    commandPath: ["config", "unset"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "config-unset" },
  },
  {
    commandPath: ["models", "list"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "models-list" },
  },
  {
    commandPath: ["models", "status"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "models-status" },
  },
  {
    commandPath: ["pibo", "todo", "init"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-todo-init" },
  },
  {
    commandPath: ["pibo", "todo", "status"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-todo-status" },
  },
  {
    commandPath: ["pibo", "todo", "check"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-todo-check" },
  },
  {
    commandPath: ["pibo", "todo", "tokens"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-todo-tokens" },
  },
  {
    commandPath: ["pibo", "commands", "list"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-commands-list" },
  },
  {
    commandPath: ["pibo", "commands", "get-dir"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-commands-get-dir" },
  },
  {
    commandPath: ["pibo", "commands", "show"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-commands-show" },
  },
  {
    commandPath: ["pibo", "commands", "set-dir"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-commands-set-dir" },
  },
  {
    commandPath: ["pibo", "find", "init"],
    exact: true,
    policy: { bypassConfigGuard: true, ensureCliPath: false },
    route: { id: "pibo-find-init" },
  },
  { commandPath: ["backup"], policy: { bypassConfigGuard: true } },
  { commandPath: ["doctor"], policy: { bypassConfigGuard: true } },
  {
    commandPath: ["completion"],
    policy: {
      bypassConfigGuard: true,
      hideBanner: true,
    },
  },
  { commandPath: ["secrets"], policy: { bypassConfigGuard: true } },
  { commandPath: ["update"], policy: { hideBanner: true } },
  {
    commandPath: ["config", "validate"],
    exact: true,
    policy: { bypassConfigGuard: true },
  },
  {
    commandPath: ["config", "schema"],
    exact: true,
    policy: { bypassConfigGuard: true },
  },
  {
    commandPath: ["plugins", "update"],
    exact: true,
    policy: { hideBanner: true },
  },
  {
    commandPath: ["onboard"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["channels", "add"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
];
