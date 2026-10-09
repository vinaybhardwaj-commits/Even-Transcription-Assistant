/**
 * GUARD — the scanner behind the room-access build gate. PURE: it takes (path, source) pairs and returns the violations, so the test can also feed it an injected raw query.
 * A violation is (a) SQL naming a room-data table (FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM <table>), or (b) a string or template literal that builds / reads an R2 room-audio key prefix,
 * in a file outside lib/room-access/ that is not on the allowlist. Comments are ignored.
 */
export const ROOM_TABLES = [
  "room_turn_speaker", "room_diarize_window", "bench_window", "bench_session", "speaker_cluster", "room_speaker_cluster_member", "diarize_window_label",
  "diarize_nemotron_window", "diarize_nemotron_run", "diarize_nemotron_label", "cue", "room_audio_state", "room_audio_day", "room_span_emotion", "jev_window_text",
  "eta_encounter_windows", "reb_track_index",
] as const;
export const KEY_PREFIXES = ["bench/", "clips/", "vad-trim/", "reb/", "consult-clips/", "mcp-sarvam/"] as const;

const NAME = `(?:"?[A-Za-z_][\\w$]*"?\\s*\\.\\s*)?"?(${ROOM_TABLES.join("|")})"?(?![\\w$])`;
// G-1: a table may be quoted ("bench_window"), schema-qualified (public.bench_window, "public"."bench_window") and may be any item of a comma FROM list
const KW_RE = new RegExp(`\\b(?:JOIN|UPDATE|INTO)\\s+(?:ONLY\\s+)?${NAME}`, "gi");
const FROM_RE = /\bFROM\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?)(?=\s(?:WHERE|GROUP|ORDER|LIMIT|JOIN|LEFT|RIGHT|INNER|CROSS|FULL|NATURAL|ON|UNION|HAVING|RETURNING|SET|FOR|OFFSET)\b|\)|;|$)/gi;
const ITEM_RE = new RegExp(`^\\s*(?:ONLY\\s+)?${NAME}`, "i");
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
  for (const lit of literalsOf(code)) {
    for (const m of lit.text.matchAll(KW_RE)) add("sql", m[1]!.toLowerCase(), lit.at + m.index!);
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
