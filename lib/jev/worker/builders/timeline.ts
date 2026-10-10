/**
 * lib/jev/worker/builders/timeline.ts — `timeline-v1` for the timeline sets (u10-timeline v2, encounter-end): the #29 segment state with the End clicks MASKED and the
 * candidate rows chosen in code (PRD §4, P2.2). The state holds no text by design (this lane runs before STT).
 *
 * SUBJECT  `tl_<room_day_id>_<anchor_start_ms>` (the PR #34 storage id). The builder loads the room-day's Nemotron evidence and anchors, builds the anchored segment with
 * lib/encounter-clock/timeline.ts, then:
 *   MASK     anchor.end_click and anchor.end_weak become "none": Jev never sees the clicks (they stay in fusion code, rank 1), otherwise its end on a
 *            clicked consult is circular.
 *   CANDIDATES  at most 12 rows, deterministic (below), as `candidates: [{key: "cand_01", row: "t+mm:ss"}, ...]`; the question's options are the fixed keys
 *            cand_01..cand_12. `resolve` maps an answer back to its row for a bench report.
 * An over-size segment is a `tooLarge` (a typed row, no call); a segment with no anchor or evidence is `null` (no opinion).
 */
import { sql } from "@/lib/db";
import { loadAnchors, type Anchor } from "@/lib/encounter-clock/anchors";
import { energyHalf, levelSamplesIn } from "@/lib/encounter-clock/gate";
import { scheduleProbes } from "@/lib/encounter-clock/probe";
import { buildSegment, segmentsFor, type BuiltSegment, type TimelineInput, type TimelineRangeRow, type TimelineRow, type TimelineState } from "@/lib/encounter-clock/timeline";
import { roleFor } from "@/lib/encounter-clock/shadow-v3";
import { loadTimelineEvidence, type TimelineEvidence } from "@/lib/room-access/encounter-timeline-io";
import type { StateBuild } from "../uses";

export const TIMELINE_STATE_VERSION = "timeline-v1+cand-v1";
export const MAX_CANDIDATES = 12;
const KEYS = Array.from({ length: MAX_CANDIDATES }, (_, i) => `cand_${String(i + 1).padStart(2, "0")}`);
type Row = TimelineRow | TimelineRangeRow;
const speechOf = (r: Row): number | null => r.speech_s;
const hasDoc = (r: Row): boolean => "spk" in r && r.spk !== null && Object.prototype.hasOwnProperty.call(r.spk, "DOC");
/** The seconds of a `t+mm:ss` label (a range row's start). */
const secOf = (t: string): number => { const m = /^t([+-])(\d{2,}):(\d{2})/.exec(t); return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0; };

/**
 * PURE. The candidate rows (indices into `rows`), chronological, at most MAX_CANDIDATES (PRD §4):
 *  1 the last row holding any non-DOC letter first heard in the first 5 minutes;  2 each row where speech goes from active to 0 for 2+ rows;
 *  3 the row before any new_spk that follows 60 s+ of quiet;  4 the row before next_start;  5 the last DOC row.  Then dedupe and pad with +-1
 *  neighbours up to the cap. (Rule 6, the row before an `edge` reset, waits for the `edge` row field, which timeline-v1 does not carry.)
 */
export function candidateRows(rows: ReadonlyArray<Row>, nextStart: string | null): number[] {
  const pick = new Set<number>();
  const n = rows.length;
  if (n === 0) return [];
  // 1
  const early = new Set<string>();
  rows.forEach((r) => { if ("new_spk" in r && secOf(r.t) <= 300) r.new_spk.forEach((l) => { if (l !== "DOC") early.add(l); }); });
  let last1 = -1;
  rows.forEach((r, i) => { if ("spk" in r && r.spk && Object.keys(r.spk).some((l) => early.has(l))) last1 = i; });
  if (last1 >= 0) pick.add(last1);
  // 2
  for (let i = 0; i < n; i += 1) {
    const active = (speechOf(rows[i]!) ?? 0) > 0;
    if (!active) continue;
    const a = speechOf(rows[i + 1] ?? ({ speech_s: null } as Row)), b = speechOf(rows[i + 2] ?? ({ speech_s: null } as Row));
    if (a === 0 && b === 0) pick.add(i);
  }
  // 3
  rows.forEach((r, i) => {
    if (i < 2 || !("new_spk" in r) || r.new_spk.length === 0) return;
    if (speechOf(rows[i - 1]!) === 0 && speechOf(rows[i - 2]!) === 0) pick.add(i - 1);
  });
  // 4
  if (nextStart && nextStart !== "none") {
    const at = secOf(nextStart);
    let idx = -1;
    rows.forEach((r, i) => { if (secOf(r.t) < at) idx = i; });
    if (idx >= 0) pick.add(idx);
  } else pick.add(n - 1);
  // 5
  let lastDoc = -1;
  rows.forEach((r, i) => { if (hasDoc(r)) lastDoc = i; });
  if (lastDoc >= 0) pick.add(lastDoc);
  // pad with +-1 neighbours, nearest first, up to the cap
  const chosen = [...pick].sort((a, b) => a - b);
  for (const base of [...chosen]) {
    for (const d of [-1, 1]) {
      const j = base + d;
      if (chosen.length < MAX_CANDIDATES && j >= 0 && j < n && !pick.has(j)) { pick.add(j); chosen.push(j); }
    }
  }
  return [...pick].sort((a, b) => a - b).slice(0, MAX_CANDIDATES);
}

export type TimelineJevState = { setting: string; anchor: { start: string; end_click: "none"; end_weak: "none"; next_start: string; cap: string } | "none"; rows: Row[]; candidates: Array<{ key: string; row: string }> };

/** PURE. A built anchored segment as the state Jev reads, plus the evidence ids and the cand-key -> row map. */
export function timelineJevState(built: Extract<BuiltSegment, { ok: true }>, subjectId: string): Extract<StateBuild, { state: unknown }> {
  const st: TimelineState = built.state;
  const rows = st.rows;
  const idx = candidateRows(rows, st.anchor === "none" ? null : st.anchor.next_start);
  const candidates = idx.map((ri, k) => ({ key: KEYS[k]!, row: rows[ri]!.t }));
  const anchor = st.anchor === "none" ? "none" : { start: st.anchor.start, end_click: "none" as const, end_weak: "none" as const, next_start: st.anchor.next_start, cap: st.anchor.cap };
  const state: TimelineJevState = { setting: st.setting, anchor, rows, candidates };
  return {
    state, lane: "timeline",
    evidence: { segment: subjectId, state_version: TIMELINE_STATE_VERSION, rows: rows.length, candidates: Object.fromEntries(candidates.map((c) => [c.key, c.row])), compressed: built.compressed },
  };
}

/** PURE. A bench answer (`cand_03`) back to its row label; any other option key is its own label. */
export function resolveTimelineAnswer(_questionId: string, value: string, evidence: Record<string, unknown>): string {
  const map = evidence.candidates as Record<string, string> | undefined;
  return map && Object.prototype.hasOwnProperty.call(map, value) ? map[value]! : value;
}

export const SUBJECT_RE = /^tl_([A-Za-z0-9_-]{1,80})_(\d{10,14})$/;

export type TimelineDeps = {
  roomOf: (roomDayId: string) => Promise<{ room_id: string; ist_date: string } | null>;
  evidence: typeof loadTimelineEvidence;
  anchors: (roomId: string, istDate: string) => Promise<Anchor[] | null>;
};
export const defaultTimelineDeps: TimelineDeps = {
  roomOf: async (id) => {
    const r = (await sql`SELECT room_id, ist_date::text AS ist_date FROM room_day WHERE id = ${id}`) as Array<{ room_id: string; ist_date: string }>;
    return r[0] ?? null;
  },
  evidence: loadTimelineEvidence,
  anchors: async (roomId, istDate) => {
    const got = await loadAnchors(sql as never, roomId, istDate);
    return "refused" in got ? null : got.anchors;
  },
};

/** The I/O wrapper: subject id -> state. null = no opinion (no room-day, no anchor, no recorded audio). */
export async function buildTimelineState(subjectId: string, deps: TimelineDeps = defaultTimelineDeps, now = new Date()): Promise<StateBuild | null> {
  const m = SUBJECT_RE.exec(subjectId);
  if (!m) return null;
  const [, roomDayId, startStr] = m;
  const room = await deps.roomOf(roomDayId!);
  if (!room) return null;
  const ev: TimelineEvidence | null = await deps.evidence(room.room_id, roomDayId!, room.ist_date, now);
  if (!ev) return null;
  const anchors = await deps.anchors(room.room_id, room.ist_date);
  const anchor = anchors?.find((a) => String(a.start_ms) === startStr);
  if (!anchor) return null;
  const probes = scheduleProbes({ day_start_ms: ev.day_start_ms, day_end_ms: ev.day_end_ms, level_samples: ev.level_samples });
  const energy = probes.map((p) => energyHalf(levelSamplesIn(ev.level_samples, p.start_ms, p.end_ms) ? { kind: "levels" as const, samples: levelSamplesIn(ev.level_samples, p.start_ms, p.end_ms)! } : null).state);
  const input: TimelineInput = { grid_origin_ms: ev.day_start_ms, energy, tape_off: ev.tape_off, windows: ev.windows, role: roleFor(ev) };
  const seg = segmentsFor(anchors!, { start_ms: ev.day_start_ms, end_ms: ev.day_end_ms }).segments.find((s) => s.anchor?.start_ms === anchor.start_ms);
  if (!seg) return null;
  const built = buildSegment(seg, input);
  if (!built.ok) return { tooLarge: true, bytes: built.chars };
  return timelineJevState(built, subjectId);
}
