import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageReport } from "@getpaseo/plugin/server/usage";
import { accountId, type KeychainStore } from "./accounts.ts";
import { AccountQuota, createAntigravityUsageSource } from "./quota.ts";

const a = "a@example.com";
const b = "b@example.com";
const idA = accountId(a);
const idB = accountId(b);
const time = "2025-01-01T00:00:00Z";
const measured: UsageReport = {
  status: "available",
  windows: [{ id: "limit", label: "Limit", remainingPct: 20, resetsAt: time }],
};

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(readSlot: () => string, request = async (): Promise<UsageReport> => measured) {
  const store: KeychainStore = {
    async read(service, account) {
      assert.equal(service, "gemini");
      assert.equal(account, "antigravity");
      return readSlot();
    },
    async write() { assert.fail("unexpected Keychain write"); },
    async remove() { assert.fail("unexpected Keychain deletion"); },
  };
  const accounts = [a, b].map(email => ({
    id: accountId(email), email, addedAt: time, snapshot: { report: measured, readAt: time },
  }));
  const recorded: string[] = [];
  const state = { activeAccountId: idA, accounts, busy: false, notice: null };
  let reconciles = 0;
  const manager = {
    epoch: 0,
    async reconcile() { reconciles++; },
    snapshot() { return state; },
    isCurrent(id: string, epoch: number) { return state.activeAccountId === id && this.epoch === epoch; },
    recordReport(id: string, epoch: number, _report: UsageReport) {
      if (!this.isCurrent(id, epoch)) return false;
      recorded.push(id);
      return true;
    },
  };
  const quota = new AccountQuota(store, request, async () => { assert.fail("unexpected agy refresh"); });
  return { source: createAntigravityUsageSource(manager, quota), state, manager, recorded, reconciles: () => reconciles };
}

function login(email: string) {
  return JSON.stringify({ id_token_email: email, token: { access_token: "fixture" } });
}

test("standby fetch uses metadata only and labels a passed reset without changing its measured value", async () => {
  const { source, reconciles } = fixture(
    () => assert.fail("standby read the Keychain"),
    async () => assert.fail("standby contacted the quota service"),
  );
  const snapshot = await source.fetch({ accountId: idB });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.windows[0].remainingPct, 20);
  assert.match(snapshot.windows[0].label, /reset passed/);
  assert.equal(snapshot.details?.[0]?.value, time);
  assert.equal(reconciles(), 0);
});

test("late live quota across A to B to A cannot be recorded, even when slot email again matches", async () => {
  const started = latch();
  const finish = latch();
  const { source, state, manager, recorded } = fixture(() => login(a), async () => {
    started.resolve();
    await finish.promise;
    return { status: "available", windows: [{ id: "new", label: "New" }] };
  });
  const pending = source.fetch({ accountId: idA });
  await started.promise;
  state.activeAccountId = idB;
  manager.epoch++;
  state.activeAccountId = idA;
  manager.epoch++;
  finish.resolve();
  const report = await pending;
  assert.equal(report.status, "available");
  assert.equal(report.windows[0].id, "limit");
  assert.deepEqual(recorded, []);
});

test("detects external slot change during a live request before updating the card", async () => {
  let email = a;
  const { source, recorded } = fixture(() => login(email), async () => {
    email = b;
    return measured;
  });
  await assert.rejects(source.fetch({ accountId: idA }), /active Antigravity account changed/);
  assert.deepEqual(recorded, []);
});

test("a switch waits for an outstanding agy credential writer even after cache reset", async () => {
  const started = latch();
  const finish = latch();
  let current = true;
  let drained = false;
  const expired = JSON.stringify({
    id_token_email: a, token: { access_token: "fixture", expiry: time },
  });
  const quota = new AccountQuota({
    read: async () => expired,
    write: async () => assert.fail("unexpected write"),
    remove: async () => assert.fail("unexpected delete"),
  }, async () => assert.fail("unexpected quota request"), async () => {
    started.resolve();
    await finish.promise;
  });
  const fetch = quota.fetch(idA, () => current);
  await started.promise;
  current = false;
  quota.reset();
  const drain = quota.drainRefreshes().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  finish.resolve();
  await assert.rejects(fetch, /account changed/);
  await drain;
  assert.equal(drained, true);
});
