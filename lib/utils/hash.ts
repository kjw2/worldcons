import crypto from "node:crypto";

export function createHash(input: string, length = 12) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function createContentHash(input?: string | null) {
  if (!input) {
    return null;
  }

  return createHash(input.replace(/\s+/g, " ").trim(), 32);
}
