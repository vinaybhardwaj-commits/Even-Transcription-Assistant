/**
 * Stage 3 — the /care/triage longitudinal label-only lane: the ONE piece of read-side logic that isn't
 * already in opd-triage-core. Everything else in the lane (partitioning, the promotion gate, the type
 * label overlay) is the shipped `buildLabelLane` / `promotionGate` / `isRoutable` — imported, never
 * re-implemented. This file only maps the existing signal-health FP-rate machinery into the shape
 * `buildLabelLane`'s `opts.gates` expects, seeding every longitudinal type so a card always shows a gate
 * (0 / 50 collecting) even before any label exists for it.
 */
import { LONGITUDINAL_SIGNAL_TYPES } from '@/lib/opd-triage-core';

/** The per-type inputs `buildLabelLane` needs to compute a promotion gate. */
export interface LaneGate { labelled: number; fpRate: number }
/** The subset of a SignalHealth row this mapping reads (decided = labelled instances; fp_rate = 0..1). */
export interface HealthLike { signal_type: string; decided: number; fp_rate: number }

/**
 * Seed each of the 5 longitudinal types at {labelled:0, fpRate:0} (so a never-labelled type still renders
 * a "collecting · 0/50" gate), then overlay the corpus-wide signal-health numbers where present. Reads the
 * SAME FP-rate the /care/triage/health panel shows — the gate never invents its own denominator.
 */
export function buildLongitudinalGates(health: HealthLike[]): Record<string, LaneGate> {
  const gates: Record<string, LaneGate> = {};
  for (const t of LONGITUDINAL_SIGNAL_TYPES) gates[t] = { labelled: 0, fpRate: 0 };
  for (const h of health || []) {
    if (!h || !LONGITUDINAL_SIGNAL_TYPES.has(h.signal_type)) continue;   // longitudinal types only
    const labelled = Math.max(0, Math.floor(Number(h.decided) || 0));
    const fpRate = Number.isFinite(h.fp_rate) ? Math.max(0, Math.min(1, Number(h.fp_rate))) : 0;
    gates[h.signal_type] = { labelled, fpRate };
  }
  return gates;
}
