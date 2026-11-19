import type { AccountView, AccountsView, WindowView } from "../shared/accounts-rpc.ts";

export function remaining(window: WindowView) {
  return window.remainingPct ?? (window.usedPct == null ? null : 100 - window.usedPct);
}

export function windows(account: AccountView) {
  return account.snapshot?.report.status === "available" ? account.snapshot.report.windows : [];
}

/** The least remaining window limits how much of a standby account's measured quota is usable. */
export function bestStandby(accounts: AccountView[], activeId: string) {
  let best: AccountView | undefined;
  let bestScore = -1;
  for (const account of accounts) {
    if (account.id === activeId) continue;
    const values = windows(account).map(remaining).filter((value) => value !== null);
    if (!values.length) continue;
    const score = Math.min(...values);
    if (score > bestScore) {
      best = account;
      bestScore = score;
    }
  }
  return best;
}

// With no measured candidate, opening the accounts page leaves every standby card selectable.
export function composerChoice(view: AccountsView, active: AccountView) {
  const depleted = view.quotaError || windows(active).some((window) => remaining(window) === 0);
  const target = depleted ? bestStandby(view.accounts, active.id) : undefined;
  return { depleted, confirmId: target?.id };
}
