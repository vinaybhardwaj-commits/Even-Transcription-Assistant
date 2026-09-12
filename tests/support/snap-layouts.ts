/**
 * tests/support/snap-layouts.ts — the ten adversarial slice layouts, as a committed fixture.
 *
 * PROVENANCE, STATED HONESTLY. These are reconstructed from the DESCRIPTIONS in the Refuter's
 * round-3 notes (docs/handoff/scratch/C2-REFUTER-R3-NOTES.md, attack (a)); the notes record each
 * layout's shape and its outcome, not the turn arrays themselves, so these are built to match the
 * descriptions rather than copied. Where a layout is defined relative to "the nominal mark", the
 * ABSOLUTE positions the Refuter used are kept — nominal was 120 000 under the algorithm they were
 * probing — so that the cases keep testing the geometry they were designed for rather than sliding
 * with the implementation.
 *
 * They exist because the random sweep is not adversarial: with a 110 s stride and 1-13 s turns a
 * clean edge is almost always available, so it reports zero splits and proves little. These ten
 * are the sharp instrument.
 */
export type Turn = { start_ms: number; end_ms: number };
export type Layout = { id: string; what: string; turns: Turn[] };

const WINDOW = 900_000;
/** Regular 15 s turns on a 20 s pitch — a clean 5 s gap between each. */
const regular = (from: number, to: number, pitch = 20_000, dur = 15_000): Turn[] => {
  const out: Turn[] = [];
  for (let t = from; t + dur <= to; t += pitch) out.push({ start_ms: t, end_ms: t + dur });
  return out;
};

export const SNAP_LAYOUTS: Layout[] = [
  { id: "A", what: "a turn longer than the cap (0-300 000), then regular turns",
    turns: [{ start_ms: 0, end_ms: 300_000 }, ...regular(300_000, WINDOW)] },
  { id: "B", what: "every candidate splits a turn — 130 s turns, back to back",
    turns: Array.from({ length: Math.ceil(WINDOW / 130_000) }, (_, i) => ({ start_ms: i * 130_000, end_ms: Math.min(WINDOW, (i + 1) * 130_000) })) },
  { id: "C", what: "the only clean gap sits EXACTLY at the old nominal +10 000 (130 000)",
    turns: [{ start_ms: 0, end_ms: 130_000 }, { start_ms: 130_000, end_ms: WINDOW }] },
  { id: "D", what: "the only clean gap sits at the old nominal +10 001 (130 001)",
    turns: [{ start_ms: 0, end_ms: 130_001 }, { start_ms: 130_001, end_ms: WINDOW }] },
  { id: "E", what: "the only clean gap sits EXACTLY at the old nominal -10 000 (110 000)",
    turns: [{ start_ms: 0, end_ms: 110_000 }, { start_ms: 110_000, end_ms: WINDOW }] },
  { id: "F", what: "the only clean gap sits at the old nominal -10 001 (109 999)",
    turns: [{ start_ms: 0, end_ms: 109_999 }, { start_ms: 109_999, end_ms: WINDOW }] },
  { id: "G", what: "all turns in the first 200 s; the rest of the window is silence",
    turns: regular(0, 200_000) },
  { id: "H", what: "no turns at all", turns: [] },
  { id: "I", what: "one continuous 900 s turn", turns: [{ start_ms: 0, end_ms: WINDOW }] },
  { id: "J", what: "the happy case — regular turns across the whole window",
    turns: regular(0, WINDOW) },
];

export const SNAP_WINDOW_END = WINDOW;
