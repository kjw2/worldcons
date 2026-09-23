import assert from "node:assert/strict";
import test from "node:test";
import type { D1ImportStatement } from "../lib/cloudflare/d1/import/types";
import type { D1Database } from "../lib/cloudflare/d1/types";
import {
  createD1HttpParameterizedWriter,
  createD1HttpQueryExecutor,
  prepareD1HttpQuery,
  type D1HttpParameterizedWriterOptions,
  type D1HttpQueryExecutorOptions,
} from "../lib/cloudflare/d1/remote/http-query";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_ID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "cf-super-secret-token-do-not-leak";
const DATABASE: D1Database = "worldcons_core";

const HUGE_PARAM = `SECRET_HUGE_${"x".repeat(120_000)}`;
const ORDINARY_PARAM = "ordinary-param-text-SECRET_ORDINARY";
const RAW_BODY_MARKER = "raw-response-body-SECRET";
const RAW_NETWORK_MARKER = "network-explosion-SECRET";

const SECRETS = [TOKEN, HUGE_PARAM, ORDINARY_PARAM, RAW_BODY_MARKER, RAW_NETWORK_MARKER];

const SECRET_STATEMENT: D1ImportStatement = {
  sql: "insert into worldcons_core.articles (id, body) values (?, ?)",
  params: [HUGE_PARAM, ORDINARY_PARAM],
};

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function assertNoLeak(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const secret of SECRETS) {
    assert.equal(
      message.includes(secret),
      false,
      `error message leaked a secret (${secret.slice(0, 24)})`,
    );
  }
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ errors: [{ message: RAW_BODY_MARKER }] }),
  } as unknown as Response;
}

function brokenJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError(`Unexpected token < in JSON: ${RAW_BODY_MARKER}`);
    },
  } as unknown as Response;
}

function capturingFetch(response: Response, captured: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
}

function rejectingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function abortAwareFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null;
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    })) as unknown as typeof fetch;
}

function buildWriter(
  fetchImpl: typeof fetch,
  overrides?: Partial<D1HttpParameterizedWriterOptions>,
) {
  return createD1HttpParameterizedWriter({
    accountId: ACCOUNT_ID,
    apiToken: TOKEN,
    databaseIds: { [DATABASE]: DATABASE_ID },
    fetch: fetchImpl,
    timeoutMs: 1000,
    ...overrides,
  });
}

function buildExecutor(
  fetchImpl: typeof fetch,
  overrides?: Partial<D1HttpQueryExecutorOptions>,
) {
  return createD1HttpQueryExecutor({
    accountId: ACCOUNT_ID,
    apiToken: TOKEN,
    databaseIds: { [DATABASE]: DATABASE_ID },
    fetch: fetchImpl,
    timeoutMs: 1000,
    ...overrides,
  });
}

test("prepareD1HttpQuery keeps strings bound and literalizes null/number", () => {
  const statement: D1ImportStatement = {
    sql: "insert into articles (id, title, summary, views) values (?, ?, ?, ?)",
    params: [HUGE_PARAM, ORDINARY_PARAM, null, 42],
  };

  const prepared = prepareD1HttpQuery(statement);

  assert.deepEqual(prepared.params, [HUGE_PARAM, ORDINARY_PARAM]);
  assert.equal(
    prepared.sql,
    "insert into articles (id, title, summary, views) values (?, ?, null, 42)",
  );

  assert.equal(prepared.sql.includes(HUGE_PARAM), false);
  assert.equal(prepared.sql.includes(ORDINARY_PARAM), false);

  const placeholderCount = (prepared.sql.match(/\?/g) ?? []).length;
  assert.equal(placeholderCount, 2);
  assert.equal(
    placeholderCount,
    prepared.params.filter((param) => typeof param === "string").length,
  );
});

test("prepareD1HttpQuery does not treat quoted '?' as a placeholder", () => {
  const inserted = prepareD1HttpQuery({
    sql: "insert into t (note, label) values (?, '?')",
    params: ["bound"],
  });
  assert.equal(inserted.sql, "insert into t (note, label) values (?, '?')");
  assert.deepEqual(inserted.params, ["bound"]);

  const selected = prepareD1HttpQuery({
    sql: 'select "?a", `?b`, ? from t',
    params: ["bound"],
  });
  assert.equal(selected.sql, 'select "?a", `?b`, ? from t');
  assert.deepEqual(selected.params, ["bound"]);
});

test("prepareD1HttpQuery rejects missing and extra parameters", () => {
  assert.throws(
    () =>
      prepareD1HttpQuery({
        sql: "insert into t (a, b) values (?, ?)",
        params: ["only-one"],
      }),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.parameter_mismatch");
      return true;
    },
  );

  assert.throws(
    () => prepareD1HttpQuery({ sql: "insert into t (a) values (?)", params: ["a", "b"] }),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.parameter_mismatch");
      return true;
    },
  );

  assert.throws(
    () => prepareD1HttpQuery({ sql: "insert into t (a) values (?)", params: [] }),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.parameter_mismatch");
      return true;
    },
  );
});

test("prepareD1HttpQuery rejects blob parameters", () => {
  assert.throws(
    () =>
      prepareD1HttpQuery({
        sql: "insert into t (blob_data) values (?)",
        params: [new Uint8Array([1, 2, 3])],
      }),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.blob_parameter_unsupported");
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter validates account id", () => {
  assert.throws(
    () => buildWriter(rejectingFetch("unused"), { accountId: "not-a-hex-account-id" }),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.invalid_account_id");
      assertNoLeak(error);
      return true;
    },
  );

  assert.throws(
    () => buildWriter(rejectingFetch("unused"), { accountId: "" }),
    (error: unknown) => errorCode(error) === "d1_http_query.invalid_account_id",
  );
});

test("createD1HttpParameterizedWriter validates the api token", () => {
  assert.throws(
    () => buildWriter(rejectingFetch("unused"), { apiToken: "" }),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.invalid_token");
      assertNoLeak(error);
      return true;
    },
  );

  assert.throws(
    () => buildWriter(rejectingFetch("unused"), { apiToken: "   " }),
    (error: unknown) => errorCode(error) === "d1_http_query.invalid_token",
  );
});

test("createD1HttpParameterizedWriter validates database ids", () => {
  assert.throws(
    () =>
      buildWriter(rejectingFetch("unused"), {
        databaseIds: { [DATABASE]: "not-a-valid-uuid" },
      }),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.invalid_database_id");
      assertNoLeak(error);
      return true;
    },
  );

  assert.throws(
    () =>
      createD1HttpParameterizedWriter({
        accountId: ACCOUNT_ID,
        apiToken: TOKEN,
        databaseIds: null as unknown as Partial<Record<D1Database, string>>,
        fetch: rejectingFetch("unused"),
      }),
    (error: unknown) => errorCode(error) === "d1_http_query.invalid_database_id",
  );
});

test("createD1HttpParameterizedWriter validates the timeout", () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildWriter(rejectingFetch("unused"), { timeoutMs }),
      (error: unknown) => {
        assert.equal(errorCode(error), "d1_http_query.invalid_timeout");
        assertNoLeak(error);
        return true;
      },
    );
  }
});

test("createD1HttpParameterizedWriter posts the prepared statement to the exact endpoint", async () => {
  const captured: CapturedRequest[] = [];
  const statement: D1ImportStatement = {
    sql: "insert into articles (id, views) values (?, ?)",
    params: [HUGE_PARAM, 7],
  };
  const fetchImpl = capturingFetch(
    jsonResponse({ success: true, result: [{ success: true }] }),
    captured,
  );

  const writer = buildWriter(fetchImpl);
  await writer(DATABASE, statement);

  assert.equal(captured.length, 1);
  const request = captured[0];
  assert.equal(
    request.url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
  );
  assert.equal(request.init.method, "POST");

  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);

  assert.deepEqual(JSON.parse(String(request.init.body)), prepareD1HttpQuery(statement));
  assert.ok(request.init.signal, "expected an abort signal to be forwarded");
});

test("createD1HttpParameterizedWriter surfaces non-2xx as http_error without leaking secrets", async () => {
  const writer = buildWriter(capturingFetch(errorResponse(503), []));

  await assert.rejects(
    () => writer(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.http_error");
      assert.match((error as Error).message, /503/);
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter rejects a top-level success:false body without leaking secrets", async () => {
  const writer = buildWriter(
    capturingFetch(
      jsonResponse({ success: false, errors: [{ message: RAW_BODY_MARKER }] }),
      [],
    ),
  );

  await assert.rejects(
    () => writer(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.invalid_response");
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter rejects a failing result entry without leaking secrets", async () => {
  const writer = buildWriter(
    capturingFetch(
      jsonResponse({ success: true, result: [{ success: false, error: RAW_BODY_MARKER }] }),
      [],
    ),
  );

  await assert.rejects(
    () => writer(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.invalid_response");
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter rejects malformed JSON without leaking secrets", async () => {
  const writer = buildWriter(capturingFetch(brokenJsonResponse(), []));

  await assert.rejects(
    () => writer(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.invalid_response");
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter rejects malformed shapes without leaking secrets", async () => {
  const payloads: unknown[] = [
    null,
    "not-an-object",
    {},
    { success: true },
    { success: true, result: "not-an-array" },
    { success: true, result: [null] },
    { success: true, result: ["not-an-object"] },
    { success: true, result: [{ success: "yes" }] },
  ];

  for (const payload of payloads) {
    const writer = buildWriter(capturingFetch(jsonResponse(payload), []));
    await assert.rejects(
      () => writer(DATABASE, SECRET_STATEMENT),
      (error: unknown) => {
        assert.equal(errorCode(error), "d1_http_query.invalid_response");
        assertNoLeak(error);
        return true;
      },
    );
  }
});

test("createD1HttpParameterizedWriter maps a rejected fetch to request_failed without leaking secrets", async () => {
  const writer = buildWriter(rejectingFetch(`network exploded: ${RAW_NETWORK_MARKER}`));

  await assert.rejects(
    () => writer(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.request_failed");
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter times out a stalled request without leaking secrets", async () => {
  const writer = buildWriter(abortAwareFetch(), { timeoutMs: 25 });

  await assert.rejects(
    () => writer(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.timeout");
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter rejects an unknown database", async () => {
  const writer = buildWriter(rejectingFetch("unused"));

  await assert.rejects(
    () => writer("worldcons_search", SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.unknown_database");
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpQueryExecutor returns the flattened result rows of a select", async () => {
  const captured: CapturedRequest[] = [];
  const fetchImpl = capturingFetch(
    jsonResponse({
      success: true,
      result: [
        { success: true, results: [{ id: "a", n: 1 }, { id: "b", n: 2 }] },
        { success: true, results: [{ id: "c", n: 3 }] },
      ],
    }),
    captured,
  );

  const execute = buildExecutor(fetchImpl);
  const rows = await execute(DATABASE, { sql: "select id, n from articles order by id limit ?", params: [10] });

  assert.deepEqual(rows, [
    { id: "a", n: 1 },
    { id: "b", n: 2 },
    { id: "c", n: 3 },
  ]);

  assert.equal(captured.length, 1);
  const request = captured[0];
  assert.equal(
    request.url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
  );
  assert.equal(request.init.method, "POST");
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(
    JSON.parse(String(request.init.body)),
    prepareD1HttpQuery({ sql: "select id, n from articles order by id limit ?", params: [10] }),
  );
});

test("createD1HttpQueryExecutor keeps string params bound and never literalizes them", async () => {
  const captured: CapturedRequest[] = [];
  const execute = buildExecutor(
    capturingFetch(jsonResponse({ success: true, result: [{ success: true, results: [] }] }), captured),
  );

  await execute(DATABASE, { sql: "select * from articles where body = ?", params: [HUGE_PARAM] });

  const body = JSON.parse(String(captured[0].init.body)) as { sql: string; params: unknown[] };
  assert.deepEqual(body.params, [HUGE_PARAM]);
  assert.equal(body.sql.includes(HUGE_PARAM), false);
  assert.equal(body.sql.includes(ORDINARY_PARAM), false);
});

test("createD1HttpQueryExecutor treats a successful envelope without results as zero rows", async () => {
  const rows = await buildExecutor(
    capturingFetch(jsonResponse({ success: true, result: [{ success: true }] }), []),
  )(DATABASE, { sql: "select 1", params: [] });

  assert.deepEqual(rows, []);
});

test("createD1HttpQueryExecutor fails closed on a malformed success payload without leaking secrets", async () => {
  const payloads: unknown[] = [
    null,
    "not-an-object",
    {},
    { success: true },
    { success: false, result: [] },
    { success: true, result: "not-an-array" },
    { success: true, result: [null] },
    { success: true, result: ["not-an-object"] },
    { success: true, result: [{ success: "yes" }] },
    { success: true, result: [{ success: true, results: "not-an-array" }] },
    { success: true, result: [{ success: true, results: [null] }] },
    { success: true, result: [{ success: true, results: [["not-an-object"]] }] },
  ];

  for (const payload of payloads) {
    const execute = buildExecutor(capturingFetch(jsonResponse(payload), []));
    await assert.rejects(
      () => execute(DATABASE, SECRET_STATEMENT),
      (error: unknown) => {
        assert.equal(errorCode(error), "d1_http_query.invalid_response");
        assertNoLeak(error);
        return true;
      },
    );
  }
});

test("createD1HttpQueryExecutor preserves the http, timeout and unknown-database errors without leaking secrets", async () => {
  await assert.rejects(
    () => buildExecutor(capturingFetch(errorResponse(500), []))(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.http_error");
      assertNoLeak(error);
      return true;
    },
  );

  await assert.rejects(
    () => buildExecutor(abortAwareFetch(), { timeoutMs: 25 })(DATABASE, SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.timeout");
      assertNoLeak(error);
      return true;
    },
  );

  await assert.rejects(
    () => buildExecutor(rejectingFetch("unused"))("worldcons_search", SECRET_STATEMENT),
    (error: unknown) => {
      assert.equal(errorCode(error), "d1_http_query.unknown_database");
      assertNoLeak(error);
      return true;
    },
  );
});

test("createD1HttpParameterizedWriter discards the rows the executor returns", async () => {
  const writer = buildWriter(
    capturingFetch(
      jsonResponse({ success: true, result: [{ success: true, results: [{ n: 42 }, { n: 43 }] }] }),
      [],
    ),
  );

  const result = await writer(DATABASE, SECRET_STATEMENT);
  assert.equal(result, undefined, "a writer must resolve void and discard every returned row");
});
