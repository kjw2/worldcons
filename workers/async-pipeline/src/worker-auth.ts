/**
 * Shared constant-time operator bearer authentication for the `worldcons-ingest`
 * Worker's operator-canary route.
 *
 * The stage-canary route uses a **dedicated** optional Worker Secret,
 * `WORLDCONS_CANARY_TOKEN`. It deliberately does NOT reuse or activate the
 * unrelated browser-transport secret (`BROWSER_RUN_TOKEN`) used by
 * `/v1/navigate`: the two surfaces have different blast radii and are provisioned
 * independently. If `WORLDCONS_CANARY_TOKEN` is unset, the canary route fails
 * closed (401) and no endpoint is exposed. Comparison is constant-time over the
 * SHA-256 digests so a timing side channel cannot recover the token.
 */

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Reads the operator token from an `Authorization: Bearer <token>` header. */
export function bearerTokenFromRequest(request: Request): string {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * True only when the request presents the configured `WORLDCONS_CANARY_TOKEN` in
 * a constant-time-equal form. A missing configured secret => fail closed (false).
 */
export async function operatorCanaryAuthorized(request: Request, env: unknown): Promise<boolean> {
  const supplied = bearerTokenFromRequest(request);
  if (!supplied) return false;
  const expected = (env as { WORLDCONS_CANARY_TOKEN?: string }).WORLDCONS_CANARY_TOKEN?.trim();
  if (!expected) return false;
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  if (difference !== 0) {
    console.warn(JSON.stringify({ event: "canary_auth_failed", suppliedLength: supplied.length, expectedLength: expected.length }));
  }
  return difference === 0;
}
