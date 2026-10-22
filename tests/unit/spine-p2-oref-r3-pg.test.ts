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
const pg = pgContainer("eta-oref-p2r3");
const d = HAVE ? describe : describe.skip;

const KEYS = ["uidtestaaaaaaaaaaaaaaaaa@mach_test", "uidtestbbbbbbbbbbbbbbbbb@mach_test", "uidtestccccccccccccccccc@mach_test"];
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

d("oref R3 on postgres:16 with ALL migrations", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }, 300_000);
  afterAll(() => { pg.stop(); });
  beforeEach(() => { pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;"); });


  it("DEFECT: flag flap at the same cut — confirmed loses freescript on `ambiguous`, and gets it back when `ambiguous` clears", async () => {
    pulse(KA, iso(4), iso(4, 9));
    allShadow();
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    pg.exec("UPDATE spine_encounter SET flags = ARRAY['ambiguous'];");
    await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'freescript' AND status = 'superseded'")).toBe(1);
    pg.exec("UPDATE spine_encounter SET flags = ARRAY[]::text[];");
    await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'freescript' AND status IN ('shadow','queued')")).toBe(1);
  });


  it("DEFECT: demotion and re-promotion at the same cut (sp -> confirmed -> sp -> confirmed) leaves the confirmed encounter with live job rows", async () => {
    timeline(KA, iso(4), iso(4, 9));
    allShadow();
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    const flip = async (s: string) => { pg.exec(`UPDATE spine_encounter SET status = '${s}';`); await runSpineEnqueue(NOW); };
    await flip("confirmed"); await flip("confirmed_single_proxy"); await flip("confirmed");
    // the encounter is confirmed: it must have its 5 normal-keyed rows not superseded
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key NOT LIKE 'sp:%' AND status = 'shadow'")).toBe(5);
    await flip("confirmed_single_proxy");
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key LIKE 'sp:%' AND status = 'shadow'")).toBe(5);
  });

  it("DEFECT: real merge, same id: sp + acoustic -> confirmed (weak_agree), acoustic revised away -> sp again; the sp encounter must have live sp rows", async () => {
    timeline(KA, iso(4), iso(4, 9));
    allShadow();
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    const id0 = String((await q("SELECT encounter_id FROM spine_encounter"))[0].encounter_id);
    sig("acoustic", "rd_abcd2345:ac1", iso(4), iso(4, 9), { ids: { room_day_id: "rd_abcd2345" }, close_reason: "non_speech" }, { received: iso(7, 30) });
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    expect((await q("SELECT status, reason, boundary_rev FROM spine_encounter WHERE status <> 'merged'"))).toEqual([{ status: "confirmed", reason: "weak_agree", boundary_rev: 0 }]);
    sig("acoustic", "rd_abcd2345:ac1", iso(6), iso(6, 9), { ids: { room_day_id: "rd_abcd2345" }, close_reason: "non_speech" }, { rev: 2, received: iso(7, 45) });
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    const e = await q(`SELECT status, boundary_rev FROM spine_encounter WHERE encounter_id = '${id0}'`);
    expect(e).toEqual([{ status: "confirmed_single_proxy", boundary_rev: 0 }]);
    expect(await num(`SELECT count(*) FROM spine_job WHERE encounter_id = '${id0}' AND status = 'shadow' AND input_key LIKE 'sp:%'`)).toBe(5);
  });

});
