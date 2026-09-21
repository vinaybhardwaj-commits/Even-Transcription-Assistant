/**
 * Overnight translate — WHICH window is next. The selector is read-only, takes the Jev fixtures first, then the
 * oldest un-transcribed window, drops the two label-free "clearly empty" proxies, and — by V's ruling of
 * 21 Sep 2026 — does NOT exclude a room because its own Transcript switch is off.
 *
 * A recording fake stands in for the database, so what is pinned is the SQL the driver would send and what it
 * does with the rows that come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeStore, fixtureVerdict, isClosedHourIst, type SqlTag } from "@/lib/overnight-translate/select";

type Call = { text: string; values: unknown[] };
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** A responder returns rows for the statements it owns, and `undefined` for everything else. */
function fakeSql(responders: Array<(c: Call) => unknown[] | undefined>): { sql: SqlTag; calls: Call[] } {
  const calls: Call[] = [];
  const sql: SqlTag = async (strings, ...values) => {
    const c = { text: flat(strings.raw.join("?")), values };
    calls.push(c);
    const r = responders.find((f) => f(c) !== undefined);
    return r ? (r(c) as unknown[]) : [];
  };
  return { sql, calls };
}
const isFixtureQuery = (c: Call) => c.text.includes("LEFT JOIN LATERAL");
const isBacklogQuery = (c: Call) => c.text.includes("LIMIT 1") && !c.text.includes("LEFT JOIN LATERAL");

const fixtureRow = (over: Record<string, unknown> = {}) => ({
  id: "bw_f1", room_id: "room_1", room_day_id: "rd_fix1", start_ms: "1000", end_ms: "901000", transcript_enabled: true,
  run_id: null, orig_len: null, eng_len: null, metrics_json: null, hour_ist: 11, no_speakers: false, ...over,
});
const backlogRow = (over: Record<string, unknown> = {}) => ({
  id: "bw_b1", room_id: "room_2", room_day_id: "rd_b", start_ms: "5000", end_ms: "905000", transcript_enabled: true, ...over,
});
const CFG = { fixtureRoomDays: ["rd_fix1", "rd_fix2"], maxFailedJobs: 2 };

describe("READ-ONLY — the selector can only SELECT", () => {
  it("every statement it sends is a SELECT/WITH and contains no write verb", async () => {
    const { sql, calls } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow({ hour_ist: 22 })] : undefined), (c) => (isBacklogQuery(c) ? [backlogRow()] : undefined)]);
    const store = makeStore(sql, CFG);
    await store.next(new Set());
    await store.summarize();
    await store.englishCheck("bw_x");
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) {
      expect(c.text, c.text.slice(0, 80)).toMatch(/^(SELECT|WITH)\b/i);
      expect(c.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|COPY)\b/i);
    }
  });
  it("Store exposes exactly three methods, all reads", () => {
    const store = makeStore(fakeSql([]).sql, CFG);
    expect(Object.keys(store).sort()).toEqual(["englishCheck", "next", "summarize"]);
  });
  it("selects transcript LENGTHS, never transcript text", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const q = calls.find(isFixtureQuery)!;
    expect(q.text).toContain("length(coalesce(t.transcript_original");
    expect(q.text).toContain("length(coalesce(t.transcript_english");
    // The text columns are read INSIDE the lateral sub-select so length() can be taken, and are never
    // handed back under their own name to the caller.
    expect(q.text).not.toMatch(/\bt\.transcript_(original|english)\s+AS\b/);
  });
});

describe("TRANSCRIPT-OFF ROOMS ARE IN SCOPE — the switch is selected, never tested", () => {
  it("neither selection query filters on room.transcript_enabled", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.text, "no WHERE / AND / OR on the switch").not.toMatch(/\b(WHERE|AND|OR)\s+(NOT\s+)?r\.transcript_enabled\b/i);
      expect(c.text).not.toMatch(/transcript_enabled\s*=\s*(TRUE|FALSE|true|false)/);
      expect(c.text, "it IS selected, so the driver knows which jobs need the override").toContain("r.transcript_enabled");
    }
  });
  it("summarize uses the switch only to COUNT windows in off rooms, never to exclude any", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).summarize();
    const remaining = calls.find((c) => c.text.includes("AS remaining"))!;
    expect(remaining.text).toContain("FILTER (WHERE NOT r.transcript_enabled) AS in_off_rooms");
    // Strip the one FILTER clause: nothing else in the statement may mention the switch.
    expect(remaining.text.replace(/count\(\*\) FILTER \(WHERE NOT r\.transcript_enabled\) AS in_off_rooms/, "")).not.toContain("transcript_enabled");
  });
  it("a window in an OFF room is returned like any other, flagged room_transcript_on=false so the job carries the override", async () => {
    const { sql } = fakeSql([(c) => (isBacklogQuery(c) ? [backlogRow({ transcript_enabled: false })] : undefined)]);
    const c = await makeStore(sql, { fixtureRoomDays: [], maxFailedJobs: 2 }).next(new Set());
    expect(c).toMatchObject({ window_id: "bw_b1", klass: "backlog", room_transcript_on: false, has_run: false });
  });
  it("an ON room is flagged true (so no override is sent for it)", async () => {
    const { sql } = fakeSql([(c) => (isBacklogQuery(c) ? [backlogRow({ transcript_enabled: true })] : undefined)]);
    expect((await makeStore(sql, { fixtureRoomDays: [], maxFailedJobs: 2 }).next(new Set()))!.room_transcript_on).toBe(true);
  });
});

describe("ORDER — fixtures first, then the backlog, oldest first", () => {
  it("returns a fixture candidate WITHOUT running the backlog query", async () => {
    const { sql, calls } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow()] : undefined)]);
    const c = await makeStore(sql, CFG).next(new Set());
    expect(c).toMatchObject({ window_id: "bw_f1", klass: "fixture", has_run: false, room_transcript_on: true });
    expect(calls.filter(isBacklogQuery)).toHaveLength(0);
  });
  it("when no fixture window needs work it falls through to the backlog", async () => {
    const { sql, calls } = fakeSql([
      (c) => (isFixtureQuery(c) ? [fixtureRow({ hour_ist: 23 }), fixtureRow({ id: "bw_f2", no_speakers: true })] : undefined),
      (c) => (isBacklogQuery(c) ? [backlogRow()] : undefined),
    ]);
    expect((await makeStore(sql, CFG).next(new Set()))!.klass).toBe("backlog");
    expect(calls.filter(isFixtureQuery)).toHaveLength(1);
    expect(calls.filter(isBacklogQuery)).toHaveLength(1);
  });
  it("skips a fixture window already tried this run and takes the next one", async () => {
    const { sql } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow(), fixtureRow({ id: "bw_f2", start_ms: "2000" })] : undefined)]);
    expect((await makeStore(sql, CFG).next(new Set(["bw_f1"])))!.window_id).toBe("bw_f2");
  });
  it("with NO fixtures configured it never runs the fixture query at all", async () => {
    const { sql, calls } = fakeSql([(c) => (isBacklogQuery(c) ? [backlogRow()] : undefined)]);
    await makeStore(sql, { fixtureRoomDays: [], maxFailedJobs: 2 }).next(new Set());
    expect(calls.filter(isFixtureQuery)).toHaveLength(0);
  });
  it("the backlog is oldest-first and deterministic", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    expect(calls.find(isBacklogQuery)!.text).toContain("ORDER BY w.end_ms ASC, w.id ASC LIMIT 1");
  });
  it("returns null when nothing is left", async () => {
    expect(await makeStore(fakeSql([]).sql, CFG).next(new Set())).toBeNull();
  });
});

describe("efficiency and consistency (Reviewer finding E)", () => {
  it("the fixture scan runs ONCE when nothing needs doing, however many times next() is called", async () => {
    const { sql, calls } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow({ hour_ist: 23 })] : undefined), (c) => (isBacklogQuery(c) ? [backlogRow()] : undefined)]);
    const store = makeStore(sql, CFG);
    for (let i = 0; i < 4; i += 1) await store.next(new Set());
    expect(calls.filter(isFixtureQuery)).toHaveLength(1);
    expect(calls.filter(isBacklogQuery)).toHaveLength(4);
  });

  it("but while a fixture window still needs work the scan repeats, so a fixture is never skipped early", async () => {
    const { sql, calls } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow(), fixtureRow({ id: "bw_f2" })] : undefined)]);
    const store = makeStore(sql, CFG);
    await store.next(new Set());
    await store.next(new Set(["bw_f1"]));
    expect(calls.filter(isFixtureQuery)).toHaveLength(2);
  });

  it("summarize's backlog count applies the SAME job filters as next(), so the night_start number is the real pool", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).summarize();
    const remaining = calls.find((c) => c.text.includes("AS remaining"))!;
    expect(remaining.text).toContain("j.status IN ('queued', 'running')");
    expect(remaining.text).toContain("j.status = 'failed'");
    expect(remaining.values).toContain(2);
  });
});

describe("the backlog query carries every guard it is supposed to", () => {
  const q = async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set(["bw_tried"]));
    return calls.find(isBacklogQuery)!;
  };
  it("takes only windows that have NO transcription run", async () => {
    expect((await q()).text).toContain("NOT EXISTS (SELECT 1 FROM transcription_run t WHERE t.subject_type = 'bench_window' AND t.subject_id = w.id)");
  });
  it("drops closed-hours windows by the IST clock (21:00-06:59) and windows the diarizer called no_speakers", async () => {
    const t = (await q()).text;
    expect(t).toContain(">= 21");
    expect(t).toContain("< 7");
    expect(t).toContain("AT TIME ZONE 'Asia/Kolkata'");
    expect(t).toContain("d.state = 'no_speakers'");
  });
  it("leaves out the fixture room-days (they are handled first) and every window already tried this run", async () => {
    const c = await q();
    expect(c.text).toContain("<> ALL(");
    expect(c.values.some((v) => Array.isArray(v) && (v as string[]).includes("rd_fix1"))).toBe(true);
    expect(c.values.some((v) => Array.isArray(v) && (v as string[]).includes("bw_tried"))).toBe(true);
  });
  it("skips a window with a job already queued or running, and one that has failed too often", async () => {
    const c = await q();
    expect(c.text).toContain("j.status IN ('queued', 'running')");
    expect(c.text).toContain("j.status = 'failed'");
    expect(c.values).toContain(2);
  });
  it("only reaches grid-aligned closed windows that belong to a room-day", async () => {
    const t = (await q()).text;
    expect(t).toContain("w.grid_aligned = TRUE");
    expect(t).toContain("w.room_day_id IS NOT NULL");
    expect(t).toContain("w.state IN ('closed', 'transcribed')");
  });
});

describe("fixtureVerdict — a fixture window's fate, one pure decision", () => {
  const run = (over: Record<string, unknown> = {}) => fixtureRow({ run_id: "tr_1", orig_len: 1200, eng_len: 0, metrics_json: null, ...over });
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["never transcribed, clinic hours → ASR + translate", fixtureRow(), "asr"],
    ["never transcribed, 22:00 IST → closed-hours proxy → skipped", fixtureRow({ hour_ist: 22 }), "skip_proxy"],
    ["never transcribed, 03:00 IST → skipped", fixtureRow({ hour_ist: 3 }), "skip_proxy"],
    ["never transcribed, 07:00 IST → NOT closed hours → ASR", fixtureRow({ hour_ist: 7 }), "asr"],
    ["never transcribed, 20:00 IST → NOT closed hours → ASR", fixtureRow({ hour_ist: 20 }), "asr"],
    ["never transcribed, diarizer said no_speakers → skipped", fixtureRow({ no_speakers: true }), "skip_proxy"],
    ["has a run with text, no English, metrics absent → English only", run(), "english_only"],
    ["has a run with text and no English, non-English language → English only", run({ metrics_json: { full_window_language: "english", sarvam_language: "kn", language_timeline: { language_mix: { kn: 3 } } } }), "english_only"],
    ["has a run that J0 reads as native English → skipped (J0 needs nothing)", run({ metrics_json: { full_window_language: "english", sarvam_language: "en", language_timeline: { language_mix: { en: 3, und: 1 } } } }), "skip_native_english"],
    ["has a run with English already → skipped", run({ eng_len: 800 }), "skip_nothing_to_translate"],
    ["has a run with no text → nothing to translate", run({ orig_len: 0 }), "skip_nothing_to_translate"],
    ["a closed-hours run that needs English is still re-drained (already transcribed; the proxies apply to never-transcribed windows only)", run({ hour_ist: 23 }), "english_only"],
  ];
  for (const [label, row, want] of cases) it(label, () => expect(fixtureVerdict(row as never)).toBe(want));

  it("uses J0's OWN isNativeEnglish — imported, not re-implemented", () => {
    const src = readFileSync(join(process.cwd(), "lib/overnight-translate/select.ts"), "utf8");
    expect(src).toContain('import { isNativeEnglish } from "@/lib/jev/english"');
  });
  it("isClosedHourIst: 21..23 and 0..6 are closed", () => {
    for (const h of [21, 22, 23, 0, 1, 6]) expect(isClosedHourIst(h), String(h)).toBe(true);
    for (const h of [7, 8, 12, 20]) expect(isClosedHourIst(h), String(h)).toBe(false);
  });
});

describe("englishCheck — the canary the driver asks after a job says `done`", () => {
  const check = async (rows: unknown[]) => {
    const { sql, calls } = fakeSql([(c) => (c.text.includes("AS eng_len") && !c.text.includes("LEFT JOIN LATERAL") ? rows : undefined)]);
    const r = await makeStore(sql, CFG).englishCheck("bw_1");
    return { r, calls };
  };
  it("text but NO English → missing (the job ran and did not do what the driver exists for)", async () => {
    expect((await check([{ orig_len: "1200", eng_len: "0" }])).r).toBe("missing");
  });
  it("text and English → ok", async () => expect((await check([{ orig_len: 1200, eng_len: 900 }])).r).toBe("ok"));
  it("a run with no text → ok (nothing to translate)", async () => expect((await check([{ orig_len: 0, eng_len: 0 }])).r).toBe("ok"));
  it("no run at all → ok (a silent window never reaches the engine)", async () => expect((await check([])).r).toBe("ok"));
  it("asks about THIS window, newest run only, and reads two lengths — never text", async () => {
    const { calls } = await check([]);
    const q = calls.find((c) => c.text.includes("AS eng_len") && !c.text.includes("LEFT JOIN LATERAL"))!;
    expect(q.values).toEqual(["bw_1"]);
    expect(q.text).toContain("ORDER BY created_at DESC LIMIT 1");
    expect(q.text).toContain("length(coalesce(transcript_original");
    expect(q.text).not.toMatch(/SELECT\s+transcript_(original|english)\b/);
  });
});

describe("candidate mapping and summarize", () => {
  it("turns bigint strings into numbers and marks a re-drain (has_run) only for a fixture that already has a run", async () => {
    const { sql } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow({ run_id: "tr_1", orig_len: 500, eng_len: 0, start_ms: "1787451300000", end_ms: "1787452200000" })] : undefined)]);
    const c = await makeStore(sql, CFG).next(new Set());
    expect(c).toMatchObject({ klass: "fixture", has_run: true, start_ms: 1787451300000, end_ms: 1787452200000 });
    expect(typeof c!.start_ms).toBe("number");
  });
  it("summarize returns counts only, tallied by verdict", async () => {
    const rows = [
      fixtureRow({ id: "a" }), fixtureRow({ id: "b", hour_ist: 22 }), fixtureRow({ id: "c", run_id: "t", orig_len: 10, eng_len: 0 }),
      fixtureRow({ id: "d", run_id: "t", orig_len: 10, eng_len: 5 }),
    ];
    const { sql } = fakeSql([
      (c) => (isFixtureQuery(c) ? rows : undefined),
      (c) => (c.text.includes("AS remaining") ? [{ remaining: "2100", in_off_rooms: "180" }] : undefined),
      (c) => (c.text.includes("AS closed_hours") ? [{ closed_hours: "182", no_speakers: "41" }] : undefined),
    ]);
    expect(await makeStore(sql, CFG).summarize()).toEqual({
      fixture_windows: 4, fixture_need_asr: 1, fixture_need_english_only: 1, fixture_skipped_native_english: 0, fixture_skipped_proxy: 1,
      backlog_remaining: 2100, backlog_in_transcript_off_rooms: 180, excluded_closed_hours: 182, excluded_no_speakers: 41,
    });
  });
});
