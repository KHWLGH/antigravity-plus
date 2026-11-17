import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

/**
 * Paseo's Import session dialog reads agy's `session/list` through the ACP adapter, which keeps
 * the first `limit` entries in agy's order. The daemon then keeps sessions whose cwd equals the
 * dialog's directory and sorts what is left. agy 1.5.10 breaks that in three ways (measured on
 * 466 sessions):
 * - it ignores `params.cwd` and returns every conversation;
 * - its order is not by recency: sessions created over ACP come after hundreds of older ones,
 *   so the adapter's cut drops every Antigravity+ conversation;
 * - it percent-encodes non-ASCII paths (`.../%E5%AD%A6%E4%B9%A0`), so they never equal the
 *   directory the daemon compares against.
 * - conversations stored without a directory are reported in the listing process's own working
 *   directory, so a listing run in the requested directory would claim them all.
 * This layer answers the adapter with the requested directory's sessions only, decoded and
 * newest first, after collecting every page agy offers. Listings run in LIST_CWD, an empty
 * directory of this plugin, and a session reported there has no known directory.
 */

export const LIST_CWD = path.join(tmpdir(), "antigravity-plus", "session-list");

/** Creates LIST_CWD on demand and returns it. */
export function listWorkingDirectory(): string {
  try {
    mkdirSync(LIST_CWD, { recursive: true });
    return LIST_CWD;
  } catch {
    return homedir();
  }
}

type JsonObject = Record<string, unknown>;
type MessageId = string | number;

/** JSON-RPC ids of follow-up page requests; the adapter never sees their responses. */
const PAGE_ID_PREFIX = "antigravity-plus-list-page-";
/** Stop following cursors after this many pages; agy 1.5.10 sends everything in one. */
const MAX_PAGES = 50;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** agy reports `file:` URIs as percent-encoded paths; turn either form into a plain path. */
export function decodeCwd(value: string): string {
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value);
    } catch {
      return value;
    }
  }
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The daemon's comparison: posix-normalized, no trailing separator except the root. */
function normalize(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export type RealpathResolver = (value: string) => string[];

function realpaths(value: string): string[] {
  const found: string[] = [];
  for (const resolve of [realpathSync.native, realpathSync]) {
    try {
      found.push(resolve(value));
    } catch {
      // Missing paths compare as strings, as in the daemon.
    }
  }
  return found;
}

/** Same equivalence as the daemon's createRealpathAwarePathMatcher, without subdirectories. */
function variantsOf(value: string, resolve: RealpathResolver, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(value);
  if (cached) return cached;
  const variants = new Set([value, ...resolve(value)].map(normalize));
  cache.set(value, variants);
  return variants;
}

function updatedAt(session: JsonObject): number {
  const parsed = typeof session.updatedAt === "string" ? Date.parse(session.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Decodes every cwd, keeps only sessions in `requestedCwd` (when given) and returns them newest
 * first. A kept session reports `requestedCwd` itself, the exact string the daemon matches.
 */
export function arrangeSessions(
  sessions: readonly unknown[],
  requestedCwd: string | null,
  resolve: RealpathResolver = realpaths,
  /** The listing process's directory: agy's stand-in for "no directory recorded". */
  placeholderCwd: string | null = null,
): JsonObject[] {
  const cache = new Map<string, Set<string>>();
  const target = requestedCwd ? variantsOf(requestedCwd, resolve, cache) : null;
  const placeholder = placeholderCwd ? variantsOf(placeholderCwd, resolve, cache) : null;
  const arranged: JsonObject[] = [];
  for (const session of sessions) {
    if (!isObject(session)) continue;
    let cwd = typeof session.cwd === "string" ? decodeCwd(session.cwd) : undefined;
    if (cwd && placeholder && [...variantsOf(cwd, resolve, cache)].some((variant) => placeholder.has(variant))) {
      // No directory recorded: never part of a directory's list; listed under home otherwise.
      if (target) continue;
      cwd = homedir();
    }
    if (target && requestedCwd) {
      if (!cwd) continue;
      const variants = variantsOf(cwd, resolve, cache);
      if (![...variants].some((variant) => target.has(variant))) continue;
      arranged.push({ ...session, cwd: requestedCwd });
    } else {
      arranged.push(cwd === undefined ? { ...session } : { ...session, cwd });
    }
  }
  // Array.prototype.sort is stable, so equal timestamps keep agy's order.
  return arranged.sort((left, right) => updatedAt(right) - updatedAt(left));
}

interface PendingList {
  originalId: MessageId;
  cwd: string | null;
  sessions: unknown[];
  pages: number;
  firstResult: JsonObject | null;
}

export interface ListRelayResult {
  /** Messages for the adapter. */
  deliver: AcpStreamMessage[];
  /** Requests to write to agy. */
  send: AcpStreamMessage[];
}

export class SessionListRelay {
  private readonly pending = new Map<MessageId, PendingList>();
  private readonly resolve: RealpathResolver;
  private readonly placeholderCwd: string | null;
  private sequence = 0;

  constructor(resolve: RealpathResolver = realpaths, placeholderCwd: string | null = null) {
    this.resolve = resolve;
    this.placeholderCwd = placeholderCwd;
  }

  /** Call for every message the adapter writes. */
  outgoing(message: AcpStreamMessage): void {
    if (!("method" in message) || message.method !== "session/list" || !("id" in message)) return;
    if (message.id === null) return;
    const params = isObject(message.params) ? message.params : {};
    const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : null;
    this.pending.set(message.id, { originalId: message.id, cwd, sessions: [], pages: 0, firstResult: null });
  }

  /** Returns null when the message is not an answer to a session/list this relay tracks. */
  incoming(message: AcpStreamMessage): ListRelayResult | null {
    if ("method" in message || !("id" in message) || message.id === null) return null;
    const entry = this.pending.get(message.id);
    if (!entry) return null;
    this.pending.delete(message.id);
    if (!("result" in message) || !isObject(message.result) || !Array.isArray(message.result.sessions)) {
      // An error on the first page goes to the adapter as is; on a later page, keep what arrived.
      if (entry.pages === 0) return { deliver: [{ ...message, id: entry.originalId } as AcpStreamMessage], send: [] };
      return { deliver: [this.answer(entry)], send: [] };
    }
    entry.pages += 1;
    entry.firstResult ??= message.result;
    entry.sessions.push(...message.result.sessions);
    const cursor = message.result.nextCursor;
    if (typeof cursor === "string" && cursor.length > 0 && entry.pages < MAX_PAGES) {
      const id = `${PAGE_ID_PREFIX}${++this.sequence}`;
      this.pending.set(id, entry);
      const params = entry.cwd ? { cwd: entry.cwd, cursor } : { cursor };
      return { deliver: [], send: [{ jsonrpc: "2.0", id, method: "session/list", params }] };
    }
    return { deliver: [this.answer(entry)], send: [] };
  }

  private answer(entry: PendingList): AcpStreamMessage {
    return {
      jsonrpc: "2.0",
      id: entry.originalId,
      result: {
        ...(entry.firstResult ?? {}),
        sessions: arrangeSessions(entry.sessions, entry.cwd, this.resolve, this.placeholderCwd),
        nextCursor: null,
      },
    };
  }
}
