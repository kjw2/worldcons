import { renderSqlLiteral } from "../import/literal";
import type { D1ImportStatement } from "../import/types";
import type { D1Database } from "../types";

export interface D1HttpQueryExecutorOptions {
  accountId: string;
  apiToken: string;
  databaseIds: Partial<Record<D1Database, string>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Backwards-compatible alias: the parameterized writer shares the executor's options. */
export type D1HttpParameterizedWriterOptions = D1HttpQueryExecutorOptions;

/**
 * The bound-parameter HTTP query surface. It executes one `?`-parameterized
 * statement against the same Cloudflare D1 query endpoint and returns the
 * flattened result rows, so a READ can reuse the exact credential validation,
 * timeout, response validation and string-parameter handling of the write path.
 */
export type D1HttpQueryExecutor = (
  database: D1Database,
  statement: D1ImportStatement,
) => Promise<Record<string, unknown>[]>;

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 120000;

function createD1HttpQueryError(code: string, message?: string): Error {
  const error = new Error(message ?? code);
  (error as Error & { code?: string }).code = code;
  return error;
}

export function prepareD1HttpQuery(statement: D1ImportStatement): {
  sql: string;
  params: string[];
} {
  const source = statement.sql;
  const values: readonly unknown[] = statement.params ?? [];
  const params: string[] = [];
  let sql = "";
  let valueIndex = 0;
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (character === "'" || character === '"' || character === "`") {
      sql += character;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        sql += inner;
        index += 1;
        if (inner === character) {
          if (source[index] === character) {
            sql += character;
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (character === "?") {
      if (valueIndex >= values.length) {
        throw createD1HttpQueryError(
          "d1_http_query.parameter_mismatch",
          "d1_http_query.parameter_mismatch",
        );
      }

      const value = values[valueIndex];
      valueIndex += 1;

      if (typeof value === "string") {
        params.push(value);
        sql += "?";
      } else if (value === null) {
        sql += renderSqlLiteral(value);
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw createD1HttpQueryError(
            "d1_http_query.unsupported_parameter",
            "d1_http_query.unsupported_parameter",
          );
        }
        sql += renderSqlLiteral(value);
      } else if (value instanceof Uint8Array) {
        throw createD1HttpQueryError(
          "d1_http_query.blob_parameter_unsupported",
          "d1_http_query.blob_parameter_unsupported",
        );
      } else {
        throw createD1HttpQueryError(
          "d1_http_query.unsupported_parameter",
          "d1_http_query.unsupported_parameter",
        );
      }
      index += 1;
      continue;
    }

    sql += character;
    index += 1;
  }

  if (valueIndex !== values.length) {
    throw createD1HttpQueryError(
      "d1_http_query.parameter_mismatch",
      "d1_http_query.parameter_mismatch",
    );
  }

  return { sql, params };
}

export function createD1HttpQueryExecutor(
  options: D1HttpQueryExecutorOptions,
): D1HttpQueryExecutor {
  const { accountId, apiToken, databaseIds } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw createD1HttpQueryError(
      "d1_http_query.invalid_account_id",
      "d1_http_query.invalid_account_id",
    );
  }

  if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
    throw createD1HttpQueryError(
      "d1_http_query.invalid_token",
      "d1_http_query.invalid_token",
    );
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw createD1HttpQueryError(
      "d1_http_query.invalid_timeout",
      "d1_http_query.invalid_timeout",
    );
  }

  if (databaseIds === null || typeof databaseIds !== "object") {
    throw createD1HttpQueryError(
      "d1_http_query.invalid_database_id",
      "d1_http_query.invalid_database_id",
    );
  }

  for (const databaseId of Object.values(databaseIds)) {
    if (
      databaseId !== undefined &&
      (typeof databaseId !== "string" || !DATABASE_ID_PATTERN.test(databaseId))
    ) {
      throw createD1HttpQueryError(
        "d1_http_query.invalid_database_id",
        "d1_http_query.invalid_database_id",
      );
    }
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;

  return async function execute(
    database: D1Database,
    statement: D1ImportStatement,
  ): Promise<Record<string, unknown>[]> {
    const databaseId = databaseIds[database];

    if (typeof databaseId !== "string" || databaseId.length === 0) {
      throw createD1HttpQueryError(
        "d1_http_query.unknown_database",
        `d1_http_query.unknown_database (database ${String(database)})`,
      );
    }

    if (!DATABASE_ID_PATTERN.test(databaseId)) {
      throw createD1HttpQueryError(
        "d1_http_query.invalid_database_id",
        "d1_http_query.invalid_database_id",
      );
    }

    const prepared = prepareD1HttpQuery(statement);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify(prepared),
            signal: controller.signal,
          },
        );
      } catch {
        throw controller.signal.aborted
          ? createD1HttpQueryError("d1_http_query.timeout", "d1_http_query.timeout")
          : createD1HttpQueryError(
              "d1_http_query.request_failed",
              "d1_http_query.request_failed",
            );
      }

      if (!response.ok) {
        throw createD1HttpQueryError(
          "d1_http_query.http_error",
          `d1_http_query.http_error (status ${response.status}, database ${String(database)})`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw createD1HttpQueryError(
          "d1_http_query.invalid_response",
          "d1_http_query.invalid_response",
        );
      }

      if (typeof payload !== "object" || payload === null) {
        throw createD1HttpQueryError(
          "d1_http_query.invalid_response",
          "d1_http_query.invalid_response",
        );
      }

      const body = payload as { success?: unknown; result?: unknown };

      if (body.success !== true || !Array.isArray(body.result)) {
        throw createD1HttpQueryError(
          "d1_http_query.invalid_response",
          "d1_http_query.invalid_response",
        );
      }

      const rows: Record<string, unknown>[] = [];
      for (const entry of body.result) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          (entry as { success?: unknown }).success !== true
        ) {
          throw createD1HttpQueryError(
            "d1_http_query.invalid_response",
            "d1_http_query.invalid_response",
          );
        }

        const results = (entry as { results?: unknown }).results;
        // A successful envelope may legitimately carry no `results` (DDL), so an
        // absent field contributes no rows. A present but non-array `results`, or a
        // non-object row, is malformed and fails closed.
        if (results === undefined) continue;
        if (!Array.isArray(results)) {
          throw createD1HttpQueryError(
            "d1_http_query.invalid_response",
            "d1_http_query.invalid_response",
          );
        }
        for (const row of results) {
          if (typeof row !== "object" || row === null || Array.isArray(row)) {
            throw createD1HttpQueryError(
              "d1_http_query.invalid_response",
              "d1_http_query.invalid_response",
            );
          }
          rows.push(row as Record<string, unknown>);
        }
      }

      return rows;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The bound-parameter write surface. It delegates to the generic executor and
 * discards the returned rows, so a WRITE keeps the exact validation, timeout and
 * response handling it always had while sharing one implementation with reads.
 */
export function createD1HttpParameterizedWriter(
  options: D1HttpParameterizedWriterOptions,
): (database: D1Database, statement: D1ImportStatement) => Promise<void> {
  const execute = createD1HttpQueryExecutor(options);
  return async (database, statement) => {
    await execute(database, statement);
  };
}
