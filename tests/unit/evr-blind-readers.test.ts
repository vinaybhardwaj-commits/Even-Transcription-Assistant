/**
 * S7-2-R2 R2 — each S7-2 held-out guard pinned ON ITS OWN (sql mocked, no docker): the pulse_record reader's guard, the consult_text -> consult_span guard, and the NOT EXISTS of the bench
 * window selection. Every test here fails if only that one guard is removed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const statements: Array<{ text: string; values: unknown[] }> = [];
type PairRow = { room_id: string; ist_date: string; consult_key?: string; t_open?: string; t_close?: string; quality?: string; attribution?: string };
let pair: PairRow | null = null;
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    if (/AS ist_date/.test(text) && /FROM eta_encounter_windows/.test(text) && /WHERE consult_key/.test(text)) return pair ? [pair] : [];
    if (/FROM eta_encounter_windows/.test(text) && /t_open, t_close, quality|SELECT consult_key, room_id, t_open/.test(text)) return [];
    return [];
  },
}));
const warehouse: string[] = [];
const REC = await import("@/lib/rubrics/evr/record");
const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const { FORMER_BLIND_PAIRS } = await import("../support/former-blind-pairs");
const { readPulseRecord } = await import("@/lib/rubrics/readers/pulse-record");
const { readConsultText } = await import("@/lib/rubrics/readers/consult-text");
const { selectEvrWindows } = await import("@/lib/rubrics/evr/select");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;

beforeEach(() => {
  statements.length = 0; warehouse.length = 0; pair = { room_id: BR, ist_date: BD, consult_key: "enc_x@m1", t_open: "2026-09-13T04:00:00Z", t_close: "2026-09-13T04:10:00Z", quality: "clean", attribution: "rows" }; // a CLOSED window: only the held-out check can stop the span read
  REC.setMetabaseForTests(async (q) => { warehouse.push(q); return []; });
});

describe("held-out rule LIFTED 10 Oct 2026: a formerly held-out pair is served by each reader", () => {
  it("pulse_record: a formerly held-out consult is NOT refused blind_room_day: the window row is read (the guard is a no-op)", async () => {
    expect(BLIND_ROOM_DAYS).toHaveLength(0);
    expect(await readPulseRecord("enc_x@m1")).not.toMatchObject({ reason: "blind_room_day" });
    expect(statements.some((s) => /warehouse_prescription_uid/.test(s.text))).toBe(true);
  });
  it("consult_text: a formerly held-out consult is not refused blind_room_day (the consult_span guard is a no-op)", async () => {
    expect(await readConsultText("enc_x@m1")).not.toMatchObject({ reason: "blind_room_day" });
    expect(statements.some((s) => /FROM eta_encounter_windows/.test(s.text))).toBe(true);
  });
  it("select.ts: the window selection still has its NOT EXISTS before ORDER BY / LIMIT, but passes EMPTY arrays, so the former pairs are not excluded", async () => {
    await selectEvrWindows(40, 5);
    const q = statements.find((s) => /FROM eta_encounter_windows w/.test(s.text))!;
    expect(q).toBeDefined();
    const i = q.text.indexOf("NOT EXISTS"), o = q.text.indexOf("ORDER BY"), l = q.text.indexOf("LIMIT");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(o);
    expect(o).toBeLessThan(l);
    expect(q.text).toMatch(/unnest\(\?::date\[\], \?::text\[\]\)/);
    expect(q.values).toContainEqual([]);
    for (const [d, r] of FORMER_BLIND_PAIRS) {
      expect(q.values.some((v) => Array.isArray(v) && (v as unknown[]).includes(d))).toBe(false);
      expect(q.values.some((v) => Array.isArray(v) && (v as unknown[]).includes(r))).toBe(false);
    }
  });
});
