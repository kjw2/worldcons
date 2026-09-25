/**
 * A small, pure-JS, non-cryptographic digest for shadow comparison evidence.
 *
 * The shadow seam must stay runtime-safe: it cannot import a Node crypto
 * builtin and it must not add a dependency for a value that is only used to
 * distinguish two canonical forms and prove determinism. This is a 64-bit
 * FNV-1a-style fold rendered as 16 lowercase hex characters. It is NOT a
 * security primitive and must never be used for anything but local parity
 * evidence.
 */
const FNV_OFFSET_A = 0x811c9dc5;
const FNV_PRIME_A = 0x01000193;
const FNV_OFFSET_B = 0x9e3779b9;
const FNV_PRIME_B = 0x85ebca6b;

export function shadowDigest(input: string): string {
  let a = FNV_OFFSET_A;
  let b = FNV_OFFSET_B;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a = Math.imul(a ^ code, FNV_PRIME_A) >>> 0;
    b = Math.imul(b ^ code, FNV_PRIME_B) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
