/**
 * spine-p1-oref-pg.test.ts — Opus refute of SPINE-P1 (ported in R3, adapted: the cron no longer runs v3, acoustic is hourly, acoustic source_key is stable): the REAL writers (writeHypothesisRun acoustic + timeline, writeLeaveRun) driven
 * through the REAL runProducers loop, then the REAL readers (readHypothesesSince, ingestSpineSignals' timeline SQL), on postgres:16 with
 * every real migration. Synthetic ids only.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => {
  const h = { tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), call: null as unknown as (a: unknown, ...rest: unknown[]) => Promise<unknown[]> };
  h.call = (a, ...rest) => {
    if (Array.isArray(a) && "raw" in (a as object)) return h.tag!(a as unknown as TemplateStringsArray, ...rest);
    const params = (rest[0] as unknown[]) ?? [];
    const parts = (a as string).split(/\$\d+/);
    return h.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...params);
  };
  return h;
});
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => H.call(a[0], ...a.slice(1)) }));
vi.mock("@/lib/brain/db", () => ({ query: async (text: string, params: unknown[]) => ({ rows: await H.call(text, params) }) }));
import { ingestSpineSignals } from "@/lib/spine/ingest-store";
import { readHypothesesSince, writeHypothesisRun, type HypothesisRunInput } from "@/lib/encounter-hypotheses";
import { writeLeaveRun } from "@/lib/encounter-clock/shadow-leave";
import { runProducers } from "@/lib/spine/producers";
import { listRoomDaysForDate } from "@/lib/room-access/room-days-for-date";

const HAVE_DOCKER = dockerAvailable();
const pg = pgContainer("eta-spine-p1-oref");
const NOW = Date.parse("2026-10-22T06:00:00Z");
const DUE = Date.parse("2026-10-22T06:30:00Z");   // 12:00 IST: acoustic due
const T0 = Date.parse("2026-10-22T04:00:00Z");
const q = async (t: string) => (await H.tag!(Object.assign([t], { raw: [t] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const cnt = async (t: string) => Number((await q(`SELECT count(*)::int AS c FROM ${t}`))[0].c);
const iv = (s: number) => ({ start_ms: s, end_ms: s + 600_000, speech_probes: 3, non_speech_probes: 1, unjudged_ms: 0, longest_unjudged_run_ms: 0, dead_mic_ms: 0, closed_by: "non_speech" as const, merged_from: 1, doctor_present: { yes: 0, no: 0, unknown: 0 } });
const run = (rd: string, source: "acoustic" | "timeline"): HypothesisRunInput => ({
  room_day_id: rd, source, smoother_version: source === "acoustic" ? "sv_test" : "ft_test", gate_version: "gv_test",
  probes: { total: 4, speech: 3, non_speech: 1, unjudged: 0 },
  intervals: source === "acoustic" ? [iv(T0), iv(T0 + 1_200_000)] : [{ ...iv(T0 + 60_000), origin: "anchor", closed_by: "pulse_end" as never }],
});
const leave = (rd: string) => ({
  room_day_id: rd, model: "m_test", question_set_sha: "q_test", prompt_version: "p_test", calibration_sha: "c_test", gate_version: "gv_test", params: {},
  rows: [{ consult_key: `ck_test_${rd}@mach_test`, cache_key: "ck", cache_hit: false, features: [], start_ms: T0, end_ms: T0 + 590_000, confidence: 0.5, raw_confidence: 0.5,
    reason_codes: ["patient_left" as const], closed_by: "patient_left" as never, encounter_end_ms: null, jev_used: false, end_row: null, end_signal: null, late_start_p: null, kind: null, kind_conf: null }],
});
const d = HAVE_DOCKER ? describe : describe.skip;

d("SPINE-P1 oref: real writers -> real spine readers", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    pg.exec(`INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_testb', 'room-test-b', 'Room Test B', 'x'), ('room_testa', 'room-test-a', 'Room Test A', 'x');
      INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_testbbbb', 'room_testb', '2026-10-22'), ('rd_testaaaa', 'room_testa', '2026-10-22'), ('rd_testold', 'room_testa', '2026-10-21');
      INSERT INTO spine_config (key, value) VALUES ('ingest', '"shadow"') ON CONFLICT (key) DO NOTHING;`);
  }, 300_000);
  afterAll(() => pg.stop());

  it("listRoomDaysForDate: only that IST date, stable room_id order, ist_date as YYYY-MM-DD text", async () => {
    expect(await listRoomDaysForDate("2026-10-22")).toEqual([
      { id: "rd_testaaaa", room_id: "room_testa", ist_date: "2026-10-22" }, { id: "rd_testbbbb", room_id: "room_testb", ist_date: "2026-10-22" }]);
  });

  it("one producer tick with leave on: acoustic proxy reads acoustic hypotheses only (never v3's timeline rows), timeline proxy reads the leave rows", async () => {
    const days = await listRoomDaysForDate("2026-10-22");
    let t = 0;
    const c = await runProducers(days, 12, {
      now: () => DUE + (t += 1), isBlind: async () => false, timelineEnabled: () => true, gateDiar: () => false,
      acoustic: async (i) => writeHypothesisRun(run(i.room_day_id, "acoustic")),
      leave: async (i) => writeLeaveRun(leave(i.room_day_id)),
    });
    expect(c).toMatchObject({ room_days: 2, acoustic_ok: 2, leave_ok: 2, acoustic_err: 0, leave_err: 0 });
    // a v3-style timeline run, written AFTER acoustic by an operator tool: the newest run per room-day is a timeline run, and the acoustic reader must still skip it
    for (const d of days) await writeHypothesisRun(run(d.id, "timeline"));
    const ac = await readHypothesesSince(NOW - 72 * 3_600_000, 5000);
    expect(ac).toHaveLength(4);
    const acRuns = new Set(ac.map((r) => r.run_id));
    const srcs = await q(`SELECT DISTINCT source FROM encounter_hypothesis_run WHERE id IN (${[...acRuns].map((x) => `'${x}'`).join(",")})`);
    expect(srcs.map((r) => r.source)).toEqual(["acoustic"]);
    const r = await ingestSpineSignals(NOW);
    expect(r).toMatchObject({ mode: "shadow", read: { acoustic: 4, timeline: 2 }, inserted: { acoustic: 4, timeline: 2 } });
  });

  it("R3 F1: 3 more identical ticks add NO acoustic signal rows (4 real intervals = 4 rows, stable keys); timeline stays at one per consult", async () => {
    const days = await listRoomDaysForDate("2026-10-22");
    for (let tick = 0; tick < 3; tick++) {
      await runProducers(days, 12, {
        now: () => DUE, isBlind: async () => false, timelineEnabled: () => true, gateDiar: () => false,
        acoustic: async (i) => writeHypothesisRun(run(i.room_day_id, "acoustic")),
        leave: async (i) => writeLeaveRun(leave(i.room_day_id)),
      });
      await ingestSpineSignals(NOW);
    }
    // 4 ticks total x 2 room-days: runs still grow with every call (F2 is bounded by the hourly gate, not here)
    expect(await cnt("encounter_hypothesis_run WHERE source = 'acoustic'")).toBe(8);
    expect(await cnt("encounter_timeline_shadow_run")).toBe(8);
    expect(await cnt("spine_signal WHERE proxy = 'timeline'")).toBe(2);
    expect(await cnt("spine_signal WHERE proxy = 'acoustic'")).toBe(4);
    expect(Number((await q("SELECT count(DISTINCT source_key)::int AS c FROM spine_signal WHERE proxy = 'acoustic'"))[0].c)).toBe(4);
    expect((await q("SELECT DISTINCT source_rev FROM spine_signal WHERE proxy = 'acoustic'")).map((r) => Number(r.source_rev))).toEqual([1]);
    // keys: <room_day_id>:<epoch minute, base 36>, within the PHI rule's shape; run_id and hypothesis_id stay in attrs.ids
    const keys = (await q("SELECT source_key, attrs FROM spine_signal WHERE proxy = 'acoustic' ORDER BY 1")) as Array<{ source_key: string; attrs: { ids: Record<string, string> } }>;
    for (const k of keys) { expect(k.source_key).toMatch(/^rd_[a-hjkmnp-z2-9]{8}:[0-9a-z]{4,6}$/); expect(k.attrs.ids.run_id).toMatch(/^ehr_/); expect(k.attrs.ids.hypothesis_id).toMatch(/^eh_/); }
  });

  it("R3 F1: a moved boundary (same start bucket, new end) is rev 2 on the SAME key; a start in another minute is a new key", async () => {
    const before = await cnt("spine_signal WHERE proxy = 'acoustic'");
    const mv = (rd: string, startShift: number, endShift: number): HypothesisRunInput => ({ ...run(rd, "acoustic"),
      intervals: [{ ...iv(T0 + startShift), end_ms: T0 + 600_000 + endShift }, iv(T0 + 1_200_000)] });
    await writeHypothesisRun(mv("rd_testaaaa", 5_000, 120_000));          // first interval: start +5 s (same minute bucket), end +120 s
    await ingestSpineSignals(NOW);
    expect(await cnt("spine_signal WHERE proxy = 'acoustic'")).toBe(before + 1);
    const k = `rd_testaaaa:${Math.floor(T0 / 60_000).toString(36)}`;
    expect((await q(`SELECT source_rev FROM spine_signal WHERE proxy = 'acoustic' AND source_key = '${k}' ORDER BY source_rev`)).map((r) => Number(r.source_rev))).toEqual([1, 2]);
    await writeHypothesisRun(mv("rd_testaaaa", 180_000, 0));              // start +3 min: a different bucket -> a new key, rev 1
    await ingestSpineSignals(NOW);
    expect(await cnt("spine_signal WHERE proxy = 'acoustic'")).toBe(before + 2);
    expect(await cnt(`spine_signal WHERE proxy = 'acoustic' AND source_key = '${`rd_testaaaa:${Math.floor((T0 + 180_000) / 60_000).toString(36)}`}' AND source_rev = 1`)).toBe(1);
  });
});
