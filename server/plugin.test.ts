import assert from "node:assert/strict";
import { test } from "node:test";
import { SteeringRelay, approve, withAntigravityMeta, withToolResults } from "./agy-stream.ts";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderModel,
} from "@getpaseo/plugin/server/provider";
import { withModelThinking } from "./catalog.ts";
import { wrapConnection } from "./session-wrapper.ts";
import {
  availableModelsSchema,
  googlePoolWindows,
  quotaSummarySchema,
  summaryWindows,
} from "./quota-windows.ts";

test("copies the Paseo system prompt into agy's append meta", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "session/new",
    params: { cwd: "/tmp", mcpServers: [], _meta: { _paseo: { systemPrompt: "Be brief." } } },
  };
  const result = withAntigravityMeta(message) as typeof message & {
    params: { _meta: { antigravity: { systemPrompt: { append: string } } } };
  };
  assert.equal(result.params._meta.antigravity.systemPrompt.append, "Be brief.");
  assert.deepEqual(result.params._meta._paseo, { systemPrompt: "Be brief." });
  assert.equal((message.params._meta as Record<string, unknown>).antigravity, undefined);
});

test("appends the plugin's own guidance after Paseo's prompt", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: 4,
    method: "session/load",
    params: { _meta: { _paseo: {} } },
  };
  const result = withAntigravityMeta(message, "Use Paseo agents.") as typeof message & {
    params: { _meta: { antigravity: { systemPrompt: { append: string } } } };
  };
  assert.equal(result.params._meta.antigravity.systemPrompt.append, "Use Paseo agents.");
});

test("leaves prompts and sessions without a system prompt untouched", () => {
  const prompt = { jsonrpc: "2.0" as const, id: 2, method: "session/prompt", params: { _meta: {} } };
  assert.equal(withAntigravityMeta(prompt), prompt);
  const load = { jsonrpc: "2.0" as const, id: 3, method: "session/load", params: { _meta: { _paseo: {} } } };
  assert.equal(withAntigravityMeta(load), load);
});

function fakeInner() {
  const sent: ProviderInput[] = [];
  let listener: (event: ProviderEvent) => void = () => {};
  const connection: ProviderConnection = {
    version: 1,
    capabilities: ["prompt.message", "session.configure"],
    async send(input) {
      sent.push(input);
    },
    onEvent(next) {
      listener = next;
      return () => {};
    },
    async close() {},
  };
  return { connection, sent, fire: (event: ProviderEvent) => listener(event) };
}

function wrapped() {
  const inner = fakeInner();
  const flags: Array<[string, boolean]> = [];
  const events: ProviderEvent[] = [];
  const connection = wrapConnection(inner.connection, ["prompt.steer"], {
    modelIds: () => ["gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gpt-oss-120b-medium"],
    setSubagentsAllowed: async (id, allowed) => {
      flags.push([id, allowed]);
    },
    env: { ANTIGRAVITY_PLUS: "1" },
  });
  connection.onEvent((event) => events.push(event));
  return { inner, flags, events, connection };
}

const openInput = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    type: "session.open",
    requestId: "o1",
    sessionId: "s1",
    history: "skip",
    config: { cwd: "/tmp", env: { PASEO_AGENT_ID: "a1" }, mcpServers: {}, settings: {}, persist: true, ...config },
    ...extra,
  }) as unknown as ProviderInput;

const innerConfig = (mode: string) => ({
  type: "session.config" as const,
  sessionId: "s1",
  config: {
    model: "gemini-4-hydrogen",
    mode,
    models: [{ id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" }],
    modes: [{ id: "default", label: "Default" }],
    thinkingOptions: [],
  },
});

test("a new session starts in Bypass: agy gets Default, Paseo sees Bypass", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({}));
  const sent = inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>;
  assert.equal(sent.config.mode, "default");
  inner.fire(innerConfig("default"));
  const config = events.find((event) => event.type === "session.config") as ReturnType<typeof innerConfig>;
  assert.equal(config.config.mode, "bypass");
  assert.ok(config.config.modes.some((mode) => mode.id === "bypass"));
  const hydrogen = config.config.models[0] as { thinkingOptions?: Array<{ id: string }> };
  assert.deepEqual(hydrogen.thinkingOptions?.map((option) => option.id), ["high", "xhigh"]);
});

test("a resumed session keeps agy's mode, and agy leaving Default ends Bypass", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({}, { persistence: { version: 1, data: { sessionId: "c1" } } }));
  assert.equal((inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>).config.mode, undefined);
  inner.fire(innerConfig("plan"));
  const config = events.at(-1) as ReturnType<typeof innerConfig>;
  assert.equal(config.config.mode, "plan");
});

test("the agy subagents switch never reaches the adapter and is applied to the hook flag", async () => {
  const { inner, flags, events, connection } = wrapped();
  await connection.send(openInput({ providerOptions: { agySubagents: true }, settings: { agySubagents: true } }));
  const sent = inner.sent[0] as Extract<ProviderInput, { type: "session.open" }>;
  assert.deepEqual(sent.config.providerOptions, {});
  assert.deepEqual(sent.config.settings, {});
  inner.fire({
    type: "session.opened",
    requestId: "o1",
    sessionId: "s1",
    capabilities: [],
    restoration: "core",
    persistence: { version: 1, data: { sessionId: "conv-1" } },
  } as unknown as ProviderEvent);
  assert.deepEqual(flags.at(-1), ["conv-1", true]);
  inner.fire({ type: "session.ready", requestId: "o1", sessionId: "s1" } as ProviderEvent);
  inner.fire(innerConfig("default"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Only the switch changes: answered here, nothing forwarded.
  await connection.send({
    type: "session.configure",
    requestId: "c1",
    sessionId: "s1",
    changes: { providerOptions: { agySubagents: false } },
  } as ProviderInput);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(inner.sent.length, 1);
  assert.deepEqual(flags.at(-1), ["conv-1", false]);
  const last = events.at(-1);
  assert.equal(last?.type, "request.completed");
  const config = events.at(-2) as ReturnType<typeof innerConfig> & {
    config: { providerOptions: Record<string, unknown> };
  };
  assert.equal(config.config.providerOptions.agySubagents, false);
});

test("switching to Bypass sends Default to agy and rolls back if the adapter fails", async () => {
  const { inner, events, connection } = wrapped();
  await connection.send(openInput({ mode: "plan" }));
  inner.fire({ type: "session.ready", requestId: "o1", sessionId: "s1" } as ProviderEvent);
  inner.fire(innerConfig("plan"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await connection.send({
    type: "session.configure",
    requestId: "c2",
    sessionId: "s1",
    changes: { mode: "bypass" },
  } as ProviderInput);
  const forwarded = inner.sent.at(-1) as Extract<ProviderInput, { type: "session.configure" }>;
  assert.equal(forwarded.changes.mode, "default");
  inner.fire({ type: "request.failed", requestId: "c2", error: { message: "nope" } } as ProviderEvent);
  const config = events.at(-2) as ReturnType<typeof innerConfig>;
  assert.equal(config.config.mode, "plan");
});

test("Bypass answers permission requests with allow once", () => {
  const answer = approve({
    jsonrpc: "2.0",
    id: 9,
    method: "session/request_permission",
    params: {
      options: [
        { optionId: "always", kind: "allow_always" },
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  assert.deepEqual(answer, { jsonrpc: "2.0", id: 9, result: { outcome: { outcome: "selected", optionId: "allow" } } });
});

test("models without effort variants get no thinking levels", () => {
  const input: ProviderModel[] = [
    { id: "gemini-4-hydrogen", label: "H" },
    { id: "gpt-oss-120b-medium", label: "G" },
  ];
  const models = withModelThinking(
    input,
    ["gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh", "gpt-oss-120b-medium"],
  );
  assert.deepEqual(models[0].thinkingOptions?.map((option) => option.id), ["low", "medium", "xhigh"]);
  assert.equal(models[0].defaultThinkingOptionId, "medium");
  assert.deepEqual(models[1].thinkingOptions, []);
});

const summary = quotaSummarySchema.parse({
  groups: [
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-11-18T06:25:56Z",
          remainingFraction: 0.835116,
        },
        {
          bucketId: "3p-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-11-17T12:44:53Z",
          remainingFraction: 1,
        },
      ],
    },
  ],
});

test("maps the quota summary to weekly and five-hour windows", () => {
  const windows = summaryWindows(summary);
  assert.deepEqual(
    windows.map((window) => [window.id, window.label, window.shortLabel]),
    [
      ["group-3p:weekly", "Claude and GPT · Weekly", "Claude and GPT wk"],
      ["group-3p:five_hour", "Claude and GPT · 5-hour", "Claude and GPT 5h"],
    ],
  );
  assert.equal(windows[0].usedPct, 16.5);
  assert.equal(windows[1].usedPct, 0);
  assert.equal(windows[0].resetsAt, "2026-11-18T06:25:56Z");
});

test("publishes one neutral window for the shared Google model pool", () => {
  const models = availableModelsSchema.parse({
    models: {
      "gemini-4-hydrogen-sonar": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        quotaInfo: { remainingFraction: 0.93359333, resetTime: "2026-11-17T11:05:18Z" },
      },
      "gemini-3.8-flash-tiered": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        quotaInfo: { remainingFraction: 0.93359333, resetTime: "2026-11-17T11:05:18Z" },
      },
      chat_20706: { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1 } },
      "claude-opus-5-5-high": {
        modelProvider: "MODEL_PROVIDER_ANTHROPIC",
        quotaInfo: { remainingFraction: 1, resetTime: "2026-11-17T12:45:46Z" },
      },
    },
  });
  const windows = googlePoolWindows(models, summary);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, "google-models");
  assert.equal(windows[0].label, "Gemini Hydrogen/Flash");
  assert.equal(windows[0].usedPct, 6.6);
});

const promptA = {
  jsonrpc: "2.0" as const,
  id: 7,
  method: "session/prompt",
  params: { sessionId: "native-1", prompt: [{ type: "text", text: "count" }] },
};
const answer = (id: string | number, stopReason: string) => ({
  jsonrpc: "2.0" as const,
  id,
  result: { stopReason },
});

test("a steer holds agy's early answer and releases it with the steered outcome", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const injected = relay.steer([{ type: "text", text: "also say BANANA" }]);
  assert.ok(injected && "id" in injected && "params" in injected);
  assert.deepEqual((injected.params as { sessionId: string }).sessionId, "native-1");
  // agy answers the original prompt as soon as the steer arrives: withheld.
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), []);
  // Notifications keep flowing.
  const update = { jsonrpc: "2.0" as const, method: "session/update", params: {} };
  assert.deepEqual(relay.incoming(update), [update]);
  // The steered prompt finishes: the adapter sees its own prompt end with that outcome.
  assert.deepEqual(relay.incoming(answer(injected.id as string, "end_turn")), [answer(7, "end_turn")]);
  assert.equal(relay.steer([{ type: "text", text: "late" }]), null);
});

test("a second steer supersedes the first, and a cancel ends the turn as canceled", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const first = relay.steer([{ type: "text", text: "one" }])!;
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), []);
  const second = relay.steer([{ type: "text", text: "two" }])!;
  assert.deepEqual(relay.incoming(answer(first.id as string, "end_turn")), []);
  assert.deepEqual(relay.incoming(answer(second.id as string, "cancelled")), [answer(7, "cancelled")]);
});

test("if the steered prompt finishes before agy answers the original, the late answer is dropped", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const injected = relay.steer([{ type: "text", text: "x" }])!;
  assert.deepEqual(relay.incoming(answer(injected.id as string, "end_turn")), [answer(7, "end_turn")]);
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), []);
});

test("a rejected steer lets the original prompt finish on its own", () => {
  const relay = new SteeringRelay();
  relay.outgoing(promptA);
  const injected = relay.steer([{ type: "text", text: "x" }])!;
  const rejected = { jsonrpc: "2.0" as const, id: injected.id, error: { code: -32000, message: "busy" } };
  assert.deepEqual(relay.incoming(rejected), []);
  assert.deepEqual(relay.incoming(answer(7, "end_turn")), [answer(7, "end_turn")]);
});

test("copies agy tool content into rawOutput and edit diffs into the adapter's edit fields", () => {
  const command = withToolResults({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        kind: "execute",
        rawInput: { CommandLine: "echo hi" },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Created At: 2026-11-17T16:04:24+08:00\nCompleted At: 2026-11-17T16:04:24+08:00\nCommand exited with code 0.\n\nCommand output:\nhi\r\n",
            },
          },
        ],
      },
    },
  }) as { params: { update: { rawOutput: string } } };
  assert.equal(command.params.update.rawOutput, "Command exited with code 0.\n\nCommand output:\nhi\r\n");
  const edit = withToolResults({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        kind: "edit",
        rawInput: { Path: "/tmp/notes.txt", Target: "beta world", Replacement: "beta updated" },
        content: [
          { type: "diff", path: "/tmp/notes.txt", oldText: "a\nbeta world\n", newText: "a\nbeta updated\n" },
        ],
      },
    },
  }) as { params: { update: { rawInput: Record<string, string> } } };
  assert.equal(edit.params.update.rawInput.filePath, "/tmp/notes.txt");
  assert.equal(edit.params.update.rawInput.oldString, "a\nbeta world\n");
  assert.equal(edit.params.update.rawInput.newString, "a\nbeta updated\n");
  assert.equal(edit.params.update.rawInput.Target, "beta world");
});

test("before agy listed its models, an open with a thinking level asks for the list first", async () => {
  const inner = fakeInner();
  let ids: string[] = [];
  const seen: ProviderEvent[] = [];
  const connection = wrapConnection(inner.connection, [], {
    modelIds: () => ids,
    setSubagentsAllowed: async () => {},
  });
  connection.onEvent((event) => seen.push(event));
  const opened = connection.send(openInput({ model: "gpt-oss-120b-medium", thinkingOption: "medium" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const catalog = inner.sent[0] as Extract<ProviderInput, { type: "catalog" }>;
  assert.equal(catalog.type, "catalog");
  ids = ["gpt-oss-120b-medium", "gemini-4-hydrogen-high"];
  inner.fire({ type: "catalog", requestId: catalog.requestId, catalog: { models: [], modes: [] } } as ProviderEvent);
  await opened;
  const open = inner.sent[1] as Extract<ProviderInput, { type: "session.open" }>;
  assert.equal(open.config.thinkingOption, undefined);
  assert.equal(seen.length, 0, "the private catalog answer is not forwarded");
});
