import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parsePositiveIntOrUndefined } from "../program/helpers.js";
import { resolveCronCreateSchedule } from "./schedule-options.js";
import {
  getCronChannelOptions,
  handleCronCliError,
  printCronJson,
  printCronList,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

export function registerCronStatusCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("status")
      .description("Show cron scheduler status")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.status", opts, {});
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronListCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("list")
      .description("List cron jobs")
      .option("--all", "Include disabled jobs", false)
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.list", opts, {
            includeDisabled: Boolean(opts.all),
          });
          if (opts.json) {
            printCronJson(res);
            return;
          }
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          printCronList(jobs, defaultRuntime);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronAddCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("add")
      .alias("create")
      .description("Add a cron job")
      .requiredOption("--name <name>", "Job name")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create job disabled", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
      .option("--agent <id>", "Agent id for this job")
      .option("--session <target>", "Session target (main|isolated)")
      .option("--session-key <key>", "Session key for job routing (e.g. agent:my-agent:my-session)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now")
      .option(
        "--at <when>",
        "Run once at time (ISO with offset, or +duration). Use --tz for offset-less datetimes",
      )
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)", "")
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option("--workflow <moduleId>", "PIBO workflow module id")
      .option("--input-json <json>", "JSON workflow input payload")
      .option("--max-rounds <n>", "Workflow round limit")
      .option("--async-workflow", "Start workflow asynchronously", false)
      .option(
        "--thinking <level>",
        "Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)",
      )
      .option("--model <model>", "Model override for agent jobs (provider/model or alias)")
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option("--light-context", "Use lightweight bootstrap context for agent jobs", false)
      .option("--tools <csv>", "Comma-separated tool allow-list (e.g. exec,read,write)")
      .option("--announce", "Announce summary to a chat (subagent-style)", false)
      .option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.")
      .option("--no-deliver", "Disable announce delivery and skip main-session summary")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--account <id>", "Channel account id for delivery (multi-account setups)")
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)
      .option("--json", "Output JSON", false)
      .action(async (opts: GatewayRpcOpts & Record<string, unknown>, cmd?: Command) => {
        try {
          const schedule = resolveCronCreateSchedule({
            at: opts.at,
            cron: opts.cron,
            every: opts.every,
            exact: opts.exact,
            stagger: opts.stagger,
            tz: opts.tz,
          });

          const wakeMode = normalizeOptionalString(opts.wake) ?? "now";
          if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
            throw new Error("--wake must be now or next-heartbeat");
          }

          const rawAgentId = normalizeOptionalString(opts.agent);
          const agentId = rawAgentId ? sanitizeAgentId(rawAgentId) : undefined;

          const optionSource =
            typeof cmd?.getOptionValueSource === "function"
              ? (name: string) => cmd.getOptionValueSource(name)
              : () => undefined;
          const deliverSource = optionSource("deliver");
          const channelSource = optionSource("channel");
          const toSource = optionSource("to");
          const hasExplicitDeliverFlag = deliverSource === "cli";
          const hasExplicitChannel = channelSource === "cli";
          const hasExplicitTo = toSource === "cli";
          const hasAnnounce =
            Boolean(opts.announce) || (hasExplicitDeliverFlag && opts.deliver === true);
          const hasNoDeliver = hasExplicitDeliverFlag && opts.deliver === false;
          const deliveryFlagCount = [hasAnnounce, hasNoDeliver].filter(Boolean).length;
          if (deliveryFlagCount > 1) {
            throw new Error("Choose at most one of --announce or --no-deliver");
          }

          const payload = (() => {
            const systemEvent = normalizeOptionalString(opts.systemEvent) ?? "";
            const message = normalizeOptionalString(opts.message) ?? "";
            const workflow = normalizeOptionalString(opts.workflow) ?? "";
            const chosen = [Boolean(systemEvent), Boolean(message), Boolean(workflow)].filter(
              Boolean,
            ).length;
            if (chosen !== 1) {
              throw new Error(
                "Choose exactly one payload: --system-event, --message, or --workflow",
              );
            }
            if (systemEvent) {
              return { kind: "systemEvent" as const, text: systemEvent };
            }
            if (workflow) {
              let inputJson: unknown = {};
              if (typeof opts.inputJson === "string" && opts.inputJson.trim()) {
                try {
                  inputJson = JSON.parse(opts.inputJson);
                } catch (error) {
                  throw new Error(
                    `Invalid --input-json: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error },
                  );
                }
              }
              const maxRounds = parsePositiveIntOrUndefined(opts.maxRounds);
              return {
                kind: "workflowStart" as const,
                moduleId: workflow,
                input: inputJson,
                maxRounds: maxRounds && Number.isFinite(maxRounds) ? maxRounds : undefined,
                asyncStart: opts.asyncWorkflow === true ? true : undefined,
              };
            }
            const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
            return {
              kind: "agentTurn" as const,
              message,
              model: normalizeOptionalString(opts.model),
              thinking: normalizeOptionalString(opts.thinking),
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
              lightContext: opts.lightContext === true ? true : undefined,
              toolsAllow:
                typeof opts.tools === "string" && opts.tools.trim()
                  ? opts.tools
                      .split(",")
                      .map((t: string) => normalizeOptionalString(t))
                      .filter((t): t is string => Boolean(t))
                  : undefined,
            };
          })();

          const sessionSource = optionSource("session");
          const sessionTargetRaw = normalizeOptionalString(opts.session) ?? "";
          const inferredSessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
          const sessionTarget =
            sessionSource === "cli" ? sessionTargetRaw || "" : inferredSessionTarget;
          const isCustomSessionTarget =
            normalizeLowercaseStringOrEmpty(sessionTarget).startsWith("session:") &&
            Boolean(normalizeOptionalString(sessionTarget.slice(8)));
          const isIsolatedLikeSessionTarget =
            sessionTarget === "isolated" || sessionTarget === "current" || isCustomSessionTarget;
          if (sessionTarget !== "main" && !isIsolatedLikeSessionTarget) {
            throw new Error("--session must be main, isolated, current, or session:<id>");
          }

          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new Error("Choose --delete-after-run or --keep-after-run, not both");
          }

          if (
            sessionTarget === "main" &&
            payload.kind !== "systemEvent" &&
            payload.kind !== "workflowStart"
          ) {
            throw new Error("Main jobs require --system-event or --workflow.");
          }
          if (sessionTarget === "isolated" && payload.kind !== "agentTurn") {
            throw new Error(
              "Isolated jobs require --message; workflow jobs do not support --session isolated.",
            );
          }
          if (
            (sessionTarget === "current" || isCustomSessionTarget) &&
            payload.kind !== "agentTurn" &&
            payload.kind !== "workflowStart"
          ) {
            throw new Error("Current/custom-session jobs require --message or --workflow.");
          }
          if (
            (opts.announce || hasExplicitDeliverFlag) &&
            (!isIsolatedLikeSessionTarget || payload.kind !== "agentTurn")
          ) {
            throw new Error("--announce/--no-deliver require a non-main agentTurn session target.");
          }

          const accountId = normalizeOptionalString(opts.account);

          if (accountId && (!isIsolatedLikeSessionTarget || payload.kind !== "agentTurn")) {
            throw new Error("--account requires a non-main agentTurn job with delivery.");
          }
          if (
            payload.kind === "workflowStart" &&
            (opts.announce ||
              hasExplicitDeliverFlag ||
              hasExplicitChannel ||
              hasExplicitTo ||
              accountId ||
              opts.bestEffortDeliver === true)
          ) {
            throw new Error(
              "workflowStart jobs do not support cron delivery flags; workflow reporting owns visible success delivery.",
            );
          }

          const deliveryMode =
            isIsolatedLikeSessionTarget && payload.kind === "agentTurn"
              ? hasAnnounce
                ? "announce"
                : hasNoDeliver
                  ? "none"
                  : "announce"
              : undefined;

          const name = normalizeOptionalString(opts.name) ?? "";
          if (!name) {
            throw new Error("--name is required");
          }

          const description = normalizeOptionalString(opts.description);

          const sessionKey = normalizeOptionalString(opts.sessionKey);

          const params = {
            name,
            description,
            enabled: !opts.disabled,
            deleteAfterRun: opts.deleteAfterRun ? true : opts.keepAfterRun ? false : undefined,
            agentId,
            sessionKey,
            schedule,
            sessionTarget,
            wakeMode,
            payload,
            delivery: deliveryMode
              ? {
                  mode: deliveryMode,
                  channel: normalizeOptionalString(opts.channel),
                  to: normalizeOptionalString(opts.to),
                  accountId,
                  bestEffort: opts.bestEffortDeliver ? true : undefined,
                }
              : undefined,
          };

          const res = await callGatewayFromCli("cron.add", opts, params);
          printCronJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
