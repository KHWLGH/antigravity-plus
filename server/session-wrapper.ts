import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderConnection,
  ProviderContent,
  ProviderEvent,
  ProviderInput,
  ProviderPrompt,
} from "@getpaseo/plugin/server/provider";
import type { AcpContentBlock, AgyStream, PermissionPolicy } from "./agy-stream.ts";
import {
  BYPASS_MODE_ID,
  BYPASS_NATIVE_MODE,
  DEFAULT_MODE,
  LEGACY_SUBAGENT_OPTION,
  thinkingLevels,
  withBypassMode,
  withModelThinking,
} from "./catalog.ts";

type SessionOpen = Extract<ProviderInput, { type: "session.open" }>;
type SessionPrompt = Extract<ProviderInput, { type: "session.prompt" }>;
type SessionConfigure = Extract<ProviderInput, { type: "session.configure" }>;
type Options = Readonly<Record<string, unknown>>;

/** What a connector call needs to know about the session.open that triggered it. */
export interface LaunchContext {
  env: Record<string, string>;
  policy: PermissionPolicy;
  register(stream: AgyStream): void;
}

/**
 * Paseo's ACP adapter calls its connector without arguments. It does so from the promise chain
 * that `send(session.open)` starts, so AsyncLocalStorage carries the session's context into the
 * connector. Catalog, listing and the connect-time probe run outside any context.
 */
export const launchContext = new AsyncLocalStorage<LaunchContext>();

export interface WrapperOptions {
  /** Effort-suffixed model ids agy last reported, for per-model thinking levels. */
  modelIds(): readonly string[];
  /** Extra environment for every session's agy process. */
  env?: Readonly<Record<string, string>>;
}

interface SessionState {
  policy: PermissionPolicy;
  /** The adapter's last config snapshot, before this wrapper's additions. */
  innerConfig: ProviderConfigState | null;
  stream: AgyStream | null;
  activeTurnId: string | null;
}

const STEER = "prompt.steer";

/** Same conversion as Paseo's ACP adapter: text and images pass through, attachments as JSON. */
export function toAcpContent(prompt: ProviderPrompt): AcpContentBlock[] {
  if (prompt.input.type === "command") {
    const suffix = prompt.input.arguments ? ` ${prompt.input.arguments}` : "";
    return [{ type: "text", text: `/${prompt.input.name}${suffix}` }];
  }
  return prompt.input.content.map((content: ProviderContent) =>
    content.type === "text" || content.type === "image"
      ? { ...content }
      : { type: "text", text: JSON.stringify(content) },
  );
}

function promptText(content: AcpContentBlock[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Drops the retired "agy subagents" option; the adapter would reject it as an unknown setting. */
function withoutLegacyOption<T extends Options | undefined>(options: T): T {
  if (!options || !(LEGACY_SUBAGENT_OPTION in options)) return options;
  const { [LEGACY_SUBAGENT_OPTION]: _retired, ...rest } = options;
  return rest as T;
}

function hasChanges(changes: ProviderConfigChanges): boolean {
  return (
    changes.model !== undefined ||
    changes.mode !== undefined ||
    changes.thinkingOption !== undefined ||
    Object.keys(changes.providerOptions ?? {}).length > 0 ||
    Object.keys(changes.settings ?? {}).length > 0
  );
}

/**
 * Wraps the adapter's single connection to add what it lacks for agy:
 * - each session's agy runs with that session's env;
 * - Bypass, a mode agy does not have: agy runs in Default and the stream approves everything;
 * - per-model thinking levels in config snapshots;
 * - steering, through the session's agy stream.
 */
export function wrapConnection(
  inner: ProviderConnection,
  requested: readonly string[],
  options: WrapperOptions,
): ProviderConnection {
  const steering = requested.includes(STEER);
  const sessions = new Map<string, SessionState>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  /**
   * The adapter emits session.ready before it registers the session, so an input sent in
   * reaction to session.ready can hit "Unknown session". Hold a session's inputs until one
   * macrotask after its open settles; chaining on one promise keeps their order.
   */
  const opening = new Map<string, Promise<void>>();
  const openRequests = new Map<string, { sessionId: string; release: () => void }>();
  /** Configure requests forwarded to the adapter, with the state to restore if they fail. */
  const configuring = new Map<string, { sessionId: string; bypass: boolean }>();

  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };

  function settleOpen(requestId: string): void {
    const pending = openRequests.get(requestId);
    if (!pending) return;
    openRequests.delete(requestId);
    setTimeout(() => {
      opening.delete(pending.sessionId);
      pending.release();
    }, 0);
  }

  function fail(input: ProviderInput, error: unknown): void {
    const failure = { message: error instanceof Error ? error.message : String(error) };
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: failure },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: failure });
    } else if ("sessionId" in input) {
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: failure });
    }
  }

  /** Catalog requests this wrapper sends itself; their events never reach Paseo. */
  const privateRequests = new Map<string, () => void>();
  let warmup: Promise<void> | null = null;
  let privateSequence = 0;

  /** Makes agy list its models once, for a session opened before any catalog request. */
  function knowModels(): Promise<void> {
    if (options.modelIds().length > 0) return Promise.resolve();
    warmup ??= new Promise<void>((resolve) => {
      const requestId = `antigravity-plus-models-${++privateSequence}`;
      const timer = setTimeout(done, 15_000);
      function done() {
        clearTimeout(timer);
        privateRequests.delete(requestId);
        warmup = null;
        resolve();
      }
      privateRequests.set(requestId, done);
      inner.send({ type: "catalog", requestId }).catch(done);
    });
    return warmup;
  }

  /**
   * Paseo fills the catalog's default thinking level in for every model, but agy rejects any
   * thinking level for a model without effort variants (GPT-OSS, Orchestrator), failing the open.
   */
  function supportsThinking(model: string | undefined): boolean {
    if (!model) return true;
    const levels = thinkingLevels(model, options.modelIds());
    return levels === null || levels.length > 0;
  }

  function present(state: SessionState, config: ProviderConfigState): ProviderConfigState {
    // Bypass holds only while agy stays in the mode it runs on; agy can change mode itself.
    if (config.mode && config.mode !== BYPASS_NATIVE_MODE) state.policy.bypass = false;
    return {
      ...config,
      mode: state.policy.bypass ? BYPASS_MODE_ID : config.mode,
      modes: withBypassMode(config.modes),
      models: withModelThinking(config.models, options.modelIds()),
    };
  }

  function publishConfig(sessionId: string, state: SessionState): void {
    if (state.innerConfig) {
      emit({ type: "session.config", sessionId, config: present(state, state.innerConfig) });
    }
  }

  inner.onEvent((event) => {
    if ((event.type === "catalog" || event.type === "request.failed") && privateRequests.has(event.requestId)) {
      privateRequests.get(event.requestId)?.();
      return;
    }
    if ((event.type === "session.ready" || event.type === "request.failed") && event.requestId) {
      settleOpen(event.requestId);
    }
    if (event.type === "request.completed" || event.type === "request.failed") {
      const pending = configuring.get(event.requestId);
      if (pending) {
        configuring.delete(event.requestId);
        const state = sessions.get(pending.sessionId);
        if (state && event.type === "request.failed") {
          state.policy.bypass = pending.bypass;
          publishConfig(pending.sessionId, state);
        }
      }
    }
    const state = "sessionId" in event ? sessions.get(event.sessionId) : undefined;
    if (state && event.type === "session.opened") {
      if (steering) event = { ...event, capabilities: [...event.capabilities, STEER] };
    } else if (state && event.type === "session.config") {
      state.innerConfig = event.config;
      event = { ...event, config: present(state, event.config) };
    } else if (state && event.type === "session.turn") {
      state.activeTurnId = event.state === "started" ? event.turnId : null;
    } else if (state && event.type === "session.closed") {
      sessions.delete(event.sessionId);
    }
    emit(event);
  });

  function open(input: SessionOpen): Promise<void> {
    // A new session without a mode starts in the default; a resumed one keeps agy's own.
    const requestedMode = input.config.mode ?? (input.persistence ? undefined : DEFAULT_MODE);
    const bypass = requestedMode === BYPASS_MODE_ID;
    const state: SessionState = {
      policy: { bypass },
      innerConfig: null,
      stream: null,
      activeTurnId: null,
    };
    sessions.set(input.sessionId, state);
    const context: LaunchContext = {
      env: { ...(input.config.env ?? {}), ...(options.env ?? {}) },
      policy: state.policy,
      register: (stream) => {
        state.stream = stream;
      },
    };
    let release = () => {};
    opening.set(input.sessionId, new Promise<void>((resolve) => (release = resolve)));
    openRequests.set(input.requestId, { sessionId: input.sessionId, release });
    const start = async () => {
      // Whether the model takes a thinking level is only known once agy listed its models.
      if (input.config.thinkingOption && input.config.model) await knowModels();
      const prepared: SessionOpen = {
        ...input,
        config: {
          ...input.config,
          mode: bypass ? BYPASS_NATIVE_MODE : requestedMode,
          thinkingOption: supportsThinking(input.config.model) ? input.config.thinkingOption : undefined,
          providerOptions: withoutLegacyOption(input.config.providerOptions),
          settings: withoutLegacyOption(input.config.settings) ?? {},
        },
      };
      await launchContext.run(context, () => inner.send(prepared));
    };
    return start().catch((error) => {
      settleOpen(input.requestId);
      sessions.delete(input.sessionId);
      throw error;
    });
  }

  function configure(input: SessionConfigure): Promise<void> {
    const state = sessions.get(input.sessionId);
    if (!state) return inner.send(input);
    const previous = { bypass: state.policy.bypass };
    const changes: ProviderConfigChanges = {
      ...input.changes,
      providerOptions: withoutLegacyOption(input.changes.providerOptions),
      settings: withoutLegacyOption(input.changes.settings),
    };
    if (changes.thinkingOption && !supportsThinking(changes.model ?? state.innerConfig?.model)) {
      changes.thinkingOption = undefined;
    }
    if (changes.mode !== undefined) {
      // null returns the mode to the provider default, which is Bypass.
      const target = changes.mode ?? DEFAULT_MODE;
      state.policy.bypass = target === BYPASS_MODE_ID;
      changes.mode = state.policy.bypass ? BYPASS_NATIVE_MODE : target;
    }
    if (!hasChanges(changes)) {
      // Answer after send() returns, as the adapter does, so the caller is already waiting.
      setTimeout(() => {
        publishConfig(input.sessionId, state);
        emit({ type: "request.completed", requestId: input.requestId });
      }, 0);
      return Promise.resolve();
    }
    configuring.set(input.requestId, { sessionId: input.sessionId, ...previous });
    return inner.send({ ...input, changes });
  }

  function steer(input: SessionPrompt): boolean {
    const state = sessions.get(input.sessionId);
    const turnId = state?.activeTurnId;
    const content = toAcpContent(input.prompt);
    if (!turnId || !state?.stream?.steer(content)) return false;
    emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: {
        type: "user_message",
        id: input.prompt.clientMessageId,
        clientMessageId: input.prompt.clientMessageId,
        text: promptText(content),
      },
    });
    emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "steer", turnId },
    });
    return true;
  }

  function route(input: ProviderInput): Promise<void> {
    if (input.type === "session.configure") return configure(input);
    if (input.type === "session.prompt" && input.prompt.delivery === "steer") {
      if (steer(input)) return Promise.resolve();
      // Nothing is running any more: deliver it as an ordinary prompt.
      return inner.send({ ...input, prompt: { ...input.prompt, delivery: "auto" } });
    }
    return inner.send(input);
  }

  return {
    version: inner.version,
    capabilities: steering ? [...inner.capabilities, STEER] : [...inner.capabilities],
    send(input) {
      if (input.type === "session.open") return open(input);
      const gate = "sessionId" in input ? opening.get(input.sessionId) : undefined;
      if (gate) {
        void gate.then(() => route(input)).catch((error) => fail(input, error));
        return Promise.resolve();
      }
      return route(input);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      await inner.close();
      sessions.clear();
      listeners.clear();
    },
  };
}
