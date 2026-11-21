import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PERMISSION_MODES = ["default", "accept-edits", "auto", "plan", "bypass"] as const;
export type PermissionModeId = (typeof PERMISSION_MODES)[number];

/** Safe out-of-the-box default: asks for permission before edits and commands. */
export const DEFAULT_PERMISSION_MODE: PermissionModeId = "default";

export const PREFERENCES_SETTINGS = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    defaultMode: z.enum(PERMISSION_MODES).default(DEFAULT_PERMISSION_MODE),
  }),
});
