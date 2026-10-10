/**
 * lib/voice-room-print/recurring.ts — PURE. Find the one voice that recurs across a Pulse doctor's windows.
 *
 * WHY THIS WORKS WITHOUT A ROSTER. Every window offered here lies inside consults that Pulse says belong to ONE
 * doctor. Patients change from consult to consult; the doctor does not. So the doctor is the voice that comes back
 * in window after window, on day after day. Nothing here needs to know who the doctor is in ETA's own tables: the
 * print is keyed by the Pulse doctor uid that labelled the windows.
 *
 * REFUSE RATHER THAN GUESS. A print is returned only when the recurring voice
 *   - joins at least MIN_WINDOWS windows on at least MIN_DAYS IST days,
 *   - is present in at least MIN_SUPPORT of the windows offered, and
 *   - is clearly ahead of the next recurring voice (a nurse who sits in every consult recurs too): the runner-up's
 *     window count must stay under AMBIGUITY_RATIO of the winner's.
 * Anything else is a refusal with its reason and counts, so "no print" is always explained.
 *
 * All thresholds are PROVISIONAL starting points (no bake-off yet). Room-to-room cosine for one speaker on one
 * microphone runs far higher than room-to-enrolment, which is why SAME_VOICE sits above the 0.37 best a room
 * speaker reached against a phone-enrolled voice_print (OPD 7, 10 Oct), and below the 0.65 the matcher uses.
 *
 * Biometric data: callers must never log an embedding. This module returns one; it logs nothing.
 */
import { cosine } from "@/lib/stt/losing-score";

/** Two room embeddings at or above this are taken as the same voice. PROVISIONAL. */
export const SAME_VOICE = 0.55;
/** A speaker with less speech than this in its window is not offered (too short for a stable embedding). */
export const MIN_SPEECH_MS = 3_000;
export const MIN_WINDOWS = 4;
export const MIN_DAYS = 2;
/** Share of the offered windows the voice must be heard in. */
export const MIN_SUPPORT = 0.5;
/** The runner-up voice may join at most this share of the winner's window count. */
export const AMBIGUITY_RATIO = 0.7;

export type UnitSpeaker = { label: string; speech_ms: number; embedding: Float32Array };
/** One Nemotron window: its id, its IST day, and one embedding per speaker. */
export type Unit = { window_id: string; day: string; speakers: ReadonlyArray<UnitSpeaker> };

export type Member = { window_id: string; label: string; cosine: number };

export type RecurringResult =
  | {
      ok: true;
      centroid: Float32Array;
      members: Member[];
      n_windows: number;
      n_days: number;
      support: number;
      runner_up_windows: number;
      windows_offered: number;
    }
  | {
      ok: false;
      reason: "too_few_windows" | "no_recurring_voice" | "too_few_days" | "low_support" | "ambiguous_recurring_voice";
      windows_offered: number;
      n_windows: number;
      n_days: number;
      runner_up_windows: number;
    };

type Cand = { unit: number; label: string; speech_ms: number; v: Float32Array };

const normalise = (v: Float32Array): Float32Array => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (!(n > 0)) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
};

function mean(vs: ReadonlyArray<Float32Array>): Float32Array {
  const out = new Float32Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i]! += v[i]!;
  return normalise(out);
}

/** In each unit, the candidate closest to `target` if it reaches SAME_VOICE. At most one per unit. */
function nearestPerUnit(target: Float32Array, cands: ReadonlyArray<Cand>, units: number): Array<{ c: Cand; cos: number }> {
  const best: Array<{ c: Cand; cos: number } | undefined> = new Array(units);
  for (const c of cands) {
    const cos = cosine(target, c.v);
    if (cos < SAME_VOICE) continue;
    const cur = best[c.unit];
    if (!cur || cos > cur.cos) best[c.unit] = { c, cos };
  }
  return best.filter((x): x is { c: Cand; cos: number } => !!x);
}

/** The candidate heard in the most other units; ties go to more speech, then to the earlier window and label. */
function bestSeed(cands: ReadonlyArray<Cand>, units: number, order: ReadonlyArray<Unit>): { seed: Cand; windows: number } | null {
  const key = (c: Cand) => `${order[c.unit]!.window_id}\u0000${c.label}`;
  let top: { seed: Cand; windows: number } | null = null;
  for (const c of cands) {
    const windows = nearestPerUnit(c.v, cands, units).length;
    const better = !top
      || windows > top.windows
      || (windows === top.windows && (c.speech_ms > top.seed.speech_ms
        || (c.speech_ms === top.seed.speech_ms && key(c) < key(top.seed))));
    if (better) top = { seed: c, windows };
  }
  return top;
}

/** The voice's members: seed, one refinement against their mean, final mean. */
function grow(seed: Cand, cands: ReadonlyArray<Cand>, units: number): { centroid: Float32Array; members: Array<{ c: Cand; cos: number }> } {
  const first = nearestPerUnit(seed.v, cands, units);
  const centre = mean(first.map((m) => m.c.v));
  const members = nearestPerUnit(centre, cands, units);
  return { centroid: members.length > 0 ? mean(members.map((m) => m.c.v)) : centre, members };
}

export function recurringVoice(units: ReadonlyArray<Unit>): RecurringResult {
  const windowsOffered = units.length;
  const refuse = (reason: Extract<RecurringResult, { ok: false }>["reason"], nWindows = 0, nDays = 0, runnerUp = 0): RecurringResult =>
    ({ ok: false, reason, windows_offered: windowsOffered, n_windows: nWindows, n_days: nDays, runner_up_windows: runnerUp });

  if (windowsOffered < MIN_WINDOWS) return refuse("too_few_windows");
  const cands: Cand[] = [];
  units.forEach((u, i) => {
    for (const s of u.speakers) {
      if (s.speech_ms < MIN_SPEECH_MS || s.embedding.length === 0) continue;
      cands.push({ unit: i, label: s.label, speech_ms: s.speech_ms, v: normalise(s.embedding) });
    }
  });
  const seed = bestSeed(cands, units.length, units);
  if (!seed || seed.windows < 2) return refuse("no_recurring_voice");

  const { centroid, members } = grow(seed.seed, cands, units.length);
  const memberWindows = new Set(members.map((m) => m.c.unit));
  const days = new Set(members.map((m) => units[m.c.unit]!.day));

  // the runner-up: the best recurring voice among what is left once the winner's voice is taken out
  const rest = cands.filter((c) => cosine(centroid, c.v) < SAME_VOICE);
  const second = bestSeed(rest, units.length, units);
  const runnerUp = second && second.windows >= 2 ? grow(second.seed, rest, units.length).members.length : 0;

  const n = memberWindows.size;
  if (n < MIN_WINDOWS) return refuse("too_few_windows", n, days.size, runnerUp);
  if (days.size < MIN_DAYS) return refuse("too_few_days", n, days.size, runnerUp);
  if (n / windowsOffered < MIN_SUPPORT) return refuse("low_support", n, days.size, runnerUp);
  if (runnerUp >= AMBIGUITY_RATIO * n) return refuse("ambiguous_recurring_voice", n, days.size, runnerUp);

  return {
    ok: true,
    centroid,
    members: members
      .map((m) => ({ window_id: units[m.c.unit]!.window_id, label: m.c.label, cosine: m.cos }))
      .sort((a, b) => (a.window_id < b.window_id ? -1 : a.window_id > b.window_id ? 1 : 0)),
    n_windows: n,
    n_days: days.size,
    support: n / windowsOffered,
    runner_up_windows: runnerUp,
    windows_offered: windowsOffered,
  };
}

/** The closest existing clinician voiceprint to a learned print: a SUGGESTION for a human, never a link. */
export function nearestClinician(
  print: Float32Array,
  prints: ReadonlyArray<{ clinician_id: string; v: Float32Array }>,
): { clinician_id: string; score: number } | null {
  let best: { clinician_id: string; score: number } | null = null;
  for (const p of prints) {
    if (p.v.length !== print.length) continue;
    const score = cosine(print, p.v);
    if (!best || score > best.score || (score === best.score && p.clinician_id < best.clinician_id)) best = { clinician_id: p.clinician_id, score };
  }
  return best;
}
