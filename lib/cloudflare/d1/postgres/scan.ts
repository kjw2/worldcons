import fs from "node:fs";
import path from "node:path";

/**
 * Read-only scanner over the existing Supabase migrations (`supabase/migrations`).
 *
 * M5.1 does not modify or translate those files. The scanner extracts a
 * canonical Postgres table/column/enum registry so the hand-authored D1 schema
 * can be cross-checked against the real source of truth. It is intentionally
 * line-oriented/regex based over the regular DDL this repository uses
 * (`create table`, `alter table ... add column`, `create index`,
 * `create type ... as enum`), not a general SQL parser.
 */
export interface PostgresColumnDefinition {
  name: string;
  /** Normalized type: lowercase, single-spaced, precision stripped (except vector(n)). */
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  primaryKey: boolean;
}

export interface PostgresTableDefinition {
  name: string;
  columns: PostgresColumnDefinition[];
  primaryKey: string[];
  /** Simple `check (col in (...))` value sets, keyed by column. */
  enumChecks: Record<string, string[]>;
}
export interface PostgresIndexDefinition {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
}

export interface PostgresSchemaRegistry {
  version: 1;
  filesScanned: number;
  statementsScanned: number;
  enums: Record<string, string[]>;
  tables: Record<string, PostgresTableDefinition>;
  indexes: Record<string, PostgresIndexDefinition>;
}

export const DEFAULT_MIGRATIONS_DIR = path.join("supabase", "migrations");

function scanSingleQuote(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'" && sql[i + 1] === "'") {
      i += 2;
      continue;
    }
    if (sql[i] === "'") return i + 1;
    i += 1;
  }
  return sql.length;
}

function scanDoubleQuote(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === '"' && sql[i + 1] === '"') {
      i += 2;
      continue;
    }
    if (sql[i] === '"') return i + 1;
    i += 1;
  }
  return sql.length;
}

const DOLLAR_TAG = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/;

function matchDollarTag(sql: string, start: number): string | null {
  const match = DOLLAR_TAG.exec(sql.slice(start));
  return match ? match[0] : null;
}
function parseStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "'") {
      const end = scanSingleQuote(sql, i);
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    if (char === '"') {
      const end = scanDoubleQuote(sql, i);
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    if (char === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      current += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      current += " ";
      continue;
    }
    if (char === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        current += " ";
        continue;
      }
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const char = text[i];
    if (char === "'") {
      i = scanSingleQuote(text, i);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (char === "'") {
      const end = scanSingleQuote(input, i);
      current += input.slice(i, end);
      i = end;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  parts.push(current);
  return parts;
}

function parenInner(text: string): string | null {
  const open = text.indexOf("(");
  if (open === -1) return null;
  const close = matchingParen(text, open);
  if (close === -1) return null;
  return text.slice(open + 1, close);
}

function stripIdentifier(text: string): string {
  const trimmed = text.trim().replace(/^[("]+/, "").replace(/[)"]+$/, "");
  const token = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(trimmed);
  return (token ? token[0] : trimmed).toLowerCase();
}
const COLUMN_KEYWORDS = new Set([
  "not", "null", "default", "primary", "unique", "references", "check", "constraint", "generated", "collate",
]);

/** Lowercases, single-spaces and strips precision (except `vector(n)`) from a type. */
export function normalizeScannedType(rawType: string): string {
  const collapsed = rawType.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^vector(\(|$)/.test(collapsed)) return collapsed;
  return collapsed.replace(/\([^)]*\)/g, "").trim();
}

function parseColumnDefinition(text: string): PostgresColumnDefinition | null {
  const trimmed = text.trim();
  const nameMatch = /^"?([A-Za-z_][A-Za-z_0-9$]*)"?\s+([\s\S]+)$/.exec(trimmed);
  if (!nameMatch) return null;
  const rest = nameMatch[2].trim();
  const typeTokens: string[] = [];
  for (const token of rest.split(/\s+/)) {
    if (COLUMN_KEYWORDS.has(token.toLowerCase())) break;
    typeTokens.push(token);
  }
  if (typeTokens.length === 0) return null;
  const lower = rest.toLowerCase();
  return {
    name: nameMatch[1].toLowerCase(),
    type: normalizeScannedType(typeTokens.join(" ")),
    notNull: /\bnot\s+null\b/.test(lower),
    hasDefault: /\bdefault\b/.test(lower),
    primaryKey: /\bprimary\s+key\b/.test(lower),
  };
}
function parseInCheck(text: string): { column: string; values: string[] } | null {
  const checkMatch = /check\s*\(/i.exec(text);
  if (!checkMatch) return null;
  const open = text.indexOf("(", checkMatch.index);
  const close = matchingParen(text, open);
  if (close === -1) return null;
  const inner = text.slice(open + 1, close).trim();
  const inMatch = /^"?([A-Za-z_][A-Za-z_0-9$]*)"?\s+in\s*\(/i.exec(inner);
  if (!inMatch) return null;
  const listOpen = inMatch[0].length - 1;
  const listClose = matchingParen(inner, listOpen);
  if (listClose === -1) return null;
  const values = splitTopLevel(inner.slice(listOpen + 1, listClose))
    .map((value) => value.trim().replace(/::[\w\s[\]]+$/, "").trim().replace(/^'/, "").replace(/'$/, ""))
    .filter((value) => value.length > 0);
  if (values.length === 0) return null;
  return { column: inMatch[1].toLowerCase(), values };
}

function parseTableBody(body: string): {
  columns: PostgresColumnDefinition[];
  primaryKey: string[];
  enumChecks: Record<string, string[]>;
} {
  const columns: PostgresColumnDefinition[] = [];
  const primaryKey: string[] = [];
  const enumChecks: Record<string, string[]> = {};
  for (const part of splitTopLevel(body)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const constraint = /^(?:constraint\s+"?[A-Za-z_][A-Za-z_0-9$]*"?\s+)?(primary\s+key|unique|check|foreign\s+key|exclude)\b/i.exec(trimmed);
    if (constraint) {
      const kind = constraint[1].toLowerCase();
      if (kind.startsWith("primary")) {
        const inner = parenInner(trimmed);
        if (inner) for (const entry of splitTopLevel(inner)) primaryKey.push(stripIdentifier(entry));
      } else if (kind === "check") {
        const check = parseInCheck(trimmed);
        if (check) enumChecks[check.column] = check.values;
      }
      continue;
    }
    const column = parseColumnDefinition(trimmed);
    if (column) columns.push(column);
  }
  for (const column of columns) if (column.primaryKey) primaryKey.push(column.name);
  return { columns, primaryKey: [...new Set(primaryKey)], enumChecks };
}
function parenInnerFrom(text: string, from: number): string | null {
  const open = text.indexOf("(", from);
  if (open === -1) return null;
  const close = matchingParen(text, open);
  if (close === -1) return null;
  return text.slice(open + 1, close);
}

function applyCreateTypeEnum(statement: string, enums: Record<string, string[]>): boolean {
  const match = /^create\s+type\s+([A-Za-z_][A-Za-z_0-9$]*)\s+as\s+enum\s*\(/i.exec(statement);
  if (!match) return false;
  const inner = parenInnerFrom(statement, match.index);
  if (inner === null) return false;
  enums[match[1].toLowerCase()] = splitTopLevel(inner)
    .map((value) => value.trim().replace(/^'/, "").replace(/'$/, ""))
    .filter((value) => value.length > 0);
  return true;
}

function applyCreateTable(statement: string, tables: Record<string, PostgresTableDefinition>): boolean {
  const match = /^create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][A-Za-z_0-9$]*)\s*\(/i.exec(statement);
  if (!match) return false;
  const body = parenInnerFrom(statement, match.index);
  if (body === null) return false;
  const name = match[1].toLowerCase();
  tables[name] = { name, ...parseTableBody(body) };
  return true;
}

function applyDropTable(statement: string, tables: Record<string, PostgresTableDefinition>): boolean {
  const match = /^drop\s+table\s+(?:if\s+exists\s+)?([A-Za-z_][A-Za-z_0-9$]*)/i.exec(statement);
  if (!match) return false;
  delete tables[match[1].toLowerCase()];
  return true;
}
function applyAlterTable(statement: string, tables: Record<string, PostgresTableDefinition>): boolean {
  const match = /^alter\s+table\s+(?:if\s+exists\s+)?([A-Za-z_][A-Za-z_0-9$]*)\s+([\s\S]+)$/i.exec(statement);
  if (!match) return false;
  const table = tables[match[1].toLowerCase()];
  if (!table) return true;
  const rest = match[2].trim();
  for (const action of splitTopLevel(rest)) {
    const trimmedAction = action.trim();
    const addColumn = /^add\s+column\s+(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(trimmedAction);
    if (addColumn) {
      const column = parseColumnDefinition(addColumn[1]);
      if (column) {
        const existing = table.columns.findIndex((entry) => entry.name === column.name);
        if (existing >= 0) table.columns[existing] = column;
        else table.columns.push(column);
        if (column.primaryKey && !table.primaryKey.includes(column.name)) table.primaryKey.push(column.name);
      }
      continue;
    }
    if (/^add\s+constraint\s+[A-Za-z_][A-Za-z_0-9$]*\s+check\b/i.test(trimmedAction)) {
      const check = parseInCheck(trimmedAction);
      if (check) table.enumChecks[check.column] = check.values;
      continue;
    }
    const dropColumn = /^drop\s+column\s+(?:if\s+exists\s+)?([A-Za-z_][A-Za-z_0-9$]*)/i.exec(trimmedAction);
    if (dropColumn) {
      const name = dropColumn[1].toLowerCase();
      table.columns = table.columns.filter((entry) => entry.name !== name);
      table.primaryKey = table.primaryKey.filter((entry) => entry !== name);
    }
  }
  return true;
}

function applyCreateIndex(statement: string, indexes: Record<string, PostgresIndexDefinition>): boolean {
  const match = /^create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][A-Za-z_0-9$]*)\s+on\s+([A-Za-z_][A-Za-z_0-9$]*)/i.exec(statement);
  if (!match) return false;
  const inner = parenInnerFrom(statement, match.index + match[0].length);
  const columns = inner
    ? splitTopLevel(inner).map((entry) => stripIdentifier(entry)).filter((entry) => entry.length > 0)
    : [];
  indexes[match[2].toLowerCase()] = {
    name: match[2].toLowerCase(),
    table: match[3].toLowerCase(),
    columns,
    unique: Boolean(match[1]),
  };
  return true;
}
export interface ScanPostgresSchemaOptions {
  rootDir?: string;
  migrationsDir?: string;
}

/**
 * Scans every `supabase/migrations/*.sql` file (in filename order) and returns
 * the canonical Postgres table/column/enum registry. Read-only: it never writes
 * to the migrations directory.
 */
export function scanPostgresSchema(options: ScanPostgresSchemaOptions = {}): PostgresSchemaRegistry {
  const rootDir = options.rootDir ?? process.cwd();
  const dir = path.resolve(rootDir, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()
    : [];
  const tables: Record<string, PostgresTableDefinition> = {};
  const enums: Record<string, string[]> = {};
  const indexes: Record<string, PostgresIndexDefinition> = {};
  let statementsScanned = 0;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    for (const statement of parseStatements(sql)) {
      statementsScanned += 1;
      if (applyCreateTypeEnum(statement, enums)) continue;
      if (applyCreateTable(statement, tables)) continue;
      if (applyAlterTable(statement, tables)) continue;
      if (applyCreateIndex(statement, indexes)) continue;
      applyDropTable(statement, tables);
    }
  }
  return { version: 1, filesScanned: files.length, statementsScanned, enums, tables, indexes };
}