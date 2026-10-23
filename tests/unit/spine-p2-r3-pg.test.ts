/**
 * spine-p2-r3-pg.test.ts — SPINE-P2 R3 (RULING B, confirmed_single_proxy): writer and enqueuer against a REAL postgres:16 (never on the Mini). Migration 0173 is the schema.
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
const pg = pgContainer("eta-spine-p2r3");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");   // 0176 widens the status CHECK

describe("REQUIRED PROOF — spine P2 R3 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-p2-r3-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
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

d("spine P2 R3 confirmed_single_proxy on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); });
  beforeEach(() => { pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;"); });

  const allShadow = () => { setConfig("merge", '"shadow"'); setConfig("jobs", '"shadow"'); for (const s of ["recut", "acoustics", "nemotron", "collector", "freescript"]) setConfig(`mode.${s}`, '"shadow"'); };
  const jobs = () => q("SELECT stage, status, input_key, cut_version FROM spine_job WHERE encounter_id = (SELECT encounter_id FROM spine_encounter WHERE status <> 'merged' ORDER BY t_open LIMIT 1) ORDER BY stage, input_key");

  it("timeline-only gives confirmed_single_proxy and 5 shadow sp: jobs; a pulse-anchored day is unchanged (confirmed, plain keys)", async () => {
    timeline(KA, iso(4), iso(4, 9)); pulse(KB, iso(4, 30), iso(4, 45)); timeline(KB, iso(4, 30), iso(4, 44));
    allShadow();
    await runSpineMerge(NOW);
    expect((await encs()).map((e) => `${e.status}/${e.reason}`)).toEqual(["confirmed_single_proxy/single_proxy_timeline", "confirmed/pulse"]);
    await runSpineEnqueue(NOW);
    const sp = await q("SELECT j.stage, j.status, j.input_key FROM spine_job j JOIN spine_encounter e USING (encounter_id) WHERE e.status = 'confirmed_single_proxy'");
    expect(sp).toHaveLength(5);
    expect(sp.every((r) => r.status === "shadow" && String(r.input_key).startsWith("sp:"))).toBe(true);
    const plain = await q("SELECT j.input_key FROM spine_job j JOIN spine_encounter e USING (encounter_id) WHERE e.status = 'confirmed'");
    expect(plain).toHaveLength(5);
    expect(plain.every((r) => !String(r.input_key).startsWith("sp:"))).toBe(true);
  });

  it("jobs=live with every mode.<stage>=live: the sp encounter still gets only shadow rows, the confirmed one queued", async () => {
    timeline(KA, iso(4), iso(4, 9)); pulse(KB, iso(4, 30), iso(4, 45));
    setConfig("merge", '"shadow"'); setConfig("jobs", '"live"'); for (const s of ["recut", "acoustics", "nemotron", "collector", "freescript"]) setConfig(`mode.${s}`, '"live"');
    await runSpineMerge(NOW);
    await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job j JOIN spine_encounter e USING (encounter_id) WHERE e.status = 'confirmed_single_proxy' AND j.status = 'shadow' AND j.input_key LIKE 'sp:%'")).toBe(5);
    expect(await num("SELECT count(*) FROM spine_job j JOIN spine_encounter e USING (encounter_id) WHERE e.status = 'confirmed_single_proxy' AND j.status <> 'shadow'")).toBe(0);
    await runSpineEnqueue(NOW);   // a rerun neither requeues them nor adds rows
    expect(await num("SELECT count(*) FROM spine_job j JOIN spine_encounter e USING (encounter_id) WHERE e.status = 'confirmed_single_proxy' AND j.status <> 'shadow'")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_job j JOIN spine_encounter e USING (encounter_id) WHERE e.status = 'confirmed' AND j.status = 'queued'")).toBeGreaterThan(0);
    expect(await num("SELECT count(*) FROM spine_job")).toBe(6);   // 5 sp shadow rows + the confirmed one's recut (the rest wait on recut being done)
  });

  it("sp + a later pulse -> confirmed, same encounter; the sp: rows are superseded and the normal rows enqueued", async () => {
    timeline(KA, iso(4), iso(4, 9));
    allShadow();
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    const id = (await encs())[0].encounter_id;
    pulse(KA, iso(4), iso(4, 10), "endConsult", { received: iso(7, 30) });
    await runSpineMerge(NOW);
    expect((await encs()).map((e) => `${e.encounter_id === id}/${e.status}/${e.reason}`)).toEqual(["true/confirmed/pulse"]);
    const c = await runSpineEnqueue(NOW);
    expect(c).toMatchObject({ superseded: 5 });
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key LIKE 'sp:%' AND status = 'superseded'")).toBe(5);
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key LIKE 'sp:%' AND status <> 'superseded'")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key NOT LIKE 'sp:%' AND status = 'shadow' AND cut_version = (SELECT 'r' || boundary_rev FROM spine_encounter)")).toBe(5);
  });

  it("sp + a second weak proxy -> confirmed (weak_agree), sp rows superseded", async () => {
    timeline(KA, iso(4), iso(4, 9));
    allShadow();
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    acoustic(1, iso(4), iso(4, 9), { received: iso(7, 30) });
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    expect((await encs()).map((e) => `${e.status}/${e.reason}`)).toEqual(["confirmed/weak_agree"]);
    expect(await num("SELECT count(*) FROM spine_job WHERE input_key LIKE 'sp:%' AND status <> 'superseded'")).toBe(0);
  });

  it("sp + ambiguous -> no freescript row", async () => {
    timeline(KA, iso(4), iso(4, 9));
    allShadow();
    await runSpineMerge(NOW);
    pg.exec("UPDATE spine_encounter SET flags = ARRAY['ambiguous'] WHERE status = 'confirmed_single_proxy';");
    await runSpineEnqueue(NOW);
    expect((await jobs()).map((r) => r.stage)).toEqual(["acoustics", "collector", "nemotron", "recut"]);
  });

  it("sp is its own bucket in the day view and the pipeline view, never in confirmed", async () => {
    timeline(KA, iso(4), iso(4, 9)); pulse(KB, iso(4, 30), iso(4, 45));
    allShadow();
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    const { dayView } = await import("@/lib/spine/explorer-read");
    const day = (await dayView({ ist_date: "2026-10-18" }, NOW)).rooms.find((r) => r.room_id === ROOM)!;
    expect(day.encounters).toMatchObject({ confirmed: 1, confirmed_single_proxy: 1, total: 2 });
    const { readPipeline } = await import("@/lib/spine/pipeline-view");
    const pv = (await readPipeline("2026-10-18", new Date(NOW))).rooms[ROOM];
    expect(pv.encounters).toMatchObject({ confirmed: 1, confirmed_single_proxy: 1 });
  });
});
