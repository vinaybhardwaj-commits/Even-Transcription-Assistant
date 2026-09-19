/**
 * lib/brain/fuse/jev-arm.ts — Slice J2 (ETA-JEV-ARM-D §5.4). ARM D (`jev`): PURE, like rules.ts.
 * No I/O, no clock read, no model call — `runJevArm` only reasons over the `jev_window_signal`
 * rows and the cue list the caller already fetched.
 *
 * TAPE-MS TO WALL-CLOCK (UNVERIFIED item in the spec, resolved from schema, not guessed): there
 * is no dedicated helper. `bench_window.start_ms/end_ms` (0057) are SESSION-RELATIVE offsets
 * ("bounded on the session clock"); `visit.tape_start_ms/tape_end_ms` (0056, as rules.ts produces
 * them) are ABSOLUTE epoch ms — rules.ts gets there by adding a cue's own epoch-ms `at` to a
 * session span already in epoch ms, never by adding an offset to a session start. Arm D has no
 * cue timestamp to anchor on, only the window's own session-relative offset, so the equivalent
 * arithmetic here is `sessionStartedAtMs (epoch, from bench_session.started_at) + window.start_ms
 * (offset)`. This is inline, mirroring rules.ts's own inline `ms()` arithmetic; there is no
 * existing named export to import (report this — see the build report).
 *
 * WHY `end_reason`/`ended_at` ARE POPULATED BUT NEVER WRITTEN: §5.4 says every DraftVisit carries
 * an `end_reason ∈ {jev_end, jev_gap, next_opener, day_end, session_end, jev_start_end_same_window}`,
 * but the same section also fixes `state: "in_chair"` (or "unknown" — never "ended"). The SHARED
 * write path (fuse.ts's `writeVisits`, and its `shown` projection in the MCP tool) — used by every
 * arm and not this arm's file to change — nulls `end_reason`/`ended_at` unless `state === "ended"`
 * (A6's rule, true for rules.ts too). So the firing rule is ALSO pushed into `reasons` (the field
 * §5.4 explicitly asks to carry "the firing rule and the p values"), which the shared path writes
 * unconditionally; `end_reason`/`ended_at` are populated here for introspection and are asserted
 * on the pure function's return, but a persisted jev row will show them NULL like a rules.ts
 * still-open visit would. This is a spec/shared-code tension, not a bug; recorded for V.
 *
 * REFUTER F2/F3/F8 (19 Sep): three fixes to the state machine, listed here since they change the
 * precedence rules a reader needs to hold in their head at once.
 *  - F2: the explicit-start rule (`p_start >= T_START`) is evaluated BEFORE the gap rule while a
 *    visit is open. Previously a strong opener riding on a window whose `p_clinical` happened to
 *    be below the clinical floor fell into the gap branch and was silently swallowed — a real
 *    visit boundary a clinician-probability threshold has no business hiding. `next_opener` now
 *    fires on `p_start` alone, whatever `p_clinical` says.
 *  - F3: signals are partitioned by `session_id` before the walk. A visit never spans two bench
 *    sessions; reaching the end of a session's own window list with a visit still open closes it
 *    with `session_end` (added to the end_reason set above) rather than letting it bleed into the
 *    next session's windows. Only the LAST session in the room-day still closes with `day_end`.
 *  - F8: the phase-confidence floor is `ETA_JEV_T_PHASE_CONF` (env, default 0.6) rather than a
 *    bare literal; a gap window no longer increments `windowCount` (only a window that is actually
 *    absorbed into the visit should count toward `ETA_JEV_MIN_VISIT_WINDOWS`); and a phase-streak
 *    visit opens at the FIRST of its two qualifying windows (`opened_by`/`openedAtMs` point there),
 *    with `windowCount` seeded at 2 since both windows are already inside it.
 */
import type { ArmOutput, DraftVisit, FuseCue, UnboundEvidence } from "./types";
import type { TapeSession } from "./rules";

export type JevPhase = "non_clinical" | "arrival" | "history" | "examination" | "plan" | "closing";

export type JevWindowSignal = {
  window_id: string;
  room_day_id: string;
  session_id: string;
  start_ms: number; // session-relative, matches bench_window.start_ms
  end_ms: number; // session-relative, matches bench_window.end_ms
  phase: JevPhase;
  phase_probs: Record<string, number>;
  phase_confidence: number;
  p_start: number;
  p_end: number;
  p_clinician: number;
  p_clinical: number;
};

function envFloat(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : def;
}

// Read once at module load (spec §5.4: "all thresholds env with defaults, read once at module load").
export const ETA_JEV_T_START = envFloat("ETA_JEV_T_START", 0.7);
export const ETA_JEV_T_END = envFloat("ETA_JEV_T_END", 0.7);
export const ETA_JEV_T_CLINICAL = envFloat("ETA_JEV_T_CLINICAL", 0.6);
export const ETA_JEV_T_PHASE_CONF = envFloat("ETA_JEV_T_PHASE_CONF", 0.6); // F8: was a bare 0.6 literal
export const ETA_JEV_MIN_VISIT_WINDOWS = envInt("ETA_JEV_MIN_VISIT_WINDOWS", 3);
export const ETA_JEV_MAX_GAP_WINDOWS = envInt("ETA_JEV_MAX_GAP_WINDOWS", 6);

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};
const clampConf = (n: number): number => Math.max(0, Math.min(0.95, n));

const str = (p: Record<string, unknown> | null, k: string): string | null => {
  const v = p?.[k];
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** Cue types §5.4 allows Arm D to adopt a uid from, inside a visit's tape span. */
const UID_CUE_TYPES = new Set(["consult_mark", "pstart", "pqm_called"]);

type Working = {
  opened_by: string; // the opening window id
  openedAtMs: number; // epoch ms
  openingP: number;
  openingClinical: number;
  reasons: string[];
  session_id: string;
  windowCount: number;
  lastEndMs: number; // epoch ms of the most recently absorbed window
};

type Anchored = { s: JevWindowSignal; epochStart: number; epochEnd: number };

/**
 * `runJevArm` — walks `signals` (one room-day's `jev_window_signal` rows, any order), partitioned
 * by session (F3) and in epoch-ms order within each session, emitting DraftVisits per the
 * open/close precedence in §5.4 (as amended by F2/F8 above). `sessions` supplies the epoch anchor
 * for each signal's session-relative `start_ms`/`end_ms` (see the header note).
 */
export function runJevArm(cues: FuseCue[], signals: JevWindowSignal[], sessions: TapeSession[]): ArmOutput {
  if (signals.length === 0) return { visits: [], unbound: [] };

  const sessionStartMs = new Map(sessions.map((s) => [s.id, ms(s.started_at)]));
  const anchored: Anchored[] = signals.map((s) => {
    const base = sessionStartMs.get(s.session_id) ?? 0;
    return { s, epochStart: base + s.start_ms, epochEnd: base + s.end_ms };
  });

  // F3: partition by session_id first. Session order is by the session's own epoch start (ties
  // broken by session_id) so output is deterministic even when `sessions` arrives unsorted.
  const bySession = new Map<string, Anchored[]>();
  for (const a of anchored) {
    const list = bySession.get(a.s.session_id) ?? [];
    list.push(a);
    bySession.set(a.s.session_id, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.epochStart - b.epochStart || (a.s.window_id < b.s.window_id ? -1 : a.s.window_id > b.s.window_id ? 1 : 0));
  }
  const sessionOrder = [...bySession.keys()].sort((a, b) => {
    const da = sessionStartMs.get(a) ?? 0;
    const db = sessionStartMs.get(b) ?? 0;
    return da - db || (a < b ? -1 : a > b ? 1 : 0);
  });

  const finished: Array<{ v: DraftVisit; windowCount: number }> = [];
  let open: Working | null = null;
  let gapCount = 0;
  let arrivalStreak = 0;
  let firstArrival: { window_id: string; epochStart: number; openingP: number; openingClinical: number } | null = null;

  const closeCurrent = (endMs: number, reason: string): void => {
    if (!open) return;
    const v: DraftVisit = {
      individual_uid: null,
      consult_uid: null,
      state: "in_chair", // §5.4: Arm D emits in_chair or unknown only; downgraded below if no uid binds
      pstart_at: new Date(open.openedAtMs).toISOString(),
      confidence: clampConf((open.openingP + open.openingClinical) / 2),
      opened_by: open.opened_by,
      opened_by_kind: "jev_window",
      reasons: [...open.reasons, reason],
      end_reason: reason, // see header note: never reaches the DB while state !== 'ended'
      ended_at: new Date(endMs).toISOString(),
      session_id: open.session_id,
      tape_start_ms: open.openedAtMs,
      tape_end_ms: endMs > open.openedAtMs ? endMs : null, // 0056-style: non-positive span → null end
      clinician_id: null,
      clinician_source: null,
      clinician_confidence: null,
    };
    finished.push({ v, windowCount: open.windowCount });
    open = null;
    gapCount = 0;
  };

  for (let si = 0; si < sessionOrder.length; si += 1) {
    const sessionId = sessionOrder[si]!;
    const list = bySession.get(sessionId)!;
    const isLastSession = si === sessionOrder.length - 1;
    // Fresh per-session: a visit is never left open across the session boundary (closeCurrent
    // below always runs before we move to the next session), and phase-streak tracking does not
    // leak from one session's tail into the next session's head either.
    arrivalStreak = 0;
    firstArrival = null;

    for (const { s, epochStart, epochEnd } of list) {
      if (open) {
        const bothFire = s.p_start >= ETA_JEV_T_START && s.p_end >= ETA_JEV_T_END;
        if (bothFire) {
          // §5.4 inconsistency rule: close-then-open in the SAME window, at its start.
          closeCurrent(epochStart, "jev_start_end_same_window");
          open = {
            opened_by: s.window_id,
            openedAtMs: epochStart,
            openingP: s.p_start,
            openingClinical: s.p_clinical,
            reasons: [`p_start:${s.p_start.toFixed(2)}`, "jev_start_end_same_window"],
            session_id: s.session_id,
            windowCount: 1,
            lastEndMs: epochEnd,
          };
          arrivalStreak = 0;
          continue;
        }
        if (s.p_end >= ETA_JEV_T_END) {
          closeCurrent(epochEnd, "jev_end");
          arrivalStreak = 0;
          continue;
        }
        // F2: the explicit-start rule is evaluated BEFORE the gap rule, so a strong opener is
        // never swallowed by a low p_clinical on the same window.
        if (s.p_start >= ETA_JEV_T_START) {
          // next_opener: close the running visit at this window's start, then open fresh here.
          closeCurrent(epochStart, "next_opener");
          open = {
            opened_by: s.window_id,
            openedAtMs: epochStart,
            openingP: s.p_start,
            openingClinical: s.p_clinical,
            reasons: [`p_start:${s.p_start.toFixed(2)}`, "next_opener"],
            session_id: s.session_id,
            windowCount: 1,
            lastEndMs: epochEnd,
          };
          arrivalStreak = 0;
          continue;
        }
        if (s.p_clinical < ETA_JEV_T_CLINICAL) {
          // F8: a gap window is never absorbed into the visit's own windowCount.
          gapCount += 1;
          if (gapCount >= ETA_JEV_MAX_GAP_WINDOWS) {
            const endMs = open.lastEndMs; // where clinical activity last held
            closeCurrent(endMs, "jev_gap");
          }
          continue;
        }
        gapCount = 0;
        open.windowCount += 1;
        open.lastEndMs = epochEnd;
        continue;
      }

      // No visit open.
      if (s.p_start >= ETA_JEV_T_START) {
        open = {
          opened_by: s.window_id,
          openedAtMs: epochStart,
          openingP: s.p_start,
          openingClinical: s.p_clinical,
          reasons: [`p_start:${s.p_start.toFixed(2)}`],
          session_id: s.session_id,
          windowCount: 1,
          lastEndMs: epochEnd,
        };
        arrivalStreak = 0;
        firstArrival = null;
        continue;
      }
      const phaseQualifies = (s.phase === "arrival" || s.phase === "history") && s.phase_confidence >= ETA_JEV_T_PHASE_CONF && s.p_clinical >= ETA_JEV_T_CLINICAL;
      if (phaseQualifies) {
        if (arrivalStreak === 0) {
          firstArrival = { window_id: s.window_id, epochStart, openingP: s.phase_confidence, openingClinical: s.p_clinical };
        }
        arrivalStreak += 1;
        if (arrivalStreak >= 2) {
          // F8: open AT THE FIRST of the two qualifying windows, not the second.
          const first = firstArrival!;
          open = {
            opened_by: first.window_id,
            openedAtMs: first.epochStart,
            openingP: first.openingP,
            openingClinical: first.openingClinical,
            reasons: [`phase_streak:${s.phase}`],
            session_id: s.session_id,
            windowCount: 2, // both streak windows are already inside the visit
            lastEndMs: epochEnd,
          };
          arrivalStreak = 0;
          firstArrival = null;
        }
      } else {
        arrivalStreak = 0;
        firstArrival = null;
      }
    }

    if (open) {
      const last = list[list.length - 1]!;
      closeCurrent(last.epochEnd, isLastSession ? "day_end" : "session_end");
    }
  }

  const visits: DraftVisit[] = [];
  const unbound: UnboundEvidence[] = [];
  for (const { v, windowCount } of finished) {
    if (windowCount < ETA_JEV_MIN_VISIT_WINDOWS) {
      unbound.push({ cue_id: v.opened_by, type: "jev_window", reason: "too_short" });
      continue;
    }
    visits.push(v);
  }

  // §5.4 uid adoption: a consult_mark/pstart/pqm_called cue with individual_uid inside
  // [tape_start_ms, tape_end_ms) binds; otherwise the visit stays uid-less and is 'unknown',
  // mirroring rules.ts's own mark-only handling (never upgraded to a guess).
  const uidCues = cues.filter((c) => UID_CUE_TYPES.has(c.type) && str(c.payload, "individual_uid") !== null);
  for (const v of visits) {
    const startMs = v.tape_start_ms!;
    const endMs = v.tape_end_ms ?? Infinity;
    const hit = uidCues.find((c) => {
      const at = ms(c.at);
      return at >= startMs && at < endMs;
    });
    if (hit) {
      v.individual_uid = str(hit.payload, "individual_uid");
      v.state = "in_chair";
      v.reasons = [...v.reasons, `bound_to_cue:${hit.id}`];
    } else {
      v.state = "unknown";
    }
  }

  return { visits, unbound };
}
