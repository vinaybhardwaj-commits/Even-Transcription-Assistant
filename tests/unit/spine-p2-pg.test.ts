/**
 * spine-p2-pg.test.ts — SPINE-P2 writer (runSpineMerge) and shadow enqueuer (runSpineEnqueue) against a REAL postgres:16 (never on the Mini). Migration 0173 is the schema.
 * Only the driver is a stand-in (see spine-ingest-pg.test.ts); this one maps a repeated $n to the same parameter. Ids are synthetic; no text anywhere.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
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
  // the tag form (readModes) and the call form (text, params)
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});

import { runSpineMerge as runMerge } from "@/lib/spine/merge-store";
import { runSpineEnqueue } from "@/lib/spine/enqueue-store";
import { GET } from "@/app/api/cron/spine/route";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-p2");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");   // 0176 widens the status CHECK

describe("REQUIRED PROOF — spine P2 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-p2-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const NOW = Date.parse("2026-10-18T08:00:00Z");
const ROOM = "room_abcd2345";
const iso = (h: number, m = 0) => `2026-10-18T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const KA = "uidtestaaaaaaaaaaaaaaaaaaa@mach_test", KB = "uidtestbbbbbbbbbbbbbbbbbbb@mach_test";
const d = HAVE_DOCKER ? describe : describe.skip;
/** The merge counts when the step ran (the skipped shape has none of these); toEqual({skipped}) still works on it. */
type Ran = { mode: string; days: number; failed_days: number; encounters: number; enc_inserted: number; enc_updated: number; links_written: number; links_moved: number; assigned: number; held_frozen: number; ambiguous: number };
const runSpineMerge = runMerge as unknown as (now: number) => Promise<Ran>;

const q = async (text: string, ...v: unknown[]): Promise<Array<Record<string, unknown>>> => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const num = async (text: string) => Number(Object.values((await q(text))[0])[0]);
const setConfig = (key: string, json: string) => pg.exec(`INSERT INTO spine_config (key, value) VALUES ('${key}', '${json}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
const lit = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
function sig(proxy: string, key: string, open: string, close: string | null, attrs: Record<string, unknown>, o: { rev?: number; room?: string; received?: string } = {}) {
  pg.exec(`INSERT INTO spine_signal (proxy, source_key, source_rev, room_id, t_open, t_close, observed_at, received_at, attrs)
    VALUES ('${proxy}', '${key}', ${o.rev ?? 1}, '${o.room ?? ROOM}', '${open}', ${lit(close)}, '${open}', '${o.received ?? iso(6)}', '${JSON.stringify(attrs)}');`);
}
const pulse = (key: string, open: string, close: string, reason = "endConsult", o = {}) =>
  sig("pulse", key, open, close, { ids: { consult_key: key, consult_uid: key.split("@")[0] }, close_reason: reason }, o);
const timeline = (key: string, open: string, close: string, o = {}) => sig("timeline", key, open, close, { ids: { consult_key: key }, close_reason: "patient_left" }, o);
const acoustic = (n: number, open: string, close: string, o = {}) => sig("acoustic", `rd_abcd2345:ac${n}`, open, close, { ids: { room_day_id: "rd_abcd2345" }, close_reason: "non_speech" }, o);

const encs = () => q("SELECT encounter_id, status, reason, flags::text AS flags, boundary_rev, merged_into, t_open, t_close, updated_at FROM spine_encounter ORDER BY t_open, encounter_id");
const shape = async () => (await encs()).map((e) => ({ status: e.status, reason: e.reason, flags: e.flags, boundary_rev: e.boundary_rev, merged_into: e.merged_into }));

d("spine P2 writer and enqueuer on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); });
  beforeEach(() => { pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;"); });

  const fixture = () => { pulse(KA, iso(4), iso(4, 10)); timeline(KA, iso(4), iso(4, 9)); pulse(KB, iso(4, 30), iso(4, 45)); timeline(KB, iso(4, 30), iso(4, 44)); };

  it("merge gate: missing, off, malformed, killed -> skipped and nothing written, not even a tick", async () => {
    fixture();
    expect(await runSpineMerge(NOW)).toEqual({ skipped: "off" });
    for (const [merge, kill] of [['"off"', null], ['"on"', null], ['{"mode":"x"}', null], ['"shadow"', '{"on": true}'], ['"shadow"', '"yes"']] as const) {
      pg.exec("DELETE FROM spine_config;");
      setConfig("merge", merge); if (kill) setConfig("kill_switch", kill);
      expect(await runSpineMerge(NOW)).toEqual({ skipped: "off" });
    }
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_tick")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_signal WHERE encounter_id IS NOT NULL")).toBe(0);
  });

  it("a fixture day is written; a rerun writes 0 changes; the cursor then sees no changed day", async () => {
    fixture();
    setConfig("merge", '"shadow"');
    const c1 = await runSpineMerge(NOW);
    expect(c1).toMatchObject({ mode: "shadow", days: 1, failed_days: 0, encounters: 2, enc_inserted: 2, enc_updated: 0 });
    const e = await encs();
    expect(e.map((x) => x.status)).toEqual(["confirmed", "confirmed"]);
    expect(e.map((x) => x.reason)).toEqual(["pulse", "pulse"]);
    expect(await num("SELECT count(*) FROM spine_link WHERE active")).toBeGreaterThanOrEqual(4);   // consult_key + consult_uid per consult
    expect(await num("SELECT count(*) FROM spine_signal WHERE encounter_id IS NULL")).toBe(0);
    expect(await num("SELECT count(DISTINCT encounter_id) FROM spine_signal")).toBe(2);
    const before = await q("SELECT encounter_id, updated_at FROM spine_encounter ORDER BY 1");
    const c1b = await runSpineMerge(NOW);   // the cursor has passed the day: nothing to do
    expect(c1b).toMatchObject({ days: 0, encounters: 0 });
    pg.exec("DELETE FROM spine_tick;");     // forget the cursor: the whole day is merged AGAIN, and must change nothing
    const c2 = await runSpineMerge(NOW);
    expect(c2).toMatchObject({ days: 1, encounters: 2, enc_inserted: 0, enc_updated: 0, links_written: 0, links_moved: 0, assigned: 0, failed_days: 0 });
    expect(await q("SELECT encounter_id, updated_at FROM spine_encounter ORDER BY 1")).toEqual(before);
    expect(await num("SELECT count(*) FROM spine_tick WHERE kind = 'merge'")).toBe(1);
    // received_at is far behind NOW in this fixture: the cursor has passed it
    const c3 = await runSpineMerge(NOW + 3_600_000);
    expect(c3).toMatchObject({ days: 0, enc_inserted: 0 });
  });

  it("a late signal moves a boundary: boundary_rev + 1, same encounter_id, a new rev assigned", async () => {
    fixture();
    setConfig("merge", '"shadow"');
    await runSpineMerge(NOW);
    const first = await encs();
    pulse(KA, iso(4), iso(4, 14), "endConsult", { rev: 2, received: iso(7, 30) });
    const c = await runSpineMerge(NOW);
    expect(c).toMatchObject({ enc_updated: 1, enc_inserted: 0 });
    const after = await encs();
    expect(after.map((x) => x.encounter_id)).toEqual(first.map((x) => x.encounter_id));
    expect(after.map((x) => x.boundary_rev)).toEqual([1, 0]);
    expect(new Date(String(after[0].t_close)).toISOString()).toBe("2026-10-18T04:14:00.000Z");
  });

  it("a merge moves the loser's links by alias: the loser is `merged`, nothing is deleted, the old link row goes inactive", async () => {
    setConfig("merge", '"shadow"');
    sig("timeline", "tlkeyaaaaaaaaaaaaaaaaaaa@mach_test", iso(6), iso(6, 5), { ids: { consult_key: "tlkeyaaaaaaaaaaaaaaaaaaa@mach_test" }, close_reason: "patient_left" });
    sig("timeline", "tlkeybbbbbbbbbbbbbbbbbbb@mach_test", iso(6, 6), iso(6, 10), { ids: { consult_key: "tlkeybbbbbbbbbbbbbbbbbbb@mach_test" }, close_reason: "patient_left" });
    await runSpineMerge(NOW);
    const two = await encs();
    expect(two).toHaveLength(2);
    expect(two.map((x) => x.status)).toEqual(["confirmed_single_proxy", "confirmed_single_proxy"]);
    pulse(KA, iso(6), iso(6, 10), "endConsult", { received: iso(7, 30) });
    const c = await runSpineMerge(NOW);
    expect(c.links_moved).toBeGreaterThanOrEqual(1);
    const all = await encs();
    expect(all).toHaveLength(2);   // never deleted
    const merged = all.filter((x) => x.status === "merged");
    const live = all.filter((x) => x.status !== "merged");
    expect(merged).toHaveLength(1);
    expect(live).toHaveLength(1);
    expect(merged[0].merged_into).toBe(live[0].encounter_id);
    expect(live[0].status).toBe("confirmed");
    // every key resolves to exactly one ACTIVE owner, and the survivor owns the loser's key now
    expect(await num("SELECT count(*) FROM (SELECT key_kind, value FROM spine_link WHERE active GROUP BY 1, 2 HAVING count(*) > 1) x")).toBe(0);
    expect(await num(`SELECT count(*) FROM spine_link WHERE active AND encounter_id = '${merged[0].encounter_id}'`)).toBe(0);
    expect(await num(`SELECT count(*) FROM spine_link WHERE NOT active`)).toBeGreaterThanOrEqual(1);
    expect(await num(`SELECT count(*) FROM spine_signal WHERE encounter_id = '${merged[0].encounter_id}'`)).toBe(0);
  });

  it("ambiguous: a weak signal that fits two encounters flags the group `ambiguous`, and the enqueuer gives it no freescript", async () => {
    pulse(KA, iso(6), iso(6, 10)); pulse(KB, iso(6, 5), iso(6, 15));
    timeline("tlkeyzzzzzzzzzzzzzzzzzzz@mach_test", iso(6, 5), iso(6, 10));
    setConfig("merge", '"shadow"');
    const c = await runSpineMerge(NOW);
    expect(c.ambiguous).toBeGreaterThanOrEqual(1);
    expect(await num("SELECT count(*) FROM spine_encounter WHERE flags @> ARRAY['ambiguous']")).toBeGreaterThanOrEqual(1);
    expect(await num("SELECT count(*) FROM spine_encounter WHERE flags @> ARRAY['pulse_overlap']")).toBe(2);
    setConfig("jobs", '"shadow"'); for (const s of ["recut", "acoustics", "nemotron", "collector", "freescript"]) setConfig(`mode.${s}`, '"shadow"');
    await runSpineEnqueue(NOW);
    const amb = (await q("SELECT encounter_id FROM spine_encounter WHERE flags @> ARRAY['ambiguous']"))[0].encounter_id;
    expect(await num(`SELECT count(*) FROM spine_job WHERE encounter_id = '${amb}' AND stage = 'freescript'`)).toBe(0);
    expect(await num(`SELECT count(*) FROM spine_job WHERE encounter_id = '${amb}' AND stage = 'collector'`)).toBe(1);
    expect(await num(`SELECT count(*) FROM spine_job WHERE stage = 'freescript'`)).toBe(1);   // the other, unambiguous, encounter
  });

  it("held (R6): a new strong group on a past-horizon day is held, not minted; the count is persisted in the tick", async () => {
    pulse(KA, "2026-10-10T04:00:00Z", "2026-10-10T04:10:00Z");
    setConfig("merge", '"shadow"');
    const c = await runSpineMerge(NOW);
    expect(c).toMatchObject({ held_frozen: 1, encounters: 0 });
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(0);
    expect(await num("SELECT (counts->>'held_frozen')::int FROM spine_tick WHERE kind = 'merge'")).toBe(1);
  });

  it("acoustic is optional: adding acoustic later changes no id, status, reason or flag set of a pulse+timeline day", async () => {
    fixture();
    setConfig("merge", '"shadow"');
    await runSpineMerge(NOW);
    const without = await shape();
    const ids = (await encs()).map((x) => x.encounter_id);
    acoustic(1, iso(4), iso(4, 10), { received: iso(7, 40) }); acoustic(2, iso(4, 30), iso(4, 45), { received: iso(7, 40) });
    const c = await runSpineMerge(NOW);
    expect(c.failed_days).toBe(0);
    expect(await shape()).toEqual(without);
    expect((await encs()).map((x) => x.encounter_id)).toEqual(ids);
    expect(await num("SELECT count(*) FROM spine_signal WHERE proxy = 'acoustic' AND encounter_id IS NOT NULL")).toBe(2);   // it only adds evidence: both attach
  });

  it("enqueuer: gate off writes nothing; shadow rows only; no paid stage; idempotent; superseded on a new cut", async () => {
    fixture();
    setConfig("merge", '"shadow"');
    await runSpineMerge(NOW);
    expect(await runSpineEnqueue(NOW)).toEqual({ skipped: "off" });
    setConfig("jobs", '"shadow"');
    expect(await runSpineEnqueue(NOW)).toEqual({ skipped: "off" });   // no mode.<stage>
    for (const s of ["recut", "acoustics", "nemotron", "collector", "freescript", "sarvam", "gapfill", "role", "llm-roles", "parts"]) setConfig(`mode.${s}`, '"shadow"');
    const c1 = await runSpineEnqueue(NOW);
    expect(c1).toMatchObject({ jobs: "shadow", planned: 10, shadow: 10, queued: 0 });
    expect(await num("SELECT count(*) FROM spine_job WHERE status <> 'shadow'")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage IN ('sarvam','gapfill','role','llm-roles','parts')")).toBe(0);
    const c2 = await runSpineEnqueue(NOW);
    expect(c2).toMatchObject({ planned: 10, shadow: 0, queued: 0, superseded: 0 });
    expect(await num("SELECT count(*) FROM spine_job")).toBe(10);
    expect(await num("SELECT count(*) FROM spine_tick WHERE kind = 'enqueue'")).toBe(2);
    // a boundary move is a new cut_version: the old cut's shadow rows are superseded, the new cut gets its own
    pulse(KA, iso(4), iso(4, 14), "endConsult", { rev: 2, received: iso(7, 30) });
    await runSpineMerge(NOW);
    const c3 = await runSpineEnqueue(NOW);
    expect(c3).toMatchObject({ shadow: 5, superseded: 5 });
    expect(await num("SELECT count(*) FROM spine_job WHERE status = 'superseded' AND cut_version = 'r0'")).toBe(5);
    expect(await num("SELECT count(*) FROM spine_job WHERE status = 'shadow' AND cut_version = 'r1'")).toBe(5);
  });

  it("enqueuer: candidates get the free engines only; nothing before the 15 min close grace; kill_switch stops it", async () => {
    acoustic(1, iso(6), iso(6, 10));
    setConfig("merge", '"shadow"'); setConfig("jobs", '"shadow"'); for (const s of ["recut", "acoustics", "nemotron", "collector", "freescript"]) setConfig(`mode.${s}`, '"shadow"');
    await runSpineMerge(NOW);
    expect((await encs())[0].status).toBe("candidate");
    expect(await runSpineEnqueue(Date.parse(iso(6, 20)))).toMatchObject({ planned: 0 });
    await runSpineEnqueue(NOW);
    expect((await q("SELECT stage FROM spine_job ORDER BY stage")).map((r) => r.stage)).toEqual(["acoustics", "nemotron", "recut"]);
    setConfig("kill_switch", '{"on": true}');
    expect(await runSpineEnqueue(NOW)).toEqual({ skipped: "off" });
    expect(await runSpineMerge(NOW)).toEqual({ skipped: "off" });
  });

  it("enqueuer live: queued, gated on the upstream stage being done; a spent shadow row goes back to queued", async () => {
    fixture();
    setConfig("merge", '"shadow"'); setConfig("jobs", '"live"');
    for (const s of ["recut", "acoustics", "nemotron", "collector", "freescript"]) setConfig(`mode.${s}`, '"shadow"');
    await runSpineMerge(NOW);
    await runSpineEnqueue(NOW);                                   // all shadow
    setConfig("mode.recut", '"live"');
    const c = await runSpineEnqueue(NOW);
    expect(c).toMatchObject({ queued: 2 });                       // the two recut rows, requeued from shadow
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'recut' AND status = 'queued'")).toBe(2);
    setConfig("mode.acoustics", '"live"');
    await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'acoustics' AND status = 'queued'")).toBe(0);   // recut not done yet
    pg.exec("UPDATE spine_job SET status = 'done' WHERE stage = 'recut';");
    await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'acoustics' AND status = 'queued'")).toBe(2);
  });

  it("cron chain on the real stores: each gate separate; ingest off + merge shadow + jobs off writes encounters and no job; counts and one tick per step", async () => {
    process.env.CRON_SECRET = "cron_test";
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const get = () => GET(new Request("https://x.test/api/cron/spine", { headers: { authorization: "Bearer cron_test" } }));
    fixture();
    expect(await (await get()).json()).toEqual({ ok: true, ingest: { skipped: "off" }, merge: { skipped: "off" }, enqueue: { skipped: "off" } });
    expect(await num("SELECT count(*) FROM spine_tick")).toBe(0);
    setConfig("merge", '"shadow"');
    const b = await (await get()).json();
    expect(b).toMatchObject({ ok: true, ingest: { skipped: "off" }, merge: { mode: "shadow" }, enqueue: { skipped: "off" } });
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(2);
    expect(await num("SELECT count(*) FROM spine_job")).toBe(0);
    expect((await q("SELECT kind FROM spine_tick ORDER BY id")).map((r) => r.kind)).toEqual(["merge"]);
    setConfig("jobs", '"shadow"'); setConfig("mode.recut", '"shadow"');
    const b2 = await (await get()).json();
    expect(b2.enqueue).toMatchObject({ jobs: "shadow", planned: 2, shadow: 2 });
    expect((await q("SELECT kind FROM spine_tick ORDER BY id")).map((r) => r.kind)).toEqual(["merge", "merge", "enqueue"]);
    setConfig("merge", '"off"');
    expect((await (await get()).json()).merge).toEqual({ skipped: "off" });
    delete process.env.CRON_SECRET;
    vi.useRealTimers();
  });
});
