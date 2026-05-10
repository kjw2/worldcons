export function boundedInteger(value: unknown, fallback: number, options: { min?: number; max?: number } = {}) {
  const min = options.min ?? 1;
  const max = options.max ?? 100;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
