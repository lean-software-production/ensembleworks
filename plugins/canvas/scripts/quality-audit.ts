import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export const AUDIT_VERSION = 1;
export const BASELINE_COMMIT = "ee79ab4";
export const SCOPE_DESCRIPTION = ["app.tsx", "server.ts", "transport.ts", "canvas/**/*.ts(x)", "hooks/**/*.ts(x)", "lib/**/*.ts(x)"];
const ROOT_FILES = new Set(["app.tsx", "server.ts", "transport.ts"]);
const ROOT_DIRS = new Set(["canvas", "hooks", "lib"]);
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

export type FunctionHotspot = { file: string; line: number; name: string; tokenLines: number; debt: number };
export type FileMetric = { file: string; tokenLines: number; debt: number };
export type AuditResult = { version: number; baselineCommit: string; productionTokenLines: number; moduleDebt: number; functionDebt: number; totalDebt: number; decisionPoints: number; localImportCycleCount: number; files: FileMetric[]; hotspots: FunctionHotspot[] };

export function productionFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) { if (ROOT_DIRS.has(relative) || relative.startsWith("canvas/") || relative.startsWith("hooks/") || relative.startsWith("lib/")) visit(absolute); }
      else if ([".ts", ".tsx"].includes(path.extname(entry.name)) && (ROOT_FILES.has(relative) || /^(canvas|hooks|lib)\/.+\.(ts|tsx)$/.test(relative))) found.push(relative);
    }
  };
  visit(root); return found.sort();
}

export function tokenLines(sourceFile: ts.SourceFile, start = 0, end = sourceFile.end): number {
  const lines = new Set<number>(); const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sourceFile.languageVariant, sourceFile.text, undefined, start); let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken && scanner.getTokenPos() < end) {
    const tokenStart = scanner.getTokenPos(); const tokenEnd = Math.min(scanner.getTextPos(), end);
    if (tokenStart < end && tokenEnd > start) { const first = sourceFile.getLineAndCharacterOfPosition(Math.max(start, tokenStart)).line; const last = sourceFile.getLineAndCharacterOfPosition(Math.max(start, tokenEnd - 1)).line; for (let line = first; line <= last; line++) lines.add(line); }
    token = scanner.scan();
  }
  return lines.size;
}
function parse(file: string, text: string): ts.SourceFile { return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function isFunction(node: ts.Node): boolean { return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node); }
function functionName(node: ts.Node): string { if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return node.name?.getText() ?? "<anonymous>"; if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.name.getText(); if (ts.isConstructorDeclaration(node)) return "constructor"; return "<arrow>"; }
function isDecision(node: ts.Node): boolean { if (ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCaseClause(node) || ts.isCatchClause(node) || ts.isConditionalExpression(node)) return true; return ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind); }
function localImports(file: ts.SourceFile): string[] { const result: string[] = []; const visit = (node: ts.Node) => { const module = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined; if (module && ts.isStringLiteral(module) && module.text.startsWith(".")) result.push(module.text); ts.forEachChild(node, visit); }; visit(file); return result; }
function resolveImport(from: string, specifier: string, files: Set<string>): string | undefined { const base = path.resolve(path.dirname(from), specifier); for (const candidate of [base, ...[".ts", ".tsx"].map((ext) => base + ext), ...[".ts", ".tsx"].map((ext) => path.join(base, `index${ext}`))]) if (files.has(path.normalize(candidate))) return path.normalize(candidate); return undefined; }
function cycleCount(graph: Map<string, string[]>): number { let nextIndex = 0; const index = new Map<string, number>(); const low = new Map<string, number>(); const stack: string[] = []; const onStack = new Set<string>(); let count = 0; const visit = (node: string) => { index.set(node, nextIndex); low.set(node, nextIndex++); stack.push(node); onStack.add(node); for (const next of graph.get(node) ?? []) { if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!)); } if (low.get(node) === index.get(node)) { const members: string[] = []; let member: string; do { member = stack.pop()!; onStack.delete(member); members.push(member); } while (member !== node); if (members.length > 1 || (graph.get(members[0]) ?? []).includes(members[0])) count++; } }; for (const node of [...graph.keys()].sort()) if (!index.has(node)) visit(node); return count; }

export function audit(root: string): AuditResult {
  const relativeFiles = productionFiles(root); const absoluteFiles = new Set(relativeFiles.map((file) => path.resolve(root, file))); const files: FileMetric[] = []; const hotspots: FunctionHotspot[] = []; const graph = new Map<string, string[]>(); let decisionPoints = 0;
  for (const relative of relativeFiles) { const absolute = path.resolve(root, relative); const source = parse(absolute, fs.readFileSync(absolute, "utf8")); const lines = tokenLines(source); files.push({ file: relative, tokenLines: lines, debt: Math.max(0, lines - 500) }); graph.set(absolute, localImports(source).map((specifier) => resolveImport(absolute, specifier, absoluteFiles)).filter((file): file is string => Boolean(file))); const visit = (node: ts.Node) => { if (isDecision(node)) decisionPoints++; if (isFunction(node)) { const functionLines = tokenLines(source, node.getStart(source), node.end); hotspots.push({ file: relative, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, name: functionName(node), tokenLines: functionLines, debt: Math.max(0, functionLines - 150) }); } ts.forEachChild(node, visit); }; visit(source); }
  files.sort((a, b) => a.file.localeCompare(b.file)); hotspots.sort((a, b) => b.debt - a.debt || a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name)); const moduleDebt = files.reduce((sum, file) => sum + file.debt, 0); const functionDebt = hotspots.reduce((sum, hotspot) => sum + hotspot.debt, 0);
  return { version: AUDIT_VERSION, baselineCommit: BASELINE_COMMIT, productionTokenLines: files.reduce((sum, file) => sum + file.tokenLines, 0), moduleDebt, functionDebt, totalDebt: moduleDebt + functionDebt, decisionPoints, localImportCycleCount: cycleCount(graph), files, hotspots };
}
function readBaseline(root: string): AuditResult { return JSON.parse(fs.readFileSync(path.join(root, "quality-audit-baseline.json"), "utf8")) as AuditResult; }
function compare(result: AuditResult, frozen: AuditResult): string[] { const errors: string[] = []; const locChange = (result.productionTokenLines - frozen.productionTokenLines) / frozen.productionTokenLines; if (Math.abs(locChange) > 0.05) errors.push(`production token lines changed by ${(locChange * 100).toFixed(2)}%`); if (result.decisionPoints < frozen.decisionPoints * 0.95) errors.push("decision points dropped by more than 5%"); if (result.localImportCycleCount > frozen.localImportCycleCount) errors.push("local import cycle count increased"); const improvement = frozen.totalDebt === 0 ? 100 : ((frozen.totalDebt - result.totalDebt) / frozen.totalDebt) * 100; if (improvement < 90) errors.push(`debt improvement is ${improvement.toFixed(2)}%, below 90%`); return errors; }
function human(result: AuditResult, frozen?: AuditResult): string { const lines = [`Production token lines: ${result.productionTokenLines}`, `Decision points: ${result.decisionPoints}`, `Local import cycle components: ${result.localImportCycleCount}`, `Module debt: ${result.moduleDebt}`, `Function debt: ${result.functionDebt}`, `Total debt: ${result.totalDebt}`]; if (frozen) lines.push(`Improvement vs ${BASELINE_COMMIT}: ${((frozen.totalDebt - result.totalDebt) / frozen.totalDebt * 100).toFixed(2)}%`); const debts = result.hotspots.filter((hotspot) => hotspot.debt > 0).slice(0, 20); if (debts.length) lines.push("Hotspots:\n" + debts.map((hotspot) => `  ${hotspot.file}:${hotspot.line} ${hotspot.name} (${hotspot.tokenLines} tokens, debt ${hotspot.debt})`).join("\n")); return lines.join("\n"); }
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) { const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); const result = audit(root); const args = new Set(process.argv.slice(2)); const frozen = readBaseline(root); console.log(args.has("--json") ? JSON.stringify(result, null, 2) : human(result, args.has("--compare") ? frozen : undefined)); if (args.has("--compare")) { const errors = compare(result, frozen); if (errors.length) { console.error(`Quality audit failed:\n${errors.map((error) => `- ${error}`).join("\n")}`); process.exitCode = 1; } } }
