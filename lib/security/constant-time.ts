import { timingSafeEqual } from "node:crypto";

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, which would itself
 * reveal length information, so both sides are padded to a common length first and the
 * real length check is folded into the result.
 */
export function timingSafeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const comparisonLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(comparisonLength);
  const paddedRight = Buffer.alloc(comparisonLength);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);

  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}
