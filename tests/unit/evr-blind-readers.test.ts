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
const { readPulseRecord } = await import("@/lib/rubrics/readers/pulse-record");
const { readConsultText } = await import("@/lib/rubrics/readers/consult-text");
const { selectEvrWindows } = await import("@/lib/rubrics/evr/select");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;

beforeEach(() => {
  statements.length = 0; warehouse.length = 0; pair = { room_id: BR, ist_date: BD, consult_key: "enc_x@m1", t_open: "2026-09-13T04:00:00Z", t_close: "2026-09-13T04:10:00Z", quality: "clean", attribution: "rows" }; // a CLOSED window: only the held-out check can stop the span read
  REC.setMetabaseForTests(async (q) => { warehouse.push(q); return []; });
});

describe("each guard on its own", () => {
  it("pulse_record: a held-out consult is refused blind_room_day BEFORE the window row is read and before the warehouse (remove only this guard and the warehouse is called)", async () => {
    expect(await readPulseRecord("enc_x@m1")).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(warehouse).toEqual([]);
    expect(statements.some((s) => /warehouse_prescription_uid/.test(s.text))).toBe(false);
    pair = { room_id: "r1", ist_date: "2026-10-08" };
    statements.length = 0;
    await readPulseRecord("enc_x@m1");
    expect(statements.some((s) => /warehouse_prescription_uid/.test(s.text))).toBe(true); // control: an ordinary consult does reach the window row
  });
  it("consult_text: a held-out consult is refused before any bench-window or cue query (the consult_span guard, reached through the reader)", async () => {
    // the window row for readConsultSpan carries t_open / t_close so only the blind check can stop it
    const { sql } = await import("@/lib/db");
    void sql;
    expect(await readConsultText("enc_x@m1")).toMatchObject({ ok: false });
    expect(statements.some((s) => /FROM bench_window|FROM cue|jev_window_text/.test(s.text))).toBe(false);
  });
  it("select.ts: the window selection excludes the held-out pairs IN THE QUERY, before ORDER BY / LIMIT, passing all 14 pairs (remove only the NOT EXISTS and this fails)", async () => {
    await selectEvrWindows(40, 5);
    const q = statements.find((s) => /FROM eta_encounter_windows w/.test(s.text))!;
    expect(q).toBeDefined();
    const i = q.text.indexOf("NOT EXISTS"), o = q.text.indexOf("ORDER BY"), l = q.text.indexOf("LIMIT");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(o);
    expect(o).toBeLessThan(l);
    expect(q.text).toMatch(/unnest\(\?::date\[\], \?::text\[\]\)/);
    expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([d]) => d));
    expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([, r]) => r));
  });
});
