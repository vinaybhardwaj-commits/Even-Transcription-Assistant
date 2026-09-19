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
 * an `end_reason ∈ {jev_end, jev_gap, next_opener, day_end}`, but the same section also fixes
 * `state: "in_chair"` (or "unknown" — never "ended"). The SHARED write path (fuse.ts's
 * `writeVisits`, and its `shown` projection in the MCP tool) — used by every arm and not this
 * arm's file to change — nulls `end_reason`/`ended_at` unless `state === "ended"` (A6's rule,
 * true for rules.ts too). So the firing rule is ALSO pushed into `reasons` (the field §5.4
 * explicitly asks to carry "the firing rule and the p values"), which the shared path writes
 * unconditionally; `end_reason`/`ended_at` are populated here for introspection and are asserted
 * on the pure function's return, but a persisted jev row will show them NULL like a rules.ts
 * still-open visit would. This is a spec/shared-code tension, not a bug; recorded for V.
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

/**
 * `runJevArm` — walks `signals` (one room-day's `jev_window_signal` rows, any order) in epoch-ms
 * order and emits DraftVisits per the open/close precedence in §5.4. `sessions` supplies the
 * epoch anchor for each signal's session-relative `start_ms`/`end_ms` (see the header note).
 */
export function runJevArm(cues: FuseCue[], signals: JevWindowSignal[], sessions: TapeSession[]): ArmOutput {
  if (signals.length === 0) return { visits: [], unbound: [] };

  const sessionStartMs = new Map(sessions.map((s) => [s.id, ms(s.started_at)]));
  const anchored = signals
    .map((s) => {
      const base = sessionStartMs.get(s.session_id) ?? 0;
      return { s, epochStart: base + s.start_ms, epochEnd: base + s.end_ms };
    })
    .sort((a, b) => a.epochStart - b.epochStart || (a.s.window_id < b.s.window_id ? -1 : a.s.window_id > b.s.window_id ? 1 : 0));

  const finished: Array<{ v: DraftVisit; windowCount: number }> = [];
  let open: Working | null = null;
  let gapCount = 0;

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

  let arrivalStreak = 0;

  for (const { s, epochStart, epochEnd } of anchored) {
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
      if (s.p_clinical < ETA_JEV_T_CLINICAL) {
        gapCount += 1;
        open.windowCount += 1;
        if (gapCount >= ETA_JEV_MAX_GAP_WINDOWS) {
          const endMs = open.lastEndMs; // where clinical activity last held
          closeCurrent(endMs, "jev_gap");
        }
        continue;
      }
      gapCount = 0;
      open.windowCount += 1;
      open.lastEndMs = epochEnd;
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
      }
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
      continue;
    }
    const phaseQualifies = (s.phase === "arrival" || s.phase === "history") && s.phase_confidence >= 0.6 && s.p_clinical >= ETA_JEV_T_CLINICAL;
    if (phaseQualifies) {
      arrivalStreak += 1;
      if (arrivalStreak >= 2) {
        open = {
          opened_by: s.window_id,
          openedAtMs: epochStart,
          openingP: s.phase_confidence,
          openingClinical: s.p_clinical,
          reasons: [`phase_streak:${s.phase}`],
          session_id: s.session_id,
          windowCount: 1,
          lastEndMs: epochEnd,
        };
        arrivalStreak = 0;
      }
    } else {
      arrivalStreak = 0;
    }
  }

  if (open) {
    const last = anchored[anchored.length - 1]!;
    closeCurrent(last.epochEnd, "day_end");
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
