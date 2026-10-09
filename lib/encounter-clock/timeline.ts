/**
 * lib/encounter-clock/timeline.ts — the speaker-turn TIMELINE Jev reads instead of words (epic #23, ticket e). PURE.
 *
 * Inputs: Nemotron turns (b), speaker roles from the identity pass (c, optional until it lands), the gate's energy
 * half per acoustic probe, tape-off spans, and Pulse anchors (g). Output: one Jev state per SEGMENT (PRD §7.2),
 * plus a server-side map from each row back to wall-clock ms and the acoustic probe index. The map never goes to Jev.
 *
 * SEGMENTS (PRD §6.5).
 *   · Anchored: [START_i − 60 s, min(START_{i+1}, START_i + 45 min)].
 *   · Time in the span that no anchored segment covers: 15-min sliding segments, 5-min overlap, `anchor: "none"`.
 *
 * ROWS are 30 s on the acoustic grid: probe i (scheduleProbes) is centred at origin + i·hop + probe/2 and owns one
 * hop around its centre (fusion-state.ts, "ownership by hop"), so every 60 s slot is exactly two rows and a row
 * maps back to one probe index. `t` is the row's start relative to the anchor START, on a 30 s grid, `mm:ss`.
 *
 * NO EVIDENCE IS NOT ZERO. A row that no stored Nemotron window fully covers has speech_s, spk, turns and overlap_s
 * all null. A covered row where nobody spoke has 0 and {}.
 *
 * SPEAKERS. Nemotron labels are window-local (spk0 of one 15-min clip is not spk0 of the next). A speaker is keyed by
 * (window, label). `DOC` only where `role` says the speaker matched the consult's doctor — the identity pass (c)
 * decides that, this module never does. Every other speaker gets a segment-local letter B, C, … in order of first
 * appearance; past Z, `?`. Until (c) lands, `role` is absent and nobody is DOC.
 *
 * PRIVACY. The state holds no clock time, date, name, id, room or text: only the fixed setting sentence, relative
 * `t` labels, enums, small integers and speaker letters. checkTimelineGrammar is the allowlist; the builder runs it
 * on every state it returns and throws on a violation (a bug here, never data to send).
 *
 * SIZE. At most MAX_ROWS rows and MAX_CHARS characters. An anchored segment can reach 93 rows (46 min, unaligned),
 * so when a segment is over MAX_ROWS, runs of identical silent rows are compressed into one `t+aa:bb..t+cc:dd` row
 * (PROVISIONAL, §7.2). A segment still over budget is refused as `too_large`, never truncated.
 */
import type { Anchor } from "@/lib/encounter-clock/anchors";
import type { EnergyState } from "@/lib/encounter-clock/gate";
import { HOP_SECONDS, PROBE_SECONDS } from "@/lib/encounter-clock/probe";
import type { TapeOff } from "@/lib/encounter-clock/smooth";

export const TIMELINE_VERSION = "timeline-v1";
export const ROW_MS = 30_000;
export const PRE_ANCHOR_MS = 60_000;
export const ANCHOR_CAP_MS = 45 * 60_000;
export const UNANCHORED_LEN_MS = 15 * 60_000;
export const UNANCHORED_STEP_MS = 10 * 60_000;
export const MAX_ROWS = 90;
export const MAX_CHARS = 20_000;
/** A run must be at least this long to be compressed into one range row. */
export const COMPRESS_MIN_RUN = 3;
/** The only free text in the state. Fixed; a test pins it. */
export const SETTING = "outpatient consultation room; one doctor; patients and companions come and go";

const LETTERS = "BCDEFGHIJKLMNOPQRSTUVWXYZ";

// ── inputs ────────────────────────────────────────────────────────────────────────────────────────────

/** One Nemotron turn, ms from the clip start (as stored, and as nemotronWindowPayload returns it). */
export type TimelineTurn = { start_ms: number; end_ms: number; speaker_idx: number };

/** One stored Nemotron row (status ok or empty) for a window. Its span is evidence even with no turns. */
export type TimelineWindow = {
  window_id: string;
  /** Wall-clock epoch ms of the clip's t=0 (bench_window.start_ms). */
  origin_ms: number;
  window_end_ms: number;
  turns: ReadonlyArray<TimelineTurn>;
};

export type SpeakerRole = "doc" | "other";

export type TimelineInput = {
  /** Start of acoustic probe 0 — scheduleProbes' day_start_ms. Rows sit on this grid. */
  grid_origin_ms: number;
  /** The gate's energy half per acoustic probe index; null or absent = not judged. */
  energy: ReadonlyArray<EnergyState | null>;
  tape_off: ReadonlyArray<TapeOff>;
  windows: ReadonlyArray<TimelineWindow>;
  /** The identity pass's answer for one speaker of one window, against this segment's anchor. Absent = "other". */
  role?: (window_id: string, speaker_idx: number, anchor: Anchor | null) => SpeakerRole;
};

// ── outputs ───────────────────────────────────────────────────────────────────────────────────────────

export type Sound = "active" | "quiet" | "dead_mic" | "tape_off" | "unjudged";

export type TimelineRow = {
  t: string;
  sound: Sound;
  speech_s: number | null;
  spk: Record<string, number> | null;
  turns: number | null;
  overlap_s: number | null;
  new_spk: string[];
};

/** A compressed run of identical silent rows. */
export type TimelineRangeRow = { t: string; sound: Sound; speech_s: 0 | null };

export type AnchorHeader = { start: string; end_click: string; end_weak: string; next_start: string; cap: string };

export type TimelineState = { setting: string; anchor: AnchorHeader | "none"; rows: Array<TimelineRow | TimelineRangeRow> };

/** SERVER-SIDE ONLY: where each state row sits on the wall clock and the acoustic grid. */
export type RowMeta = { t: string; start_ms: number; end_ms: number; probe_first: number | null; probe_last: number | null };

export type Segment = { anchor: Anchor | null; start_ms: number; end_ms: number };

export type BuiltSegment =
  | { ok: true; segment: Segment; state: TimelineState; meta: RowMeta[]; chars: number; compressed: boolean }
  | { ok: false; segment: Segment; reason: "too_large"; rows: number; chars: number };

// ── segments ──────────────────────────────────────────────────────────────────────────────────────────

type Span = { start_ms: number; end_ms: number };

function mergeSpans(spans: ReadonlyArray<Span>): Span[] {
  const sorted = spans.filter((s) => s.end_ms > s.start_ms).map((s) => ({ ...s })).sort((a, b) => a.start_ms - b.start_ms);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, s.end_ms);
    else out.push(s);
  }
  return out;
}

/**
 * PURE — the segments for one room-day. `anchors` are that room's (any order); `span` is the time to cover with
 * unanchored segments where no anchored one reaches. An anchor whose next Start is not after its own Start makes
 * an empty segment; it is dropped and counted.
 */
export function segmentsFor(anchors: ReadonlyArray<Anchor>, span: Span): { segments: Segment[]; dropped: number } {
  const sorted = [...anchors].sort((a, b) => a.start_ms - b.start_ms || (a.consult_key < b.consult_key ? -1 : a.consult_key > b.consult_key ? 1 : 0));
  const anchored: Segment[] = [];
  let dropped = 0;
  for (const a of sorted) {
    const cap = a.start_ms + ANCHOR_CAP_MS;
    const end = a.next_start_ms != null ? Math.min(a.next_start_ms, cap) : cap;
    if (!(end > a.start_ms)) { dropped++; continue; }
    anchored.push({ anchor: a, start_ms: a.start_ms - PRE_ANCHOR_MS, end_ms: end });
  }
  const unanchored: Segment[] = [];
  let cursor = span.start_ms;
  const gaps: Span[] = [];
  for (const c of mergeSpans(anchored)) {
    if (c.start_ms > cursor) gaps.push({ start_ms: cursor, end_ms: Math.min(c.start_ms, span.end_ms) });
    cursor = Math.max(cursor, c.end_ms);
  }
  if (span.end_ms > cursor) gaps.push({ start_ms: cursor, end_ms: span.end_ms });
  for (const g of gaps) {
    if (!(g.end_ms > g.start_ms)) continue;
    for (let s = g.start_ms; ; s += UNANCHORED_STEP_MS) {
      const e = Math.min(s + UNANCHORED_LEN_MS, g.end_ms);
      unanchored.push({ anchor: null, start_ms: s, end_ms: e });
      if (e >= g.end_ms) break;
    }
  }
  return { segments: [...anchored, ...unanchored].sort((a, b) => a.start_ms - b.start_ms || (a.anchor ? 0 : 1) - (b.anchor ? 0 : 1)), dropped };
}

// ── rows ──────────────────────────────────────────────────────────────────────────────────────────────

/** `t+mm:ss` / `t-mm:ss` for a signed offset already on the 30 s grid. */
export function relLabel(offset_ms: number): string {
  const sign = offset_ms < 0 ? "-" : "+";
  const total = Math.round(Math.abs(offset_ms) / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `t${sign}${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** A wall-clock instant as a header label: relative to the anchor START, rounded to the 30 s grid. */
const headerLabel = (ms: number | null, start_ms: number): string =>
  ms == null ? "none" : relLabel(Math.round((ms - start_ms) / ROW_MS) * ROW_MS);

/** The acoustic probe whose hop slot holds this row, or null before probe 0's slot. */
export function probeIndexOfRow(row_start_ms: number, grid_origin_ms: number): number | null {
  const hop = HOP_SECONDS * 1000;
  // probe i is centred at origin + i·hop + probe/2 and owns [centre − hop/2, centre + hop/2)
  const firstSlotStart = grid_origin_ms + (PROBE_SECONDS * 1000) / 2 - hop / 2;
  const i = Math.floor((row_start_ms - firstSlotStart) / hop);
  return i >= 0 ? i : null;
}

type Piece = { key: string; label?: string; start_ms: number; end_ms: number };

/** Measure of time where at least `min` of the (per-key merged) spans are active. */
function measureAtLeast(spans: ReadonlyArray<Span>, min: number): number {
  const ev: Array<[number, number]> = [];
  for (const s of spans) { ev.push([s.start_ms, 1]); ev.push([s.end_ms, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0, prev = 0, total = 0;
  for (const [x, d] of ev) {
    if (depth >= min) total += x - prev;
    depth += d;
    prev = x;
  }
  return total;
}

const sec = (ms: number) => Math.round(ms / 1000);

function soundOf(row: Span, input: TimelineInput): Sound {
  const mid = (row.start_ms + row.end_ms) / 2;
  if (input.tape_off.some((t) => mid >= t.start_ms && mid < t.end_ms)) return "tape_off";
  const p = probeIndexOfRow(row.start_ms, input.grid_origin_ms);
  const e = p == null ? null : input.energy[p] ?? null;
  return e === "active" || e === "quiet" || e === "dead_mic" ? e : "unjudged";
}

function isSilentRow(r: TimelineRow): boolean {
  return r.sound !== "active" && r.new_spk.length === 0 && (r.speech_s === null ? r.spk === null : r.speech_s === 0 && r.turns === 0);
}

/** Runs of ≥ COMPRESS_MIN_RUN identical silent rows become one range row. */
function compress(rows: TimelineRow[], meta: RowMeta[]): { rows: Array<TimelineRow | TimelineRangeRow>; meta: RowMeta[] } {
  const outRows: Array<TimelineRow | TimelineRangeRow> = [];
  const outMeta: RowMeta[] = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    if (isSilentRow(rows[i])) {
      while (j + 1 < rows.length && isSilentRow(rows[j + 1]) && rows[j + 1].sound === rows[i].sound && rows[j + 1].speech_s === rows[i].speech_s) j++;
    }
    if (j - i + 1 >= COMPRESS_MIN_RUN) {
      outRows.push({ t: `${rows[i].t}..${rows[j].t}`, sound: rows[i].sound, speech_s: rows[i].speech_s as 0 | null });
      outMeta.push({ t: `${rows[i].t}..${rows[j].t}`, start_ms: meta[i].start_ms, end_ms: meta[j].end_ms, probe_first: meta[i].probe_first, probe_last: meta[j].probe_last });
      i = j + 1;
    } else {
      outRows.push(rows[i]);
      outMeta.push(meta[i]);
      i++;
    }
  }
  return { rows: outRows, meta: outMeta };
}

/** PURE — one segment's Jev state and its server-side row map. */
export function buildSegment(segment: Segment, input: TimelineInput): BuiltSegment {
  const anchor = segment.anchor;
  const ref_ms = anchor ? anchor.start_ms : segment.start_ms;
  const first = input.grid_origin_ms + Math.floor((segment.start_ms - input.grid_origin_ms) / ROW_MS) * ROW_MS;
  const firstOffset = anchor ? Math.round((first - ref_ms) / ROW_MS) * ROW_MS : 0;

  const coverage = mergeSpans(input.windows.map((w) => ({ start_ms: w.origin_ms, end_ms: w.window_end_ms })));
  const covered = (a: number, b: number) => coverage.some((c) => c.start_ms <= a && c.end_ms >= b);

  const pieces: Piece[] = [];
  for (const w of input.windows) {
    for (const t of w.turns) {
      const start_ms = w.origin_ms + t.start_ms;
      const end_ms = w.origin_ms + t.end_ms;
      if (end_ms <= segment.start_ms || start_ms >= segment.end_ms || !(end_ms > start_ms)) continue;
      const doc = input.role?.(w.window_id, t.speaker_idx, anchor) === "doc";
      pieces.push({ key: doc ? "DOC" : `${w.window_id}#${t.speaker_idx}`, start_ms, end_ms });
    }
  }
  pieces.sort((a, b) => a.start_ms - b.start_ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const letters = new Map<string, string>();
  const labelOf = (key: string): string => {
    if (key === "DOC") return "DOC";
    let l = letters.get(key);
    if (!l) { l = letters.size < LETTERS.length ? LETTERS[letters.size] : "?"; letters.set(key, l); }
    return l;
  };
  const seenLabels = new Set<string>();

  const rows: TimelineRow[] = [];
  const meta: RowMeta[] = [];
  for (let k = 0, a = first; a < segment.end_ms; k++, a += ROW_MS) {
    const b = a + ROW_MS;
    const t = relLabel(firstOffset + k * ROW_MS);
    const probe = probeIndexOfRow(a, input.grid_origin_ms);
    meta.push({ t, start_ms: a, end_ms: b, probe_first: probe, probe_last: probe });
    const sound = soundOf({ start_ms: a, end_ms: b }, input);
    if (!covered(a, b)) {
      rows.push({ t, sound, speech_s: null, spk: null, turns: null, overlap_s: null, new_spk: [] });
      continue;
    }
    const inRow = pieces
      .filter((p) => p.end_ms > a && p.start_ms < b)
      .map((p) => ({ key: p.key, start_ms: Math.max(p.start_ms, a), end_ms: Math.min(p.end_ms, b) }));
    // per speaker key: merged spans, so one speaker's own overlapping turns never count as overlap
    const byKey = new Map<string, Span[]>();
    for (const p of inRow) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
    const merged = new Map<string, Span[]>();
    for (const [key, spans] of byKey) merged.set(key, mergeSpans(spans));
    // keys in order of first appearance in this row; a key speaking under half a second is not "present"
    const keys = [...merged.keys()]
      .filter((key) => merged.get(key)!.reduce((s, x) => s + x.end_ms - x.start_ms, 0) >= 500)
      .sort((x, y) => merged.get(x)![0].start_ms - merged.get(y)![0].start_ms || (x < y ? -1 : x > y ? 1 : 0));
    const perLabel = new Map<string, Span[]>();
    for (const key of keys) {
      const label = labelOf(key);
      perLabel.set(label, [...(perLabel.get(label) ?? []), ...merged.get(key)!]);
    }
    const spk: Record<string, number> = {};
    const new_spk: string[] = [];
    for (const [label, spans] of perLabel) {
      const s = sec(measureAtLeast(mergeSpans(spans), 1));
      if (s > 0) spk[label] = s;
      if (!seenLabels.has(label)) { seenLabels.add(label); new_spk.push(label); }
    }
    const allMerged = [...merged.values()].flat();
    rows.push({
      t,
      sound,
      speech_s: sec(measureAtLeast(allMerged, 1)),
      spk,
      turns: inRow.length,
      overlap_s: sec(measureAtLeast(allMerged, 2)),
      new_spk,
    });
  }

  const header: AnchorHeader | "none" = anchor
    ? {
        start: relLabel(0),
        end_click: headerLabel(anchor.end_click_ms, ref_ms),
        end_weak: headerLabel(anchor.end_weak_ms, ref_ms),
        next_start: headerLabel(anchor.next_start_ms, ref_ms),
        cap: relLabel(ANCHOR_CAP_MS),
      }
    : "none";

  let outRows: Array<TimelineRow | TimelineRangeRow> = rows;
  let outMeta = meta;
  let compressed = false;
  if (rows.length > MAX_ROWS) {
    ({ rows: outRows, meta: outMeta } = compress(rows, meta));
    compressed = true;
  }
  const state: TimelineState = { setting: SETTING, anchor: header, rows: outRows };
  const text = JSON.stringify(state);
  if (outRows.length > MAX_ROWS || text.length > MAX_CHARS) {
    return { ok: false, segment, reason: "too_large", rows: outRows.length, chars: text.length };
  }
  const bad = checkTimelineGrammar(text);
  if (bad.length) throw new Error(`timeline state failed its own grammar: ${bad[0]}`);
  return { ok: true, segment, state, meta: outMeta, chars: text.length, compressed };
}

/** PURE — every segment of one room-day, built. */
export function buildTimeline(anchors: ReadonlyArray<Anchor>, span: Span, input: TimelineInput): { built: BuiltSegment[]; dropped: number } {
  const { segments, dropped } = segmentsFor(anchors, span);
  return { built: segments.map((s) => buildSegment(s, input)), dropped };
}

// ── the allowlist grammar ─────────────────────────────────────────────────────────────────────────────

const T_RE = /^t[+-]\d{2,4}:[0-5]\d$/;
const T_RANGE_RE = /^t[+-]\d{2,4}:[0-5]\d\.\.t[+-]\d{2,4}:[0-5]\d$/;
const LABEL_RE = /^(DOC|[B-Z]|\?)$/;
const SOUNDS: ReadonlySet<string> = new Set(["active", "quiet", "dead_mic", "tape_off", "unjudged"]);
const ROW_KEYS = ["new_spk", "overlap_s", "sound", "speech_s", "spk", "t", "turns"].join(",");
const RANGE_KEYS = ["sound", "speech_s", "t"].join(",");
const HEADER_KEYS = ["anchor", "rows", "setting"].join(",");
const ANCHOR_KEYS = ["cap", "end_click", "end_weak", "next_start", "start"].join(",");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort().join(",");
const smallInt = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const nullOr = (v: unknown, ok: (x: unknown) => boolean) => v === null || ok(v);

/**
 * PURE — the allowlist. Returns the violations (empty = the serialized state is allowed). Every key must be one of
 * the known keys and every value must match its pattern; anything else — a clock time, a date, an id, a name, a room,
 * free text — fails because it matches no pattern, not because a blocklist caught it.
 */
export function checkTimelineGrammar(serialized: string): string[] {
  const bad: string[] = [];
  let s: unknown;
  try { s = JSON.parse(serialized); } catch { return ["not json"]; }
  if (!isObj(s) || keysOf(s) !== HEADER_KEYS) return ["state keys"];
  if (s.setting !== SETTING) bad.push("setting");
  if (s.anchor !== "none") {
    if (!isObj(s.anchor) || keysOf(s.anchor) !== ANCHOR_KEYS) bad.push("anchor keys");
    else for (const [k, v] of Object.entries(s.anchor)) if (!(typeof v === "string" && (T_RE.test(v) || (k !== "start" && k !== "cap" && v === "none")))) bad.push(`anchor.${k}`);
  }
  if (!Array.isArray(s.rows)) return [...bad, "rows"];
  s.rows.forEach((r: unknown, i: number) => {
    if (!isObj(r)) { bad.push(`row ${i}`); return; }
    const keys = keysOf(r);
    if (!SOUNDS.has(r.sound as string)) bad.push(`row ${i} sound`);
    if (keys === RANGE_KEYS) {
      if (!(typeof r.t === "string" && T_RANGE_RE.test(r.t))) bad.push(`row ${i} t`);
      if (!(r.speech_s === 0 || r.speech_s === null)) bad.push(`row ${i} speech_s`);
      return;
    }
    if (keys !== ROW_KEYS) { bad.push(`row ${i} keys`); return; }
    if (!(typeof r.t === "string" && T_RE.test(r.t))) bad.push(`row ${i} t`);
    if (!nullOr(r.speech_s, (v) => smallInt(v, 30))) bad.push(`row ${i} speech_s`);
    if (!nullOr(r.overlap_s, (v) => smallInt(v, 30))) bad.push(`row ${i} overlap_s`);
    if (!nullOr(r.turns, (v) => smallInt(v, 999))) bad.push(`row ${i} turns`);
    if (r.spk !== null) {
      if (!isObj(r.spk)) bad.push(`row ${i} spk`);
      else for (const [k, v] of Object.entries(r.spk)) if (!LABEL_RE.test(k) || !smallInt(v, 30)) bad.push(`row ${i} spk`);
    }
    if (!Array.isArray(r.new_spk) || !r.new_spk.every((l) => typeof l === "string" && LABEL_RE.test(l))) bad.push(`row ${i} new_spk`);
  });
  return bad;
}
