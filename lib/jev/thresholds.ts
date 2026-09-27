/**
 * lib/jev/thresholds.ts — W41 F4 (jev-audit finding #5): one reviewable module for every Jev
 * threshold that was scattered across lib/jev/confidence.ts, lib/brain/fuse/jev-arm.ts,
 * lib/encounter-clock/fusion.ts, lib/jev/role-composite.ts and lib/jobs/kinds/jev-window.ts.
 *
 * Every value here is MOVED from its origin file, none changed. Each origin file re-exports its
 * own constants from here, so no existing import path anywhere in the codebase changes -- a
 * caller that already does `import { ETA_JEV_MIN_VISIT_WINDOWS } from "@/lib/brain/fuse/jev-arm"`
 * keeps working exactly as before.
 */

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

// lib/jev/confidence.ts — J-CORE-1, PLAN-v3.md §1 principle 4. Plain literal, no env override.
// (ConfidenceThresholds stays defined in confidence.ts, its original home; imported here as a
// type only, so this has no runtime dependency on that module.)
import type { ConfidenceThresholds } from "./confidence";
export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = { act: 0.9, caution: 0.5 };

// lib/brain/fuse/jev-arm.ts — Slice J2 (ETA-JEV-ARM-D §5.4). Read once at module load (env, with
// these defaults).
export const ETA_JEV_T_START = envFloat("ETA_JEV_T_START", 0.7);
export const ETA_JEV_T_END = envFloat("ETA_JEV_T_END", 0.7);
export const ETA_JEV_T_CLINICAL = envFloat("ETA_JEV_T_CLINICAL", 0.6);
export const ETA_JEV_T_PHASE_CONF = envFloat("ETA_JEV_T_PHASE_CONF", 0.6); // F8: was a bare 0.6 literal
export const ETA_JEV_MIN_VISIT_WINDOWS = envInt("ETA_JEV_MIN_VISIT_WINDOWS", 3);
export const ETA_JEV_MAX_GAP_WINDOWS = envInt("ETA_JEV_MAX_GAP_WINDOWS", 6);

// lib/encounter-clock/fusion.ts — E-6 (PLAN-v3 §C). PROVISIONAL plain literals, no env override.
export const START_P = 0.9;
export const END_P = 0.9;
export const JEV_MIN_RUN = 3;

// lib/jev/role-composite.ts — Slice J3 (ETA-JEV-ARM-D §6.3).
export const ETA_JEV_T_ROLE_DEFAULT = 0.6;
export const ETA_JEV_T_ROLE = envFloat("ETA_JEV_T_ROLE", ETA_JEV_T_ROLE_DEFAULT);

// lib/jobs/kinds/jev-window.ts — Slice J2 (ETA-JEV-ARM-D §5.2). Internal to that job kind; not
// exported from its own file today, kept private-by-convention here too (still exported so this
// module stays the single place that reads every one of these env vars).
export const ETA_JEV_BATCH_WINDOWS = envInt("ETA_JEV_BATCH_WINDOWS", 20);
export const ETA_JEV_CONTEXT_WINDOWS = envInt("ETA_JEV_CONTEXT_WINDOWS", 2);
export const ETA_JEV_MAX_INFLIGHT_PER_JOB = envInt("ETA_JEV_MAX_INFLIGHT_PER_JOB", 2);
export const ETA_JEV_MAX_INFLIGHT_GLOBAL = envInt("ETA_JEV_MAX_INFLIGHT_GLOBAL", 4);
