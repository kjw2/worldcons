/** Read-only retry for transient tag-detail page reads. Never returns draft data. */
export interface TagDetailReadFailure {
  event: "worldcons_tag_detail_read_failed";
  stage: "metadata" | "articles";
  attempt: number;
  reason: string;
}

function safeFailureCode(error: unknown) {
  if (!(error instanceof Error)) return "unknown_error";
  const safe = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
  if (safe.test(error.message)) return error.message;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && safe.test(code)) return code;
  if (error.message.startsWith("D1_ERROR")) return "d1.query_error";
  return safe.test(error.name) ? error.name : "unknown_error";
}

export async function readTagDetailSafely<T>(
  stage: TagDetailReadFailure["stage"],
  read: () => Promise<T>,
  options: {
    wait?: (ms: number) => Promise<void>;
    log?: (entry: TagDetailReadFailure) => void;
  } = {},
): Promise<T> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((entry: TagDetailReadFailure) => console.error(JSON.stringify(entry)));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      log({ event: "worldcons_tag_detail_read_failed", stage, attempt, reason: safeFailureCode(error) });
      if (attempt === 2) throw error;
      await wait(120);
    }
  }
  throw new Error("tag_detail.unreachable");
}
