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

const SQL_RE = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM)\\s+(${ROOM_TABLES.join("|")})\\b`, "gi");
const KEY_RE = new RegExp(`[\`'"](?:${KEY_PREFIXES.map((p) => p.replace(/[/-]/g, (c) => `\\${c}`)).join("|")})`, "g");

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
  for (const m of code.matchAll(SQL_RE)) out.push({ file, kind: "sql", what: m[1]!.toLowerCase(), line: lineOf(m.index!) });
  for (const m of code.matchAll(KEY_RE)) out.push({ file, kind: "key", what: m[0].slice(1), line: lineOf(m.index!) });
  return out;
}
