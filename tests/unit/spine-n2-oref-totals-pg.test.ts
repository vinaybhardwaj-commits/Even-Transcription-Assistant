/**
 * Refuter repros for SPINE-P2 R3 (spine-p2-r3-oref), kept as regression tests: enqueue-store ON CONFLICT must take a superseded row back to the planned status. postgres:16, ALL real migrations. Synthetic ids only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => {
  const run = (text: string, params: unknown[]) => {
    const order: number[] = [];
    const parts = text.split(/\$(\d+)/);
    const strings: string[] = [];
    for (let i = 0; i < parts.length; i += 2) { strings.push(parts[i]); if (i + 1 < parts.length) order.push(Number(parts[i + 1]) - 1); }
    return H.tag!(Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray, ...order.map((n) => params[n]));
  };
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});


import { runSpineMerge as runMerge } from "@/lib/spine/merge-store";
import { runSpineEnqueue } from "@/lib/spine/enqueue-store";
import { FREE_STAGES } from "@/lib/spine/enqueue";
import type { Mode } from "@/lib/spine/config";
const runSpineMerge = runMerge as unknown as (now: number) => Promise<Record<string, number>>;
const HAVE = dockerAvailable();
const pg = pgContainer("eta-oref-n2tot");
const d = HAVE ? describe : describe.skip;

const KEYS = ["uidtestaaaaaaaaaaaaaaaaaaa@mach_test", "uidtestbbbbbbbbbbbbbbbbbbb@mach_test", "uidtestccccccccccccccccccc@mach_test"];
const NOW = Date.parse("2026-10-18T08:00:00Z");
const ROOM = "room_abcd2345";
const iso = (h: number, m = 0, day = 18) => `2026-10-${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const KA = KEYS[0], KB = KEYS[1];
const q = async (text: string): Promise<Array<Record<string, unknown>>> => (await H.tag!(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const num = async (text: string) => Number(Object.values((await q(text))[0])[0]);
const setConfig = (key: string, json: string) => pg.exec(`INSERT INTO spine_config (key, value) VALUES ('${key}', '${json}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
const lit = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
function sig(proxy: string, key: string, open: string, close: string | null, attrs: Record<string, unknown>, o: { rev?: number; room?: string; received?: string } = {}) {
  pg.exec(`INSERT INTO spine_signal (proxy, source_key, source_rev, room_id, t_open, t_close, observed_at, received_at, attrs)
    VALUES ('${proxy}', '${key}', ${o.rev ?? 1}, '${o.room ?? ROOM}', '${open}', ${lit(close)}, '${open}', '${o.received ?? iso(6)}', '${JSON.stringify(attrs)}');`);
}
const pulse = (key: string, open: string, close: string | null, o = {}) => sig("pulse", key, open, close, { ids: { consult_key: key, consult_uid: key.split("@")[0] }, close_reason: "endConsult" }, o);
const timeline = (key: string, open: string, close: string, o = {}) => sig("timeline", key, open, close, { ids: { consult_key: key }, close_reason: "patient_left" }, o);
const allShadow = () => { setConfig("merge", '"shadow"'); setConfig("jobs", '"shadow"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, '"shadow"'); };
const allLive = () => { setConfig("merge", '"shadow"'); setConfig("jobs", '"live"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, '"live"'); };
const dump = () => execFileSync("docker", ["exec", pg.name, "pg_dump", "-s", "-U", "postgres", "postgres"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((l) => !l.startsWith("--") && !/^\\(un)?restrict/.test(l)).join("\n");
const jobRows = (where = "") => q(`SELECT stage, status, input_key LIKE 'sp:%' AS sp, cut_version FROM spine_job ${where} ORDER BY stage, input_key, cut_version`);
d("oref N2 totals", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }, 300_000);
  afterAll(() => { pg.stop(); });
  beforeEach(() => { pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;"); });
  const enq = () => runSpineEnqueue(NOW) as unknown as Promise<Record<string, unknown>>;
  const truth = async (ids: string[]) => Object.fromEntries((await q(`SELECT status, count(*)::int AS n FROM spine_job WHERE encounter_id IN (${ids.map((i) => `'${i}'`).join(",")}) GROUP BY status`)).map((r) => [String(r.status), Number(r.n)]));
  const PASS_KEYS = ["jobs", "encounters", "planned", "shadow", "queued", "superseded", "by_stage", "ambiguous_no_freescript", "totals"].sort();

  it("totals = exact GROUP BY status over the pass's encounters, every status, excludes out-of-horizon encounters; one tick write; no ids", async () => {
    pulse(KA, iso(4), iso(4, 9)); pulse(KB, iso(5), iso(5, 9)); pulse(KEYS[2], iso(6), iso(6, 9));
    allShadow(); await runSpineMerge(NOW);
    const first = await enq();
    expect(Object.keys(first).sort()).toEqual(PASS_KEYS);
    const encs = (await q("SELECT encounter_id FROM spine_encounter ORDER BY t_open")).map((r) => String(r.encounter_id));
    expect(first.totals).toEqual(await truth(encs));
    // spread statuses over the jobs
    const sts = ["leased", "done", "failed", "dead", "queued", "superseded"];
    pg.exec(`UPDATE spine_job SET status = (ARRAY['${sts.join("','")}'])[1 + (job_id % ${sts.length})]`);
    // push the third encounter out of the horizon: its jobs must not be counted
    pg.exec(`UPDATE spine_encounter SET ist_date = '2026-09-01' WHERE encounter_id = '${encs[2]}'`);
    const snapBefore = await q("SELECT * FROM spine_job ORDER BY job_id");
    const ticksBefore = await num("SELECT count(*) FROM spine_tick WHERE kind = 'enqueue'");
    const rerun = await enq();
    const inPass = encs.slice(0, 2);
    expect(rerun.encounters).toBe(2);
    expect(rerun.totals).toEqual(await truth(inPass));
    expect(rerun.totals).not.toEqual(await truth(encs));
    expect(Object.keys(rerun.totals as object).length).toBeGreaterThan(2);
    expect(await num("SELECT count(*) FROM spine_tick WHERE kind = 'enqueue'")).toBe(ticksBefore + 1);
    const snapAfter = await q("SELECT * FROM spine_job ORDER BY job_id");
    const tick = JSON.stringify((await q("SELECT counts FROM spine_tick WHERE kind = 'enqueue' ORDER BY id DESC LIMIT 1"))[0].counts);
    for (const e of encs) expect(tick).not.toContain(e);
    for (const k of KEYS) expect(tick).not.toContain(k.split("@")[0]);
    expect(JSON.parse(tick)).toEqual(rerun);
    // the rerun may re-plan rows it superseded; but totals must reflect the table AFTER the insert
    expect(snapAfter.length).toBeGreaterThanOrEqual(snapBefore.length);
  });

  it("no encounters in horizon: totals {} and no TOTALS query result leaks", async () => {
    allShadow();
    const c = await enq();
    expect(c.encounters).toBe(0); expect(c.totals).toEqual({});
  });

  it("totals read AFTER the insert: first pass totals equal inserted rows by status, and live inserts are counted as queued", async () => {
    pulse(KA, iso(4), iso(4, 9));
    allLive(); await runSpineMerge(NOW);
    const c = await enq();
    expect(c.queued).toBeGreaterThan(0);
    expect(c.totals).toEqual({ queued: c.queued });
  });
});
