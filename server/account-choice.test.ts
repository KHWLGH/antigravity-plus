import test from "node:test";
import assert from "node:assert/strict";
import { composerChoice } from "../client/account-choice.ts";
import type { AccountsView, AccountView } from "../shared/accounts-rpc.ts";

const a: AccountView = { id: "a", email: "a@example.com", addedAt: "2026-01-01" };
const b: AccountView = { ...a, id: "b", email: "b@example.com" };
const c: AccountView = { ...a, id: "c", email: "c@example.com" };

function measured(account: AccountView, ...percentages: number[]): AccountView {
  return {
    ...account, snapshot: { readAt: "2026-01-01", report: {
      status: "available", windows: percentages.map((remainingPct, i) => ({ id: String(i), label: String(i), remainingPct })),
    } },
  };
}
function state(accounts: AccountView[], quotaError = false): AccountsView {
  return { accounts, activeAccountId: a.id, quotaError, busy: false, notice: null };
}

test("exhausted quota with unmeasured standby opens accounts for a manual selection", () => {
  const active = measured(a, 0);
  assert.deepEqual(composerChoice(state([active, b]), active), { depleted: true, confirmId: undefined });
});

test("agy quota errors suggest the standby with the largest measured minimum for confirmation", () => {
  const view = state([a, measured(b, 10, 90), measured(c, 50, 60)], true);
  assert.deepEqual(composerChoice(view, a), { depleted: true, confirmId: c.id });
});

test("available quota opens the ordinary accounts screen", () => {
  const active = measured(a, 80);
  assert.deepEqual(composerChoice(state([active, measured(b, 100)]), active), { depleted: false, confirmId: undefined });
});
