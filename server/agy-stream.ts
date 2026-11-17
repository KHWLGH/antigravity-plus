import { createInterface } from "node:readline";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

/** Methods whose `_meta` agy reads when it creates or reopens a session runtime. */
const SESSION_METHODS = new Set(["session/new", "session/load", "session/resume"]);
/** JSON-RPC ids of prompts this layer injects; the Paseo adapter never sees their responses. */
const STEER_ID_PREFIX = "antigravity-plus-steer-";

type JsonObject = Record<string, unknown>;
type MessageId = string | number;
export type AcpContentBlock = JsonObject;

export interface AgyStream {
  stream: AcpStream;
  /**
   * Adds content to the running turn. Returns false when no prompt is running, so the caller
   * delivers it as a normal prompt instead.
   */
  steer(content: AcpContentBlock[]): boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Paseo's ACP adapter sends the agent's system prompt as `_meta._paseo.systemPrompt`,
 * which agy ignores. agy appends `_meta.antigravity.systemPrompt.append` to its own
 * system prompt instead (verified against agy 1.5.10), so copy the value across.
 */
export function withAntigravityMeta(message: AcpStreamMessage, extra?: string): AcpStreamMessage {
  if (!("method" in message) || !SESSION_METHODS.has(message.method)) return message;
  const params = message.params;
  // Only Paseo's session opens carry `_meta`; catalog probes stay untouched.
  if (!isObject(params) || !isObject(params._meta)) return message;
  const paseo = params._meta._paseo;
  const own = isObject(paseo) ? paseo.systemPrompt : undefined;
  const systemPrompt = [typeof own === "string" ? own.trim() : "", extra?.trim() ?? ""]
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (systemPrompt.length === 0) return message;
  const antigravity = isObject(params._meta.antigravity) ? params._meta.antigravity : {};
  return {
    ...message,
    params: {
      ...params,
      _meta: {
        ...params._meta,
        antigravity: { ...antigravity, systemPrompt: { append: systemPrompt } },
      },
    },
  };
}

/** Keeps one tool row well under Paseo's timeline item limits. */
const MAX_TOOL_OUTPUT = 20_000;
const TIMESTAMP_PREFIX = /^(Created At: [^\n]*\n)?(Completed At: [^\n]*\n)?/;

/**
 * agy reports tool results in ACP `content` (text blocks and diffs), but Paseo's adapter
 * only reads `rawInput` and `rawOutput`. Copy text output into `rawOutput`, and give edits
 * the filePath/oldString/newString fields the adapter turns into a diff row.
 */
export function withToolResults(message: AcpStreamMessage): AcpStreamMessage {
  if (!("method" in message) || message.method !== "session/update") return message;
  const params = message.params;
  if (!isObject(params) || !isObject(params.update)) return message;
  const update = params.update;
  const kind = update.sessionUpdate;
  if ((kind !== "tool_call" && kind !== "tool_call_update") || !Array.isArray(update.content)) {
    return message;
  }
  const texts: string[] = [];
  let diff: JsonObject | null = null;
  for (const entry of update.content) {
    if (!isObject(entry)) continue;
    if (entry.type === "diff" && diff === null) diff = entry;
    if (entry.type === "content" && isObject(entry.content) && typeof entry.content.text === "string") {
      texts.push(entry.content.text);
    }
  }
  const enriched: JsonObject = { ...update };
  if (texts.length > 0 && update.rawOutput === undefined) {
    const text = texts.join("\n").replace(TIMESTAMP_PREFIX, "");
    enriched.rawOutput =
      text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[truncated]` : text;
  }
  if (diff && update.kind === "edit") {
    const input = isObject(update.rawInput) ? update.rawInput : {};
    enriched.rawInput = {
      ...input,
      filePath: typeof diff.path === "string" ? diff.path : input.Path,
      ...(typeof diff.oldText === "string" ? { oldString: diff.oldText } : {}),
      ...(typeof diff.newText === "string" ? { newString: diff.newText } : {}),
    };
  }
  return { ...message, params: { ...params, update: enriched } };
}

interface SteerRequest {
  jsonrpc: "2.0";
  id: string;
  method: "session/prompt";
  params: { sessionId: string; prompt: AcpContentBlock[] };
}

interface Steering {
  /** The adapter's running session/prompt. */
  promptId: MessageId;
  /** The newest injected prompt; agy answers older ones as soon as a newer one arrives. */
  latestSteerId: string;
  /** agy's early answer to promptId, withheld until the steered work finishes. */
  held: AcpStreamMessage | null;
}

/**
 * Tracks prompts between the adapter and agy so a steer can extend the running turn.
 *
 * agy semantics (measured on 1.5.10): a second session/prompt during a turn makes agy answer
 * the first one immediately with `end_turn`, then carry the remaining work and the new
 * instruction under the second request. The adapter would treat that early answer as the end
 * of the turn while agy keeps working, so hold it and release it with the outcome of the last
 * injected prompt. Paseo then sees one turn that ran until agy really stopped.
 */
export class SteeringRelay {
  private readonly pending = new Map<MessageId, string>();
  private readonly swallow = new Set<MessageId>();
  private steering: Steering | null = null;
  private sequence = 0;

  /** Call for every message the adapter writes. */
  outgoing(message: AcpStreamMessage): void {
    if (!("method" in message) || message.method !== "session/prompt" || !("id" in message)) return;
    if (message.id === null || !isObject(message.params)) return;
    const sessionId = message.params.sessionId;
    if (typeof sessionId === "string") this.pending.set(message.id, sessionId);
  }

  /** Call for every message agy writes; returns the messages the adapter should receive. */
  incoming(message: AcpStreamMessage): AcpStreamMessage[] {
    if ("method" in message || !("id" in message) || message.id === null) return [message];
    const id = message.id;
    if (typeof id === "string" && id.startsWith(STEER_ID_PREFIX)) return this.steerAnswered(id, message);
    if (this.swallow.delete(id)) return [];
    if (this.steering?.promptId === id) {
      this.steering.held = message;
      return [];
    }
    this.pending.delete(id);
    return [message];
  }

  /** Returns the injected request to write, or null when no adapter prompt is running. */
  steer(content: AcpContentBlock[]): SteerRequest | null {
    const running = [...this.pending.entries()].at(-1);
    if (!running) return null;
    const [promptId, sessionId] = running;
    if (this.steering && this.steering.promptId !== promptId) return null;
    const id = `${STEER_ID_PREFIX}${++this.sequence}`;
    this.steering = { promptId, latestSteerId: id, held: this.steering?.held ?? null };
    return { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: content } };
  }

  private steerAnswered(id: string, message: AcpStreamMessage): AcpStreamMessage[] {
    const steering = this.steering;
    // An older injected prompt that agy answered early because a newer one arrived.
    if (!steering || steering.latestSteerId !== id) return [];
    const failed = "error" in message;
    if (failed && steering.held === null) {
      // agy refused the steer while the original prompt still runs; let that prompt finish.
      console.error("[antigravity-plus] agy rejected a steering prompt; the turn continues");
      this.steering = null;
      return [];
    }
    this.steering = null;
    this.pending.delete(steering.promptId);
    if (failed) return steering.held ? [steering.held] : [];
    if (steering.held === null) this.swallow.add(steering.promptId);
    const outcome = "result" in message ? { result: message.result } : {};
    return [{ jsonrpc: "2.0", id: steering.promptId, ...outcome } as AcpStreamMessage];
  }
}

let observedModelIds: string[] = [];

/**
 * Model ids from agy's last session/new or session/load answer, effort variants included
 * (`gemini-4-hydrogen-xhigh`). The adapter keeps only the configOptions; catalog discovery
 * reads this right after the answer that set it.
 */
export function latestModelIds(): readonly string[] {
  return observedModelIds;
}

function observeModels(message: AcpStreamMessage): void {
  if (!("result" in message) || !isObject(message.result) || !isObject(message.result.models)) return;
  const available = message.result.models.availableModels;
  if (!Array.isArray(available)) return;
  const ids = available
    .map((model) => (isObject(model) ? model.modelId : undefined))
    .filter((id): id is string => typeof id === "string");
  if (ids.length > 0) observedModelIds = ids;
}

/** Mutable per session: the wrapper flips it when the agent enters or leaves Bypass. */
export interface PermissionPolicy {
  bypass: boolean;
}

export interface AgyStreamOptions {
  policy?: PermissionPolicy;
  /** Appended to agy's system prompt after Paseo's own on session/new|load. */
  appendSystemPrompt?: string;
}

/** The answer Bypass gives a session/request_permission: allow once, never "always". */
export function approve(message: AcpStreamMessage): AcpStreamMessage | null {
  if (!("method" in message) || message.method !== "session/request_permission") return null;
  if (!("id" in message) || message.id === null || !isObject(message.params)) return null;
  const options = Array.isArray(message.params.options) ? message.params.options.filter(isObject) : [];
  const choice =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => typeof option.kind === "string" && option.kind.startsWith("allow"));
  if (!choice || typeof choice.optionId !== "string") return null;
  return {
    jsonrpc: "2.0",
    id: message.id,
    result: { outcome: { outcome: "selected", optionId: choice.optionId } },
  };
}

/**
 * Starts `agy acp` with the daemon-resolved launch plus the session's own environment
 * (PASEO_AGENT_ID, PASEO_WORKSPACE_ID, ...), and exposes it as an object stream.
 */
export function openAgyStream(
  launch: ProviderLaunch,
  env: Record<string, string>,
  options: AgyStreamOptions = {},
): AgyStream {
  const child = spawnProcess(launch.command, launch.args, {
    env: { ...launch.env, ...env },
    stdio: "pipe",
  });
  const relay = new SteeringRelay();
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
  });
  let stopping = false;
  let exited = false;
  child.once("close", () => {
    exited = true;
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (exited) return;
    // End stdin for a graceful shutdown so agy can finish saving the conversation.
    child.stdin.end();
    const kill = setTimeout(() => void terminateProcess(child), 3000);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
  };
  const write = (message: AcpStreamMessage) =>
    new Promise<void>((resolve, reject) => {
      if (stopping || child.stdin.destroyed) {
        reject(new Error("agy acp is not running"));
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  const lines = createInterface({ input: child.stdout });
  // agy can keep writing after the adapter cancels the stream (a failed open, a close), and
  // enqueueing on a closed controller throws inside the readline callback, which would crash
  // the whole plugin process. Drop such lines.
  let readableOpen = true;
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      const deliver = (message: AcpStreamMessage) => {
        if (!readableOpen) return;
        try {
          controller.enqueue(message);
        } catch {
          readableOpen = false;
        }
      };
      lines.on("line", (line) => {
        if (!line.trim() || !readableOpen) return;
        let message: AcpStreamMessage;
        try {
          message = JSON.parse(line) as AcpStreamMessage;
        } catch {
          console.error("[antigravity-plus] agy acp wrote a non-JSON line; ignored");
          return;
        }
        observeModels(message);
        if (options.policy?.bypass) {
          const answer = approve(message);
          if (answer) {
            write(answer).catch((error) => {
              console.error(`[antigravity-plus] bypass approval failed: ${String(error)}`);
            });
            return;
          }
        }
        for (const forwarded of relay.incoming(withToolResults(message))) deliver(forwarded);
      });
      child.once("error", (error) => {
        if (!readableOpen) return;
        readableOpen = false;
        try {
          controller.error(error);
        } catch {
          // Already closed.
        }
      });
      child.once("close", (code, signal) => {
        lines.close();
        if (!stopping && stderrTail.trim()) {
          console.error(
            `[antigravity-plus] agy acp exited (${signal ?? code}): ${stderrTail.trim().slice(-800)}`,
          );
        }
        if (!readableOpen) return;
        readableOpen = false;
        try {
          controller.close();
        } catch {
          // Already errored or closed.
        }
      });
    },
    cancel() {
      readableOpen = false;
      stop();
    },
  });
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      const prepared = withAntigravityMeta(message, options.appendSystemPrompt);
      relay.outgoing(prepared);
      return write(prepared);
    },
    close() {
      stop();
    },
    abort() {
      stopping = true;
      if (!exited) void terminateProcess(child);
    },
  });
  return {
    stream: { readable, writable },
    steer(content) {
      const request = relay.steer(content);
      if (!request) return false;
      write(request).catch((error) => {
        console.error(`[antigravity-plus] steering write failed: ${String(error)}`);
      });
      return true;
    },
  };
}
