import type { FileUIPart } from "ai";
import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  abortChatRun,
  handleChatEvent,
  loadChatHistory,
  sendChatMessage,
  type ChatEventPayload,
} from "../../../ui/src/ui/controllers/chat.ts";
import {
  flushToolStreamSync,
  handleAgentEvent,
  resetToolStream,
  type AgentEventPayload,
} from "../../../ui/src/ui/app-tool-stream.ts";
import { shouldReloadHistoryForFinalEvent } from "../../../ui/src/ui/chat-event-reload.ts";
import { extractTextCached, extractThinkingCached } from "../../../ui/src/ui/chat/message-extract.ts";
import { GatewayBrowserClient, type GatewayHelloOk } from "../../../ui/src/ui/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../../ui/src/ui/types.ts";
import {
  BotIcon,
  CableIcon,
  LoaderCircleIcon,
  MenuIcon,
  RefreshCcwIcon,
  SendIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildDefaultGatewayUrl,
  createGatewayChatHost,
  filePartsToChatAttachments,
  formatRelativeTime,
  loadBootstrapConfig,
  loadCustomUiSettings,
  loadModelCatalog,
  persistCustomUiSettings,
  resolveActiveSessionKey,
  resolveSessionKeyWithDefaults,
  toRenderableMessage,
  type GatewayChatHost,
  type RenderableMessage,
  type SessionDefaultsSnapshot,
  type TranscriptAttachment,
} from "@/lib/openclaw";

type ConnectionState = "connecting" | "connected" | "disconnected";

type ChatSnapshot = {
  chatLoading: boolean;
  chatMessages: unknown[];
  chatRunId: string | null;
  chatSending: boolean;
  chatStream: string | null;
  chatStreamSegments: Array<{ text: string; ts: number }>;
  chatThinkingLevel: string | null;
  chatToolMessages: Record<string, unknown>[];
  connected: boolean;
  lastError: string | null;
  sessionKey: string;
};

function snapshotHost(host: GatewayChatHost): ChatSnapshot {
  return {
    chatLoading: host.chatLoading,
    chatMessages: [...host.chatMessages],
    chatRunId: host.chatRunId,
    chatSending: host.chatSending,
    chatStream: host.chatStream,
    chatStreamSegments: [...host.chatStreamSegments],
    chatThinkingLevel: host.chatThinkingLevel,
    chatToolMessages: [...host.chatToolMessages],
    connected: host.connected,
    lastError: host.lastError,
    sessionKey: host.sessionKey,
  };
}

function currentModelLabel(session: GatewaySessionRow | undefined) {
  return session?.model ?? "default";
}

function currentSessionSubtitle(session: GatewaySessionRow | undefined) {
  if (!session) {
    return "No session loaded";
  }
  const parts = [session.surface, session.subject, session.room].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : session.key;
}

function isExpectedDisconnectError(error: unknown): boolean {
  return error instanceof Error && error.message === "gateway client stopped";
}

function renderAttachmentGrid(attachments: TranscriptAttachment[]) {
  const nonAudio = attachments.filter((attachment) => !attachment.mediaType?.startsWith("audio/"));
  if (nonAudio.length === 0) {
    return null;
  }
  return (
    <Attachments variant={nonAudio.length > 1 ? "grid" : "list"}>
      {nonAudio.map((attachment) => (
        <Attachment data={attachment} key={attachment.id}>
          <AttachmentPreview />
          <AttachmentInfo showMediaType={nonAudio.length === 1} />
        </Attachment>
      ))}
    </Attachments>
  );
}

function renderAudioPlayers(attachments: TranscriptAttachment[]) {
  const audio = attachments.filter((attachment) => attachment.mediaType?.startsWith("audio/"));
  if (audio.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-2">
      {audio.map((attachment) => (
        <audio className="w-full max-w-sm" controls key={attachment.id} src={attachment.url}>
          <track kind="captions" />
        </audio>
      ))}
    </div>
  );
}

function MessageCard({ message, assistantAvatar }: { message: RenderableMessage; assistantAvatar: string }) {
  const timeLabel = formatRelativeTime(message.timestamp);
  return (
    <Message from={message.role === "user" ? "user" : "assistant"}>
      <div className="flex items-start gap-3">
        {message.role !== "user" ? (
          <div className="mt-1 flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            {assistantAvatar ? (
              <img alt="" className="size-full object-cover" src={assistantAvatar} />
            ) : (
              <BotIcon className="size-4 text-slate-300" />
            )}
          </div>
        ) : null}
        <div className={cn("grid min-w-0 gap-3", message.role === "user" && "w-full justify-items-end")}>
          <div className="flex items-center gap-2 px-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">
            <span>{message.role === "user" ? "Operator" : message.role === "system" ? "System" : "OpenClaw"}</span>
            {timeLabel ? <span>{timeLabel}</span> : null}
            {message.streaming ? <span className="text-amber-300">Streaming</span> : null}
          </div>
          <MessageContent className={cn(message.role !== "user" && "max-w-3xl")}>
            {message.reasoning ? (
              <Reasoning defaultOpen={false}>
                <ReasoningTrigger />
                <ReasoningContent>{message.reasoning}</ReasoningContent>
              </Reasoning>
            ) : null}
            {message.text ? <MessageResponse>{message.text}</MessageResponse> : null}
            {renderAttachmentGrid(message.attachments)}
            {renderAudioPlayers(message.attachments)}
            {message.tools.map((tool) => (
              <Tool className="bg-slate-950/40" defaultOpen={tool.state !== "output-available"} key={tool.id}>
                <ToolHeader state={tool.state} title={tool.title} toolName={tool.title} type="dynamic-tool" />
                <ToolContent>
                  {tool.input !== undefined ? <ToolInput input={tool.input} /> : null}
                  <ToolOutput errorText={tool.errorText} output={tool.output} />
                </ToolContent>
              </Tool>
            ))}
          </MessageContent>
        </div>
      </div>
    </Message>
  );
}

export function App({ initialGatewayToken }: { initialGatewayToken: string | null }) {
  const initialSettings = useMemo(() => {
    const settings = loadCustomUiSettings();
    if (initialGatewayToken && !settings.token) {
      return { ...settings, token: initialGatewayToken };
    }
    return settings;
  }, [initialGatewayToken]);
  const hostRef = useRef(createGatewayChatHost(initialSettings.sessionKey));
  const clientRef = useRef<GatewayBrowserClient | null>(null);
  const sessionDefaultsRef = useRef<SessionDefaultsSnapshot | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [connectionRequest, setConnectionRequest] = useState({
    ...initialSettings,
    nonce: 1,
  });
  const [bootstrap, setBootstrap] = useState({
    assistantAvatar: "",
    assistantName: "OpenClaw",
    basePath: "",
  });
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [hello, setHello] = useState<GatewayHelloOk | null>(null);
  const [sessionRows, setSessionRows] = useState<GatewaySessionRow[]>([]);
  const [modelCatalog, setModelCatalog] = useState<Awaited<ReturnType<typeof loadModelCatalog>>>([]);
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot>(() => snapshotHost(hostRef.current));
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  function syncFromHost() {
    const next = snapshotHost(hostRef.current);
    startTransition(() => {
      setChatSnapshot(next);
    });
  }

  useEffect(() => {
    void loadBootstrapConfig().then((nextBootstrap) => {
      setBootstrap(nextBootstrap);
      const defaultGatewayUrl = buildDefaultGatewayUrl("");
      const nextGatewayUrl = buildDefaultGatewayUrl(nextBootstrap.basePath);
      setSettings((current) =>
        current.gatewayUrl === defaultGatewayUrl ? { ...current, gatewayUrl: nextGatewayUrl } : current,
      );
      setConnectionRequest((current) =>
        current.gatewayUrl === defaultGatewayUrl ? { ...current, gatewayUrl: nextGatewayUrl } : current,
      );
    });
  }, []);

  async function refreshSessions(client = hostRef.current.client) {
    if (!client || !hostRef.current.connected) {
      return;
    }
    const result = await client.request<SessionsListResult>("sessions.list", {
      includeGlobal: false,
      includeUnknown: true,
      limit: 200,
    });
    const nextKey = resolveActiveSessionKey({
      currentSessionKey: hostRef.current.sessionKey,
      defaults: sessionDefaultsRef.current,
      sessions: result.sessions,
    });
    hostRef.current.sessionKey = nextKey;
    setSessionRows(result.sessions ?? []);
    persistCustomUiSettings({
      gatewayUrl: settings.gatewayUrl,
      sessionKey: nextKey,
      token: settings.token,
    });
    syncFromHost();
  }

  async function refreshHistory() {
    await loadChatHistory(hostRef.current);
    syncFromHost();
  }

  async function refreshModels(client = hostRef.current.client) {
    if (!client) {
      return;
    }
    const models = await loadModelCatalog(client);
    setModelCatalog(models);
  }

  useEffect(() => {
    const host = hostRef.current;
    host.sessionKey = settings.sessionKey;
    host.connected = false;
    host.client = null;
    host.lastError = null;
    resetToolStream(host);
    syncFromHost();

    const requestedSettings = connectionRequest;
    const client = new GatewayBrowserClient({
      clientName: "openclaw-control-ui",
      clientVersion: hello?.server?.version ?? "custom-ui",
      instanceId: "openclaw-custom-ui",
      mode: "webchat",
      password: requestedSettings.password,
      token: requestedSettings.token,
      url: requestedSettings.gatewayUrl,
      onGap: () => {
        host.lastError = "Event gap detected. Reconnecting...";
        syncFromHost();
        client.stop();
        setConnectionRequest((current) => ({ ...current, nonce: current.nonce + 1 }));
      },
      onHello: (nextHello) => {
        if (clientRef.current !== client) {
          return;
        }
        const snapshot = nextHello.snapshot as { sessionDefaults?: SessionDefaultsSnapshot } | undefined;
        sessionDefaultsRef.current = snapshot?.sessionDefaults ?? null;
        host.connected = true;
        host.client = client;
        host.lastError = null;
        host.sessionKey = resolveSessionKeyWithDefaults(host.sessionKey, sessionDefaultsRef.current);
        setConnectionState("connected");
        setHello(nextHello);
        persistCustomUiSettings({
          gatewayUrl: requestedSettings.gatewayUrl,
          sessionKey: host.sessionKey,
          token: requestedSettings.token,
        });
        syncFromHost();
        void client.request("sessions.subscribe", {}).catch(() => {});
        void Promise.all([refreshSessions(client), refreshModels(client)])
          .then(() => refreshHistory())
          .catch((error) => {
            if (isExpectedDisconnectError(error)) {
              return;
            }
            host.lastError = error instanceof Error ? error.message : String(error);
            syncFromHost();
          });
      },
      onClose: ({ error }) => {
        if (clientRef.current !== client) {
          return;
        }
        host.connected = false;
        host.client = null;
        if (error) {
          host.lastError = error.message;
        }
        setConnectionState("disconnected");
        syncFromHost();
      },
      onEvent: (event) => {
        if (clientRef.current !== client) {
          return;
        }
        if (event.event === "sessions.changed") {
          void refreshSessions(client);
          return;
        }
        if (event.event === "agent") {
          handleAgentEvent(host, event.payload as AgentEventPayload | undefined);
          flushToolStreamSync(host);
          syncFromHost();
          return;
        }
        if (event.event !== "chat") {
          return;
        }
        const payload = event.payload as ChatEventPayload | undefined;
        const state = handleChatEvent(host, payload);
        syncFromHost();
        if (state !== "final" && state !== "error" && state !== "aborted") {
          return;
        }
        const hadToolEvents = host.toolStreamOrder.length > 0;
        resetToolStream(host);
        syncFromHost();
        if (
          payload?.state === "final" &&
          (hadToolEvents || shouldReloadHistoryForFinalEvent(payload))
        ) {
          void refreshHistory();
        }
      },
    });

    clientRef.current = client;
    setConnectionState("connecting");
    client.start();

    return () => {
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      client.stop();
    };
  }, [
    connectionRequest.gatewayUrl,
    connectionRequest.nonce,
    connectionRequest.password,
    connectionRequest.token,
    hello?.server?.version,
  ]);

  async function handleReconnect() {
    persistCustomUiSettings({
      gatewayUrl: settings.gatewayUrl,
      sessionKey: settings.sessionKey,
      token: settings.token,
    });
    hostRef.current.sessionKey = settings.sessionKey;
    setConnectionRequest({
      ...settings,
      nonce: connectionRequest.nonce + 1,
    });
  }

  async function handleSelectSession(nextSessionKey: string) {
    hostRef.current.sessionKey = nextSessionKey;
    setSettings((current) => ({ ...current, sessionKey: nextSessionKey }));
    setMobilePanelOpen(false);
    persistCustomUiSettings({
      gatewayUrl: settings.gatewayUrl,
      sessionKey: nextSessionKey,
      token: settings.token,
    });
    syncFromHost();
    await refreshHistory();
  }

  async function handleSelectModel(modelId: string) {
    const client = hostRef.current.client;
    if (!client || !hostRef.current.connected) {
      return;
    }
    await client.request("sessions.patch", {
      key: hostRef.current.sessionKey,
      model: modelId,
    });
    setModelSelectorOpen(false);
    await refreshSessions(client);
    await refreshHistory();
  }

  async function handleSubmitPrompt(payload: { files: FileUIPart[]; text: string }) {
    const attachments = await filePartsToChatAttachments(payload.files);
    await sendChatMessage(hostRef.current, payload.text, attachments);
    syncFromHost();
  }

  async function handleAbortRun() {
    await abortChatRun(hostRef.current);
    syncFromHost();
  }

  const currentSession = sessionRows.find((row) => row.key === chatSnapshot.sessionKey);
  const renderableMessages = useMemo(() => {
    const persisted = chatSnapshot.chatMessages.map((message, index) =>
      toRenderableMessage({
        extractReasoning: extractThinkingCached,
        extractText: extractTextCached,
        index,
        message,
      }),
    );
    const streamedSegments = chatSnapshot.chatStreamSegments.map((segment, index) => ({
      attachments: [],
      id: `segment-${index}`,
      reasoning: null,
      role: "assistant" as const,
      streaming: true,
      text: segment.text,
      timestamp: segment.ts,
      tools: [],
    }));
    const toolMessages = chatSnapshot.chatToolMessages.map((message, index) =>
      toRenderableMessage({
        extractReasoning: extractThinkingCached,
        extractText: extractTextCached,
        index: chatSnapshot.chatMessages.length + index,
        message,
      }),
    );
    const activeStream = chatSnapshot.chatStream?.trim()
      ? [
          {
            attachments: [],
            id: "active-stream",
            reasoning: null,
            role: "assistant" as const,
            streaming: true,
            text: chatSnapshot.chatStream,
            timestamp: Date.now(),
            tools: [],
          } satisfies RenderableMessage,
        ]
      : [];
    return [...persisted, ...streamedSegments, ...toolMessages, ...activeStream];
  }, [chatSnapshot.chatMessages, chatSnapshot.chatStream, chatSnapshot.chatStreamSegments, chatSnapshot.chatToolMessages]);

  const deferredMessages = useDeferredValue(renderableMessages);
  const modelGroups = useMemo(() => {
    const groups = new Map<string, typeof modelCatalog>();
    for (const model of modelCatalog) {
      const provider = model.provider || "other";
      const existing = groups.get(provider) ?? [];
      existing.push(model);
      groups.set(provider, existing);
    }
    return [...groups.entries()].toSorted(([left], [right]) => left.localeCompare(right));
  }, [modelCatalog]);

  const chatStatus = chatSnapshot.chatSending
    ? "submitted"
    : chatSnapshot.chatRunId || chatSnapshot.chatStream
      ? "streaming"
      : chatSnapshot.lastError
        ? "error"
        : "ready";

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(27,92,255,0.22),_transparent_24%),linear-gradient(180deg,_#07101d_0%,_#03060a_100%)] text-foreground">
        <div className="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col gap-6 px-4 py-4 lg:px-6">
          <section className="grid gap-4 rounded-[32px] border border-white/10 bg-slate-950/70 p-3 shadow-[0_28px_80px_rgba(0,0,0,0.38)] backdrop-blur md:p-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            {mobilePanelOpen ? (
              <button
                aria-label="Close side panel"
                className="fixed inset-0 z-30 bg-black/55 lg:hidden"
                onClick={() => setMobilePanelOpen(false)}
                type="button"
              />
            ) : null}
            <aside
              className={cn(
                "fixed inset-y-3 left-3 z-40 flex w-[min(90vw,360px)] flex-col gap-4 overflow-y-auto rounded-[28px] border border-white/8 bg-slate-950 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.55)] transition-transform lg:static lg:z-auto lg:min-h-[75vh] lg:w-auto lg:translate-x-0 lg:bg-white/[0.03] lg:shadow-none",
                mobilePanelOpen ? "translate-x-0" : "-translate-x-[110%] lg:translate-x-0",
              )}
            >
              <div className="rounded-[24px] border border-cyan-400/20 bg-cyan-400/8 p-4">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex size-12 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/10">
                    {bootstrap.assistantAvatar ? (
                      <img alt="" className="size-full object-cover" src={bootstrap.assistantAvatar} />
                    ) : (
                      <SparklesIcon className="size-5 text-cyan-100" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-200/70">Custom Operator UI</p>
                    <h1 className="truncate text-xl font-semibold">{bootstrap.assistantName}</h1>
                  </div>
                </div>
                <div className="grid gap-2 text-sm text-slate-300">
                  <div className="flex items-center gap-2">
                    <CableIcon className="size-4 text-cyan-200" />
                    <span>{connectionState === "connected" ? "Gateway connected" : connectionState === "connecting" ? "Connecting..." : "Gateway disconnected"}</span>
                  </div>
                  <p className="text-xs leading-5 text-slate-400">
                    Mounted as a standalone Control-UI-compatible app and ready for `gateway.controlUi.root`.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 rounded-[24px] border border-white/8 bg-black/10 p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium tracking-wide text-slate-200">Connection</h2>
                  <Button className="gap-2" onClick={handleReconnect} size="sm" variant="secondary">
                    <RefreshCcwIcon className="size-4" />
                    Reconnect
                  </Button>
                </div>
                <label className="grid gap-1.5 text-xs text-slate-400">
                  Gateway URL
                  <Input
                    className="border-white/10 bg-slate-950/70"
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, gatewayUrl: event.target.value }))
                    }
                    value={settings.gatewayUrl}
                  />
                </label>
                <label className="grid gap-1.5 text-xs text-slate-400">
                  Token
                  <Input
                    className="border-white/10 bg-slate-950/70"
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, token: event.target.value }))
                    }
                    placeholder="Optional"
                    type="password"
                    value={settings.token}
                  />
                </label>
                <label className="grid gap-1.5 text-xs text-slate-400">
                  Password
                  <Input
                    className="border-white/10 bg-slate-950/70"
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, password: event.target.value }))
                    }
                    placeholder="Optional"
                    type="password"
                    value={settings.password}
                  />
                </label>
                {chatSnapshot.lastError ? (
                  <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
                    {chatSnapshot.lastError}
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 rounded-[24px] border border-white/8 bg-black/10 p-3">
                <div className="mb-3 flex items-center justify-between px-1">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Sessions</p>
                    <h2 className="text-sm font-medium text-slate-200">{sessionRows.length} available</h2>
                  </div>
                  <Button className="gap-2" onClick={() => void refreshSessions()} size="icon-sm" variant="ghost">
                    <LoaderCircleIcon className={cn("size-4", chatSnapshot.chatLoading && "animate-spin")} />
                  </Button>
                </div>
                <div className="grid max-h-[48vh] gap-2 overflow-y-auto pr-1">
                  {sessionRows.map((session) => {
                    const active = session.key === chatSnapshot.sessionKey;
                    return (
                      <button
                        className={cn(
                          "grid gap-1 rounded-2xl border px-3 py-3 text-left transition",
                          active
                            ? "border-cyan-400/30 bg-cyan-400/12 text-white"
                            : "border-white/6 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]",
                        )}
                        key={session.key}
                        onClick={() => void handleSelectSession(session.key)}
                        type="button"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-sm font-medium">
                            {session.label || session.displayName || session.subject || session.key}
                          </span>
                          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                            {session.kind}
                          </span>
                        </div>
                        <span className="truncate text-xs text-slate-400">{currentSessionSubtitle(session)}</span>
                        <span className="text-[11px] text-slate-500">{session.model || "default model"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </aside>

            <section className="flex min-h-[80svh] min-w-0 flex-col gap-4 rounded-[28px] border border-white/8 bg-slate-950/60 p-3 md:p-4 lg:min-h-[75vh]">
              <div className="flex items-center justify-between rounded-[22px] border border-white/8 bg-white/[0.03] px-3 py-2 lg:hidden">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Operator UI</p>
                  <p className="truncate text-sm text-slate-300">
                    {connectionState === "connected" ? "Connected" : connectionState === "connecting" ? "Connecting..." : "Disconnected"}
                  </p>
                </div>
                <Button
                  className="gap-2"
                  onClick={() => setMobilePanelOpen(true)}
                  size="sm"
                  variant="secondary"
                >
                  <MenuIcon className="size-4" />
                  Menu
                </Button>
              </div>
              <header className="grid gap-4 rounded-[24px] border border-white/8 bg-white/[0.03] p-4 lg:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <p className="mb-1 text-[11px] uppercase tracking-[0.22em] text-slate-500">Active session</p>
                  <h2 className="truncate text-2xl font-semibold">
                    {currentSession?.label || currentSession?.displayName || currentSession?.subject || chatSnapshot.sessionKey}
                  </h2>
                  <p className="mt-2 truncate text-sm text-slate-400">{currentSessionSubtitle(currentSession)}</p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="rounded-2xl border border-white/8 bg-black/10 px-3 py-2 text-sm text-slate-300">
                    <span className="mr-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Model</span>
                    <span>{currentModelLabel(currentSession)}</span>
                  </div>
                  <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
                    <Button className="gap-2" size="sm" variant="secondary">
                      <Settings2Icon className="size-4" />
                      Change model
                    </Button>
                    <ModelSelectorContent title="Choose model">
                      <ModelSelectorInput placeholder="Search models..." />
                      <ModelSelectorList>
                        <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                        {modelGroups.map(([provider, models]) => (
                          <ModelSelectorGroup heading={provider} key={provider}>
                            {models.map((model) => (
                              <ModelSelectorItem
                                key={model.id}
                                onSelect={() => void handleSelectModel(model.id)}
                                value={`${provider}-${model.id}`}
                              >
                                <ModelSelectorLogoGroup>
                                  <ModelSelectorLogo provider={provider} />
                                </ModelSelectorLogoGroup>
                                <ModelSelectorName>{model.id}</ModelSelectorName>
                                {model.reasoning ? <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">reasoning</span> : null}
                              </ModelSelectorItem>
                            ))}
                          </ModelSelectorGroup>
                        ))}
                      </ModelSelectorList>
                    </ModelSelectorContent>
                  </ModelSelector>
                </div>
              </header>

              <div className="min-h-0 flex-1 rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))]">
                <Conversation className="min-h-[38svh] flex-1 md:min-h-[44vh]">
                  <ConversationContent className="p-5">
                    {deferredMessages.length === 0 ? (
                      <ConversationEmptyState
                        description="Connect to the gateway and send a message to start the session."
                        icon={<SendIcon className="size-6" />}
                        title="No chat activity yet"
                      />
                    ) : (
                      deferredMessages.map((message) => (
                        <MessageCard assistantAvatar={bootstrap.assistantAvatar} key={message.id} message={message} />
                      ))
                    )}
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>
              </div>

              <PromptInput
                accept="image/*"
                className="sticky bottom-0 z-10 rounded-[24px] border border-white/8 bg-slate-950/92 p-3 backdrop-blur"
                maxFiles={4}
                onSubmit={(message) => void handleSubmitPrompt(message)}
              >
                <PromptInputBody>
                  <PromptInputTextarea
                    className="min-h-[88px] border-none bg-transparent px-1 text-base shadow-none focus-visible:ring-0"
                    placeholder="Write to the current session..."
                  />
                </PromptInputBody>
                <PromptInputFooter className="mt-3 items-center justify-between gap-3">
                  <PromptInputTools>
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                    <div className="rounded-full border border-white/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">
                      {chatSnapshot.sessionKey}
                    </div>
                  </PromptInputTools>
                  <PromptInputSubmit
                    onStop={() => void handleAbortRun()}
                    status={chatStatus}
                  />
                </PromptInputFooter>
              </PromptInput>
            </section>
          </section>
        </div>
      </main>
    </TooltipProvider>
  );
}
