import type {
  ProviderConnection,
  ProviderContent,
  ProviderEvent,
  ProviderInput,
  ProviderPrompt,
} from "@getpaseo/plugin/server/provider";
import type { AcpContentBlock } from "./agy-stream.ts";

export interface InnerConnection {
  connection: ProviderConnection;
  /** Adds content to the running agy prompt; false when nothing is running. */
  steer(content: AcpContentBlock[]): boolean;
}

/** Opens one inner ACP connection whose agy processes run with `env`. */
export type InnerConnectionFactory = (env: Record<string, string>) => Promise<InnerConnection>;

type SessionOpen = Extract<ProviderInput, { type: "session.open" }>;
type SessionPrompt = Extract<ProviderInput, { type: "session.prompt" }>;

interface SessionEntry {
  inner: Promise<InnerConnection>;
  retired: boolean;
  activeTurnId: string | null;
}

const STEER = "prompt.steer";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * Paseo's ACP adapter takes a connector without arguments, so a connector cannot see the
 * session's environment. Give every session its own inner connection, created with that
 * session's env, and keep one shared inner connection for catalog and session listing.
 * Routing is by sessionId; the inner adapter does all protocol work except steering, which
 * the adapter does not offer and this layer adds through the agy stream.
 */
export async function createMultiplexedConnection(
  factory: InnerConnectionFactory,
  requested: readonly string[],
  prepareOpen: (input: SessionOpen) => SessionOpen = (input) => input,
): Promise<ProviderConnection> {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, SessionEntry>();
  const steering = requested.includes(STEER);
  let closed = false;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const shared = await factory({});
  shared.connection.onEvent(emit);
  const capabilities = steering
    ? [...shared.connection.capabilities, STEER]
    : [...shared.connection.capabilities];

  function fail(input: ProviderInput, error: unknown): void {
    const failure = { message: describe(error) };
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

  function retire(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry || entry.retired) return;
    entry.retired = true;
    sessions.delete(sessionId);
    // Let the inner adapter finish publishing the events of the current operation first.
    setTimeout(() => {
      void entry.inner.then(({ connection }) => connection.close()).catch(() => undefined);
    }, 0);
  }

  function observe(entry: SessionEntry, input: SessionOpen, event: ProviderEvent): void {
    if (event.type === "session.opened" && event.sessionId === input.sessionId && steering) {
      event = { ...event, capabilities: [...event.capabilities, STEER] };
    }
    if (event.type === "session.turn" && event.sessionId === input.sessionId) {
      entry.activeTurnId = event.state === "started" ? event.turnId : null;
    }
    emit(event);
    if (event.type === "session.closed" && event.sessionId === input.sessionId) {
      retire(input.sessionId);
    } else if (event.type === "request.failed" && event.requestId === input.requestId) {
      retire(input.sessionId);
    }
  }

  function open(input: SessionOpen): void {
    const prepared = prepareOpen(input);
    const entry: SessionEntry = {
      retired: false,
      activeTurnId: null,
      inner: factory(prepared.config.env ?? {}).then((inner) => {
        inner.connection.onEvent((event) => observe(entry, input, event));
        return inner;
      }),
    };
    sessions.set(input.sessionId, entry);
    entry.inner
      .then(({ connection }) => connection.send(prepared))
      .catch((error) => {
        retire(input.sessionId);
        fail(input, error);
      });
  }

  function prompt(entry: SessionEntry, input: SessionPrompt, inner: InnerConnection): Promise<void> {
    if (input.prompt.delivery === "steer") {
      const content = toAcpContent(input.prompt);
      const turnId = entry.activeTurnId;
      if (turnId && inner.steer(content)) {
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
        return Promise.resolve();
      }
      // Nothing is running any more: deliver it as an ordinary prompt.
      return inner.connection.send({ ...input, prompt: { ...input.prompt, delivery: "auto" } });
    }
    return inner.connection.send(input);
  }

  return {
    version: shared.connection.version,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Antigravity+ connection is closed");
      if (input.type === "session.open") {
        if (sessions.has(input.sessionId)) {
          throw new Error(`Session already exists: ${input.sessionId}`);
        }
        open(input);
        return;
      }
      if (!("sessionId" in input)) {
        await shared.connection.send(input);
        return;
      }
      const entry = sessions.get(input.sessionId);
      if (!entry) throw new Error(`Unknown Antigravity+ session: ${input.sessionId}`);
      // Callbacks on one promise run in registration order, so per-session input order holds.
      entry.inner
        .then((inner) =>
          input.type === "session.prompt" ? prompt(entry, input, inner) : inner.connection.send(input),
        )
        .catch((error) => fail(input, error));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled([
        shared.connection.close(),
        ...entries.map((entry) => entry.inner.then(({ connection }) => connection.close())),
      ]);
      listeners.clear();
    },
  };
}
