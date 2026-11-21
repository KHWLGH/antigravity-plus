import { useSettings } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import {
  DEFAULT_PERMISSION_MODE,
  PREFERENCES_SETTINGS,
  type PermissionModeId,
} from "../shared/settings.ts";
import { ErrorMessage } from "./error-message.tsx";

const MODE_OPTIONS: readonly { value: PermissionModeId; label: string }[] = [
  { value: "default", label: "Default — ask before edits and commands" },
  { value: "accept-edits", label: "Accept edits — approve workspace edits automatically" },
  { value: "auto", label: "Auto — ask before irreversible actions" },
  { value: "plan", label: "Plan — plan before executing" },
  { value: "bypass", label: "Bypass — approve everything without asking" },
];

export function SettingsScreen() {
  const settings = useSettings(PREFERENCES_SETTINGS);

  if (settings.status === "loading") return <Loading />;

  if (settings.status === "error") {
    return (
      <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
        <ErrorMessage message={settings.error} />
        <SettingsAction label="Could not load settings" actionLabel="Retry" onPress={() => void settings.reload()} />
      </ScrollView>
    );
  }

  if (settings.status === "invalid") {
    return (
      <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
        <ErrorMessage message={settings.error} />
        <SettingsAction
          label="Reset settings to defaults"
          actionLabel="Reset"
          disabled={settings.saving}
          onPress={() => void settings.reset()}
        />
      </ScrollView>
    );
  }

  const currentMode = settings.values.defaultMode ?? DEFAULT_PERMISSION_MODE;
  const hint =
    currentMode === "bypass"
      ? "New sessions approve edits and commands automatically without asking, outside agy's terminal sandbox. Deny rules in agy settings still apply."
      : "Mode used when starting a new Antigravity+ session without an explicit mode. You can still switch modes per session in the composer.";

  return (
    <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
      <SettingsSection title="Permissions">
        <SettingsSelect
          label="Default permission mode"
          hint={hint}
          error={settings.saveError}
          value={currentMode}
          options={MODE_OPTIONS}
          disabled={settings.saving}
          onValueChange={(next) => {
            if (next === currentMode) return;
            void settings.save({ ...settings.values, defaultMode: next }, settings.revision);
          }}
        />
        <SettingsRow
          label="Scope"
          hint="Applies to newly created Antigravity+ sessions on this host. Existing sessions keep their own mode."
        />
      </SettingsSection>
    </ScrollView>
  );
}
