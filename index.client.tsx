import { useComposer, type PluginClientContext, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Action, SidebarRow } from "@getpaseo/plugin/client/ui";
import { accountLabel, AccountsScreen } from "./client/accounts-screen.tsx";
import { composerChoice } from "./client/account-choice.ts";
import { SettingsScreen } from "./client/settings-screen.tsx";
import { createAccountStore, useAccountView } from "./client/store.ts";

export default function contribute(client: PluginClientContext) {
  const store = createAccountStore(client);
  const screenId = "accounts";
  function AccountAction() {
    const { view, error } = useAccountView(store);
    const active = view?.accounts.find((account) => account.id === view.activeAccountId);
    if (!active || !view || error) return <Action icon="Users" title="Antigravity+ accounts" onPress={() => client.openScreen({ screenId })} />;
    const { depleted, confirmId } = composerChoice(view, active);
    const label = (depleted ? "Quota limit · " : "") + accountLabel(active);
    return <Action icon={depleted ? "CircleAlert" : "CircleUserRound"} title={label}
      onPress={() => client.openScreen({ screenId, params: confirmId ? { confirm: confirmId, request: String(Date.now()) } : {} })} />;
  }
  const screen = client.addScreen({
    id: screenId, title: "Antigravity+ accounts",
    Component: ({ params }: PluginScreenProps) => <AccountsScreen key={params.request || "accounts"} store={store} confirmId={params.confirm} />,
  });
  const sidebar = client.addSidebarHeaderItem({
    id: screenId, title: "Antigravity+ accounts",
    Component: ({ currentScreen, openScreen }: PluginSidebarItemProps) => <SidebarRow icon="Users"
      active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId })} />,
  });
  const settings = client.addSettingsScreen({
    id: "settings",
    title: "Antigravity+",
    icon: "Shield",
    Component: SettingsScreen,
  });
  const composer = client.addComposerItem({
    id: "active-account",
    Component: () => useComposer().agent.provider === "antigravity-plus" ? <AccountAction /> : null,
  });
  return () => { composer(); settings(); sidebar(); screen(); store.dispose(); };
}
