/**
 * lib/stt/shadow.ts — Slice C1 step 5. Which windows get a second opinion.
 *
 * ─── WHY SHADOW AT ALL ─────────────────────────────────────────────────────────────────────────
 * The room engine is being switched on a prior rather than a comparison, because the gold corpus
 * that would settle it does not exist. A shadow run rebuilds the comparison from work that is
 * already happening: on a sample of windows the previous engine's answer is stored beside the new
 * one, so every pair V adjudicates becomes a gold row. The corpus then grows out of the clinic
 * instead of out of a labelling project.
 *
 * ─── SAMPLING IS DETERMINISTIC, NOT RANDOM, AND THAT IS THE DESIGN ─────────────────────────────
 * The decision is a hash of the window id. Three things follow, all of which a coin flip loses:
 *   - A re-drain of the same window makes the SAME decision, so a window does not acquire a shadow
 *     run on its second pass and lose it on its third. The delete-then-insert the drain performs
 *     would otherwise make the pair appear and disappear.
 *   - The sample is reproducible. "Which windows are shadowed" is answerable from the ids alone,
 *     without reading the table, which matters when deciding whether a gap is a sampling artefact.
 *   - It is stable under rate changes in one direction: raising the rate only ADDS windows, it
 *     never reshuffles the set, so a widened sample is a superset of the narrower one.
 */
import { createHash } from "node:crypto";

export const SHADOW_RATE_ENV = "ETA_ROOM_SHADOW_SAMPLE";
/** The spec's default: a minority of windows, enough to see a trend inside a day. */
export const DEFAULT_SHADOW_RATE = 0.1;

/**
 * PURE. The configured fraction, clamped to [0,1].
 *
 * An unparseable or out-of-range value falls back to the default rather than to 0. A typo in an
 * env var must not silently switch the only instrument this slice has off — and it must not
 * silently switch it to 100% either, which is why the clamp is two-sided.
 */
export function shadowRate(raw: string | undefined = process.env[SHADOW_RATE_ENV]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHADOW_RATE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SHADOW_RATE;
  return Math.min(1, Math.max(0, n));
}

/**
 * PURE. Deterministic per window id.
 *
 * The first 8 hex digits of sha256 over 0xffffffff. Rate 0 is never, rate 1 is always, and both
 * are exact — a `< rate` comparison on a value in [0,1) gives those endpoints for free, which a
 * modulo-of-100 scheme does not.
 */
export function shouldShadow(windowId: string, rate: number = shadowRate()): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const h = createHash("sha256").update(windowId).digest("hex").slice(0, 8);
  return parseInt(h, 16) / 0xffffffff < rate;
}
