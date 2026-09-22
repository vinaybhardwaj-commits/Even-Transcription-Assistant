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
import { makeStore, fixtureVerdict, isClosedHourIst, RETRY_MAX_ATTEMPTS, RETRY_ACTOR, RECENT_WINDOW_ACTIVITY_MINUTES, type SqlTag } from "@/lib/overnight-translate/select";
import { ACTOR, DEFAULT_MAX_FAILED_JOBS } from "@/lib/overnight-translate/driver";

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
      retry_pending: 0, parked: 0,
      backlog_remaining: 2100, backlog_in_transcript_off_rooms: 180, excluded_closed_hours: 182, excluded_no_speakers: 41,
    });
  });
});


// ===========================================================================
// THE CANARY RETRY (V's engineering ruling, 21 Sep 2026, RULINGS-21-SEP-1730)
const isRetryQuery = (c: Call) => c.text.includes("JOIN LATERAL") && !c.text.includes("LEFT JOIN LATERAL") && !c.text.includes("AS remaining");
const retryRow = (over: Record<string, unknown> = {}) => ({
  id: "bw_r1", room_id: "room_3", room_day_id: "rd_r", start_ms: "3000", end_ms: "903000", transcript_enabled: true,
  run_id: "tr_1", orig_len: 900, eng_len: 0, metrics_json: null, hour_ist: 0, no_speakers: false, attempts: 1, ...over,
});

describe("THE FAILED-JOBS PARK — this driver's OWN failures only, contention excluded (ETA-Refuter Finding 2, 22 Sep 2026)", () => {
  it(`DEFAULT_MAX_FAILED_JOBS is hardcoded 2, not merely self-consistent (nothing pinned it before)`, () => {
    expect(DEFAULT_MAX_FAILED_JOBS).toBe(2);
  });

  it("EVERY selection query's failed-jobs count is scoped to THIS actor and excludes join_already_running " +
     "— checked unconditionally (a mutant that deforms the clause must not also escape the check that would catch it)", async () => {
    const { sql, calls } = fakeSql([]);
    const store = makeStore(sql, CFG);
    await store.next(new Set());
    await store.summarize();
    const jobQueries = calls.filter((c) => c.text.includes("j.kind = 'room_window' AND j.args->>'window_id' = w.id"));
    expect(jobQueries.length).toBeGreaterThanOrEqual(4);
    const exactClause = "j.status = 'failed' AND (j.error IS NULL OR j.error NOT LIKE '%join_already_running%')) < ?";
    const withClause = jobQueries.filter((c) => c.text.includes(exactClause));
    expect(withClause.length, "every one of them, not just some").toBe(jobQueries.length);
    // and each carries the actor as a bound value at least as many times as it appears in the text.
    for (const c of withClause) {
      const actorOccurrences = c.text.split("j.args->>'actor' = ?").length - 1;
      expect(actorOccurrences).toBeGreaterThanOrEqual(1);
      expect(c.values.filter((v) => v === RETRY_ACTOR).length, c.text.slice(0, 60)).toBeGreaterThanOrEqual(1);
    }
  });

  it("a configured actor (the driver's own ACTOR, not the retry default) reaches the failed-jobs count too", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, { ...CFG, actor: ACTOR }).next(new Set());
    const jobQueries = calls.filter((c) => c.text.includes("j.kind = 'room_window' AND j.args->>'window_id' = w.id"));
    for (const c of jobQueries) expect(c.values).toContain(ACTOR);
  });

  it("a cancelled job was already excluded — the count filters status = 'failed' only, never 'cancelled'", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const jobQueries = calls.filter((c) => c.text.includes("j.kind = 'room_window' AND j.args->>'window_id' = w.id"));
    for (const c of jobQueries) expect(c.text).not.toMatch(/status\s*=\s*'cancelled'/);
  });
});

describe("RECENT-ACTIVITY GUARD — a window with ANY room_window job (any actor) touched this recently is skipped (Fable, 22 Sep 2026 21:10, ETA-OVERNIGHT-FATALS-ROOTCAUSE)", () => {
  it("the default is hardcoded 5, not merely self-consistent — kills a mutant that changes the constant (ETA-Refuter Finding 3: mutation RECENT_ACTIVITY_MINUTES 5→0 survived)", () => {
    expect(RECENT_WINDOW_ACTIVITY_MINUTES).toBe(5);
  });


  it(`every selection query (fixture, retry pick, retry summary, backlog pick, backlog summary) carries the recency clause, bound to the default ${RECENT_WINDOW_ACTIVITY_MINUTES}`, async () => {
    const { sql, calls } = fakeSql([]);
    const store = makeStore(sql, CFG);
    await store.next(new Set());
    await store.summarize();
    // UNCONDITIONAL: every query that names `scribe_job` for the window at all must carry the clause. Filtering
    // by the clause's own shape first would let a mutant that deformed exactly this text slip past unnoticed.
    const jobQueries = calls.filter((c) => c.text.includes("j.kind = 'room_window' AND j.args->>'window_id' = w.id"));
    expect(jobQueries.length).toBeGreaterThanOrEqual(4);
    const withRecency = jobQueries.filter((c) => c.text.includes("OR j.updated_at > now() - make_interval(mins => ?))"));
    expect(withRecency.length, "every one of them, not just some").toBe(jobQueries.length);
    for (const c of withRecency) expect(c.values, c.text.slice(0, 60)).toContain(RECENT_WINDOW_ACTIVITY_MINUTES);
  });

  it("a configured recentWindowActivityMinutes overrides the default in every query, not just one", async () => {
    const { sql, calls } = fakeSql([]);
    const store = makeStore(sql, { ...CFG, recentWindowActivityMinutes: 15 });
    await store.next(new Set());
    await store.summarize();
    const withJobExclusion = calls.filter((c) => c.text.includes("make_interval(mins => ?)"));
    expect(withJobExclusion.length).toBeGreaterThanOrEqual(4);
    for (const c of withJobExclusion) {
      expect(c.values).toContain(15);
      expect(c.values).not.toContain(RECENT_WINDOW_ACTIVITY_MINUTES);
    }
  });

  it("the guard is an OR alongside queued/running, not a replacement — a queued/running job still excludes with no recency needed", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const backlog = calls.find((c) => c.text.includes("LIMIT 1") && !c.text.includes("LEFT JOIN LATERAL"))!;
    expect(backlog.text).toContain("j.status IN ('queued', 'running') OR j.updated_at > now() - make_interval(mins => ?)");
  });

  it("the exclusion is by window_id and kind alone — ANY actor's job counts, not just this driver's own", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const backlog = calls.find((c) => c.text.includes("LIMIT 1") && !c.text.includes("LEFT JOIN LATERAL"))!;
    const clause = backlog.text.slice(backlog.text.indexOf("AND NOT EXISTS"), backlog.text.indexOf("make_interval(mins => ?))") + 26);
    expect(clause, clause).not.toMatch(/actor/i);
  });
});

describe("THE CANARY RETRY — a window this driver ran that still has no English is re-picked, up to 3 attempts in all, then parked", () => {
  it("the bound is 3, the first attempt counts, and the actor is the driver's own", () => {
    expect(RETRY_MAX_ATTEMPTS).toBe(3);
    expect(RETRY_ACTOR, "select.ts's default must be the name the driver submits under").toBe(ACTOR);
  });

  it("comes AFTER the fixtures and BEFORE the never-transcribed backlog, and the backlog is not even asked when a retry is found", async () => {
    const { sql, calls } = fakeSql([(c) => (isRetryQuery(c) ? [retryRow()] : undefined), (c) => (isBacklogQuery(c) ? [backlogRow()] : undefined)]);
    const c = await makeStore(sql, CFG).next(new Set());
    expect(c).toMatchObject({ window_id: "bw_r1", klass: "retry", has_run: true, attempt: 2, room_transcript_on: true });
    expect(calls.filter(isBacklogQuery)).toHaveLength(0);
    const order = calls.map((x) => (isFixtureQuery(x) ? "fixture" : isRetryQuery(x) ? "retry" : "backlog"));
    expect(order.indexOf("fixture")).toBeLessThan(order.indexOf("retry"));
  });

  it("the attempt number is the count of finished attempts plus one: 1 -> 2, 2 -> 3", async () => {
    for (const [attempts, want] of [[1, 2], ["2", 3]] as const) {
      const { sql } = fakeSql([(c) => (isRetryQuery(c) ? [retryRow({ attempts })] : undefined)]);
      expect((await makeStore(sql, CFG).next(new Set()))!.attempt).toBe(want);
    }
  });

  it("a window with 3 finished attempts and still no English is PARKED: never returned, the scan falls through to the backlog", async () => {
    const { sql } = fakeSql([(c) => (isRetryQuery(c) ? [retryRow({ attempts: 3 }), retryRow({ id: "bw_r2", attempts: "4" })] : undefined), (c) => (isBacklogQuery(c) ? [backlogRow()] : undefined)]);
    expect((await makeStore(sql, CFG).next(new Set()))!.klass).toBe("backlog");
  });

  it("the SQL itself holds the bound: attempts < 3 is a bound parameter, and parked windows are only fetched when asked for (summarize)", async () => {
    const { sql, calls } = fakeSql([]);
    const store = makeStore(sql, CFG);
    await store.next(new Set());
    await store.summarize();
    const [forNext, forSummary] = calls.filter(isRetryQuery);
    expect(forNext!.values).toContain(RETRY_MAX_ATTEMPTS);
    expect(forNext!.values, "includeParked = false for a pick").toContain(false);
    expect(forSummary!.values, "includeParked = true for the count").toContain(true);
  });

  it("counts attempts as DONE translate jobs of this actor — nothing written anywhere, the state is the app's own job rows", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const q = calls.find(isRetryQuery)!;
    expect(q.text).toContain("j.args->>'actor' = ?");
    expect(q.text).toContain("j.args->>'translate' = 'true'");
    expect(q.text).toContain("j.status = 'done'");
    expect(q.values).toContain(RETRY_ACTOR);
    // ...in EVERY place it is needed: the attempts column, the attempts bound, and the EXISTS that says this driver ran the window at all
    // (attempts >= 1), so an older run from somewhere else with no English is never swept in — PLUS a 4th
    // 'actor' occurrence since ETA-Refuter Finding 2 (22 Sep 2026): the maxFailedJobs count is now ALSO
    // scoped to this actor, in this same retry query.
    expect(q.text.split("j.args->>'actor' = ?").length - 1, "actor: 3 original + 1 from the failed-count scope").toBe(4);
    for (const frag of ["j.args->>'translate' = 'true'", "j.status = 'done'"]) {
      expect(q.text.split(frag).length - 1, frag).toBe(3);
    }
  });

  // Q5 — the SQL half of the attempts bound. The TypeScript verdict (fixtureVerdict, `>= RETRY_MAX_ATTEMPTS`) is a second guard for the
  // same rule; these pin the STATEMENT, so removing the verdict in favour of "the SQL already does it" would still be caught, and so
  // would a `<` quietly becoming `<=` (which lets a 4th attempt through the statement).
  it("the SQL holds the attempts bound itself: a strict `< ?` on the count of done attempts, parked windows only when asked for", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const q = calls.find(isRetryQuery)!;
    expect(q.text).toContain("AND (?::boolean OR (SELECT count(*) FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id");
    expect(q.text, "the bound compares the attempts count strictly: < ?, once").toContain("AND j.args->>'translate' = 'true' AND j.status = 'done') < ?)");
    expect(q.text.split("j.status = 'done') < ?)").length - 1).toBe(1);
    expect(q.text, "never <=").not.toMatch(/j\.status = 'done'\)\s*<=/);
    expect(q.text, "never a literal in place of the parameter").not.toMatch(/j\.status = 'done'\)\s*<\s*\d/);
  });

  // Q6 — the row cap. LIVE-RELEVANT: 211 windows already have text and no English on their newest run (Refuter, 21 Sep, read-only), which is
  // MORE than 200, so correctness depends on the scan being re-run with a growing skip list rather than on one pass. The cap therefore has to
  // be there, and at this number: without it a pick would pull every such row, and a different number changes how many passes it takes.
  it("the retry scan is capped at 200 rows, oldest first, in the statement text (the same way the backlog pick is pinned)", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    await makeStore(sql, CFG).summarize();
    const retry = calls.filter(isRetryQuery);
    expect(retry.length, "one for the pick, one for the summary count").toBe(2);
    for (const q of retry) {
      expect(q.text).toContain("ORDER BY w.end_ms ASC, w.id ASC LIMIT 200");
      expect(q.text.endsWith("LIMIT 200")).toBe(true);
    }
  });

  it("the retry scan ends its order and cap exactly like the backlog pick ends its order and cap, only with a different number", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const backlog = calls.find(isBacklogQuery)!.text;
    const retry = calls.find(isRetryQuery)!.text;
    expect(backlog).toContain("ORDER BY w.end_ms ASC, w.id ASC LIMIT 1");
    expect(retry.slice(retry.indexOf("ORDER BY w.end_ms"))).toBe("ORDER BY w.end_ms ASC, w.id ASC LIMIT 200");
  });

  it("an actor given in the config is the one sent (not the default)", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, { ...CFG, actor: "some-other-actor" }).next(new Set());
    expect(calls.find(isRetryQuery)!.values).toContain("some-other-actor");
    expect(calls.find(isRetryQuery)!.values).not.toContain(RETRY_ACTOR);
  });

  it("only a window whose NEWEST run has text and no English, that this driver ran, and that has no job in flight", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set());
    const q = calls.find(isRetryQuery)!;
    expect(q.text).toContain("length(coalesce(t.transcript_original, '')) > 0");
    expect(q.text).toContain("length(coalesce(t.transcript_english, '')) = 0");
    expect(q.text).toContain("ORDER BY created_at DESC FETCH FIRST 1 ROW ONLY");
    expect(q.text).toContain("EXISTS ( SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window'");
    expect(q.text).toContain("j.status IN ('queued', 'running')");
    expect(q.text).toContain("j.status = 'failed' AND (j.error IS NULL OR j.error NOT LIKE '%join_already_running%')) < ?");
  });

  it("does not take a fixture room-day (the fixture path holds the same bound) and skips windows already tried this run", async () => {
    const { sql, calls } = fakeSql([]);
    await makeStore(sql, CFG).next(new Set(["bw_x", "bw_y"]));
    const q = calls.find(isRetryQuery)!;
    expect(q.text).toContain("w.room_day_id <> ALL(?::text[])");
    expect(q.values).toContainEqual(["rd_fix1", "rd_fix2"]);
    expect(q.values[q.values.length - 1]).toEqual(["bw_x", "bw_y"]);
  });

  it("a NATIVE-English run is not this driver's to redo (same J0 rule as the fixtures)", async () => {
    const native = { full_window_language: "english", sarvam_language: "en", language_timeline: { language_mix: { en: 3, und: 1 } } };
    const { sql } = fakeSql([(c) => (isRetryQuery(c) ? [retryRow({ metrics_json: native })] : undefined), (c) => (isBacklogQuery(c) ? [backlogRow()] : undefined)]);
    expect((await makeStore(sql, CFG).next(new Set()))!.klass).toBe("backlog");
  });

  it("a retry scan that came up empty is not run again on the next pick in the same run", async () => {
    const { sql, calls } = fakeSql([(c) => (isBacklogQuery(c) ? [backlogRow(), backlogRow({ id: "bw_b2" })] : undefined)]);
    const store = makeStore(sql, CFG);
    await store.next(new Set());
    await store.next(new Set(["bw_b1"]));
    expect(calls.filter(isRetryQuery)).toHaveLength(1);
  });

  it("a Transcript-OFF room is retried like any other, flagged so the job carries the override", async () => {
    const { sql } = fakeSql([(c) => (isRetryQuery(c) ? [retryRow({ transcript_enabled: false })] : undefined)]);
    expect((await makeStore(sql, CFG).next(new Set()))!.room_transcript_on).toBe(false);
  });

  it("the FIXTURE path holds the same bound: a fixture window re-driven 3 times with no English is parked, not picked", async () => {
    const base = { run_id: "tr_1", orig_len: 500, eng_len: 0 };
    expect(fixtureVerdict(fixtureRow({ ...base, attempts: 2 }))).toBe("english_only");
    expect(fixtureVerdict(fixtureRow({ ...base, attempts: 3 }))).toBe("skip_parked");
    expect(fixtureVerdict(fixtureRow({ ...base }))).toBe("english_only");
    const { sql } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow({ ...base, attempts: 3 })] : undefined), (c) => (isBacklogQuery(c) ? [backlogRow()] : undefined)]);
    expect((await makeStore(sql, CFG).next(new Set()))!.klass).toBe("backlog");
  });

  it("a fixture candidate carries its attempt number too", async () => {
    const { sql } = fakeSql([(c) => (isFixtureQuery(c) ? [fixtureRow({ run_id: "tr_1", orig_len: 500, eng_len: 0, attempts: 1 })] : undefined)]);
    expect((await makeStore(sql, CFG).next(new Set()))).toMatchObject({ klass: "fixture", attempt: 2 });
  });

  it("summarize counts the retries pending and the parked ones (retry scan + fixtures), so a parked window is COUNTED, not forgotten", async () => {
    const { sql } = fakeSql([
      (c) => (isFixtureQuery(c) ? [fixtureRow({ id: "f", run_id: "t", orig_len: 10, eng_len: 0, attempts: 3 })] : undefined),
      (c) => (isRetryQuery(c) ? [retryRow({ id: "r1", attempts: 1 }), retryRow({ id: "r2", attempts: 2 }), retryRow({ id: "r3", attempts: 3 })] : undefined),
      (c) => (c.text.includes("AS remaining") ? [{ remaining: "10", in_off_rooms: "1" }] : undefined),
      (c) => (c.text.includes("AS closed_hours") ? [{ closed_hours: "0", no_speakers: "0" }] : undefined),
    ]);
    expect(await makeStore(sql, CFG).summarize()).toMatchObject({ retry_pending: 2, parked: 2, fixture_need_english_only: 0 });
  });

  it("every statement the retry adds is still a read", async () => {
    const { sql, calls } = fakeSql([]);
    const store = makeStore(sql, CFG);
    await store.next(new Set());
    await store.summarize();
    for (const c of calls.filter(isRetryQuery)) {
      expect(c.text).toMatch(/^SELECT\b/);
      expect(c.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|COPY)\b/i);
    }
  });
});
