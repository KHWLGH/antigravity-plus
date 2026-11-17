import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ProviderConnection,
  ProviderContent,
  ProviderEvent,
  ProviderInput,
  ProviderPrompt,
} from "@getpaseo/plugin/server/provider";
import type { AcpContentBlock, AgyStream } from "./agy-stream.ts";

type SessionOpen = Extract<ProviderInput, { type: "session.open" }>;
type SessionPrompt = Extract<ProviderInput, { type: "session.prompt" }>;

/** What a connector call needs to know about the session.open that triggered it. */
export interface LaunchContext {
  env: Record<string, string>;
  register(stream: AgyStream): void;
}

/**
 * Paseo's ACP adapter calls its connector without arguments. It does so from the promise chain
 * that `send(session.open)` starts, so AsyncLocalStorage carries the session's context into the
 * connector. Catalog, listing and the connect-time probe run outside any context.
 */
export const launchContext = new AsyncLocalStorage<LaunchContext>();

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

/**
 * Wraps the adapter's single connection to (1) launch each session's agy with that session's
 * env and (2) add steering, which the adapter does not offer, through the session's agy stream.
 */
export function wrapConnection(
  inner: ProviderConnection,
  requested: readonly string[],
  prepareOpen: (input: SessionOpen) => SessionOpen = (input) => input,
): ProviderConnection {
  const steering = requested.includes(STEER);
  const streams = new Map<string, AgyStream>();
  const activeTurns = new Map<string, string>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  /**
   * The adapter emits session.ready before it registers the session, so an input sent in
   * reaction to session.ready can hit "Unknown session". Hold a session's inputs until one
   * macrotask after its open settles; chaining on one promise keeps their order.
   */
  const opening = new Map<string, Promise<void>>();
  const openRequests = new Map<string, { sessionId: string; release: () => void }>();

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

  inner.onEvent((event) => {
    if ((event.type === "session.ready" || event.type === "request.failed") && event.requestId) {
      settleOpen(event.requestId);
    }
    if (event.type === "session.opened" && steering) {
      event = { ...event, capabilities: [...event.capabilities, STEER] };
    } else if (event.type === "session.turn") {
      if (event.state === "started") activeTurns.set(event.sessionId, event.turnId);
      else activeTurns.delete(event.sessionId);
    } else if (event.type === "session.closed") {
      streams.delete(event.sessionId);
      activeTurns.delete(event.sessionId);
    }
    emit(event);
  });

  function steer(input: SessionPrompt): boolean {
    const turnId = activeTurns.get(input.sessionId);
    const stream = streams.get(input.sessionId);
    const content = toAcpContent(input.prompt);
    if (!turnId || !stream?.steer(content)) return false;
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
      if (input.type === "session.open") {
        const prepared = prepareOpen(input);
        // A reopened session replaces its previous stream when the new one starts.
        const context: LaunchContext = {
          env: { ...(prepared.config.env ?? {}) },
          register: (stream) => streams.set(input.sessionId, stream),
        };
        let release = () => {};
        opening.set(input.sessionId, new Promise<void>((resolve) => (release = resolve)));
        openRequests.set(input.requestId, { sessionId: input.sessionId, release });
        try {
          return launchContext.run(context, () => inner.send(prepared));
        } catch (error) {
          settleOpen(input.requestId);
          throw error;
        }
      }
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
      streams.clear();
      activeTurns.clear();
      listeners.clear();
    },
  };
}
