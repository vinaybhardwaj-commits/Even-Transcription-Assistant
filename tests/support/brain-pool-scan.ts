/**
 * tests/support/brain-pool-scan.ts — a static scan of EVERY module that imports the brain pool (lib/brain/db), for the
 * tables its queries name. Jev P0 #56, P0.3.
 *
 * WHY EVERYTHING. A pin on three files catches only a mutation in those three. The brain pool is the role brain_svc;
 * a read of a table it cannot SELECT is a 42501 in production, and the only place to stop it is CI. So the scan:
 *   - finds every importer (static `import`, `import()`/`require()`, relative or `@/` specifier, resolved to a path);
 *   - checks EVERY query call in each (`query(`, `query<T>(`, `client.query(`, `pool.query(`, `getPool().query(`);
 *   - resolves the first argument: an inline template, a string concatenation, or an identifier — to a `const` in the
 *     same file or to an `export const` in the module it was imported from, followed transitively;
 *   - and REFUSES to guess: an argument it cannot resolve is reported as `unresolved`, which fails the test.
 * THE BRAIN QUERY IS FOUND BY BINDING, NOT BY NAME. A module may import it as `query as brainQuery`, as a namespace
 * (`import * as b` then `b.query`), through a barrel (`export { query as q } from`, `export * from`), by destructuring
 * (`const { query: q } = await import(...)`, `const { query } = ns`) or by aliasing (`const q = query`). Each is tracked
 * to the local name; a binding that escapes as a bare value (`run(query)`), a default import, or a dynamic import the
 * scan cannot capture is reported as `unresolved`, which fails the test.
 * It reads SQL from string literals only (an interpolated `${x}` is resolved if it is a constant, else dropped).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const BRAIN_DB = "lib/brain/db.ts";

export type Sources = Record<string, string>;   // repo-relative path -> source text
export type Finding = { file: string; tables: string[] };
export type ScanResult = { importers: string[]; reads: Finding[]; unresolved: Array<{ file: string; arg: string }> };

/** All .ts/.tsx under the given roots (skipping node_modules, .next, tests). */
export function loadSources(roots: string[] = ["lib", "app"], root = process.cwd()): Sources {
  const out: Sources = {};
  const walk = (rel: string) => {
    const abs = join(root, rel);
    for (const name of readdirSync(abs)) {
      if (name === "node_modules" || name === ".next") continue;
      const r = `${rel}/${name}`;
      if (statSync(join(root, r)).isDirectory()) walk(r);
      else if (/\.tsx?$/.test(name)) out[r] = readFileSync(join(root, r), "utf8");
    }
  };
  for (const r of roots) walk(r);
  return out;
}

function resolveSpec(from: string, spec: string, src: Sources): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = resolve("/", dirname(from), spec).slice(1);
  else return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) if (c in src) return c;
  return null;
}

/** Index of the end of the string/template literal that starts at i; templates nest `${ }`. */
function endOfLiteral(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j += 1) {
    if (s[j] === "\\") { j += 1; continue; }
    if (q === "`" && s[j] === "$" && s[j + 1] === "{") { j = endOfBraces(s, j + 1); continue; }
    if (s[j] === q) return j;
  }
  return s.length - 1;
}
function endOfBraces(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    const c = s[j];
    if (c === "'" || c === '"' || c === "`") { j = endOfLiteral(s, j); continue; }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return j; }
  }
  return s.length - 1;
}

/** The expression text starting at i, up to a `,` `)` `;` at depth 0 (or the end). */
function expressionAt(s: string, i: number, stops: string): string {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    const c = s[j];
    if (c === "'" || c === '"' || c === "`") { j = endOfLiteral(s, j); continue; }
    if (c === "/" && s[j + 1] === "/") { while (j < s.length && s[j] !== "\n") j += 1; continue; }
    if (c === "/" && s[j + 1] === "*") { j = s.indexOf("*/", j + 2); if (j < 0) break; j += 1; continue; }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) { if (depth === 0 && stops.includes(c)) return s.slice(i, j); depth -= 1; }
    else if (depth === 0 && stops.includes(c)) return s.slice(i, j);
  }
  return s.slice(i);
}

/** The source with every comment blanked (strings kept), so a `query(` inside a comment is not a call. */
export function maskComments(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") { const j = endOfLiteral(s, i); out += s.slice(i, j + 1); i = j; }
    else if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") { out += " "; i += 1; } out += "\n"; }
    else if (c === "/" && s[i + 1] === "*") { const j = s.indexOf("*/", i + 2); const end = j < 0 ? s.length : j + 2; out += s.slice(i, end).replace(/[^\n]/g, " "); i = end - 1; }
    else out += c;
  }
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** SQL text of an expression: its string-literal parts, with `${CONST}` and bare identifiers resolved where they can be. null = unresolvable. */
function sqlOf(expr: string, file: string, src: Sources, seen: Set<string>): string | null {
  const e = expr.trim();
  if (IDENT.test(e)) return constText(e, file, src, seen);
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
  if (call && expressionAt(e, call[0].length, ")").length + call[0].length + 1 === e.length) return funcText(call[1], file, src, seen);
  let out = "";
  let sawLiteral = false;
  for (let i = 0; i < e.length; i += 1) {
    const c = e[i];
    if (c === "'" || c === '"') { const j = endOfLiteral(e, i); out += e.slice(i + 1, j) + " "; sawLiteral = true; i = j; }
    else if (c === "`") {
      const j = endOfLiteral(e, i); const body = e.slice(i + 1, j); sawLiteral = true; i = j;
      let k = 0;
      while (k < body.length) {
        if (body[k] === "$" && body[k + 1] === "{") {
          const end = endOfBraces(body, k + 1);
          const inner = body.slice(k + 2, end).trim();
          if (IDENT.test(inner)) { const t = constText(inner, file, src, seen); if (t) out += ` ${t} `; }
          k = end + 1;
        } else { out += body[k]; k += 1; }
      }
      out += " ";
    } else if (/[A-Za-z_$]/.test(c) && (i === 0 || !/[\w$.]/.test(e[i - 1]))) {
      let j = i; while (j < e.length && /[\w$]/.test(e[j])) j += 1;
      const id = e.slice(i, j);
      // a bare identifier operand of a `+` (not a call or member access): try to resolve it as a constant
      const after = e.slice(j).trimStart()[0];
      if (after !== "(" && after !== "." && after !== "[") { const t = constText(id, file, src, seen); if (t) { out += ` ${t} `; sawLiteral = true; } }
      i = j - 1;
    }
  }
  return sawLiteral ? out : null;
}

/** The SQL text of `const NAME = ...` in `file`, or of `export const NAME` in the module `file` imports it from. */
function constText(name: string, file: string, src: Sources, seen: Set<string>): string | null {
  const key = `${file}::${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const text = src[file] ?? "";
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b[^=\\n]*=\\s*`).exec(text);
  if (decl) return sqlOf(expressionAt(text, decl.index + decl[0].length, ";"), file, src, seen);
  return viaModules(name, file, src, seen, constText);
}

/** A named import or re-export of `name` in `file`, followed into the module it comes from; `export * from` tries each. */
function viaModules(name: string, file: string, src: Sources, seen: Set<string>, into: (n: string, f: string, s: Sources, seen: Set<string>) => string | null): string | null {
  const text = src[file] ?? "";
  for (const m of text.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)).filter((n) => n[0]);
    const hit = names.find((n) => (n[1] ?? n[0]) === name);
    if (hit) { const target = resolveSpec(file, m[2], src); return target ? into(hit[0], target, src, seen) : null; }
  }
  for (const m of text.matchAll(/export\s+\*\s+from\s*["']([^"']+)["']/g)) {
    const target = resolveSpec(file, m[1], src);
    const t = target ? into(name, target, src, seen) : null;
    if (t) return t;
  }
  return null;
}

/** The string-literal parts of a function's whole body: `function NAME(...) { ... }`, in this file or the module it is imported from. */
function funcText(name: string, file: string, src: Sources, seen: Set<string>): string | null {
  const key = `${file}::fn:${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const text = src[file] ?? "";
  const m = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name.replace(/\$/g, "\\$")}\\b`).exec(text);
  if (m) {
    const open = text.indexOf("{", text.indexOf(")", m.index));
    if (open < 0) return null;
    const body = text.slice(open, endOfBraces(text, open) + 1);
    return sqlOf(body, file, src, seen) ?? "";
  }
  return viaModules(name, file, src, seen, funcText);
}

// A table is the identifier after one of these. After FROM/JOIN/USING an identifier IMMEDIATELY followed by "(" is a
// function (unnest, jsonb_to_recordset), not a table; after INTO/UPDATE a "(" is the column list of the table.
const TABLE_RE = /\b(FROM|JOIN|INTO|UPDATE|TRUNCATE(?:\s+TABLE)?|LOCK\s+TABLE|USING)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z_0-9]*)(?![a-z_0-9])"?(\()?/gi;
const CTE_RE = /\b([a-z_][a-z_0-9]*)\s+AS\s*(?:NOT\s+MATERIALIZED\s*|MATERIALIZED\s*)?\(/gi;
const NOT_A_TABLE = new Set(["select", "set", "only", "lateral", "values", "the", "a", "an"]);

export function tablesIn(sqlText: string): string[] {
  const ctes = new Set([...sqlText.matchAll(CTE_RE)].map((m) => m[1].toLowerCase()));
  const out = new Set<string>();
  for (const m of sqlText.matchAll(TABLE_RE)) {
    const t = m[2].toLowerCase();
    const fn = m[3] === "(" && /^(FROM|JOIN|USING)$/i.test(m[1]);
    if (!fn && !ctes.has(t) && !NOT_A_TABLE.has(t)) out.add(t);
  }
  return [...out].sort();
}


// ─── bindings ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Kind = "query" | "getPool" | "ns";
type Exports = Map<string, Kind>;
type Bindings = { names: Map<string, Kind>; nsMaps: Map<string, Exports>; importsAny: boolean; unresolved: string[] };

const ID = "[A-Za-z_$][\\w$]*";
const IMPORT_STMT = new RegExp(`import\\s+(type\\s+)?(${ID})?\\s*,?\\s*(\\{[^}]*\\}|\\*\\s*as\\s+${ID})?\\s*from\\s*["']([^"']+)["']`, "g");
const items = (list: string): Array<[string, string]> =>
  list.replace(/[{}]/g, "").split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean).map((x) => {
    const [a, b] = x.split(/\s+as\s+/);
    return [a.trim(), (b ?? a).trim()] as [string, string];
  });

function exportsOf(file: string, src: Sources, memo: Map<string, Exports>, stack: Set<string>): Exports {
  const hit = memo.get(file);
  if (hit) return hit;
  const out: Exports = new Map();
  if (file === BRAIN_DB) { out.set("query", "query"); out.set("getPool", "getPool"); memo.set(file, out); return out; }
  if (stack.has(file) || !(file in src)) return out;
  stack.add(file);
  const text = maskComments(src[file]);
  for (const m of text.matchAll(/export\s+(?!type\b)\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const t = resolveSpec(file, m[2], src);
    if (!t) continue;
    const ex = exportsOf(t, src, memo, stack);
    for (const [a, b] of items(m[1])) { const k = ex.get(a); if (k) out.set(b, k); }
  }
  for (const m of text.matchAll(/export\s+\*\s+from\s*["']([^"']+)["']/g)) {
    const t = resolveSpec(file, m[1], src);
    if (t) for (const [k, v] of exportsOf(t, src, memo, stack)) if (k !== "default") out.set(k, v);
  }
  for (const m of text.matchAll(new RegExp(`export\\s+\\*\\s+as\\s+(${ID})\\s+from\\s*["']([^"']+)["']`, "g"))) {
    const t = resolveSpec(file, m[2], src);
    if (t && exportsOf(t, src, memo, stack).size) out.set(m[1], "ns");
  }
  const b = bindingsOf(file, src, memo, stack);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) for (const [a, c] of items(m[1])) { const k = b.names.get(a); if (k) out.set(c, k); }
  for (const m of text.matchAll(new RegExp(`export\\s+(?:const|let)\\s+(${ID})\\s*=\\s*(${ID})\\s*[;\\n]`, "g"))) { const k = b.names.get(m[2]); if (k) out.set(m[1], k); }
  stack.delete(file);
  memo.set(file, out);
  return out;
}

function bindingsOf(file: string, src: Sources, memo: Map<string, Exports>, stack: Set<string>): Bindings {
  const text = maskComments(src[file] ?? "");
  const r: Bindings = { names: new Map(), nsMaps: new Map(), importsAny: false, unresolved: [] };
  const add = (local: string, k: Kind, ns?: Exports) => { r.names.set(local, k); if (ns) r.nsMaps.set(local, ns); };
  const brainy = (spec: string): Exports | null => {
    const t = resolveSpec(file, spec, src);
    if (!t) return /(^|\/)brain\/db$/.test(spec) ? new Map() : null;
    const ex = exportsOf(t, src, memo, stack);
    return t === BRAIN_DB || ex.size ? ex : null;
  };
  for (const m of text.matchAll(IMPORT_STMT)) {
    if (m[1]) continue;                                      // import type: no runtime binding
    const ex = brainy(m[4]);
    if (!ex) continue;
    r.importsAny = true;
    if (m[2]) { const k = ex.get("default"); if (k) add(m[2], k, k === "ns" ? ex : undefined); else r.unresolved.push(`default import ${m[2]} from ${m[4]} cannot be resolved`); }
    if (m[3]?.startsWith("{")) for (const [a, b] of items(m[3])) { const k = ex.get(a); if (k) add(b, k, k === "ns" ? ex : undefined); }
    else if (m[3]) add(m[3].replace(/^\*\s*as\s+/, ""), "ns", ex);
  }
  // dynamic import() / require(): captured only when bound by const/let/var; anything else on a brain module fails
  const dyn = new RegExp(`(?:\\bimport|\\brequire)\\s*\\(\\s*["']([^"']+)["']\\s*\\)`, "g");
  const captured = new RegExp(`(?:const|let|var)\\s+(\\{[^}]*\\}|${ID})\\s*=\\s*(?:await\\s+)?(?:import|require)\\s*\\(\\s*["']([^"']+)["']\\s*\\)`, "g");
  let capturedN = 0;
  for (const m of text.matchAll(captured)) {
    const ex = brainy(m[2]);
    if (!ex) continue;
    capturedN += 1; r.importsAny = true;
    if (m[1].startsWith("{")) for (const part of m[1].replace(/[{}]/g, "").split(",").map((x) => x.trim()).filter(Boolean)) { const [a, b] = part.split(":").map((x) => x.trim()); const k = ex.get(a); if (k) add(b ?? a, k, k === "ns" ? ex : undefined); }
    else add(m[1], "ns", ex);
  }
  let dynN = 0;
  for (const m of text.matchAll(dyn)) if (brainy(m[1])) dynN += 1;
  if (dynN > capturedN) r.importsAny = true;
  if (dynN > capturedN) r.unresolved.push(`${dynN - capturedN} dynamic import()/require() of the brain pool is not bound to a name`);
  // aliases to a fixpoint: const q = query; const q = ns.query; const { query: q } = ns
  for (let changed = true; changed;) {
    changed = false;
    const before = r.names.size;
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+(${ID})\\s*=\\s*(${ID})\\s*(?:[;\\n,)]|$)`, "g"))) {
      const k = r.names.get(m[2]); if (k && !r.names.has(m[1])) add(m[1], k, r.nsMaps.get(m[2]));
    }
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+(${ID})\\s*=\\s*(${ID})\\s*\\.\\s*(${ID})\\s*(?:[;\\n,)]|$)`, "g"))) {
      const k = r.nsMaps.get(m[2])?.get(m[3]); if (k && !r.names.has(m[1])) add(m[1], k);
    }
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s*(\\{[^}]*\\})\\s*=\\s*(${ID})\\s*[;\\n]`, "g"))) {
      const ex = r.nsMaps.get(m[2]); if (!ex) continue;
      for (const part of m[1].replace(/[{}]/g, "").split(",").map((x) => x.trim()).filter(Boolean)) { const [a, b] = part.split(":").map((x) => x.trim()); const k = ex.get(a); if (k && !r.names.has(b ?? a)) add(b ?? a, k); }
    }
    changed = r.names.size > before;
  }
  return r;
}

/** The source with string and template TEXT blanked (the `${ }` expressions inside templates stay), so a word in a message is not a use. */
function maskStrings(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'" || c === '"') { const j = endOfLiteral(s, i); out += c + " ".repeat(Math.max(0, j - i - 1)) + s[j]; i = j; }
    else if (c === "`") {
      const j = endOfLiteral(s, i); out += "`";
      for (let k = i + 1; k < j; k += 1) {
        if (s[k] === "$" && s[k + 1] === "{") { const e = endOfBraces(s, k + 1); out += maskStrings(s.slice(k, e + 1)); k = e; }
        else out += s[k] === "\n" ? "\n" : " ";
      }
      out += "`"; i = j;
    } else out += c;
  }
  return out;
}

export function importersOfBrainPool(src: Sources): string[] {
  const memo = new Map<string, Exports>();
  return Object.keys(src).filter((f) => f !== BRAIN_DB && bindingsOf(f, src, memo, new Set()).importsAny).sort();
}

const GENERIC_QUERY = /(?<![\w$])[A-Za-z_$][\w$]*(?:\(\))?\s*\.\s*query\s*(?:<[^()]*>)?\s*\(/g;

export function scanBrainPool(src: Sources): ScanResult {
  const memo = new Map<string, Exports>();
  const importers = Object.keys(src).filter((f) => f !== BRAIN_DB && bindingsOf(f, src, memo, new Set()).importsAny).sort();
  const reads: Finding[] = [];
  const unresolved: ScanResult["unresolved"] = [];
  for (const f of importers) {
    const b = bindingsOf(f, src, memo, new Set());
    for (const u of b.unresolved) unresolved.push({ file: f, arg: u });
    const text = maskComments(src[f]);
    const open = new Set<number>();                      // index just past each call's "(", so a call matched twice is read once
    const note = (m: RegExpMatchArray) => open.add(m.index! + m[0].length);
    for (const [name, k] of b.names) {
      const n = name.replace(/\$/g, "\\$");
      if (k === "query") for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${n}\\s*(?:<[^()]*>)?\\s*\\(`, "g"))) note(m);
      if (k === "ns") {
        const ex = b.nsMaps.get(name);
        for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${n}\\s*\\.\\s*(${ID})\\s*(?:<[^()]*>)?\\s*\\(`, "g"))) if (ex?.get(m[1]) === "query") note(m);
      }
    }
    for (const m of text.matchAll(GENERIC_QUERY)) note(m);
    for (const at of [...open].sort((x, y) => x - y)) {
      const arg = expressionAt(text, at, ",)");
      const sqlText = sqlOf(arg, f, src, new Set());
      if (sqlText === null) { unresolved.push({ file: f, arg: arg.trim().slice(0, 60) }); continue; }
      reads.push({ file: f, tables: tablesIn(sqlText) });
    }
    // an escape: the binding used as a bare value (run(query), arr = [query]) cannot be followed, so it fails
    const noImports = maskStrings(text).replace(IMPORT_STMT, (x) => " ".repeat(x.length));
    for (const [name, k] of b.names) {
      const n = name.replace(/\$/g, "\\$");
      for (const m of noImports.matchAll(new RegExp(`(?<![\\w$.])${n}(?![\\w$])`, "g"))) {
        const before = noImports.slice(Math.max(0, m.index! - 80), m.index!);
        const after = noImports.slice(m.index! + name.length, m.index! + name.length + 80);
        const call = k === "query" ? /^\s*(?:<[^()]*>)?\s*\(/ : k === "getPool" ? /^\s*\(/ : /^\s*\.\s*[\w$]+/;
        const declSource = /(?:const|let|var)\s+[\w${}:,\s]+=\s*(?:await\s+)?$/.test(before);   // the source of an alias we track
        const exported = /export\s*\{[^}]*$/.test(before);
        if (!call.test(after) && !declSource && !exported && !/\bfunction\s+$|(?:const|let|var)\s+$/.test(before)) unresolved.push({ file: f, arg: `${name} escapes as a value` });
      }
    }
  }
  return { importers, reads, unresolved };
}
