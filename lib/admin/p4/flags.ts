export const ADMIN_REDESIGN_UI_FLAG = "ADMIN_REDESIGN_UI_ENABLED";

export function adminRedesignUiEnabled(environment: Record<string, string | undefined> = process.env) {
  return environment[ADMIN_REDESIGN_UI_FLAG]?.trim().toLowerCase() === "true";
}
