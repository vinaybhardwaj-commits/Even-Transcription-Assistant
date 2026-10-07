/** SPEC-v1 AMENDMENT 1: escalation by duration, the sort, the chip, the contrast. */
import { describe, it, expect } from "vitest";
import { INK, L3_FILL, L4_FILL, cardStyle, chipAlarm, contrast, durationOf, escalationLevel, sortAttention, type EscalationLevel } from "@/lib/rooms-live/escalation";
import { COLORS } from "@/lib/rooms-live/present";
import type { RoomStateName } from "@/lib/rooms-live/state";

const MIN = 60_000;
const SEC = 1000;
describe("escalationLevel boundaries", () => {
  it("1:59 -> L1, 2:00 -> L2, 4:59 -> L2, 5:00 -> L3, 9:59 -> L3, 10:00 -> L4", () => {
    expect(escalationLevel(0)).toBe(1);
    expect(escalationLevel(1 * MIN + 59 * SEC)).toBe(1);
    expect(escalationLevel(2 * MIN)).toBe(2);
    expect(escalationLevel(4 * MIN + 59 * SEC)).toBe(2);
    expect(escalationLevel(5 * MIN)).toBe(3);
    expect(escalationLevel(9 * MIN + 59 * SEC)).toBe(3);
    expect(escalationLevel(10 * MIN)).toBe(4);
    expect(escalationLevel(6 * 3_600_000)).toBe(4);
  });
  it("negative, NaN and Infinity are safe", () => {
    expect(escalationLevel(-5)).toBe(1);
    expect(escalationLevel(Number.NaN)).toBe(1);
    expect(escalationLevel(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("duration", () => {
  const now = Date.parse("2026-10-07T10:00:00Z");
  it("server state_since wins; null falls back to this browser's first sighting; neither -> 0", () => {
    expect(durationOf({ state_since: "2026-10-07T09:55:00Z" }, now, now - 99 * MIN)).toBe(5 * MIN);
    expect(durationOf({ state_since: null }, now, now - 3 * MIN)).toBe(3 * MIN);
    expect(durationOf({ state_since: null }, now, null)).toBe(0);
    expect(durationOf({ state_since: "2026-10-07T10:05:00Z" }, now, null)).toBe(0);
  });
});

describe("sort of Needs attention: level first, then duration longest first, then room order", () => {
  const it_ = (id: string, ms: number) => ({ item: { room_id: id }, ms });
  it("orders by level, then longest", () => {
    const r = sortAttention([it_("a", 30 * SEC), it_("b", 12 * MIN), it_("c", 3 * MIN), it_("d", 7 * MIN), it_("e", 25 * MIN), it_("f", 90 * SEC)]);
    expect(r.map((x) => x.item.room_id)).toEqual(["e", "b", "d", "c", "f", "a"]);
    expect(r.map((x) => x.level)).toEqual([4, 4, 3, 2, 1, 1]);
  });
  it("a longer duration inside a lower level never outranks a higher level; equal durations keep room order", () => {
    const r = sortAttention([it_("a", 4 * MIN + 59 * SEC), it_("b", 5 * MIN), it_("c", 5 * MIN)]);
    expect(r.map((x) => x.item.room_id)).toEqual(["b", "c", "a"]);
  });
});

describe("header chip", () => {
  it("dark red only when some room is at L3 or L4", () => {
    expect(chipAlarm([])).toBe(false);
    expect(chipAlarm([1, 2, 2])).toBe(false);
    expect(chipAlarm([1, 3])).toBe(true);
    expect(chipAlarm([4])).toBe(true);
  });
});

describe("card style and contrast (>= 4.5:1 at every level, for every problem state)", () => {
  const problem: RoomStateName[] = ["muted", "unplugged", "notrec", "off"];
  const levels: EscalationLevel[] = [1, 2, 3, 4];
  it("L1 white with a 2 px state border; L2 tint with 3 px and bold duration; L3 #B3261E; L4 #7A1410 with the pulse", () => {
    for (const s of problem) {
      const c = COLORS[s];
      expect(cardStyle(1, s)).toMatchObject({ bg: "#FFFFFF", border: c.fg, borderWidth: 2, pulse: false, boldFor: false });
      expect(cardStyle(2, s)).toMatchObject({ bg: c.bg, border: c.fg, borderWidth: 3, boldFor: true, pulse: false });
      expect(cardStyle(3, s)).toMatchObject({ bg: L3_FILL, fg: "#FFFFFF", pulse: false });
      expect(cardStyle(4, s)).toMatchObject({ bg: L4_FILL, fg: "#FFFFFF", pulse: true });
    }
    expect(L3_FILL).toBe("#B3261E");
    expect(L4_FILL).toBe("#7A1410");
  });
  it("L3 and L4 are red whatever the state (muted turns red too)", () => {
    expect(cardStyle(3, "muted").bg).toBe(cardStyle(3, "unplugged").bg);
    expect(cardStyle(4, "off").bg).toBe(L4_FILL);
  });
  it("text, pill and headline colours reach 4.5:1 on their background at every level", () => {
    for (const s of problem) {
      for (const l of levels) {
        const st = cardStyle(l, s);
        expect(contrast(st.fg, st.bg), `${s} L${l} card text`).toBeGreaterThanOrEqual(4.5);
        const pillBg = st.pill.bg === "transparent" ? st.bg : st.pill.bg;
        expect(contrast(st.pill.fg, pillBg), `${s} L${l} pill`).toBeGreaterThanOrEqual(4.5);
        // the headline is drawn in the state colour on white / tint at L1 and L2
        if (l <= 2) expect(contrast(COLORS[s].fg, st.bg), `${s} L${l} headline`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(INK, "#F6F5F2")).toBeGreaterThanOrEqual(4.5);
  });
  it("contrast() itself: black on white is 21, equal colours 1", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});
