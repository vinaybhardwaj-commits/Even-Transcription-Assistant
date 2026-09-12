/**
 * lib/stt/window-bounds.ts — C2 R2 Defect 2. Two kinds of millisecond, told apart by the compiler.
 *
 * ─── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ────────────────────────────────────────────────────
 * `loadWindowTurns(roomDayId, startMs, endMs)` filtered `payload->'window'` — the 900 s WINDOW
 * bounds stamped on every turn cue — against values the caller passed as 120 s SLICE bounds. Both
 * were `number`, so nothing complained; the predicate simply could never be true. The result was
 * the worst shape a bug can take: eight real /diarize calls per window, about thirty minutes of a
 * serialised Mini, zero turns loaded, zero rows written, and a job reporting `done`.
 *
 * Renaming the parameters would not have caught it — the wrong value was being PASSED, and a name
 * is not a type. A window bound and a slice bound are different quantities that happen to share a
 * representation, which is exactly what a brand is for.
 */

declare const WindowBrand: unique symbol;
declare const SliceBrand: unique symbol;

/** The 900 s window's own bounds — the value stamped into every turn cue's `window` object. */
export type WindowStartMs = number & { readonly [WindowBrand]: "start" };
export type WindowEndMs = number & { readonly [WindowBrand]: "end" };
/** One 120 s slice's bounds. NEVER interchangeable with the above, by construction. */
export type SliceStartMs = number & { readonly [SliceBrand]: "start" };
export type SliceEndMs = number & { readonly [SliceBrand]: "end" };

/**
 * The only way in. Each constructor is a deliberate assertion about WHICH quantity this number is,
 * made at the point where the answer is actually known — reading a bench_window row, or planning a
 * slice — rather than four call sites later where both look identical.
 */
export const windowStart = (n: number): WindowStartMs => n as WindowStartMs;
export const windowEnd = (n: number): WindowEndMs => n as WindowEndMs;
export const sliceStart = (n: number): SliceStartMs => n as SliceStartMs;
export const sliceEnd = (n: number): SliceEndMs => n as SliceEndMs;

/** For arithmetic and for the wire, where a brand has done its job and a number is a number. */
export const ms = (n: WindowStartMs | WindowEndMs | SliceStartMs | SliceEndMs): number => n as number;
