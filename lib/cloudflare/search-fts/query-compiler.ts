import { ftsError } from "./errors";
import { collapseWhitespace, normalizeFtsText } from "./normalize";
import { normalizeFtsTitle } from "./title";
import { SEARCH_FTS_MAX_QUERY_LENGTH } from "./types";

/**
 * Conservative, deterministic subset of web search syntax compiled to FTS5.
 *
 * Supported:
 * - plain terms -> implicit AND;
 * - `"quoted phrases"` -> FTS5 phrase strings;
 * - `OR` (case-insensitive, standalone) between positive clauses;
 * - unary `-term` / `-phrase` negation, allowed only alongside a positive clause.
 *
 * Safety contract:
 * - every user literal is emitted only inside a double-quoted FTS5 string with
 *   embedded `"` doubled, so authored FTS5 operators (`*`, `(`, `)`, `:`, `^`,
 *   `NEAR`, `AND`, `NOT`, `+`, ...) can never be injected;
 * - the compiled expression is returned for BINDING as a `?` parameter; it is
 *   never concatenated into SQL text.
 *
 * Documented divergence: this is NOT `websearch_to_tsquery`. It does not model
 * tsquery operator precedence for negative-only OR branches, it collapses
 * whitespace and applies NFKC (Postgres `websearch_to_tsquery` does not), and
 * FTS5 bm25 tokenization is not Postgres `simple`-dictionary tokenization.
 * Therefore no query-language or rank parity is claimed.
 */

const SEARCHABLE_CHARACTER = /[\p{L}\p{N}]/u;

type ClauseKind = "term" | "phrase";

interface Clause {
  kind: ClauseKind;
  text: string;
}

type RawToken = { type: ClauseKind; text: string; negative: boolean } | { type: "or" };

export interface CompiledSearchFtsQuery {
  /** Raw trimmed query text as validated against the 200-char ceiling. */
  queryText: string;
  /** NFKC/whitespace normalized query used for exact-title detection. */
  exactQueryText: string;
  /** The FTS5 MATCH expression. Bind this value; never interpolate it. */
  matchExpression: string;
  termCount: number;
  phraseCount: number;
  negativeCount: number;
  orGroupCount: number;
}

function assertSearchableClause(text: string): void {
  if (!SEARCHABLE_CHARACTER.test(text)) {
    throw ftsError("malformed_query", "query clause contains no searchable letters or digits");
  }
}

function tokenize(normalizedQuery: string): RawToken[] {
  const tokens: RawToken[] = [];
  let index = 0;
  while (index < normalizedQuery.length) {
    const character = normalizedQuery[index];
    if (character === " ") {
      index += 1;
      continue;
    }
    let negative = false;
    if (character === "-") {
      negative = true;
      index += 1;
      if (index >= normalizedQuery.length || normalizedQuery[index] === " ") {
        throw ftsError("malformed_query", "dangling '-' negation operator");
      }
    }
    if (normalizedQuery[index] === '"') {
      index += 1;
      let buffer = "";
      let closed = false;
      while (index < normalizedQuery.length) {
        if (normalizedQuery[index] === '"') {
          closed = true;
          index += 1;
          break;
        }
        buffer += normalizedQuery[index];
        index += 1;
      }
      if (!closed) throw ftsError("malformed_query", "unbalanced quoted phrase");
      const phrase = collapseWhitespace(buffer);
      assertSearchableClause(phrase);
      tokens.push({ type: "phrase", text: phrase, negative });
      continue;
    }
    let buffer = "";
    while (index < normalizedQuery.length && normalizedQuery[index] !== " ") {
      if (normalizedQuery[index] === '"') throw ftsError("malformed_query", "unbalanced quote inside a term");
      buffer += normalizedQuery[index];
      index += 1;
    }
    if (buffer.length === 0) throw ftsError("malformed_query", "empty query term");
    if (!negative && buffer.toLowerCase() === "or") {
      tokens.push({ type: "or" });
      continue;
    }
    assertSearchableClause(buffer);
    tokens.push({ type: "term", text: buffer, negative });
  }
  return tokens;
}

/** FTS5 double-quoted string with embedded quotes doubled. */
function ftsString(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Validates and compiles a raw query. Throws `SearchFtsError` on any malformed,
 * unbalanced, empty or negative-only input.
 */
export function compileSearchFtsQuery(rawQuery: unknown): CompiledSearchFtsQuery {
  if (typeof rawQuery !== "string") throw ftsError("invalid_query", "query must be a string");
  const queryText = rawQuery.trim();
  if (queryText.length === 0) throw ftsError("invalid_query", "query must not be empty");
  if (queryText.length > SEARCH_FTS_MAX_QUERY_LENGTH) {
    throw ftsError("invalid_query", `query must be at most ${SEARCH_FTS_MAX_QUERY_LENGTH} characters`);
  }

  const normalizedQuery = normalizeFtsText(queryText);
  if (normalizedQuery.length === 0) throw ftsError("empty_query", "query is empty after normalization");

  const tokens = tokenize(normalizedQuery);
  const groups: Clause[][] = [[]];
  const negatives: Clause[] = [];
  for (const token of tokens) {
    if (token.type === "or") {
      if (groups[groups.length - 1].length === 0) {
        throw ftsError("malformed_query", "OR must separate positive clauses");
      }
      groups.push([]);
      continue;
    }
    const clause: Clause = { kind: token.type, text: token.text };
    if (token.negative) negatives.push(clause);
    else groups[groups.length - 1].push(clause);
  }
  const positiveClauses = groups.reduce<Clause[]>((all, group) => all.concat(group), []);
  if (positiveClauses.length === 0) {
    if (negatives.length > 0) throw ftsError("negative_only", "query has no positive clause");
    throw ftsError("empty_query", "query has no searchable clause");
  }
  if (groups[groups.length - 1].length === 0) {
    throw ftsError("malformed_query", "OR must separate positive clauses");
  }

  const groupExpressions = groups.map((group) => `(${group.map((clause) => ftsString(clause.text)).join(" ")})`);
  let matchExpression = groupExpressions.join(" OR ");
  for (const clause of negatives) matchExpression += ` NOT ${ftsString(clause.text)}`;

  return {
    queryText,
    exactQueryText: normalizeFtsTitle(queryText),
    matchExpression,
    termCount: tokens.filter((token) => token.type === "term").length,
    phraseCount: tokens.filter((token) => token.type === "phrase").length,
    negativeCount: negatives.length,
    orGroupCount: groups.length,
  };
}
