/**
 * lib/stt/window-bounds.ts — C2 R2 Defect 2. Two kinds of millisecond, told apart by the compiler.
 *
 * ─── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ────────────────────────────────────────────────────
 * The turn join filters `payload->'window'` — the WINDOW bounds stamped on every turn cue. It once
 * received a different quantity passed as a plain `number`, and the predicate could never be true:
 * real /diarize calls, zero turns loaded, zero rows written, and a job reporting `done`.
 *
 * Renaming the parameters would not have caught it — the wrong value was being PASSED, and a name
 * is not a type. A window bound is a specific quantity that happens to be a number, which is
 * exactly what a brand is for.
 */

declare const WindowBrand: unique symbol;

/** The 900 s window's own bounds — the value stamped into every turn cue's `window` object. */
export type WindowStartMs = number & { readonly [WindowBrand]: "start" };
export type WindowEndMs = number & { readonly [WindowBrand]: "end" };

/**
 * The only way in. Each constructor is a deliberate assertion about WHICH quantity this number is,
 * made at the point where the answer is actually known — reading a bench_window row — rather than four call sites later where both look identical.
 */
export const windowStart = (n: number): WindowStartMs => n as WindowStartMs;
export const windowEnd = (n: number): WindowEndMs => n as WindowEndMs;

/** For arithmetic and for the wire, where a brand has done its job and a number is a number. */
export const ms = (n: WindowStartMs | WindowEndMs): number => n as number;
