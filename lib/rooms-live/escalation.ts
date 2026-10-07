/**
 * lib/rooms-live/escalation.ts — SPEC-v1 AMENDMENT 1: a problem card gets darker red the longer it stays. Pure.
 *   L1 0 to <2 min   white card, 2 px border in the state colour
 *   L2 2 to <5 min   card filled with the state tint, 3 px border, "For N min" bold
 *   L3 5 to <10 min  solid #B3261E, white text and icons, whatever the state
 *   L4 >= 10 min     solid #7A1410, white text, slow 2 s outline pulse (a 4 px white inner ring under prefers-reduced-motion)
 * Applies to the problem states (muted, unplugged, notrec, off) in the "Needs attention" group only (a doctor is present).
 * Duration = now - state_since; when state_since is null, the time this browser first saw the room in that state.
 */
import { COLORS, isProblem } from "./present";
import type { RoomRow } from "./snapshot";
import type { RoomStateName } from "./state";

export type EscalationLevel = 1 | 2 | 3 | 4;
export const L2_MS = 2 * 60_000;
export const L3_MS = 5 * 60_000;
export const L4_MS = 10 * 60_000;
export const L3_FILL = "#B3261E";
export const L4_FILL = "#7A1410";
export const INK = "#22262B";

export function escalationLevel(durationMs: number): EscalationLevel {
  const d = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  return d >= L4_MS ? 4 : d >= L3_MS ? 3 : d >= L2_MS ? 2 : 1;
}

/** ms in the current state; `firstSeen` is the client's own first sighting (used only when the server has no state_since) */
export function durationOf(row: Pick<RoomRow, "state_since">, nowMs: number, firstSeen: number | null): number {
  const t = row.state_since ? Date.parse(row.state_since) : firstSeen;
  return t === null || !Number.isFinite(t) ? 0 : Math.max(0, nowMs - t);
}

export type CardStyle = { bg: string; fg: string; border: string; borderWidth: number; pill: { bg: string; fg: string; border: string }; pulse: boolean; boldFor: boolean; accent: string };

export function cardStyle(level: EscalationLevel, state: RoomStateName): CardStyle {
  const c = COLORS[state];
  if (level === 1) return { bg: "#FFFFFF", fg: INK, border: c.fg, borderWidth: 2, pill: { bg: c.bg, fg: c.fg, border: "transparent" }, pulse: false, boldFor: false, accent: c.fg };
  if (level === 2) return { bg: c.bg, fg: INK, border: c.fg, borderWidth: 3, pill: { bg: "#FFFFFF", fg: c.fg, border: c.fg }, pulse: false, boldFor: true, accent: c.fg };
  const fill = level === 3 ? L3_FILL : L4_FILL;
  return { bg: fill, fg: "#FFFFFF", border: fill, borderWidth: 3, pill: { bg: "transparent", fg: "#FFFFFF", border: "#FFFFFF" }, pulse: level === 4, boldFor: true, accent: "#FFFFFF" };
}

export type Ranked<T> = { item: T; level: EscalationLevel; ms: number };

/** "Needs attention" order: escalation level first, then duration, longest first; the room order breaks exact ties (stable) */
export function sortAttention<T extends { room_id: string }>(items: ReadonlyArray<{ item: T; ms: number }>): Ranked<T>[] {
  return items
    .map((x, i) => ({ item: x.item, ms: x.ms, level: escalationLevel(x.ms), i }))
    .sort((a, b) => b.level - a.level || b.ms - a.ms || a.i - b.i)
    .map(({ item, ms, level }) => ({ item, ms, level }));
}

/** the header "need you" chip turns dark red when any Needs-attention room is at L3 or L4 */
export const chipAlarm = (levels: readonly EscalationLevel[]): boolean => levels.some((l) => l >= 3);

export const needsEscalation = (state: RoomStateName): boolean => isProblem(state);

/** WCAG relative-luminance contrast of two #rrggbb colours */
export function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}
