import { createInterface } from "node:readline";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

/** Methods whose `_meta` agy reads when it creates or reopens a session runtime. */
const SESSION_METHODS = new Set(["session/new", "session/load", "session/resume"]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Paseo's ACP adapter sends the agent's system prompt as `_meta._paseo.systemPrompt`,
 * which agy ignores. agy appends `_meta.antigravity.systemPrompt.append` to its own
 * system prompt instead (verified against agy 1.5.10), so copy the value across.
 */
export function withAntigravityMeta(message: AcpStreamMessage): AcpStreamMessage {
  if (!("method" in message) || !SESSION_METHODS.has(message.method)) return message;
  const params = message.params;
  if (!isObject(params) || !isObject(params._meta)) return message;
  const paseo = params._meta._paseo;
  const systemPrompt = isObject(paseo) ? paseo.systemPrompt : undefined;
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) return message;
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

/**
 * Starts `agy acp` with the daemon-resolved launch plus the session's own environment
 * (PASEO_AGENT_ID, PASEO_WORKSPACE_ID, ...), and exposes it as an object stream.
 */
export function openAgyStream(launch: ProviderLaunch, env: Record<string, string>): AcpStream {
  const child = spawnProcess(launch.command, launch.args, {
    env: { ...launch.env, ...env },
    stdio: "pipe",
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // End stdin for a graceful shutdown so agy can finish saving the conversation.
    child.stdin.end();
    const kill = setTimeout(() => void terminateProcess(child), 3000);
    child.once("close", () => clearTimeout(kill));
  };
  const lines = createInterface({ input: child.stdout });
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      lines.on("line", (line) => {
        if (!line.trim()) return;
        try {
          controller.enqueue(JSON.parse(line) as AcpStreamMessage);
        } catch {
          console.error("[antigravity-plus] agy acp wrote a non-JSON line; ignored");
        }
      });
      child.once("error", (error) => {
        try {
          controller.error(error);
        } catch {
          // Already closed.
        }
      });
      child.once("close", (code, signal) => {
        if (!stopping && stderrTail.trim()) {
          console.error(
            `[antigravity-plus] agy acp exited (${signal ?? code}): ${stderrTail.trim().slice(-800)}`,
          );
        }
        try {
          controller.close();
        } catch {
          // Already errored or closed.
        }
      });
    },
    cancel() {
      stop();
    },
  });
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      return new Promise<void>((resolve, reject) => {
        if (stopping || child.stdin.destroyed) {
          reject(new Error("agy acp is not running"));
          return;
        }
        child.stdin.write(`${JSON.stringify(withAntigravityMeta(message))}\n`, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    },
    close() {
      stop();
    },
    abort() {
      stopping = true;
      void terminateProcess(child);
    },
  });
  return { readable, writable };
}
