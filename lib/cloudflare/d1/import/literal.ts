import type { D1ImportParam } from "./types";

/**
 * Deterministic SQLite/D1 literal encoding for the emitted import script.
 *
 * The parameterized statements are authoritative; this renderer exists so the
 * same import can be written as a `wrangler d1 execute --file` script. Values
 * are always literals here (the SQL text itself only contains authored
 * identifiers), and the encoders fail closed on anything they do not understand.
 */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Decodes canonical base64 text (the stored blob form) back to raw bytes. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function renderSqlLiteral(param: D1ImportParam): string {
  if (param === null) return "null";
  if (typeof param === "number") {
    if (!Number.isFinite(param)) throw new Error("cannot render a non-finite number as SQL");
    return String(param);
  }
  if (typeof param === "string") return `'${param.replace(/'/g, "''")}'`;
  if (param instanceof Uint8Array) return `X'${toHex(param)}'`;
  throw new Error(`cannot render an unsupported import parameter (${typeof param})`);
}
