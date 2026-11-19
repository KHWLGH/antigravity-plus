import { useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Loading, Modal, ScrollView, SettingsAction, SettingsInput, SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { accountsRpc, type AccountView } from "../shared/accounts-rpc.ts";
import { ErrorMessage } from "./error-message.tsx";
import { AddAccount } from "./add-account.tsx";
import { quotaSummary, remaining, windows } from "./account-choice.ts";
import { useAccountView, type AccountStore } from "./store.ts";

export const accountLabel = (account: AccountView) => account.nickname || account.email;
const localTime = (value: string) => new Date(value).toLocaleString();

function QuotaRows({ account, active }: { account: AccountView; active: boolean }) {
  const snapshot = account.snapshot;
  if (!snapshot) return <SettingsRow label="No quota reading yet" />;
  const report = snapshot.report;
  return <>
    <SettingsRow label={active ? "Last reading" : "Standby snapshot"} hint={localTime(snapshot.readAt)} />
    {report.status === "error" && <ErrorMessage message={report.error} />}
    {report.status === "unavailable" && <SettingsRow label="Quota unavailable"
      hint={report.problem.kind === "no_quota" ? report.problem.detail : report.problem.kind} />}
    {windows(account).map((window) => {
      const pct = remaining(window);
      const reset = window.resetsAt;
      const elapsed = !active && reset && Date.parse(reset) <= Date.now();
      const hint = [pct == null ? "Remaining quota unknown" : String(pct) + "% remaining at last reading",
        reset && "Reset " + localTime(reset), elapsed && "Reset time passed; recovery expected"].filter(Boolean).join(" · ");
      return <SettingsRow key={window.id} label={window.label} hint={hint} />;
    })}
  </>;
}

function AccountQuota({ account, active, quotaError }: { account: AccountView; active: boolean; quotaError: boolean }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const summary = quotaSummary(account, active, quotaError);
  const expanded = choice ?? summary.defaultExpanded;
  return <>
    <SettingsAction label={summary.label} actionLabel={expanded ? "Hide quota details" : "Show quota details"}
      onPress={() => setChoice(!expanded)} />
    {expanded && <QuotaRows account={account} active={active} />}
  </>;
}

type Dialog = { kind: "switch" | "remove" | "rename"; account: AccountView } | { kind: "add" };

export function AccountsScreen({ store, confirmId }: { store: AccountStore; confirmId?: string }) {
  const { view, error } = useAccountView(store);
  const switchAccount = useRpc(accountsRpc.switch);
  const remove = useRpc(accountsRpc.remove);
  const rename = useRpc(accountsRpc.rename);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [nickname, setNickname] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const target = view?.accounts.find((account) => account.id === confirmId && account.id !== view.activeAccountId);
  const current = dialog ?? (!dismissed && target ? { kind: "switch" as const, account: target } : null);
  function close() {
    setDismissed(true);
    setDialog(null);
    setProblem("");
  }
  function open(next: Dialog) {
    setProblem("");
    setNickname(next.kind === "rename" ? next.account.nickname ?? "" : "");
    setDialog(next);
  }
  async function submit() {
    if (!current || current.kind === "add" || pending) return;
    setPending(true);
    setProblem("");
    try {
      switch (current.kind) {
        case "switch": await switchAccount({ id: current.account.id }); break;
        case "remove": await remove({ id: current.account.id }); break;
        case "rename": await rename({ id: current.account.id, nickname }); break;
      }
      close();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await store.refresh();
      setPending(false);
    }
  }
  if (!view && !error) return <Loading />;
  // Another client can own a live operation, or an interrupted journal can need a retry.
  // The server distinguishes the two under its mutex. Keep recovery reachable in both cases.
  const disabled = pending;
  const title = current?.kind === "switch" ? "Switch account" :
    current?.kind === "remove" ? "Delete standby account" : "Rename account";
  return <>
    <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
      {error && <ErrorMessage message={error} />}
      {!view?.activeAccountId && <SettingsRow label="Signed out of Antigravity" />}
      {view?.accounts.map((account) => {
        const active = account.id === view.activeAccountId;
        return <SettingsSection key={account.id} title={accountLabel(account)}>
          <SettingsRow label={active ? "Active account" : "Standby account"} hint={account.email} />
          <AccountQuota account={account} active={active} quotaError={view.quotaError} />
          {!active && <SettingsAction label="Use this account for all sessions" actionLabel="Switch"
            disabled={disabled} onPress={() => open({ kind: "switch", account })} />}
          <SettingsAction label="Nickname" actionLabel="Rename" disabled={disabled} onPress={() => open({ kind: "rename", account })} />
          {!active && <SettingsAction label="Remove this account from the vault" actionLabel="Delete"
            disabled={disabled} onPress={() => open({ kind: "remove", account })} />}
        </SettingsSection>;
      })}
      <SettingsAction label="Sign in through agy" actionLabel="Add account" disabled={disabled} onPress={() => open({ kind: "add" })} />
    </ScrollView>
    {current?.kind === "add" && <AddAccount close={close} refresh={store.refresh} />}
    {current && current.kind !== "add" && <Modal open title={title} onOpenChange={(visible) => { if (!visible && !pending) close(); }}>
      <Modal.Content>
        <SettingsRow label={accountLabel(current.account)} hint={current.account.email} />
        {current.kind === "rename" && <SettingsInput label="Nickname" initialValue={nickname} onChangeText={setNickname} disabled={disabled} />}
        {current.kind === "switch" && <SettingsRow label="All idle Antigravity+ sessions will use this account." />}
        {problem && <ErrorMessage message={problem} />}
        <SettingsAction label={title} actionLabel={pending ? "Working…" : "Confirm"} disabled={disabled} onPress={() => void submit()} />
        <SettingsAction label="Close dialog" actionLabel="Cancel" disabled={pending} onPress={close} />
      </Modal.Content>
    </Modal>}
  </>;
}
