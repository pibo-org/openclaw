import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState as rawDecodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState as rawEncodeAcpxRuntimeHandleState,
  type AcpAgentRegistry,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
} from "acpx/runtime";
import type { AcpRuntime } from "../runtime-api.js";

type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;

type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
};

function readOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
type AcpxRuntimeHandleMode = "persistent" | "oneshot";

type AcpxRuntimeHandleState = {
  name: string;
  agent?: string;
  cwd?: string;
  mode: AcpxRuntimeHandleMode;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

function decodeAcpxRuntimeHandleState(
  runtimeSessionName: string,
): AcpxRuntimeHandleState | undefined {
  const decoded = rawDecodeAcpxRuntimeHandleState(runtimeSessionName);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return undefined;
  }
  const record = decoded as Record<string, unknown>;
  const name = readOptionalString(record.name);
  const mode = readOptionalString(record.mode);
  if (!name || (mode !== "persistent" && mode !== "oneshot")) {
    return undefined;
  }
  const state: AcpxRuntimeHandleState = {
    name,
    mode,
  };
  const agent = readOptionalString(record.agent);
  if (agent) {
    state.agent = agent;
  }
  const cwd = readOptionalString(record.cwd);
  if (cwd) {
    state.cwd = cwd;
  }
  const acpxRecordId = readOptionalString(record.acpxRecordId);
  if (acpxRecordId) {
    state.acpxRecordId = acpxRecordId;
  }
  const backendSessionId = readOptionalString(record.backendSessionId);
  if (backendSessionId) {
    state.backendSessionId = backendSessionId;
  }
  const agentSessionId = readOptionalString(record.agentSessionId);
  if (agentSessionId) {
    state.agentSessionId = agentSessionId;
  }
  return state;
}

function encodeAcpxRuntimeHandleState(state: AcpxRuntimeHandleState): string {
  return String(rawEncodeAcpxRuntimeHandleState(state));
}

function readSessionRecordName(record: AcpSessionRecord): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  const { name } = record as { name?: unknown };
  return readOptionalString(name);
}

function readSessionRecordAgentSessionId(record: AcpLoadedSessionRecord): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  const { agentSessionId } = record as { agentSessionId?: unknown };
  return readOptionalString(agentSessionId);
}

function sessionRecordHasAgentMessages(record: AcpLoadedSessionRecord): boolean {
  if (typeof record !== "object" || record === null) {
    return false;
  }
  const { messages } = record as { messages?: unknown };
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) => typeof message === "object" && message !== null && "Agent" in message,
    )
  );
}

function isVirginPersistentSessionRecord(record: AcpLoadedSessionRecord): boolean {
  if (!record) {
    return false;
  }
  if (readSessionRecordAgentSessionId(record)) {
    return false;
  }
  return !sessionRecordHasAgentMessages(record);
}

function createResetAwareSessionStore(baseStore: AcpSessionStore): ResetAwareSessionStore {
  const freshSessionKeys = new Set<string>();

  return {
    async load(sessionId: string): Promise<AcpLoadedSessionRecord> {
      const normalized = sessionId.trim();
      if (normalized && freshSessionKeys.has(normalized)) {
        return undefined;
      }
      return await baseStore.load(sessionId);
    },
    async save(record: AcpSessionRecord): Promise<void> {
      await baseStore.save(record);
      const sessionName = readSessionRecordName(record);
      if (sessionName) {
        freshSessionKeys.delete(sessionName);
      }
    },
    markFresh(sessionKey: string): void {
      const normalized = sessionKey.trim();
      if (normalized) {
        freshSessionKeys.add(normalized);
      }
    },
  };
}

export class AcpxRuntime {
  private readonly sessionStore: ResetAwareSessionStore;
  private readonly delegate: BaseAcpxRuntime;

  constructor(
    options: AcpRuntimeOptions,
    testOptions?: ConstructorParameters<typeof BaseAcpxRuntime>[1],
  ) {
    this.sessionStore = createResetAwareSessionStore(options.sessionStore);
    this.delegate = new BaseAcpxRuntime(
      {
        ...options,
        sessionStore: this.sessionStore,
      },
      testOptions,
    );
  }

  isHealthy(): boolean {
    return this.delegate.isHealthy();
  }

  probeAvailability(): Promise<void> {
    return this.delegate.probeAvailability();
  }

  doctor(): Promise<AcpRuntimeDoctorReport> {
    return this.delegate.doctor();
  }

  ensureSession(input: Parameters<AcpRuntime["ensureSession"]>[0]): Promise<AcpRuntimeHandle> {
    return this.delegate.ensureSession(input);
  }

  runTurn(input: Parameters<AcpRuntime["runTurn"]>[0]): AsyncIterable<AcpRuntimeEvent> {
    return this.runTurnWithFirstTurnPersistentFallback(input);
  }

  getCapabilities(): ReturnType<BaseAcpxRuntime["getCapabilities"]> {
    return this.delegate.getCapabilities();
  }

  getStatus(input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0]): Promise<AcpRuntimeStatus> {
    return this.delegate.getStatus(input);
  }

  async setMode(input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]): Promise<void> {
    await this.withFirstTurnPersistentFallbackOnHandle(input.handle, async () => {
      await this.delegate.setMode(input);
    });
  }

  async setConfigOption(
    input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
  ): Promise<void> {
    if (input.key === "timeout") {
      return;
    }
    await this.withFirstTurnPersistentFallbackOnHandle(input.handle, async () => {
      await this.delegate.setConfigOption(input);
    });
  }

  cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    return this.delegate.cancel(input);
  }

  async prepareFreshSession(input: { sessionKey: string }): Promise<void> {
    this.sessionStore.markFresh(input.sessionKey);
  }

  close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    return this.delegate
      .close({
        handle: input.handle,
        reason: input.reason,
        discardPersistentState: input.discardPersistentState,
      })
      .then(() => {
        if (input.discardPersistentState) {
          this.sessionStore.markFresh(input.handle.sessionKey);
        }
      });
  }

  private runTurnWithFirstTurnPersistentFallback(
    input: Parameters<AcpRuntime["runTurn"]>[0],
  ): AsyncIterable<AcpRuntimeEvent> {
    return (async function* (runtime: AcpxRuntime) {
      const originalState = decodeAcpxRuntimeHandleState(input.handle.runtimeSessionName);
      let restorePersistentMode = false;

      if (originalState && (await runtime.shouldAllowFreshFallbackOnFirstPersistentTurn(input))) {
        input.handle.runtimeSessionName = encodeAcpxRuntimeHandleState({
          ...originalState,
          mode: "oneshot",
        });
        restorePersistentMode = originalState.mode === "persistent";
      }

      try {
        yield* runtime.delegate.runTurn(input);
      } finally {
        if (restorePersistentMode && originalState) {
          const latestState = decodeAcpxRuntimeHandleState(input.handle.runtimeSessionName);
          input.handle.runtimeSessionName = encodeAcpxRuntimeHandleState({
            ...(latestState ?? originalState),
            mode: originalState.mode,
          });
        }
      }
    })(this);
  }

  private async withFirstTurnPersistentFallbackOnHandle<T>(
    handle: AcpRuntimeHandle,
    run: () => Promise<T>,
  ): Promise<T> {
    const originalState = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
    let restorePersistentMode = false;

    if (originalState && (await this.shouldAllowFreshFallbackOnFirstPersistentHandle(handle))) {
      handle.runtimeSessionName = encodeAcpxRuntimeHandleState({
        ...originalState,
        mode: "oneshot",
      });
      restorePersistentMode = originalState.mode === "persistent";
    }

    try {
      return await run();
    } finally {
      if (restorePersistentMode && originalState) {
        const latestState = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
        handle.runtimeSessionName = encodeAcpxRuntimeHandleState({
          ...(latestState ?? originalState),
          mode: originalState.mode,
        });
      }
    }
  }

  private async shouldAllowFreshFallbackOnFirstPersistentTurn(
    input: Parameters<AcpRuntime["runTurn"]>[0],
  ): Promise<boolean> {
    return await this.shouldAllowFreshFallbackOnFirstPersistentHandle(input.handle);
  }

  private async shouldAllowFreshFallbackOnFirstPersistentHandle(
    handle: AcpRuntimeHandle,
  ): Promise<boolean> {
    const state = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
    if (!state || state.mode !== "persistent") {
      return false;
    }

    const recordId =
      readOptionalString(state.acpxRecordId) ||
      readOptionalString(handle.acpxRecordId) ||
      readOptionalString(handle.sessionKey);
    if (!recordId) {
      return false;
    }

    const record = await this.sessionStore.load(recordId);
    const allowed = isVirginPersistentSessionRecord(record);
    return allowed;
  }
}

export {
  ACPX_BACKEND_ID,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
