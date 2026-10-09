/**
 * GUARD — the scanner behind the room-access build gate. WHAT IT IS: a TEXT LINT against ACCIDENTAL raw room SQL (someone writing `FROM bench_window` in a route or tool). It is NOT an adversarial parser and
 * does not stop a determined author; review and the job / tool-layer checks are the controls for that. PURE: it takes (path, source) pairs and returns the violations, so the test can also feed it an injected query.
 * A violation is (a) SQL naming a room-data table (FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM <table>, quoted / schema-qualified / ONLY / inside parentheses, SQL comments blanked), (b) a literal that uses a
 * dollar-quote ($$ / $tag$) or an E'...' string AND names any gated table (FAIL CLOSED: those forms are not parsed), or (c) a literal that builds / reads an R2 room-audio key prefix, in a file outside
 * lib/room-access/ that is not on the allowlist. TS comments are ignored.
 * KNOWN LIMITS (not scanned): SQL assembled by string concatenation or built in a variable across literals (a table name in one piece, FROM in another); a table name from a variable or a config value;
 * SQL read from a file; dynamic identifiers; a table reached through a VIEW or function that is not gated. LINT-FU: the former residual forms are scanned now: FROM (bench_window w JOIN x ...) (a bracketed join group, also
 * JOIN (...)), DELETE ... USING <table>, TABLE <table>, COPY <table>, TRUNCATE <table>[, ...]. Still not scanned: a name carried by a bare word in prose with no SQL keyword before it; a table named only after a comma in a
 * USING / COPY / TABLE list (only the first name after the keyword is seen; TRUNCATE takes a full list).
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
// LINT-FU: JOIN may open a bracketed group (JOIN (bench_window w JOIN ...)), and DELETE ... USING <table>, TABLE <table> (also TRUNCATE TABLE, CREATE / ALTER / DROP TABLE), COPY <table> are the same table named
const KW_RE = new RegExp(`\\b(?:JOIN\\s+(?:\\(\\s*)*|(?:UPDATE|INTO|USING|TABLE|COPY)\\s+)(?:ONLY\\s+)?${NAME}`, "gi");
// LINT-FU: TRUNCATE [ONLY] a, b, c (a comma list; TRUNCATE TABLE is caught by the TABLE pattern above)
const TRUNC_RE = /\bTRUNCATE\s+(?!TABLE\b)([^;]*)/gi;
const FROM_RE = /\bFROM\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?)(?=\s(?:WHERE|GROUP|ORDER|LIMIT|JOIN|LEFT|RIGHT|INNER|CROSS|FULL|NATURAL|ON|UNION|HAVING|RETURNING|SET|FOR|OFFSET)\b|\)|;|$)/gi;
const ITEM_RE = new RegExp(`^\\s*(?:\\(\\s*)*(?:ONLY\\s+)?${NAME}`, "i"); // LINT-FU: a bracketed join group FROM (bench_window w JOIN x ...) / FROM ((cue c ...))
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
    for (const m of lit.text.matchAll(TRUNC_RE)) {
      let off = m.index! + m[0].indexOf(m[1]!);
      for (const item of splitList(m[1]!)) { const t = ITEM_RE.exec(item); if (t) add("sql", t[1]!.toLowerCase(), lit.at + off + (t.index ?? 0)); off += item.length + 1; }
    }
    // REL3-FU2 G3-1: every FROM is looked at, INCLUDING the ones inside parentheses (derived tables, LATERAL, subqueries in a JOIN): the scan resumes right after each FROM keyword instead of
    // skipping the span a match consumed; FROM ONLY <table> is the same table
    const re = new RegExp(FROM_RE.source, "gi");
    for (let m = re.exec(lit.text); m; m = re.exec(lit.text)) {
      let off = m.index! + m[0].indexOf(m[1]!);
      for (const item of splitList(m[1]!)) {
        const t = ITEM_RE.exec(item);
        if (t) add("sql", t[1]!.toLowerCase(), lit.at + off + (t.index ?? 0));
        off += item.length + 1;
      }
      re.lastIndex = m.index! + 4;
    }
  }
  for (const m of code.matchAll(KEY_RE)) add("key", m[0].slice(1), m.index!);
  return out.sort((a, b) => a.line - b.line);
}
