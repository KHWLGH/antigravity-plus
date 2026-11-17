import assert from "node:assert/strict";
import { test } from "node:test";
import { SteeringRelay, withAntigravityMeta, withToolResults } from "./agy-stream.ts";
import { withDefaultMode } from "./provider.ts";
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

test("leaves prompts and sessions without a system prompt untouched", () => {
  const prompt = { jsonrpc: "2.0" as const, id: 2, method: "session/prompt", params: { _meta: {} } };
  assert.equal(withAntigravityMeta(prompt), prompt);
  const load = { jsonrpc: "2.0" as const, id: 3, method: "session/load", params: { _meta: { _paseo: {} } } };
  assert.equal(withAntigravityMeta(load), load);
});

test("new sessions default to Auto, resumed and explicit ones do not", () => {
  const base = {
    type: "session.open" as const,
    requestId: "r",
    sessionId: "s",
    config: { cwd: "/tmp", env: {}, mcpServers: {} },
  } as unknown as Parameters<typeof withDefaultMode>[0];
  assert.equal(withDefaultMode(base).config.mode, "auto");
  const explicit = { ...base, config: { ...base.config, mode: "plan" } };
  assert.equal(withDefaultMode(explicit).config.mode, "plan");
  const resumed = { ...base, persistence: { version: 1, data: { sessionId: "x" } } };
  assert.equal(withDefaultMode(resumed).config.mode, undefined);
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
  assert.equal(windows[0].label, "Google models");
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
