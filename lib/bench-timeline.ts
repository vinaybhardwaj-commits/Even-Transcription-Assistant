/**
 * lib/bench-timeline.ts — Bench timeline.md (Ambient Brain Kickoff D, decisions D1–D5).
 *
 * v0 is DETERMINISTIC (D3): a stitch of bench_event consult marks (session-scoped, kind
 * 'consult_mark') and the brain's `visit` rows for the room's room_day on the session's IST
 * date, sorted by time. No Gemini, no LLM, no new deps. Generated on every download (D1);
 * nothing is stored.
 *
 * Trust order when the two disagree (D5): marks first, brain rows second — at equal
 * timestamps a mark sorts before a visit line. Never invents individual_uid or names: the
 * file carries no identity at all (admin-only surface, but still).
 *
 * Reads:
 *   - marks     → app DB (APP_DATABASE_URL, lib/db `sql`) via lib/bench listBenchConsultMarks
 *   - visits    → BRAIN DB (BRAIN_DATABASE_URL, lib/brain/db WebSocket pool) via the brain's
 *                 own read helpers (findRoomDay + SQL_VISITS_FOR_DAY / SQL_CLUSTERS_FOR_DAY,
 *                 already prod-validated in Kickoff A2). Same Neon database, different role
 *                 (decision B8) — the app role is not assumed to have grants on brain tables.
 *
 * K-B (R9): bench_event mic_* rows render as "(mic)" lines — "main mic lost · on backup
 * mic", "main mic back …" — so timeline.md tells the mic story of the day.
 *
 * Degradation (D4 + rules): no visits → "*picture not run*"; no marks → "*no consult marks*";
 * brain unreachable / not configured → marks-only + "*picture unavailable*"; marks query
 * failing → visits-only + "*consult marks unavailable*". A day with nothing still yields a
 * valid file that says so. `renderBenchTimeline` never throws.
 */

import { findBenchSession, listBenchConsultMarks, listBenchEvents, type BenchSessionRow } from "@/lib/bench";
import { query } from "@/lib/brain/db";
import { findRoomDay, istDate, SQL_CLUSTERS_FOR_DAY, SQL_VISITS_FOR_DAY } from "@/lib/brain/state";

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

export type TimelineMark = { at: Date };

/** K-B (R9): the mic story — bench_event kinds mic_primary_lost / restored / mic_backup_*. */
export type TimelineMicEvent = { at: Date; kind: string; reason?: string | null };

export type TimelineVisit = {
  id: string;
  state: string; // called | in_chair | at_diagnostics | ended | unknown
  /** line time: pstart_at for `called` when present, else updated_at */
  at: Date;
  confidence: number | null;
  end_reason: string | null;
  /** evidence label where derivable: pqm (pstart_at present) | voice (cluster attached) */
  evidence: "pqm" | "voice" | null;
};

export type TimelineInput = {
  session: Pick<BenchSessionRow, "id" | "room_name" | "started_at">;
  marks: TimelineMark[] | "unavailable";
  visits: TimelineVisit[] | "unavailable";
  /** K-B: optional; omitted/empty = no mic events that day */
  mic_events?: TimelineMicEvent[];
};

const MIC_LABEL: Record<string, string> = {
  mic_primary_lost: "main mic lost · on backup mic",
  mic_primary_restored: "main mic back · recording on it again",
  mic_backup_unavailable: "no backup mic",
  mic_backup_error: "backup mic error · retrying",
  mic_backup_restored: "backup mic back",
  // Remount resume FU1b: the reload gap must be visible where the day is read.
  kiosk_remount_resumed: "rejoined after reload",
};

const IST_HM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
});
const IST_LONG_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export const fmtIstHm = (d: Date): string => IST_HM.format(d);
export const fmtIstLongDate = (d: Date): string => IST_LONG_DATE.format(d);

const STATE_LABEL: Record<string, string> = {
  called: "called",
  in_chair: "in chair",
  at_diagnostics: "at diagnostics",
  ended: "ended",
  unknown: "unsure",
};

type Line = { at: number; rank: 0 | 1; text: string };

function visitLine(v: TimelineVisit): Line {
  const label = STATE_LABEL[v.state] ?? "unsure";
  const bits: string[] = [label];
  if (v.state === "unknown") {
    if (v.end_reason) bits.push(v.end_reason);
  } else if (v.state === "ended") {
    if (v.end_reason) bits.push(v.end_reason);
  } else if (v.confidence !== null && Number.isFinite(v.confidence)) {
    bits.push(`confidence ${v.confidence.toFixed(2)}`);
  }
  const body = bits.join(" · ");
  const ev = v.evidence ? ` (${v.evidence})` : "";
  return { at: v.at.getTime(), rank: 1, text: `- ${fmtIstHm(v.at)}  ${body}${ev}` };
}

/** Pure: input → markdown. Never throws on well-typed input. */
export function buildBenchTimeline(input: TimelineInput): string {
  const started = new Date(input.session.started_at);
  const out: string[] = [];
  out.push(`# ${input.session.room_name} · ${fmtIstLongDate(started)}`);
  out.push(`Tape: ${input.session.id}`);
  out.push("");

  const lines: Line[] = [];
  if (input.marks !== "unavailable") {
    for (const m of input.marks) {
      lines.push({ at: m.at.getTime(), rank: 0, text: `- ${fmtIstHm(m.at)}  consult marked (mark)` });
    }
  }
  if (input.visits !== "unavailable") {
    for (const v of input.visits) lines.push(visitLine(v));
  }
  for (const e of input.mic_events ?? []) {
    const label = MIC_LABEL[e.kind] ?? e.kind;
    const reason = e.reason ? ` · ${e.reason}` : "";
    const tag = e.kind.startsWith("mic_") ? "mic" : "kiosk";
    lines.push({ at: e.at.getTime(), rank: 0, text: `- ${fmtIstHm(e.at)}  ${label}${reason} (${tag})` });
  }
  // D5: stable sort by time; a mark outranks a brain row at the same instant.
  lines.sort((a, b) => a.at - b.at || a.rank - b.rank);
  for (const l of lines) out.push(l.text);
  if (lines.length > 0) out.push("");

  const notes: string[] = [];
  if (input.marks === "unavailable") notes.push("*consult marks unavailable*");
  else if (input.marks.length === 0) notes.push("*no consult marks*");
  if (input.visits === "unavailable") notes.push("*picture unavailable*");
  else if (input.visits.length === 0) notes.push("*picture not run*");
  for (const n of notes) out.push(n);

  return out.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Data assembly (fail-soft per source)
// ---------------------------------------------------------------------------

type VisitRow = {
  id: string;
  individual_uid: string | null;
  consult_uid: string | null;
  state: string;
  pstart_at: Date | string | null;
  confidence: number | null;
  end_reason: string | null;
  updated_at: Date | string;
};
type ClusterRow = { id: string; kind: string; visit_id: string | null };

/** Brain visits for the room's room_day on the session's IST date. Throws on brain error. */
async function loadBrainVisits(roomId: string, sessionStartedAt: Date): Promise<TimelineVisit[]> {
  const day = await findRoomDay(roomId, istDate(sessionStartedAt));
  if (!day) return [];
  const [visits, clusters] = await Promise.all([
    query<VisitRow>(SQL_VISITS_FOR_DAY, [day.id]),
    query<ClusterRow>(SQL_CLUSTERS_FOR_DAY, [day.id]),
  ]);
  const withVoice = new Set(clusters.rows.map((c) => c.visit_id).filter((x): x is string => !!x));
  return visits.rows.map((v) => {
    const updated = new Date(v.updated_at);
    const pstart = v.pstart_at ? new Date(v.pstart_at) : null;
    const at = v.state === "called" && pstart && !Number.isNaN(pstart.getTime()) ? pstart : updated;
    const evidence: TimelineVisit["evidence"] = pstart ? "pqm" : withVoice.has(v.id) ? "voice" : null;
    return {
      id: v.id,
      state: v.state,
      at,
      confidence: v.confidence === null || v.confidence === undefined ? null : Number(v.confidence),
      end_reason: v.end_reason ?? null,
      evidence,
    };
  });
}

/**
 * Session id → markdown. NEVER throws: each source degrades independently, and a total
 * failure still returns a header + "*timeline unavailable*".
 */
export async function renderBenchTimeline(
  sessionId: string,
  presetSession?: BenchSessionRow | null,
): Promise<{ markdown: string; session: BenchSessionRow | null }> {
  let session: BenchSessionRow | null = presetSession ?? null;
  try {
    if (!session) session = await findBenchSession(sessionId);
  } catch {
    session = null;
  }
  if (!session) {
    return {
      markdown: `# Bench session · ${sessionId}\nTape: ${sessionId}\n\n*timeline unavailable*\n`,
      session: null,
    };
  }

  const startedAt = new Date(session.started_at);

  let marks: TimelineInput["marks"];
  try {
    marks = (await listBenchConsultMarks(session.id)).map((m) => ({ at: new Date(m.at) }));
  } catch (e) {
    console.warn("[bench-timeline] marks query failed", String((e as Error)?.message ?? e).slice(0, 200));
    marks = "unavailable";
  }

  // K-B: the mic story (fail-soft — a missing story is just an empty list).
  // FU1b: kiosk_remount_resumed renders too, its silence length as the reason text.
  let micEvents: TimelineMicEvent[] = [];
  try {
    micEvents = (await listBenchEvents(session.id))
      .filter((e) => e.kind.startsWith("mic_") || e.kind === "kiosk_remount_resumed")
      .map((e) => {
        const p = (typeof e.payload === "object" && e.payload !== null ? e.payload : {}) as {
          reason?: unknown;
          silence_seconds?: unknown;
        };
        const reason =
          e.kind === "kiosk_remount_resumed"
            ? typeof p.silence_seconds === "number" && Number.isFinite(p.silence_seconds)
              ? `${Math.max(0, Math.round(p.silence_seconds))} s silence`
              : null
            : typeof p.reason === "string"
              ? p.reason
              : null;
        return { at: new Date(e.at), kind: e.kind, reason };
      });
  } catch (e) {
    console.warn("[bench-timeline] mic events query failed", String((e as Error)?.message ?? e).slice(0, 200));
    micEvents = [];
  }

  let visits: TimelineInput["visits"];
  try {
    visits = await loadBrainVisits(session.room_id, startedAt);
  } catch (e) {
    // BrainConfigError (BRAIN_DATABASE_URL unset), WS unavailable, or a query error.
    console.warn("[bench-timeline] brain read failed", String((e as Error)?.message ?? e).slice(0, 200));
    visits = "unavailable";
  }

  try {
    return { markdown: buildBenchTimeline({ session, marks, visits, mic_events: micEvents }), session };
  } catch (e) {
    console.warn("[bench-timeline] render failed", String((e as Error)?.message ?? e).slice(0, 200));
    return {
      markdown: `# ${session.room_name} · ${fmtIstLongDate(startedAt)}\nTape: ${session.id}\n\n*timeline unavailable*\n`,
      session,
    };
  }
}
