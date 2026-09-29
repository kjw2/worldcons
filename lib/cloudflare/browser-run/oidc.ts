/** Dedicated GitHub Actions OIDC audience for the consolidated Browser Run endpoint. */
export const WORLDCONS_BROWSER_RUN_OIDC_AUDIENCE = "worldcons-ingest" as const;

export function githubActionsOidcAvailable(environment: Record<string, string | undefined>): boolean {
  return Boolean(
    environment.ACTIONS_ID_TOKEN_REQUEST_URL?.trim()
      && environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim(),
  );
}
