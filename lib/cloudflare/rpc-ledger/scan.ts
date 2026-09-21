import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { RpcCallSite, RpcCallSiteKind } from "./types";

/** Runtime roots the ledger is authoritative for (M4.6 scope: app/lib/workers). */
export const DEFAULT_SCAN_ROOTS = ["app", "lib", "workers"] as const;

/** Adjacent roots that are counted but out of the runtime ledger scope. */
export const ADJACENT_SCAN_ROOTS = ["worker", "components", "plugins", "scripts"] as const;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".vinext",
  ".wrangler",
  ".cache",
  ".crawlee-storage",
]);

const SOURCE_EXTENSION = /\.tsx?$/;
const TEST_FILE = /\.(test|spec)\.tsx?$/;

export interface RpcLedgerScan {
  roots: string[];
  files: number;
  callSites: RpcCallSite[];
  byKind: Record<RpcCallSiteKind, number>;
  uniqueFunctions: string[];
  adjacentCallSiteCounts: Record<string, number>;
}

interface SourceModule {
  fileName: string;
  relativePath: string;
  source: ts.SourceFile;
}

interface DeclarationRef {
  name: string;
  node: ts.Node;
  scope: ts.Node;
}
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function union(left: string[] | null, right: string[] | null): string[] | null {
  if (!left || !right) return null;
  return unique([...left, ...right]);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function enclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isBlock(current) || ts.isModuleBlock(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function functionLikeName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  const parent = node.parent;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && parent
    && ts.isVariableDeclaration(parent)
    && ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return null;
}
function isRpcCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "rpc";
}

function listSourceFiles(rootDir: string, roots: readonly string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const absolute = path.join(rootDir, root);
    if (fs.existsSync(absolute)) walk(absolute, files);
  }
  return files;
}

function walk(directory: string, files: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(absolute, files);
      continue;
    }
    if (!SOURCE_EXTENSION.test(entry.name) || entry.name.endsWith(".d.ts") || TEST_FILE.test(entry.name)) continue;
    files.push(absolute);
  }
}

class Scanner {
  private readonly rootDir: string;
  private readonly modules = new Map<string, SourceModule>();
  private readonly declarationCache = new Map<string, DeclarationRef[]>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private moduleFor(fileName: string): SourceModule {
    const cached = this.modules.get(fileName);
    if (cached) return cached;
    const text = fs.readFileSync(fileName, "utf8");
    const source = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const relativePath = path.relative(this.rootDir, fileName).split(path.sep).join("/");
    const mod: SourceModule = { fileName, relativePath, source };
    this.modules.set(fileName, mod);
    return mod;
  }
  private declarations(mod: SourceModule): DeclarationRef[] {
    const cached = this.declarationCache.get(mod.fileName);
    if (cached) return cached;
    const refs: DeclarationRef[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        refs.push({ name: node.name.text, node, scope: enclosingScope(node) });
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        refs.push({ name: node.name.text, node, scope: enclosingScope(node) });
      } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        refs.push({ name: node.name.text, node, scope: enclosingFunction(node) ?? mod.source });
      } else if (ts.isImportSpecifier(node)) {
        refs.push({ name: node.name.text, node, scope: mod.source });
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.source);
    this.declarationCache.set(mod.fileName, refs);
    return refs;
  }

  private findDeclaration(mod: SourceModule, name: string, usage: ts.Node): DeclarationRef | null {
    const refs = this.declarations(mod).filter((ref) => ref.name === name);
    if (refs.length === 0) return null;
    let current: ts.Node | undefined = usage.parent;
    while (current) {
      const match = refs.find((ref) => ref.scope === current);
      if (match) return match;
      current = current.parent;
    }
    return refs.find((ref) => ts.isSourceFile(ref.scope)) ?? refs[0];
  }
  evaluate(node: ts.Expression, mod: SourceModule, seen: Set<string>): string[] | null {
    const expression = unwrapExpression(node);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
    if (ts.isTemplateExpression(expression)) {
      return expression.templateSpans.length === 0 ? [expression.head.text] : null;
    }
    if (ts.isConditionalExpression(expression)) {
      return union(this.evaluate(expression.whenTrue, mod, seen), this.evaluate(expression.whenFalse, mod, seen));
    }
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return union(this.evaluate(expression.left, mod, seen), this.evaluate(expression.right, mod, seen));
      }
      return null;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const values: string[] = [];
      for (const element of expression.elements) {
        const resolved = this.evaluate(element, mod, seen);
        if (!resolved) return null;
        values.push(...resolved);
      }
      return unique(values);
    }
    if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
      return this.evaluateFunctionLike(expression, mod, seen);
    }
    if (ts.isIdentifier(expression)) return this.evaluateIdentifier(expression, mod, seen);
    if (ts.isCallExpression(expression)) return this.evaluateCall(expression, mod, seen);
    return null;
  }
  private evaluateIdentifier(node: ts.Identifier, mod: SourceModule, seen: Set<string>): string[] | null {
    const declaration = this.findDeclaration(mod, node.text, node);
    return declaration ? this.evaluateDeclaration(declaration, mod, seen) : null;
  }

  private evaluateDeclaration(declaration: DeclarationRef, mod: SourceModule, seen: Set<string>): string[] | null {
    const node = declaration.node;
    if (ts.isImportSpecifier(node)) {
      const importClause = node.parent.parent;
      if (!ts.isImportClause(importClause)) return null;
      const importDeclaration = importClause.parent;
      if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return null;
      const importedName = node.propertyName ? node.propertyName.text : node.name.text;
      return this.resolveImported(importDeclaration.moduleSpecifier.text, importedName, mod, seen);
    }
    if (ts.isVariableDeclaration(node)) return node.initializer ? this.evaluate(node.initializer, mod, seen) : null;
    if (ts.isParameter(node)) return this.resolveParameter(node, mod, seen);
    if (ts.isFunctionDeclaration(node)) return this.evaluateFunctionLike(node, mod, seen);
    return null;
  }

  private evaluateCall(node: ts.CallExpression, mod: SourceModule, seen: Set<string>): string[] | null {
    const callee = unwrapExpression(node.expression);
    if (!ts.isIdentifier(callee)) return null;
    const declaration = this.findDeclaration(mod, callee.text, callee);
    return declaration ? this.evaluateDeclaration(declaration, mod, seen) : null;
  }
  private evaluateFunctionLike(node: ts.Node, mod: SourceModule, seen: Set<string>): string[] | null {
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      return this.evaluate(node.body, mod, seen);
    }
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (!body || !ts.isBlock(body)) return null;
    const values: string[] = [];
    let returned = 0;
    let unresolvedReturns = 0;
    const visit = (child: ts.Node) => {
      if (ts.isFunctionLike(child) && child !== node) return;
      if (ts.isReturnStatement(child) && child.expression) {
        returned += 1;
        const resolved = this.evaluate(child.expression, mod, seen);
        if (resolved) values.push(...resolved);
        else unresolvedReturns += 1;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(body);
    if (returned === 0 || unresolvedReturns > 0) return null;
    return unique(values);
  }
  private resolveParameter(parameter: ts.ParameterDeclaration, mod: SourceModule, seen: Set<string>): string[] | null {
    const owner = enclosingFunction(parameter);
    if (!owner) return null;
    const name = functionLikeName(owner);
    if (!name || !ts.isIdentifier(parameter.name)) return null;
    const key = `${mod.relativePath}#param:${name}:${parameter.name.text}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const values: string[] = [];
    let unresolved = false;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name && node.arguments.length > 0) {
        const resolved = this.evaluate(node.arguments[0], mod, seen);
        if (resolved) values.push(...resolved);
        else unresolved = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.source);
    if (unresolved || values.length === 0) return null;
    return unique(values);
  }
  private evaluateExported(mod: SourceModule, name: string, seen: Set<string>): string[] | null {
    const key = `${mod.relativePath}#export:${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    for (const statement of mod.source.statements) {
      if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
            return this.evaluate(declaration.initializer, mod, seen);
          }
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && hasExportModifier(statement)) {
        return this.evaluateFunctionLike(statement, mod, seen);
      }
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== name) continue;
          const localName = element.propertyName ? element.propertyName.text : element.name.text;
          if (specifier) {
            const target = this.resolveModuleFile(specifier, path.dirname(mod.fileName));
            return target ? this.evaluateExported(this.moduleFor(target), localName, seen) : null;
          }
          const local = this.findModuleDeclaration(mod, localName);
          return local ? this.evaluateDeclaration(local, mod, seen) : null;
        }
      } else if (!statement.exportClause && specifier) {
        const target = this.resolveModuleFile(specifier, path.dirname(mod.fileName));
        if (target) {
          const resolved = this.evaluateExported(this.moduleFor(target), name, seen);
          if (resolved) return resolved;
        }
      }
    }
    return null;
  }
  private resolveImported(specifier: string, importedName: string, fromModule: SourceModule, seen: Set<string>): string[] | null {
    const target = this.resolveModuleFile(specifier, path.dirname(fromModule.fileName));
    if (!target) return null;
    return this.evaluateExported(this.moduleFor(target), importedName, seen);
  }

  private findModuleDeclaration(mod: SourceModule, name: string): DeclarationRef | null {
    const refs = this.declarations(mod).filter((ref) => ref.name === name);
    return refs.find((ref) => ts.isSourceFile(ref.scope)) ?? refs[0] ?? null;
  }

  private resolveModuleFile(specifier: string, fromDirectory: string): string | null {
    let base: string | null = null;
    if (specifier.startsWith("@/")) base = path.join(this.rootDir, specifier.slice(2));
    else if (specifier.startsWith(".")) base = path.resolve(fromDirectory, specifier);
    if (!base) return null;
    const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
  }
  private classify(argument: ts.Expression, mod: SourceModule): RpcCallSiteKind {
    const expression = unwrapExpression(argument);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return "literal";
    if (ts.isIdentifier(expression)) {
      const declaration = this.findDeclaration(mod, expression.text, expression);
      if (!declaration) return "unresolved";
      if (ts.isParameter(declaration.node)) return "parameter";
      if (ts.isVariableDeclaration(declaration.node) || ts.isImportSpecifier(declaration.node)) {
        return this.evaluate(expression, mod, new Set()) ? "constant" : "unresolved";
      }
      return "unresolved";
    }
    if (ts.isCallExpression(expression)) {
      return this.evaluate(expression, mod, new Set()) ? "function-call" : "unresolved";
    }
    return "unresolved";
  }

  private resolverFor(argument: ts.Expression, kind: RpcCallSiteKind, mod: SourceModule): string | null {
    if (kind === "literal") return null;
    const expression = unwrapExpression(argument);
    if (ts.isIdentifier(expression)) {
      const declaration = this.findDeclaration(mod, expression.text, expression);
      if (kind === "parameter" && declaration && ts.isParameter(declaration.node)) {
        const owner = enclosingFunction(declaration.node);
        return `parameter ${expression.text} of ${owner ? functionLikeName(owner) ?? "anonymous" : "anonymous"}()`;
      }
      return `const ${expression.text}`;
    }
    if (ts.isCallExpression(expression)) {
      return `resolver call ${collapseWhitespace(expression.expression.getText(mod.source))}`;
    }
    return `unresolved: ${collapseWhitespace(argument.getText(mod.source))}`;
  }
  private describeCall(call: ts.CallExpression, mod: SourceModule): RpcCallSite {
    const argument = call.arguments[0];
    const position = mod.source.getLineAndCharacterOfPosition(call.getStart(mod.source));
    const location = { file: mod.relativePath, line: position.line + 1, column: position.character + 1 };
    if (!argument) {
      return { ...location, argText: "", kind: "unresolved", names: [], resolver: "no first argument" };
    }
    const kind = this.classify(argument, mod);
    const names = kind === "unresolved" ? [] : this.evaluate(argument, mod, new Set()) ?? [];
    return {
      ...location,
      argText: collapseWhitespace(argument.getText(mod.source)),
      kind,
      names: [...names].sort(),
      resolver: this.resolverFor(argument, kind, mod),
    };
  }

  scan(files: string[]): RpcCallSite[] {
    const callSites: RpcCallSite[] = [];
    for (const fileName of files) {
      const mod = this.moduleFor(fileName);
      const visit = (node: ts.Node) => {
        if (isRpcCall(node)) callSites.push(this.describeCall(node, mod));
        ts.forEachChild(node, visit);
      };
      visit(mod.source);
    }
    return callSites.sort((left, right) => (
      left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column
    ));
  }
}
export function scanRpcLedgerSources(options: {
  rootDir: string;
  roots?: readonly string[];
  adjacentRoots?: readonly string[];
}): RpcLedgerScan {
  const roots = [...(options.roots ?? DEFAULT_SCAN_ROOTS)];
  const adjacentRoots = [...(options.adjacentRoots ?? ADJACENT_SCAN_ROOTS)];
  const scanner = new Scanner(options.rootDir);
  const files = listSourceFiles(options.rootDir, roots);
  const callSites = scanner.scan(files);
  const byKind: Record<RpcCallSiteKind, number> = { literal: 0, constant: 0, parameter: 0, "function-call": 0, unresolved: 0 };
  const uniqueNames = new Set<string>();
  for (const site of callSites) {
    byKind[site.kind] += 1;
    for (const name of site.names) uniqueNames.add(name);
  }
  const adjacentCallSiteCounts: Record<string, number> = {};
  for (const root of adjacentRoots) {
    adjacentCallSiteCounts[root] = scanner.scan(listSourceFiles(options.rootDir, [root])).length;
  }
  return {
    roots,
    files: files.length,
    callSites,
    byKind,
    uniqueFunctions: [...uniqueNames].sort(),
    adjacentCallSiteCounts,
  };
}