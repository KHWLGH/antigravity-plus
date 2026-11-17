import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";

/** Opens one inner ACP connection whose agy processes run with `env`. */
export type InnerConnectionFactory = (env: Record<string, string>) => Promise<ProviderConnection>;

type SessionOpen = Extract<ProviderInput, { type: "session.open" }>;

interface SessionEntry {
  connection: Promise<ProviderConnection>;
  retired: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Paseo's ACP adapter takes a connector without arguments, so a connector cannot see the
 * session's environment. Give every session its own inner connection, created with that
 * session's env, and keep one shared inner connection for catalog and session listing.
 * Routing is by sessionId only; the inner adapter does all protocol work.
 */
export async function createMultiplexedConnection(
  factory: InnerConnectionFactory,
  prepareOpen: (input: SessionOpen) => SessionOpen = (input) => input,
): Promise<ProviderConnection> {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, SessionEntry>();
  let closed = false;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const shared = await factory({});
  shared.onEvent(emit);

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
      void entry.connection.then((connection) => connection.close()).catch(() => undefined);
    }, 0);
  }

  function open(input: SessionOpen): void {
    const prepared = prepareOpen(input);
    const entry: SessionEntry = {
      retired: false,
      connection: factory(prepared.config.env ?? {}).then((connection) => {
        connection.onEvent((event) => {
          emit(event);
          if (event.type === "session.closed" && event.sessionId === input.sessionId) {
            retire(input.sessionId);
          } else if (event.type === "request.failed" && event.requestId === input.requestId) {
            retire(input.sessionId);
          }
        });
        return connection;
      }),
    };
    sessions.set(input.sessionId, entry);
    entry.connection
      .then((connection) => connection.send(prepared))
      .catch((error) => {
        retire(input.sessionId);
        fail(input, error);
      });
  }

  return {
    version: shared.version,
    capabilities: shared.capabilities,
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
        await shared.send(input);
        return;
      }
      const entry = sessions.get(input.sessionId);
      if (!entry) throw new Error(`Unknown Antigravity+ session: ${input.sessionId}`);
      // Callbacks on one promise run in registration order, so per-session input order holds.
      entry.connection
        .then((connection) => connection.send(input))
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
        shared.close(),
        ...entries.map((entry) => entry.connection.then((connection) => connection.close())),
      ]);
      listeners.clear();
    },
  };
}
