export class WorldconsToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfter?: string;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; retryAfter?: string } = {},
  ) {
    super(message);
    this.name = "WorldconsToolError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter;
  }
}

export function safeToolError(error: unknown) {
  if (error instanceof WorldconsToolError) return error;
  return new WorldconsToolError(
    "SERVICE_UNAVAILABLE",
    "헌법판례요약시스템 조회가 일시적으로 지연되고 있습니다. 잠시 뒤 다시 시도해 주세요.",
    { retryable: true },
  );
}
