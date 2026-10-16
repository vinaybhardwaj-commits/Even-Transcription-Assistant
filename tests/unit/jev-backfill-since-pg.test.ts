/**
 * JEV-C4-BACKFILL-SINCE, Jev side, on a REAL postgres:16 with every migration applied: parseBackfillSince (pure) and allTranscribedConsults' second pass
 * (JEV_CONSULT_BACKFILL_SINCE). Synthetic ids only; no text.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
vi.setConfig({ testTimeout: 180_000 });
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), sqlCalls: 0 }));
vi.mock("@/lib/db", () => ({ sql: (a: TemplateStringsArray, ...v: unknown[]) => { H.sqlCalls += 1; return H.tag!(a, ...v); } }));

import { allTranscribedConsults, parseBackfillSince, jevBackfillSince, BACKFILL_SINCE_FLOOR } from "@/lib/jev/worker/consult-eligible";
import { selectTranscribedConsults } from "@/lib/room-access/consult-select";

const HAVE = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-backfill-since");
const ALL = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
const suite = HAVE || !ALLOW_SKIP ? describe : describe.skip;
const TODAY0 = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
const SHA = "a".repeat(64);
let n = 0;
/** IST date `daysAgo` days before today (IST). */
const istDay = (daysAgo: number): string => new Date(Date.now() + 5.5 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);

function win(key: string, uid: string, o: { daysAgo?: number; min?: number; sec?: number; text?: boolean } = {}): void {
  const { daysAgo = 1, min = 0, sec = 0, text = true } = o;
  const open = `${TODAY0} - interval '${daysAgo} days' + interval '${min} minutes' + interval '${sec} seconds'`;
  pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
           VALUES ('${key}', '${uid}', 'mc_1', 'rm_a', 'none', ${open}, ${open} + interval '1 second', 'endConsult', 'clean', 'v_t')`);
  const st = text ? `{"sealed":{"state":"ok"},"stt":{"state":"ok"},"translate":{"state":"ok"}}` : `{"sealed":{"state":"ok"}}`;
  pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) VALUES ('${uid}', '${st}'::jsonb) ON CONFLICT DO NOTHING`);
}
const decide = (key: string, sha = SHA) =>
  pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer) VALUES ('jd_${++n}', 'consult', '${key}', 'q_1', 'pv', 'm', '${sha}', 'derived', 'shadow', '{"type":"none"}')`);
const wipe = () => pg.exec("DELETE FROM encounter_catalog; DELETE FROM jev_decision; DELETE FROM eta_encounter_windows;");
const ctx = { sha: SHA, mode: "shadow" };

describe("parseBackfillSince (pure)", () => {
  const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);      // 16 Oct 2026 17:30 IST
  it("absent, empty, blank and junk are OFF", () => {
    for (const v of [undefined, "", "   ", "junk", "2026-10-1", "2026/10/10", "2026-10-10T00:00:00", "20261010"]) expect(parseBackfillSince(v, NOW), String(v)).toBeNull();
    expect(parseBackfillSince(" 2026-10-10 ", NOW)).toBe("2026-10-10");      // surrounding blanks are trimmed
  });
  it("a date that is not on the calendar is OFF (31 Sep, 30 Feb, month 13)", () => {
    for (const v of ["2026-09-31", "2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00"]) expect(parseBackfillSince(v, NOW), v).toBeNull();
  });
  it("before the floor is OFF; the floor itself is on", () => {
    expect(BACKFILL_SINCE_FLOOR).toBe("2026-09-01");
    expect(parseBackfillSince("2026-08-31", NOW)).toBeNull();
    expect(parseBackfillSince("2026-09-01", NOW)).toBe("2026-09-01");
  });
  it("the future is OFF; today (IST) is on; the IST day is not the UTC day", () => {
    expect(parseBackfillSince("2026-10-17", NOW)).toBeNull();
    expect(parseBackfillSince("2026-10-16", NOW)).toBe("2026-10-16");
    const lateUtc = Date.UTC(2026, 9, 16, 19, 0, 0);      // 17 Oct 00:30 IST
    expect(parseBackfillSince("2026-10-17", lateUtc)).toBe("2026-10-17");
    expect(parseBackfillSince("2026-10-18", lateUtc)).toBeNull();
  });
  it("a valid date is on", () => { expect(parseBackfillSince("2026-09-09", NOW)).toBe("2026-09-09"); });
  it("jevBackfillSince reads JEV_CONSULT_BACKFILL_SINCE", () => {
    const old = process.env.JEV_CONSULT_BACKFILL_SINCE;
    try {
      delete process.env.JEV_CONSULT_BACKFILL_SINCE; expect(jevBackfillSince(NOW)).toBeNull();
      process.env.JEV_CONSULT_BACKFILL_SINCE = "2026-09-09"; expect(jevBackfillSince(NOW)).toBe("2026-09-09");
      process.env.JEV_CONSULT_BACKFILL_SINCE = "nope"; expect(jevBackfillSince(NOW)).toBeNull();
    } finally { if (old === undefined) delete process.env.JEV_CONSULT_BACKFILL_SINCE; else process.env.JEV_CONSULT_BACKFILL_SINCE = old; }
  });
});

suite("JEV consult backfill since — second pass", () => {
  beforeAll(() => {
    if (!HAVE) throw new Error("docker is required (set ETA_ALLOW_SKIP_E2E=1 to skip)");
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE ROLE brain_svc NOLOGIN;");
    for (const f of ALL) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }, 300_000);
  afterAll(() => pg.stop());
  beforeEach(() => { wipe(); H.sqlCalls = 0; delete process.env.JEV_CONSULT_BACKFILL_DAYS; });
  afterEach(() => { delete process.env.JEV_CONSULT_BACKFILL_SINCE; });
  const since = (daysAgo: number) => { process.env.JEV_CONSULT_BACKFILL_SINCE = istDay(daysAgo); };

  it("live consults are always first; the older ones follow, oldest first", async () => {
    win("cx_live1@ma", "u_live1", { daysAgo: 1 }); win("cx_live2@ma", "u_live2", { daysAgo: 2 });
    win("cx_old9@ma", "u_old9", { daysAgo: 9 }); win("cx_old10@ma", "u_old10", { daysAgo: 10 });
    since(12);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_live2@ma", "cx_live1@ma", "cx_old10@ma", "cx_old9@ma"]);
  });
  it("pass 2 runs only when pass 1 is short, and takes only the n - k left", async () => {
    win("cx_live1@ma", "u_live1", { daysAgo: 1 }); win("cx_live2@ma", "u_live2", { daysAgo: 2 });
    win("cx_old9@ma", "u_old9", { daysAgo: 9 }); win("cx_old10@ma", "u_old10", { daysAgo: 10 });
    since(12);
    H.sqlCalls = 0;
    expect(await allTranscribedConsults(2, ctx)).toEqual(["cx_live2@ma", "cx_live1@ma"]);
    expect(H.sqlCalls).toBe(1);
    H.sqlCalls = 0;
    expect(await allTranscribedConsults(3, ctx)).toEqual(["cx_live2@ma", "cx_live1@ma", "cx_old10@ma"]);
    expect(H.sqlCalls).toBe(2);
    H.sqlCalls = 0;
    expect(await allTranscribedConsults(1, ctx)).toEqual(["cx_live2@ma"]);
    expect(H.sqlCalls).toBe(1);
  });
  it("no overlap at the pass boundary: a consult exactly at the window start is pass 1's only; one second earlier is pass 2's only", async () => {
    win("cx_edge@ma", "u_edge", { daysAgo: 7 });
    win("cx_just_before@ma", "u_jb", { daysAgo: 7, sec: -1 });
    since(12);
    const out = await allTranscribedConsults(50, ctx);
    expect(out).toEqual(["cx_edge@ma", "cx_just_before@ma"]);      // live (pass 1) first
    expect(new Set(out).size).toBe(out.length);
    // pass 1 alone holds the edge row; pass 2 alone holds the earlier one
    expect(await selectTranscribedConsults(50, 7, SHA, "shadow", "consult")).toEqual(["cx_edge@ma"]);
    const { selectTranscribedConsultsBefore } = await import("@/lib/room-access/consult-select");
    expect(await selectTranscribedConsultsBefore(50, 7, istDay(12), SHA, "shadow", "consult")).toEqual(["cx_just_before@ma"]);
  });
  it("a uid with a window in each range is returned once, by its pass-1 key (never twice)", async () => {
    win("cx_a_old@ma", "u_split", { daysAgo: 9 });
    pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
             VALUES ('cx_z_new@ma', 'u_split', 'mc_1', 'rm_a', 'none', ${TODAY0} - interval '1 days', ${TODAY0} - interval '1 days' + interval '1 second', 'endConsult', 'clean', 'v_t')`);
    since(12);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_z_new@ma"]);
  });
  it("the SINCE bound is inclusive at 00:00 IST; one second earlier is out", async () => {
    win("cx_in@ma", "u_in", { daysAgo: 10 });
    win("cx_out@ma", "u_out", { daysAgo: 10, sec: -1 });
    since(10);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_in@ma"]);
  });
  it("a decided consult is excluded in pass 2 (for the same sha and mode), and an untranscribed one stays out", async () => {
    win("cx_old1@ma", "u_old1", { daysAgo: 9 }); win("cx_old2@ma", "u_old2", { daysAgo: 10 }); win("cx_old3@ma", "u_old3", { daysAgo: 11, text: false });
    decide("cx_old2@ma");
    since(12);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_old1@ma"]);
    expect(await allTranscribedConsults(50, { sha: "b".repeat(64), mode: "shadow" })).toEqual(["cx_old2@ma", "cx_old1@ma"]);
  });
  it("SINCE inside the live window gives an empty pass 2 (nothing doubled)", async () => {
    win("cx_live1@ma", "u_live1", { daysAgo: 1 });
    since(3);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_live1@ma"]);
  });
  it("OFF (absent, empty, junk, future, before the floor) matches the base on the same fixture and makes no second query", async () => {
    win("cx_live1@ma", "u_live1", { daysAgo: 1 }); win("cx_old9@ma", "u_old9", { daysAgo: 9 });
    const base = await selectTranscribedConsults(50, 7, SHA, "shadow", "consult");
    expect(base).toEqual(["cx_live1@ma"]);
    for (const v of [undefined, "", "junk", "2026-09-31", istDay(-3), "2026-08-01"]) {
      if (v === undefined) delete process.env.JEV_CONSULT_BACKFILL_SINCE; else process.env.JEV_CONSULT_BACKFILL_SINCE = v;
      H.sqlCalls = 0;
      expect(await allTranscribedConsults(50, ctx), String(v)).toEqual(base);
      expect(H.sqlCalls).toBe(1);
    }
  });
});
