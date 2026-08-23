/**
 * lib/stt/subject.ts — what a transcription_run belongs to (K4a Part C).
 *
 * Until 0058 a run belonged to an encounter and nothing else, so every reader in the STT lab
 * started `FROM encounter e JOIN transcription_run`. That shape cannot express a bench_window,
 * and worse, it silently DROPS one: an inner join from encounter to runs makes a run with no
 * encounter invisible rather than wrong, which is the failure mode nobody notices.
 *
 * The readers now start from transcription_run and LEFT JOIN outwards. This module holds the
 * one thing they all need afterwards: given a row that may or may not have an encounter, say
 * what the subject IS, in words a person can read.
 *
 * ─── WHY THE KIND IS ALWAYS SHOWN (C2) ────────────────────────────────────────────────────
 * A run list that mixes encounters and bench windows without labelling them is a trap. Every
 * per-run number means something different between the two: an encounter is one consultation
 * with a patient label, a bench window is fifteen minutes of a room with no patient at all.
 * Comparing their WERs without knowing which is which is not a comparison, and a leaderboard
 * that quietly averaged the two would be wrong in a way that looks like data.
 */

export const SUBJECT_TYPES = ["encounter", "bench_window"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const isSubjectType = (v: unknown): v is SubjectType =>
  typeof v === "string" && (SUBJECT_TYPES as readonly string[]).includes(v);

/** Short word for the kind, for a chip or a column. Never blank. */
export function subjectKindLabel(t: unknown): string {
  return t === "bench_window" ? "room window" : t === "encounter" ? "encounter" : "unknown";
}

export type SubjectRowish = {
  subject_type?: unknown;
  subject_id?: unknown;
  /** encounter-sourced, NULL for a bench_window subject */
  patient_label_raw?: unknown;
  /** bench_window-sourced, NULL for an encounter subject */
  window_start_ms?: unknown;
  window_end_ms?: unknown;
  window_source_mic?: unknown;
  window_session_id?: unknown;
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istClock = (msVal: number): string =>
  new Date(msVal + IST_OFFSET_MS).toISOString().slice(11, 16);

/**
 * A human name for the subject, whichever kind it is.
 *
 * C1 — an encounter field is NULL on a bench_window row, and this never renders that NULL. It
 * does not fall through to "undefined" or "null": a window names its clock and its microphone,
 * which is the only identifying thing a room window has.
 */
export function subjectLabel(row: SubjectRowish): string {
  const id = typeof row.subject_id === "string" ? row.subject_id : "";
  if (row.subject_type === "bench_window") {
    const s = Number(row.window_start_ms);
    const e = Number(row.window_end_ms);
    const mic = typeof row.window_source_mic === "string" ? row.window_source_mic : null;
    if (Number.isFinite(s) && Number.isFinite(e)) {
      return `${istClock(s)}–${istClock(e)} IST${mic && mic !== "primary" ? ` · ${mic} mic` : ""}`;
    }
    return id || "room window";
  }
  const label = typeof row.patient_label_raw === "string" && row.patient_label_raw.trim().length > 0
    ? row.patient_label_raw
    : null;
  return label ?? id ?? "encounter";
}

/** The subject block every reader returns, so the six of them agree on one shape. */
export function subjectOf(row: SubjectRowish): {
  type: string;
  id: string | null;
  kind_label: string;
  label: string;
} {
  return {
    type: typeof row.subject_type === "string" ? row.subject_type : "encounter",
    id: typeof row.subject_id === "string" ? row.subject_id : null,
    kind_label: subjectKindLabel(row.subject_type),
    label: subjectLabel(row),
  };
}
