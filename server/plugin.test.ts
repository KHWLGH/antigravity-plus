import assert from "node:assert/strict";
import { test } from "node:test";
import { withAntigravityMeta } from "./agy-stream.ts";
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
  assert.ok(Math.abs((windows[0].usedPct ?? 0) - 16.4884) < 0.001);
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
  assert.ok(Math.abs((windows[0].usedPct ?? 0) - 6.640667) < 0.001);
});
