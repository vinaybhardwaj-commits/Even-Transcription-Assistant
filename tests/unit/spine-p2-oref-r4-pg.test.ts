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
const pg = pgContainer("eta-oref-p2r4");
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

d("oref R4 on postgres:16 with ALL migrations", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }, 300_000);
  afterAll(() => { pg.stop(); });
  beforeEach(() => { pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;"); });


  const live = (st: string) => num(`SELECT count(*) FROM spine_job WHERE status = '${st}'`);
  const snap = () => q("SELECT job_id, encounter_id, stage, cut_version, input_key, status, priority, attempts, next_attempt_at, lease_owner, lease_until, last_error_class, last_error_code, created_at, done_at FROM spine_job ORDER BY job_id");
  const setEnc = (set: string) => pg.exec(`UPDATE spine_encounter SET ${set};`);
  const enq = () => runSpineEnqueue(NOW) as unknown as Promise<Record<string, number>>;

  it("R4a: leased/done/failed/dead at the planned key are never touched (shadow and live, any status flip)", async () => {
    pulse(KA, iso(4), iso(4, 9));
    allShadow();
    await runSpineMerge(NOW); await enq();
    const sts = ["leased", "done", "failed", "dead", "leased"];
    pg.exec(`UPDATE spine_job SET status = (ARRAY['${sts.join("','")}'])[job_id], attempts = 3, next_attempt_at = '2026-10-18T09:00:00Z', lease_owner = 'w_test', lease_until = '2026-10-18T09:00:00Z', last_error_class = 'transient', last_error_code = 'e_test', done_at = '2026-10-18T07:00:00Z';`);
    const plain = () => snap().then((rs) => rs.filter((x) => !String(x.input_key).startsWith("sp:")));
    const before = await plain();
    for (const cfg of [allShadow, allLive]) { cfg(); await enq(); setEnc("flags = ARRAY['ambiguous']"); await enq(); setEnc("flags = ARRAY[]::text[]"); await enq(); setEnc("status = 'confirmed_single_proxy'"); await enq(); setEnc("status = 'confirmed'"); await enq(); }
    expect(await plain()).toEqual(before);
  });

  it("R4b: a revived superseded row has exactly the columns of a fresh row (same job_id, no new row); rerun writes 0 rows and changes nothing", async () => {
    pulse(KA, iso(4), iso(4, 9));
    pulse(KB, iso(5), iso(5, 9));
    allShadow();
    await runSpineMerge(NOW); await enq();
    const ids = (await q("SELECT encounter_id FROM spine_encounter ORDER BY t_open")).map((r) => String(r.encounter_id));
    const idsA = (await q(`SELECT job_id FROM spine_job WHERE encounter_id = '${ids[0]}' ORDER BY job_id`)).map((r) => Number(r.job_id));
    pg.exec(`UPDATE spine_job SET status = 'superseded', attempts = 4, next_attempt_at = '2026-10-18T09:00:00Z', lease_owner = 'w_test', lease_until = '2026-10-18T09:00:00Z', last_error_class = 'permanent', last_error_code = 'e_test', done_at = '2026-10-18T07:00:00Z' WHERE encounter_id = '${ids[0]}';`);
    pg.exec(`DELETE FROM spine_job WHERE encounter_id = '${ids[1]}';`);
    const c = await enq();
    expect(c.shadow).toBe(10);
    const rows = await q("SELECT job_id, encounter_id, stage, status, priority, attempts, next_attempt_at, lease_owner, lease_until, last_error_class, last_error_code, done_at FROM spine_job ORDER BY encounter_id, stage");
    expect(rows.length).toBe(10);
    const strip = (r: Record<string, unknown>) => { const { job_id: _a, encounter_id: _b, ...rest } = r; return rest; };
    const a = rows.filter((r) => r.encounter_id === ids[0]), b = rows.filter((r) => r.encounter_id === ids[1]);
    expect(a.map(strip)).toEqual(b.map(strip));
    expect(a.map((r) => Number(r.job_id)).sort((x, y) => x - y)).toEqual(idsA);
    const s0 = await snap();
    const c2 = await enq();
    expect([c2.shadow, c2.queued, c2.superseded]).toEqual([0, 0, 0]);
    expect(await snap()).toEqual(s0);
  });

  it("R4c: live — a superseded confirmed row revives as queued only when its needs are done; sp rows revive as shadow", async () => {
    pulse(KA, iso(4), iso(4, 9));
    timeline(KB, iso(6), iso(6, 9));
    allLive();
    await runSpineMerge(NOW); await enq();
    // recut queued for the confirmed one only (needs gate), sp all 5 shadow
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key LIKE 'sp:%' AND status = 'shadow'")).toBe(5);
    pg.exec("UPDATE spine_job SET status = 'superseded' WHERE input_key NOT LIKE 'sp:%' OR stage IN ('recut','freescript');");
    pg.exec("UPDATE spine_job SET status = 'superseded' WHERE input_key LIKE 'sp:%';");
    await enq();
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key LIKE 'sp:%' AND status <> 'shadow'")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key NOT LIKE 'sp:%' AND status = 'queued'")).toBe(1);
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key NOT LIKE 'sp:%' AND stage = 'recut' AND status = 'queued'")).toBe(1);
    pg.exec("UPDATE spine_job SET status = 'done' WHERE stage = 'recut' AND input_key NOT LIKE 'sp:%';");
    await enq();
    expect((await q("SELECT stage FROM spine_job WHERE input_key NOT LIKE 'sp:%' AND status = 'queued' ORDER BY stage")).map((r) => r.stage)).toEqual(["acoustics", "collector", "nemotron"]);
  });

  it("R4d: random config sweep (60): after every flap, an sp row is never queued; every planned key is live exactly once; rerun writes 0", async () => {
    let seed = 7; const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const MODES = ['"off"', '"shadow"', '"live"', '{"mode":"live"}', '"LIVE"', '42'];
    timeline(KA, iso(4), iso(4, 9));
    allShadow(); await runSpineMerge(NOW);
    for (let i = 0; i < 60; i++) {
      pg.exec("DELETE FROM spine_config WHERE key <> 'merge';");
      setConfig("jobs", pick(MODES)); for (const s of FREE_STAGES) setConfig(`mode.${s}`, pick(MODES));
      if (r() < 0.15) setConfig("kill_switch", pick(["true", "false", '"no"']));
      setEnc(`status = '${pick(["confirmed", "confirmed_single_proxy", "candidate", "confirmed_single_proxy"])}', flags = ${pick(["ARRAY[]::text[]", "ARRAY['ambiguous']"])}`);
      if (r() < 0.2) pg.exec("UPDATE spine_job SET status = 'done' WHERE stage = 'recut' AND status IN ('shadow','superseded');");
      await enq();
      expect(await num("SELECT count(*) FROM spine_job WHERE input_key LIKE 'sp:%' AND status = 'queued'")).toBe(0);
      expect(await num("SELECT count(*) FROM (SELECT encounter_id, stage, cut_version, input_key FROM spine_job GROUP BY 1,2,3,4 HAVING count(*) > 1) z")).toBe(0);
      const s0 = await snap(); const c2 = await enq();
      if (!("skipped" in c2)) expect([c2.shadow, c2.queued, c2.superseded]).toEqual([0, 0, 0]);
      expect(await snap()).toEqual(s0);
    }
  });

  it("R4 flap 1: demote/re-promote twice (confirmed -> sp -> confirmed -> sp -> confirmed): 10 rows total, live set always matches status", async () => {
    pulse(KA, iso(4), iso(4, 9));
    allShadow(); await runSpineMerge(NOW); await enq();
    for (const s of ["confirmed_single_proxy", "confirmed", "confirmed_single_proxy", "confirmed"]) {
      setEnc(`status = '${s}'`); await enq();
      const sp = s === "confirmed_single_proxy";
      expect(await num(`SELECT count(*) FROM spine_job WHERE status = 'shadow' AND (input_key LIKE 'sp:%') = ${sp}`)).toBe(5);
      expect(await num(`SELECT count(*) FROM spine_job WHERE status = 'superseded' AND (input_key LIKE 'sp:%') = ${!sp}`)).toBe(5);
    }
    expect(await num("SELECT count(*) FROM spine_job")).toBe(10);
  });

  it("R4 flap 2: ambiguous on/off/on, shadow then live: freescript superseded/revived/superseded; the other 4 untouched", async () => {
    pulse(KA, iso(4), iso(4, 9));
    allShadow(); await runSpineMerge(NOW); await enq();
    const other = async () => snap().then((rs) => rs.filter((x) => x.stage !== "freescript"));
    const o0 = await other();
    const fs = async () => String((await q("SELECT status FROM spine_job WHERE stage = 'freescript'"))[0].status);
    const seq: Array<[string, string]> = [["ARRAY['ambiguous']", "superseded"], ["ARRAY[]::text[]", "shadow"], ["ARRAY['ambiguous']", "superseded"]];
    for (const [f, want] of seq) { setEnc(`flags = ${f}`); await enq(); expect(await fs()).toBe(want); }
    expect(await other()).toEqual(o0);
    allLive(); pg.exec("UPDATE spine_job SET status = 'done' WHERE stage = 'collector';");
    for (const [f, want] of [["ARRAY[]::text[]", "queued"], ["ARRAY['ambiguous']", "superseded"], ["ARRAY[]::text[]", "queued"]] as Array<[string, string]>) { setEnc(`flags = ${f}`); await enq(); expect(await fs()).toBe(want); }
    expect(await num("SELECT count(*) FROM spine_job")).toBe(5);
    expect(await num("SELECT attempts FROM spine_job WHERE stage = 'freescript'")).toBe(0);
  });

  it("R4 flap 3: sp r0 -> confirmed r1 (boundary move) -> sp r1 -> confirmed r1; old-cut rows never revived, new cut flips correctly", async () => {
    timeline(KA, iso(4), iso(4, 9));
    allShadow(); await runSpineMerge(NOW); await enq();
    const cnt = (cut: string, sp: boolean, st: string) => num(`SELECT count(*) FROM spine_job WHERE cut_version = '${cut}' AND (input_key LIKE 'sp:%') = ${sp} AND status = '${st}'`);
    expect(await cnt("r0", true, "shadow")).toBe(5);
    setEnc("status = 'confirmed', boundary_rev = 1"); await enq();
    expect(await cnt("r0", true, "superseded")).toBe(5); expect(await cnt("r1", false, "shadow")).toBe(5);
    setEnc("status = 'confirmed_single_proxy'"); await enq();
    expect(await cnt("r0", true, "superseded")).toBe(5); expect(await cnt("r1", false, "superseded")).toBe(5); expect(await cnt("r1", true, "shadow")).toBe(5);
    setEnc("status = 'confirmed'"); await enq();
    expect(await cnt("r0", true, "superseded")).toBe(5); expect(await cnt("r1", true, "superseded")).toBe(5); expect(await cnt("r1", false, "shadow")).toBe(5);
    expect(await num("SELECT count(*) FROM spine_job")).toBe(15);
  });

  it("R4 merged/rejected then back at the same cut, and flag-off: off/killed/default never revive or write", async () => {
    pulse(KA, iso(4), iso(4, 9));
    allShadow(); await runSpineMerge(NOW); await enq();
    setEnc("status = 'rejected'"); await enq();
    expect(await live("superseded")).toBe(5);
    setEnc("status = 'confirmed'");
    const s0 = await snap(); const t0 = await num("SELECT count(*) FROM spine_tick");
    for (const off of [() => pg.exec("DELETE FROM spine_config;"), () => { allLive(); setConfig("kill_switch", "true"); }, () => { pg.exec("DELETE FROM spine_config;"); setConfig("jobs", '"bogus"'); }, () => { allShadow(); setConfig("jobs", '"off"'); }]) {
      off(); expect(await enq()).toEqual({ skipped: "off" });
    }
    expect(await snap()).toEqual(s0); expect(await num("SELECT count(*) FROM spine_tick")).toBe(t0);
    allShadow(); await enq(); expect(await live("shadow")).toBe(5);
  });

  it("R4 LOW: ambiguous_no_freescript counts confirmed + sp (past grace, not frozen), not candidate", async () => {
    pulse(KA, iso(4), iso(4, 9)); pulse(KB, iso(5), iso(5, 9)); pulse(KEYS[2], iso(6), iso(6, 9));
    timeline("uidtestddddddddddddddddddd@mach_test", iso(6, 30), iso(6, 39)); timeline("uidtesteeeeeeeeeeeeeeeeeee@mach_test", iso(7, 40), iso(7, 50), { received: iso(7, 55) });
    allShadow(); await runSpineMerge(NOW);
    const ids = (await q("SELECT encounter_id FROM spine_encounter WHERE status <> 'merged' ORDER BY t_open")).map((r) => String(r.encounter_id));
    expect(ids.length).toBe(5);
    const st = ["confirmed", "confirmed_single_proxy", "candidate", "confirmed_single_proxy", "confirmed_single_proxy"];
    const fl = ["ARRAY['ambiguous']", "ARRAY['ambiguous']", "ARRAY['ambiguous']", "ARRAY['ambiguous','frozen']", "ARRAY['ambiguous']"];
    ids.forEach((id, i) => pg.exec(`UPDATE spine_encounter SET status = '${st[i]}', flags = ${fl[i]} WHERE encounter_id = '${id}';`));
    const c = await enq();
    expect(c.ambiguous_no_freescript).toBe(2); // confirmed + sp; candidate, frozen sp and the in-grace sp (closes 07:50) are not counted
  });

  it("N2: the tick carries totals (rows per status for the pass's encounters), read after the insert, on a first pass and on a rerun", async () => {
    const empty = await enq();
    expect(empty).toEqual({ skipped: "off" });             // no config yet: skipped, nothing to total
    pulse(KA, iso(4), iso(4, 9));
    allShadow(); await runSpineMerge(NOW);
    const first = (await enq()) as unknown as { shadow: number; queued: number; by_stage: Record<string, number>; totals: Record<string, number> };
    expect(first.shadow).toBeGreaterThan(0);
    expect(first.totals).toEqual({ shadow: first.shadow });
    const rerun = (await enq()) as unknown as typeof first;
    expect(rerun.shadow).toBe(0); expect(rerun.by_stage).toEqual({});
    expect(rerun.totals).toEqual(first.totals);             // self-explaining: the 0 is "already there", not "nothing planned"
    expect(await num("SELECT count(*) FROM spine_job")).toBe(first.shadow);
    const tick = await q("SELECT counts FROM spine_tick WHERE kind = 'enqueue' ORDER BY id DESC LIMIT 1");
    expect((tick[0].counts as Record<string, unknown>).totals).toEqual(first.totals);
    allLive();                                                // shadow rows are promoted: totals follow the status, per-pass fields unchanged in meaning
    const live2 = (await enq()) as unknown as typeof first;
    expect(Object.values(live2.totals).reduce((a, b) => a + b, 0)).toBe(first.shadow);
    expect(live2.totals.shadow ?? 0).toBe(first.shadow - live2.queued);
  });
});
