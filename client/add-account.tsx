import { useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Modal, SettingsAction, SettingsInput, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ErrorMessage } from "./error-message.tsx";
import { accountsRpc, type LoginStatus } from "../shared/accounts-rpc.ts";

export function AddAccount({ close, refresh }: { close(): void; refresh(): Promise<void> }) {
  const begin = useRpc(accountsRpc.add);
  const read = useRpc(accountsRpc.loginStatus);
  const send = useRpc(accountsRpc.loginSubmit);
  const cancel = useRpc(accountsRpc.loginCancel);
  const [makeActive, setMakeActive] = useState(false);
  const [id, setId] = useState("");
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState("");
  const [disconnected, setDisconnected] = useState(false);
  const [sending, setSending] = useState(false);
  const live = useRef(true);
  const owned = useRef("");
  const release = useRef(cancel);
  release.current = cancel;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (owned.current) void release.current({ id: owned.current }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await read({id});
        if (stopped) return;
        setDisconnected(false);
        setStatus(next);
        if (next.phase === "done" || next.phase === "failed") {
          owned.current = "";
          setId("");
          setValue("");
          void refresh();
          if (next.phase === "done") close();
          else { setStatus(null); setProblem(next.message); }
          return;
        }
      } catch {
        if (stopped) return;
        setDisconnected(true);
      }
      timer = setTimeout(() => void poll(), 750);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, read]);

  async function start() {
    setProblem("");
    setStatus({ phase: "starting" });
    try {
      const result = await begin({makeActive});
      if (!live.current) { await cancel(result); return; }
      owned.current = result.id;
      setId(result.id);
    } catch (error) {
      if (live.current) {
        setProblem(error instanceof Error ? error.message : "Could not start sign-in.");
        setStatus(null);
      }
    }
  }

  async function submit() {
    setSending(true);
    setProblem("");
    try {
      await send({id, value});
      setValue("");
      setStatus({ phase: "submitted" });
    } catch {
      setProblem("Could not submit the code. Check that you pasted a single code or callback URL.");
    } finally { setSending(false); }
  }

  async function dismiss() {
    if (!id) { close(); return; }
    try {
      await cancel({id});
      setValue("");
      setStatus({ phase: "finishing" });
    } catch { setProblem("Could not cancel sign-in. Please retry."); }
  }

  const finishing = status?.phase === "finishing";
  return <Modal open title="Add account" onOpenChange={open => { if (!open && !finishing) void dismiss(); }}>
    <Modal.Content>
      <SettingsSwitch label="Use the new login for all sessions" value={makeActive} onValueChange={setMakeActive} disabled={!!status} />
      {!status && <SettingsAction label="Sign in through agy" actionLabel="Start sign-in" onPress={() => void start()} />}
      {status?.phase === "starting" && <SettingsRow label="Waiting for the Google login link…" />}
      {status?.phase === "input" && <>
        <ExternalLink href={status.url}>Open login link</ExternalLink>
        <SettingsInput label="Authorization code or full callback URL" secureTextEntry onChangeText={setValue} />
        <SettingsAction label="Send to agy" actionLabel="Submit" disabled={!value.trim() || sending} onPress={() => void submit()} />
      </>}
      {status?.phase === "submitted" && <SettingsRow label="Waiting for agy to finish sign-in…" />}
      {finishing && <SettingsRow label="Finishing account changes…" />}
      {disconnected && <SettingsRow label="Could not read login progress. Reconnecting…" />}
      {problem && <ErrorMessage message={problem} />}
      <SettingsAction label="Close sign-in" actionLabel="Cancel" disabled={finishing} onPress={() => void dismiss()} />
    </Modal.Content>
  </Modal>;
}
