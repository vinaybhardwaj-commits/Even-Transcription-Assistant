/**
 * lib/encounter-clock/fusion-state.ts — what the E-6 fusion shows Jev about each probe. PURE.
 *
 * THE GRID IS THE ACOUSTIC ONE. Fusion probe i is acoustic probe i: the same centre `t`, owning the same
 * 60 s hop around it ([t - 30 s, t + 30 s)), which is how the smoother already assigns time (smooth.ts,
 * "ownership by hop"). Reusing the grid index for index is what lets a split piece be re-tallied from the
 * acoustic verdicts with the smoother's own arithmetic.
 *
 * TEXT PER PROBE is the stored transcript already placed on the clock (splitWindowText, the E-shadow's
 * own placement). A span belongs to the probe its midpoint falls in. Three outcomes, kept apart:
 *   · null  — no transcript COVERS this probe: missing evidence, never asked about;
 *   · ""    — covered, and nothing was said: asked about as silence would be pointless, so also skipped,
 *             but counted separately so "silent" and "never transcribed" do not share a value;
 *   · text  — the native text; the caller translates it (Jev-English path) before any state is built.
 *
 * STATE SHAPES ARE THE TRIALLED ONES (lib/jev/prompts/encounter-v1.ts): {window_text} for U1 and U6,
 * {W1, W2, W3} for U2 — the probe with its neighbours, labelled ordinally, never with times (§1.7).
 */
import type { TextSpan } from "@/lib/stt/window-measure";

/** A fusion probe owns one hop of the acoustic grid. */
export const FUSION_HOP_MS = 60_000;

export type ProbeSlot = { index: number; t: number; start_ms: number; end_ms: number };

export type ProbeText = ProbeSlot & {
  /** null = not covered by any transcript; "" = covered, nothing said; otherwise the native text. */
  text: string | null;
};

export type Coverage = Array<{ start_ms: number; end_ms: number }>;

/** PURE — the fusion slots for the acoustic probe centres: each owns [t - hop/2, t + hop/2). */
export function slotsFromCentres(centres: readonly number[], hop_ms: number = FUSION_HOP_MS): ProbeSlot[] {
  const half = hop_ms / 2;
  return centres.map((t, index) => ({ index, t, start_ms: t - half, end_ms: t + half }));
}

const covers = (coverage: Coverage, a: number, b: number): boolean =>
  coverage.some((c) => c.start_ms < b && c.end_ms > a);

/**
 * PURE — the native text owned by each slot. A span goes to the slot its midpoint falls in, so a span is
 * counted once and never split mid-word. Spans are joined in time order with a space.
 */
export function textForSlots(slots: readonly ProbeSlot[], spans: readonly TextSpan[], coverage: Coverage): ProbeText[] {
  const buckets = new Map<number, Array<{ at: number; text: string }>>();
  for (const s of spans) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    const mid = (s.start_ms + s.end_ms) / 2;
    const slot = slots.find((p) => mid >= p.start_ms && mid < p.end_ms);
    if (!slot) continue;
    const list = buckets.get(slot.index) ?? [];
    list.push({ at: s.start_ms, text });
    buckets.set(slot.index, list);
  }
  return slots.map((slot) => {
    const list = buckets.get(slot.index);
    if (list?.length) {
      return { ...slot, text: list.sort((a, b) => a.at - b.at).map((x) => x.text).join(" ") };
    }
    return { ...slot, text: covers(coverage, slot.start_ms, slot.end_ms) ? "" : null };
  });
}

/** PURE — the stable jev_decision subject id for a probe: a replay upserts, it does not duplicate. */
export function probeSubjectId(roomDayId: string, startMs: number): string {
  return `pr_${roomDayId}_${Math.round(startMs)}`;
}

/** PURE — U1 and U6 state, as trialled. */
export function windowState(english: string): { window_text: string } {
  return { window_text: english };
}

/**
 * PURE — U2 state, as trialled: the probe (W2) with the probe before (W1) and after (W3). A missing
 * neighbour — the first or last probe of the day, or one with no English — is the empty string, which
 * the trialled criteria read as "no consultation present" rather than inventing context.
 */
export function boundaryState(prev: string | null, cur: string, next: string | null): { W1: string; W2: string; W3: string } {
  return { W1: prev ?? "", W2: cur, W3: next ?? "" };
}
