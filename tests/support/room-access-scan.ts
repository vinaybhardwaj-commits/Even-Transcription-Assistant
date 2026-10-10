/**
 * GUARD — the scanner behind the room-access build gate. WHAT IT IS: a TEXT LINT against ACCIDENTAL raw room SQL (someone writing `FROM bench_window` in a route or tool). It is NOT an adversarial parser and
 * does not stop a determined author; review and the job / tool-layer checks are the controls for that. PURE: it takes (path, source) pairs and returns the violations, so the test can also feed it an injected query.
 * A violation is (a) SQL naming a room-data table (FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM <table>, quoted / schema-qualified / ONLY / inside parentheses, SQL comments blanked), (b) a literal that uses a
 * dollar-quote ($$ / $tag$) or an E'...' string AND names any gated table (FAIL CLOSED: those forms are not parsed), or (c) a literal that builds / reads an R2 room-audio key prefix, in a file outside
 * lib/room-access/ that is not on the allowlist. TS comments are ignored.
 * KNOWN LIMITS (not scanned): SQL assembled by string concatenation or built in a variable across literals (a table name in one piece, FROM in another); a table name from a variable or a config value;
 * SQL read from a file; dynamic identifiers; a table reached through a VIEW or function that is not gated; bare prose with no SQL keyword before the table name. LINT-FU: the former residual forms are scanned: a
 * FROM list is walked with a real paren-depth count (a table at ANY bracket depth in an item or a join group, FROM (((T w JOIN x) JOIN y) JOIN z)); a FROM whose brackets do not balance inside the literal FAILS CLOSED
 * (any gated table word in the rest of the literal is a violation); JOIN (T ..); DELETE .. USING T / USING (T ..) and MERGE INTO a USING (T) s; TABLE T (also CREATE / ALTER / DROP TABLE); COPY T; LOCK [TABLE] [ONLY] a, T;
 * TRUNCATE [TABLE] [ONLY] a, T (the WHOLE comma list). Still not scanned: only the first name after COPY / TABLE (TRUNCATE and LOCK read the whole list); `JOIN y USING (T)` outside a DELETE / MERGE statement is
 * a column list, not a table, and passes.
 */
export const ROOM_TABLES = [
  "room_turn_speaker", "room_diarize_window", "bench_window", "bench_session", "speaker_cluster", "room_speaker_cluster_member", "diarize_window_label",
  "diarize_nemotron_window", "diarize_nemotron_run", "diarize_nemotron_label", "cue", "room_audio_state", "room_audio_day", "room_span_emotion", "jev_window_text",
  "eta_encounter_windows", "reb_track_index",
  // REL3-FU2 scope: the session tape rows (R2 keys, times, sizes per session) and the transcripts of window subjects
  "bench_chunk", "transcription_run",
] as const;
export const KEY_PREFIXES = ["bench/", "clips/", "vad-trim/", "reb/", "consult-clips/", "mcp-sarvam/"] as const;

const NAME = `(?:"?[A-Za-z_][\\w$]*"?\\s*\\.\\s*)?"?(${ROOM_TABLES.join("|")})"?(?![\\w$])`;
// G-1: a table may be quoted ("bench_window"), schema-qualified (public.bench_window, "public"."bench_window") and may be any item of a comma FROM list
// LINT-FU: JOIN may open a bracketed group (JOIN (bench_window w JOIN ...)); DELETE ... USING <table>, TABLE <table> (also CREATE / ALTER / DROP TABLE) and COPY <table> are the same table named
const KW_RE = new RegExp(`\\b(?:JOIN\\s+(?:\\(\\s*)*|(?:UPDATE|INTO|USING|TABLE|COPY)\\s+)(?:ONLY\\s+)?${NAME}`, "gi");
// USING (T w JOIN ..) / MERGE INTO a USING (T) s: a bracketed source — only in a DELETE or MERGE statement, where USING names a source; after a JOIN, USING (col) is a column list
const USING_PAREN_RE = new RegExp(`\\bUSING\\s+\\(\\s*(?:\\(\\s*)*(?:ONLY\\s+)?${NAME}`, "gi");
// TRUNCATE [TABLE] [ONLY] a, b, c and LOCK [TABLE] [ONLY] a, b IN .. MODE: the whole comma list
const LIST_RE = /\b(?:TRUNCATE|LOCK)\s+(?:TABLE\s+)?([^;]*?)(?=\sIN\s|;|$)/gi;
const FROM_KW = /\bFROM\s+/gi;
// JOIN / LEFT / CROSS / NATURAL / ON / USING do NOT end the list: `FROM a JOIN x USING (id), T w` has T as a later comma item
const FROM_END = /^\s(?:WHERE|GROUP|ORDER|LIMIT|UNION|INTERSECT|EXCEPT|HAVING|RETURNING|SET|FOR|OFFSET|WINDOW|FETCH)\b/i;
const ITEM_RE = new RegExp(`^\\s*(?:\\(\\s*)*(?:ONLY\\s+)?${NAME}`, "id"); // a bracketed join group FROM (bench_window w JOIN x ...) at any depth
// a bracket run that opens an item or a group (not a call: count(cue) has an identifier char before the bracket; not a USING (col) column list) followed by a gated table
const GROUP_RE = new RegExp(`(?<![\\w$])(?<!\\bUSING\\s+)\\(\\s*(?:\\(\\s*)*(?:ONLY\\s+)?${NAME}`, "gid");
/** the extent of a FROM list starting at `from`: a real bracket-depth walk; ends at depth 0 on a clause keyword (WHERE / GROUP / ORDER / ..., not a JOIN form) or ';', or at a bracket that closes the enclosing group. balanced=false: the text ran out inside an open bracket. */
export function fromSpan(text: string, from: number): { end: number; balanced: boolean } {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") { if (depth === 0) return { end: i, balanced: true }; depth--; }
    else if (depth === 0 && (c === ";" || (/\s/.test(c) && FROM_END.test(text.slice(i, i + 12))))) return { end: i, balanced: true };
  }
  return { end: text.length, balanced: depth === 0 };
}
const KEY_RE = new RegExp(`[\`'"](?:${KEY_PREFIXES.map((p) => p.replace(/[/-]/g, (c) => `\\${c}`)).join("|")})`, "g");

/** The bodies of the string and template literals in comment-stripped code, with their start offsets. */
export function literalsOf(code: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "`" || c === "'" || c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === "\\") j++; j++; }
      out.push({ text: code.slice(i + 1, j), at: i + 1 });
      i = j + 1;
    } else i++;
  }
  return out;
}

/** Split a FROM list on top-level commas. */
const splitList = (list: string): string[] => {
  const items: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(cur); cur = ""; } else cur += ch;
  }
  items.push(cur);
  return items;
};

/** Replace comments with spaces (same length), keeping strings. Naive but string-aware enough for this tree. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let q: string | null = null;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (q) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") { while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    if (c === "`" || c === "'" || c === '"') { q = c; }
    out += c;
    i++;
  }
  return out;
}

/**
 * REL3-FU2 F2-1: SQL comments INSIDE a literal's text (`FROM /* x * / cue`, `FROM -- c` + newline + `cue`) are blanked before the table patterns run, or they would hide a table from them. SQL-aware: a comment opener inside a
 * SQL string ('...'), a quoted identifier ("...") or a dollar-quoted body is NOT a comment, so `SELECT '/*' AS a FROM cue WHERE b = '*\/'` still shows `cue`. Block comments nest (as in Postgres). Length is kept (newlines
 * stay) so offsets and line numbers hold.
 */
export function blankSqlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!, n = text[i + 1];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length) { if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; } j++; }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "-" && n === "-") { while (i < text.length && text[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") {
      let depth = 1; out += "  "; i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; out += "  "; i += 2; }
        else if (text[i] === "*" && text[i + 1] === "/") { depth--; out += "  "; i += 2; }
        else { out += text[i] === "\n" ? "\n" : " "; i++; }
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

export type Violation = { file: string; kind: "sql" | "key"; what: string; line: number };

export function scanSource(file: string, src: string): Violation[] {
  const code = stripComments(src);
  const lineOf = (idx: number): number => code.slice(0, idx).split("\n").length;
  const out: Violation[] = [];
  const seen = new Set<string>();
  const add = (kind: "sql" | "key", what: string, idx: number): void => {
    const k = `${kind}:${what}:${idx}`;
    if (!seen.has(k)) { seen.add(k); out.push({ file, kind, what, line: lineOf(idx) }); }
  };
  for (const lit0 of literalsOf(code)) {
    const lit = { ...lit0, text: blankSqlComments(lit0.text) };
    // REL3-FU2 F3 fail closed: forms the scanner does not parse (dollar-quoted bodies, E'..' escape strings) that name ANY gated table are a violation by themselves
    // F4: the unparsed-form test and the table search run on the RAW text (before comment blanking), so a comment opener hidden in a $$ body or an E'..' string cannot blank the table away
    const unparsed = /\$(?:[A-Za-z_]\w*)?\$/.test(lit0.text) || /(?<![A-Za-z0-9_])[Ee]'/.test(lit0.text) || (/(?<![A-Za-z0-9_$])[Ee]$/.test(code.slice(Math.max(0, lit0.at - 3), lit0.at - 1)) && code[lit0.at - 1] === "'");
    if (unparsed) for (const t of ROOM_TABLES) { const w = new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`, "i").exec(lit0.text); if (w) add("sql", t, lit0.at + w.index); }
    for (const m of lit.text.matchAll(KW_RE)) add("sql", m[1]!.toLowerCase(), lit.at + m.index!);
    if (/\b(?:DELETE|MERGE)\b/i.test(lit.text)) for (const m of lit.text.matchAll(USING_PAREN_RE)) add("sql", m[1]!.toLowerCase(), lit.at + m.index!);
    const addItems = (list: string, base: number): void => {
      let off = base;
      for (const item of splitList(list)) {
        const t = ITEM_RE.exec(item);
        if (t) add("sql", t[1]!.toLowerCase(), lit.at + off + (t as RegExpExecArray & { indices: Array<[number, number]> }).indices[1]![0]);
        off += item.length + 1;
      }
    };
    for (const m of lit.text.matchAll(LIST_RE)) addItems(m[1]!, m.index! + m[0].indexOf(m[1]!));
    // REL3-FU2 G3-1: every FROM is looked at, INCLUDING the ones inside parentheses (derived tables, LATERAL, subqueries in a JOIN): the scan resumes right after each FROM keyword; FROM ONLY <table> is the same table.
    // LINT-FU: the list is cut by a real bracket-depth walk (any depth); its depth-0 comma items and every bracket-opened group inside it are looked at; unbalanced brackets fail closed
    for (const m of lit.text.matchAll(FROM_KW)) {
      const start = m.index! + m[0].length;
      const { end, balanced } = fromSpan(lit.text, start);
      const span = lit.text.slice(start, end);
      addItems(span, start);
      for (const g of span.matchAll(GROUP_RE)) add("sql", g[1]!.toLowerCase(), lit.at + start + (g as RegExpMatchArray & { indices: Array<[number, number]> }).indices[1]![0]);
      if (!balanced) for (const t of ROOM_TABLES) { const w = new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`, "i").exec(span); if (w) add("sql", t, lit.at + start + w.index); }
    }
  }
  for (const m of code.matchAll(KEY_RE)) add("key", m[0].slice(1), m.index!);
  return out.sort((a, b) => a.line - b.line);
}
