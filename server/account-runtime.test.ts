import test from "node:test";
import assert from "node:assert/strict";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { AccountRuntime } from "./account-runtime.ts";

function agent(id: string, status = "idle", provider = "antigravity-plus") {
  return { id, provider, status, pendingPermissions: [] } as unknown as PaseoAgent;
}

function fixture(entries: PaseoAgent[]) {
  const reloaded: string[] = [];
  const runtime = new AccountRuntime();
  runtime.attach({
    agents: {
      list: async () => ({ entries: entries.map(agent => ({agent})), pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: entries.find(a => a.id === id) }),
        reload: async () => { reloaded.push(id); return { agent: entries.find(a => a.id === id) }; },
      }),
    },
  } as unknown as PaseoApi);
  return { runtime, reloaded };
}

test("runtime keeps a queued prompt busy until the turn settles and rejects prompts during the switch", async () => {
  const {runtime} = fixture([]);
  let emit!: (event: ProviderEvent) => void;
  let sent = 0;
  const connection: ProviderConnection = {
    version: 1, capabilities: [],
    send: async () => { sent++; },
    onEvent(listener) { emit = listener; return () => {}; },
    close: async () => {},
  };
  const gate = { allowTurn: true, allowOpen: true };
  const guarded = runtime.guard(connection, gate);
  const prompt = { type: "session.prompt", sessionId: "session", prompt: {clientMessageId: "message"} } as ProviderInput;
  await guarded.send(prompt);
  assert.deepEqual(await runtime.busyAgents(), ["session"]);
  emit({type: "session.prompt_result", sessionId: "session", clientMessageId: "message", result: {type: "turn", turnId: "turn"}});
  assert.deepEqual(await runtime.busyAgents(), ["session"]);
  emit({type: "session.turn", sessionId: "session", state: "completed", turnId: "turn"});
  assert.deepEqual(await runtime.busyAgents(), []);
  gate.allowTurn = false;
  await assert.rejects(guarded.send(prompt), /account change/);
  assert.equal(sent, 1);
});

test("reload skips other providers and closed history and rechecks for active turns", async () => {
  const entries = [agent("ours"), agent("history", "closed"), agent("other", "running", "other")];
  const {runtime, reloaded} = fixture(entries);
  await runtime.rememberOpenAgents();
  entries[0] = agent("ours", "closed");
  await runtime.reload();
  assert.deepEqual(reloaded, ["ours"]);
  entries[0] = agent("ours", "running");
  await assert.rejects(runtime.reload(), /ours/);
  assert.deepEqual(reloaded, ["ours"]);
});
