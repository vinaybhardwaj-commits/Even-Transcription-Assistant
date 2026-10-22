/**
 * spine-p2-oref-pg.test.ts (moved from the refuter's .bc/oref-p2-pg.test.ts) — Opus REFUTER (spine-p2-r1-oref) adversarial tests for SPINE-P2 at 46dd638d. postgres:16 with ALL real migrations. Throwaway; synthetic ids only.
 * A test named "DEFECT:" asserts the CORRECT behaviour and is expected to FAIL on 46dd638d (it reproduces a finding).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), log: [] as Array<{ text: string; params: unknown[] }> }));
vi.mock("@/lib/db", () => {
  const run = (text: string, params: unknown[]) => {
    if (text.includes("WITH enc AS")) H.log.push({ text, params });
    const order: number[] = [];
    const parts = text.split(/\$(\d+)/);
    const strings: string[] = [];
    for (let i = 0; i < parts.length; i += 2) { strings.push(parts[i]); if (i + 1 < parts.length) order.push(Number(parts[i + 1]) - 1); }
    return H.tag!(Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray, ...order.map((n) => params[n]));
  };
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});

import { runSpineMerge as runMerge, liftAttrs, toSignal } from "@/lib/spine/merge-store";
import { runSpineEnqueue } from "@/lib/spine/enqueue-store";
import { mergeSignals } from "@/lib/spine/merge";
import { effectiveModes, planJobs, FREE_STAGES, CANDIDATE_STAGES } from "@/lib/spine/enqueue";
import { KNOWN_STAGES, PAID_STAGES, type Mode } from "@/lib/spine/config";
import type { SpineSignal } from "@/lib/spine/types";

type Ran = Record<string, number> & { mode: string };
const runSpineMerge = runMerge as unknown as (now: number) => Promise<Ran>;
const HAVE = dockerAvailable();
const pg = pgContainer("eta-oref-p2");
const d = HAVE ? describe : describe.skip;

const NOW = Date.parse("2026-10-18T08:00:00Z");
const ROOM = "room_abcd2345";
const iso = (h: number, m = 0, day = 18) => `2026-10-${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const KA = "uidtestaaaaaaaaaaaaaaaaa@mach_test", KB = "uidtestbbbbbbbbbbbbbbbbb@mach_test";
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
const allStagesShadow = () => { setConfig("jobs", '"shadow"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, '"shadow"'); };

// ---------------- pure ----------------
describe("oref pure: liftAttrs and the S1 shape (FINDING 1)", () => {
  const T = Date.parse("2026-10-18T04:00:00Z");
  const row = (proxy: string, o: number, c: number, attrs: unknown) => ({ proxy, source_key: KA, source_rev: 1, room_id: ROOM, t_open: new Date(T + o * 60_000).toISOString(), t_close: new Date(T + c * 60_000).toISOString(), encounter_id: null, attrs });
  // a pulse 0-10 and its timeline 9-30: overlap 1 min (< 50% of the shorter), so only the consult_key can join them
  const rows = [row("pulse", 0, 10, { ids: { consult_key: KA, consult_uid: "uidtestaaaaaaaaaaaaaaaaa" }, close_reason: "endConsult" }), row("timeline", 9, 30, { ids: { consult_key: KA }, close_reason: "patient_left" })];
  it("raw S1-shaped attrs: no key match (2 encounters); lifted: one encounter (the mismatch is real)", () => {
    const raw = rows.map((r) => ({ ...toSignal(r), attrs: r.attrs as Record<string, unknown> })) as SpineSignal[];
    const now = T + 6 * 3_600_000;
    expect(mergeSignals(raw, "t", { encounters: [], links: [] }, now).encounters).toHaveLength(2);
    expect(mergeSignals(rows.map(toSignal), "t", { encounters: [], links: [] }, now).encounters).toHaveLength(1);
  });
  it("lift never overwrites a top-level value, ignores empty / non-string ids, keeps pulse_enc_id in ids, parses a text jsonb", () => {
    expect(liftAttrs({ consult_key: "top", ids: { consult_key: "inner" } }).consult_key).toBe("top");
    expect(liftAttrs({ ids: { consult_key: "", consult_uid: 7, window_id: null } })).toEqual({ ids: { consult_key: "", consult_uid: 7, window_id: null } });
    expect(liftAttrs({ ids: { pulse_enc_id: "pe" } })).toEqual({ ids: { pulse_enc_id: "pe" } });
    expect(toSignal(row("timeline", 0, 1, JSON.stringify({ ids: { consult_key: KA } }))).attrs?.consult_key).toBe(KA);
    expect(liftAttrs({ ids: "garbage" })).toEqual({ ids: "garbage" });
  });
});

describe("oref pure: acoustic absent = unknown, more shapes", () => {
  const T = Date.parse("2026-10-18T04:00:00Z");
  const NOWP = T + 6 * 3_600_000;
  const m = (n: number) => T + n * 60_000;
  const s = (proxy: SpineSignal["proxy"], key: string, o: number, c: number | null, a: Record<string, unknown> = {}): SpineSignal => ({ proxy, source_key: key, source_rev: 1, room_id: ROOM, t_open: m(o), t_close: c === null ? null : m(c), attrs: a });
  const P = (k: string, o: number, c: number | null, reason = "endConsult") => s("pulse", k, o, c, { consult_key: k, consult_uid: k.split("@")[0], close_reason: reason });
  const TL = (k: string, o: number, c: number) => s("timeline", k, o, c, { consult_key: k, close_reason: "patient_left" });
  const A = (n: number, o: number, c: number) => s("acoustic", `rd_x:ac${n}`, o, c, { close_reason: "non_speech" });
  const view = (r: ReturnType<typeof mergeSignals>) => r.encounters.map((e) => [e.encounter_id, e.status, e.reason, e.flags.join(","), e.t_open, e.t_close].join("|"));
  const shapes: Record<string, SpineSignal[]> = {
    pulse_only: [P(KA, 0, 10)],
    pulse_idle_close_neighbour: [P(KA, 0, 40, "idle_timeout"), P(KB, 20, 35), TL(KA, 0, 18)],
    pulse_open_capped: [P(KA, 0, null)],
    two_pulse_overlap: [P(KA, 0, 20), P(KB, 15, 30), TL(KA, 0, 19)],
    pulse_plus_timeline_far: [P(KA, 0, 10), TL(KA, 9, 30)],
    ambiguous_timeline: [P(KA, 0, 10), P(KB, 5, 15), TL("tlzz@mach_test", 5, 10)],
  };
  // F5 (acoustic PRESENCE adds `ambiguous`) is out of scope of R2 and awaits a fable ruling: these two shapes fail on merge.ts as it is. `it.fails` keeps them red the day F5 is fixed.
  const F5_PENDING = new Set(["pulse_idle_close_neighbour", "ambiguous_timeline"]);
  for (const [name, sigs] of Object.entries(shapes)) {
    (F5_PENDING.has(name) ? it.fails : it)(`${name}: identical with and without per-consult acoustic (same span as each pulse)`, () => {
      const ac = sigs.filter((x) => x.proxy === "pulse").map((x, i) => A(i, (x.t_open - T) / 60_000, x.t_close === null ? (x.t_open - T) / 60_000 + 90 : (x.t_close - T) / 60_000));
      expect(view(mergeSignals([...sigs, ...ac], "t", { encounters: [], links: [] }, NOWP))).toEqual(view(mergeSignals(sigs, "t", { encounters: [], links: [] }, NOWP)));
    });
  }
  it("timeline-only consult: candidate (weak_single) without acoustic; confirmed only with it (D4 consequence)", () => {
    const r = mergeSignals([TL("tlonly@mach_test", 0, 12)], "t", { encounters: [], links: [] }, NOWP);
    expect(r.encounters.map((e) => `${e.status}/${e.reason}`)).toEqual(["candidate/weak_single"]);
    const r2 = mergeSignals([TL("tlonly@mach_test", 0, 12), A(9, 0, 12)], "t", { encounters: [], links: [] }, NOWP);
    expect(r2.encounters.map((e) => `${e.status}/${e.reason}`)).toEqual(["confirmed/weak_agree"]);
  });
  it("PRESENCE (not absence) can demote: one long acoustic over two back-to-back consults flags one `ambiguous` (no freescript)", () => {
    const base = [P(KA, 0, 10), P(KB, 10, 20)];
    const r = mergeSignals([...base, A(1, 0, 20)], "t", { encounters: [], links: [] }, NOWP);
    expect(mergeSignals(base, "t", { encounters: [], links: [] }, NOWP).encounters.some((e) => e.flags.includes("ambiguous"))).toBe(false);
    expect(r.encounters.some((e) => e.flags.includes("ambiguous"))).toBe(true);
  });
});

describe("oref pure: enqueue plan under every config", () => {
  it("no config of jobs x mode.<every known stage + unknown> plans a paid/unknown stage; jobs=shadow never queues; candidates only recut/acoustics/nemotron; ambiguous never freescript", () => {
    const modes: Mode[] = ["off", "shadow", "live"];
    const encs = [
      { encounter_id: "enc_a", status: "candidate", boundary_rev: 0, flags: [], t_close: 0 },
      { encounter_id: "enc_b", status: "confirmed", boundary_rev: 2, flags: ["ambiguous"], t_close: 0 },
      { encounter_id: "enc_c", status: "confirmed", boundary_rev: 1, flags: [], t_close: 0 },
      { encounter_id: "enc_d", status: "merged", boundary_rev: 0, flags: [], t_close: 0 },
      { encounter_id: "enc_e", status: "rejected", boundary_rev: 0, flags: [], t_close: 0 },
      { encounter_id: "enc_f", status: "confirmed", boundary_rev: 0, flags: ["frozen"], t_close: 0 },
    ];
    let n = 0;
    for (let seed = 0; seed < 3000; seed++) {
      const stages: Record<string, Mode> = {};
      for (const [i, s] of [...KNOWN_STAGES, "bogus"].entries()) stages[s] = modes[(seed * 7 + i * 13 + (seed >> i)) % 3];
      for (const jobs of modes) {
        const plan = planJobs(encs, effectiveModes(jobs, stages), 3_600_000);
        for (const p of plan) {
          n++;
          expect(PAID_STAGES.includes(p.stage)).toBe(false);
          expect(FREE_STAGES.includes(p.stage)).toBe(true);
          if (jobs !== "live") expect(p.status).toBe("shadow");
          if (p.encounter_id === "enc_a") expect((CANDIDATE_STAGES as readonly string[]).includes(p.stage)).toBe(true);
          if (p.encounter_id === "enc_b") expect(p.stage).not.toBe("freescript");
          expect(["enc_d", "enc_e", "enc_f"]).not.toContain(p.encounter_id);
        }
        if (jobs === "off") expect(plan).toHaveLength(0);
      }
    }
    expect(n).toBeGreaterThan(1000);
  });
});

// ---------------- postgres:16, ALL migrations ----------------
d("oref P2 on postgres:16 with all migrations", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }, 300_000);
  afterAll(() => { pg.stop(); });
  beforeEach(() => {
    pg.exec("DROP TRIGGER IF EXISTS oref_poison ON spine_encounter; TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;");
    H.log.length = 0;
  });

  it("real seeds: after all migrations only ingest/producers are seeded; merge and jobs stay off", async () => {
    pg.exec("TRUNCATE spine_config;");
    for (const f of ["0174_spine_ingest_shadow.sql", "0175_spine_producers_shadow.sql"]) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    expect((await q("SELECT key FROM spine_config ORDER BY key")).map((r) => r.key)).toEqual(["ingest", "producers"]);
    pulse(KA, iso(4), iso(4, 10));
    expect(await runSpineMerge(NOW)).toEqual({ skipped: "off" });
    expect(await runSpineEnqueue(NOW)).toEqual({ skipped: "off" });
  });

  it("DEFECT: an encounter that becomes ambiguous WITHOUT a boundary move keeps its freescript job (R1)", async () => {
    setConfig("merge", '"shadow"'); allStagesShadow();
    pulse(KA, iso(4), iso(4, 10)); pulse(KB, iso(4, 20), iso(4, 30));
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'freescript' AND status = 'shadow'")).toBe(2);
    timeline("tlkeyzzzzzzzzzzzzzzzzzzz@mach_test", iso(4, 5), iso(4, 25), { received: iso(7, 50) });   // >= 50% of each 10-min pulse
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    const amb = await q("SELECT encounter_id, boundary_rev FROM spine_encounter WHERE flags @> ARRAY['ambiguous']");
    expect(amb).toHaveLength(1);
    expect(amb[0].boundary_rev).toBe(0);                     // no boundary move -> same cut_version
    expect(await num(`SELECT count(*) FROM spine_job WHERE encounter_id = '${amb[0].encounter_id}' AND stage = 'freescript' AND status IN ('shadow','queued')`)).toBe(0);
  });

  it("DEFECT: a consult across IST midnight makes the link ping-pong between two room-days: a rerun is not a no-op", async () => {
    setConfig("merge", '"shadow"');
    // 23:50 IST 18 Oct -> 00:10 IST 19 Oct; its timeline opens 00:00 IST, i.e. on the NEXT room-day
    pulse(KA, iso(18, 20), iso(18, 40), { received: iso(19, 0) });
    timeline(KA, iso(18, 30), iso(18, 39), { received: iso(19, 0) });
    const later = Date.parse(iso(20, 0));
    const c1 = await runSpineMerge(later);
    expect(c1.days).toBe(2);
    const rows1 = await num("SELECT count(*) FROM spine_link");
    pg.exec("DELETE FROM spine_tick;");
    const c2 = await runSpineMerge(later);                    // nothing changed in the data
    const rows2 = await num("SELECT count(*) FROM spine_link");
    expect({ moved: c2.links_moved, written: c2.links_written, grew: rows2 - rows1 }).toEqual({ moved: 0, written: 0, grew: 0 });
  });

  it("commit skew INSIDE RECENT_MS is caught: a signal stamped under the cursor, merged within 10 min", async () => {
    setConfig("merge", '"shadow"');
    pulse(KA, iso(4), iso(4, 10), { received: iso(7, 58) });
    await runSpineMerge(NOW);
    pulse(KB, iso(4, 30), iso(4, 40), { received: iso(7, 55) });   // tx started before the cursor's mx, committed after the pass
    const c = await runSpineMerge(NOW + 5 * 60_000);
    expect(c.days).toBe(1);
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(2);
  });

  it("DEFECT: commit skew + one skipped/failed pass (gap > RECENT_MS) misses the day for good", async () => {
    setConfig("merge", '"shadow"');
    pulse(KA, iso(4), iso(4, 10), { received: iso(7, 58) });
    await runSpineMerge(NOW);
    pulse(KB, iso(4, 30), iso(4, 40), { received: iso(7, 55) });
    // the next pass that runs is 15 min later (one cron run lost, or merge toggled off and on)
    await runSpineMerge(NOW + 15 * 60_000);
    await runSpineMerge(NOW + 20 * 60_000);
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(2);
  });

  it("failed day: cursor holds before it, the day is retried, days after it are re-merged idempotently, recovery advances", async () => {
    setConfig("merge", '"shadow"');
    pg.exec(`CREATE OR REPLACE FUNCTION oref_poison_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.room_id = 'room_poison' THEN RAISE EXCEPTION 'oref poison'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER oref_poison BEFORE INSERT OR UPDATE ON spine_encounter FOR EACH ROW EXECUTE FUNCTION oref_poison_fn();`);
    pulse(KA, iso(4), iso(4, 10), { room: "room_aaaa", received: iso(6, 0) });
    pulse(KB, iso(4), iso(4, 10), { room: "room_poison", received: iso(6, 1) });
    pulse("uidtestcccccccccccccccccc@mach_test", iso(4), iso(4, 10), { room: "room_cccc", received: iso(6, 2) });
    const c1 = await runSpineMerge(NOW);
    expect(c1).toMatchObject({ days: 3, failed_days: 1 });
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(2);                    // atomic: nothing of the poison day
    expect(await num("SELECT count(*) FROM spine_signal WHERE room_id = 'room_poison' AND encounter_id IS NOT NULL")).toBe(0);
    expect((await q("SELECT counts->>'cursor_room' AS r FROM spine_tick ORDER BY id DESC LIMIT 1"))[0].r).toBe("room_aaaa");
    const c2 = await runSpineMerge(NOW);
    expect(c2).toMatchObject({ days: 2, failed_days: 1, enc_inserted: 0, enc_updated: 0, assigned: 0 });   // poison retried, cccc idempotent
    pg.exec("DROP TRIGGER oref_poison ON spine_encounter;");
    const c3 = await runSpineMerge(NOW);
    expect(c3).toMatchObject({ days: 2, failed_days: 0, enc_inserted: 1 });
    expect((await q("SELECT counts->>'cursor_room' AS r FROM spine_tick ORDER BY id DESC LIMIT 1"))[0].r).toBe("room_cccc");
    expect(await runSpineMerge(NOW)).toMatchObject({ days: 0 });
  });

  it("PERF: the IST range predicate of loadDay selects exactly the rows of the old (t_open AT TIME ZONE ..)::date = day predicate, incl. IST midnight edges", async () => {
    const edges = ["2026-10-17T18:29:59.999Z", "2026-10-17T18:30:00Z", "2026-10-17T18:30:00.001Z", "2026-10-18T12:00:00Z", "2026-10-18T18:29:59.999999Z", "2026-10-18T18:30:00Z", "2026-10-18T18:30:00.000001Z", "2026-10-19T05:00:00Z"];
    edges.forEach((t, i) => pulse(`uidtest${String(i).padStart(2, "e")}aaaaaaaaaaaaaaa@mach_test`, t, null));
    pulse("uidtestzzzzzzzzzzzzzzzzzz@mach_test", iso(18, 30), null, { room: "room_other" });
    for (const day of ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]) {
      const oldIds = await q(`SELECT source_key FROM spine_signal WHERE room_id = '${ROOM}' AND (t_open AT TIME ZONE 'Asia/Kolkata')::date = '${day}'::date ORDER BY source_key`);
      const newIds = await q(`SELECT source_key FROM spine_signal WHERE room_id = '${ROOM}' AND t_open >= (('${day}'::date)::timestamp AT TIME ZONE 'Asia/Kolkata') AND t_open < ((('${day}'::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') ORDER BY source_key`);
      expect(newIds).toEqual(oldIds);
    }
    expect(await num(`SELECT count(*) FROM spine_signal WHERE room_id = '${ROOM}' AND t_open >= (('2026-10-18'::date)::timestamp AT TIME ZONE 'Asia/Kolkata') AND t_open < ((('2026-10-18'::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`)).toBe(4);
  });

  it("PERF: loadDay puts a signal opening exactly at IST midnight on the NEW day only (upper bound exclusive)", async () => {
    setConfig("merge", '"shadow"');
    pulse(KA, iso(18, 30), iso(18, 40));           // 00:00 IST on the 19th
    pulse(KB, iso(18, 29), "2026-10-18T18:29:30Z");
    await runSpineMerge(NOW);
    expect((await q("SELECT ist_date::text AS d, count(*)::int AS n FROM spine_encounter GROUP BY 1 ORDER BY 1")).map((r) => `${r.d}:${r.n}`)).toEqual(["2026-10-18:1", "2026-10-19:1"]);
    expect(await num("SELECT count(*) FROM spine_link WHERE NOT active")).toBe(0);
  });

  it("F4: a day that keeps failing is passed after MAX_FAILS passes, its key and count kept in the tick, and retried on a later signal; success clears it", async () => {
    setConfig("merge", '"shadow"');
    pg.exec(`CREATE OR REPLACE FUNCTION oref_poison_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.room_id = 'room_poison' THEN RAISE EXCEPTION 'oref poison'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER oref_poison BEFORE INSERT OR UPDATE ON spine_encounter FOR EACH ROW EXECUTE FUNCTION oref_poison_fn();`);
    pulse(KB, iso(4), iso(4, 10), { room: "room_poison", received: iso(6, 0) });
    pulse(KA, iso(4), iso(4, 10), { room: "room_aaaa", received: iso(6, 1) });
    const cur = async () => (await q("SELECT counts FROM spine_tick ORDER BY id DESC LIMIT 1"))[0].counts as Record<string, unknown>;
    expect(await runSpineMerge(NOW)).toMatchObject({ failed_days: 1, skipped_days: 0 });
    expect((await cur()).cursor_room).toBeNull();
    expect(await runSpineMerge(NOW)).toMatchObject({ failed_days: 1, skipped_days: 0 });
    expect(await runSpineMerge(NOW)).toMatchObject({ failed_days: 1, skipped_days: 1 });
    expect(await cur()).toMatchObject({ cursor_room: "room_aaaa", failing: [{ k: "room_poison|2026-10-18", n: 3 }], skipped_keys: ["room_poison|2026-10-18"] });
    expect(await runSpineMerge(NOW)).toMatchObject({ days: 1, failed_days: 1, skipped_days: 1 });   // still inside the cursor's recent window (its signal is unassigned): retried, skipped again, never blocking
    pulse("uidtestcccccccccccccccccc@mach_test", iso(5), iso(5, 10), { room: "room_poison", received: iso(7, 0) });
    expect(await runSpineMerge(NOW)).toMatchObject({ days: 1, failed_days: 1, skipped_days: 1 });   // a later signal retries it (still failing: skipped again, never blocking)
    pg.exec("DROP TRIGGER oref_poison ON spine_encounter;");
    pulse("uidtestdddddddddddddddddd@mach_test", iso(5, 20), iso(5, 30), { room: "room_poison", received: iso(7, 5) });
    expect(await runSpineMerge(NOW)).toMatchObject({ days: 1, failed_days: 0, skipped_days: 0 });
    expect((await cur()).failing).toEqual([]);
  });

  it("an open signal is deferred < 90 min, then capped and written with no new row (C horizon)", async () => {
    setConfig("merge", '"shadow"');
    pulse(KA, iso(7, 0), null, { received: iso(7, 0) });
    expect(await runSpineMerge(NOW)).toMatchObject({ days: 1, encounters: 0, open_deferred: 1 });
    const c = await runSpineMerge(NOW + 40 * 60_000);
    expect(c).toMatchObject({ days: 1, encounters: 1, enc_inserted: 1 });
    // C keeps re-merging it until 72 h after t_open (idempotently)
    expect(await runSpineMerge(NOW + 50 * 3_600_000)).toMatchObject({ days: 1, enc_inserted: 0, enc_updated: 0 });
    expect(await runSpineMerge(NOW + 73 * 3_600_000)).toMatchObject({ days: 0 });
  });

  it("200-day cap: the first pass takes 200 days, the next takes the rest", async () => {
    setConfig("merge", '"shadow"');
    pg.exec(`INSERT INTO spine_signal (proxy, source_key, source_rev, room_id, t_open, t_close, observed_at, received_at, attrs)
      SELECT 'timeline', 'tl' || chr(97 + g / 26) || chr(97 + g % 26) || '@mach_test', 1, 'room_' || chr(97 + g / 26) || chr(97 + g % 26), '${iso(4)}', '${iso(4, 10)}', '${iso(4)}',
             '${iso(5)}'::timestamptz + g * interval '1 second', '{"ids":{}}'::jsonb FROM generate_series(0, 204) g;`);
    expect(await runSpineMerge(NOW)).toMatchObject({ days: 200, failed_days: 0 });
    expect(await runSpineMerge(NOW)).toMatchObject({ days: 5 });
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(205);
  }, 400_000);

  it("DEFECT: one poison day + the 200-day cap starves every newer room-day (head-of-line block)", async () => {
    setConfig("merge", '"shadow"');
    pg.exec(`CREATE OR REPLACE FUNCTION oref_poison_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.room_id = 'room_poison' THEN RAISE EXCEPTION 'oref poison'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER oref_poison BEFORE INSERT OR UPDATE ON spine_encounter FOR EACH ROW EXECUTE FUNCTION oref_poison_fn();`);
    pulse(KB, iso(4), iso(4, 10), { room: "room_poison", received: iso(5, 0) });
    pg.exec(`INSERT INTO spine_signal (proxy, source_key, source_rev, room_id, t_open, t_close, observed_at, received_at, attrs)
      SELECT 'timeline', 'tl' || chr(97 + g / 26) || chr(97 + g % 26) || '@mach_test', 1, 'room_' || chr(97 + g / 26) || chr(97 + g % 26), '${iso(4)}', '${iso(4, 10)}', '${iso(4)}',
             '${iso(5, 1)}'::timestamptz + g * interval '1 second', '{"ids":{}}'::jsonb FROM generate_series(0, 204) g;`);
    for (let i = 0; i < 4; i++) await runSpineMerge(NOW);   // MAX_FAILS (3) passes hold the cursor, then the poison day is passed and the 5 left merge
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(205);   // every healthy day merged despite the poison day
  }, 400_000);

  it("enqueue: a merged encounter's queued/shadow jobs are superseded; leased/done untouched; a done job is never requeued by live", async () => {
    setConfig("merge", '"shadow"'); allStagesShadow();
    timeline("tlkeyaaaaaaaaaaaaaaaaaaa@mach_test", iso(6), iso(6, 5)); timeline("tlkeybbbbbbbbbbbbbbbbbbb@mach_test", iso(6, 6), iso(6, 10));
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job")).toBe(6);
    pg.exec("UPDATE spine_job SET status = 'done' WHERE stage = 'recut'; UPDATE spine_job SET status = 'leased' WHERE stage = 'nemotron';");
    pulse(KA, iso(6), iso(6, 10), { received: iso(7, 30) });
    await runSpineMerge(NOW);
    setConfig("jobs", '"live"'); setConfig("mode.recut", '"live"');
    await runSpineEnqueue(NOW);
    const loser = (await q("SELECT encounter_id FROM spine_encounter WHERE status = 'merged'"))[0].encounter_id;
    expect((await q(`SELECT stage, status FROM spine_job WHERE encounter_id = '${loser}' ORDER BY stage`)).map((r) => `${r.stage}:${r.status}`))
      .toEqual(["acoustics:superseded", "nemotron:leased", "recut:done"]);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'recut' AND status = 'queued' AND cut_version = 'r0'")).toBe(0);
  });

  it("concurrency: the SAME write statement from two sessions at once (fresh day, and a link move) -> no double row, constraints hold", async () => {
    setConfig("merge", '"shadow"');
    timeline("tlkeyaaaaaaaaaaaaaaaaaaa@mach_test", iso(6), iso(6, 5)); timeline("tlkeybbbbbbbbbbbbbbbbbbb@mach_test", iso(6, 6), iso(6, 10));
    await runSpineMerge(NOW);
    const fresh = H.log[0];
    pulse(KA, iso(6), iso(6, 10), { received: iso(7, 30) });
    await runSpineMerge(NOW);
    const move = H.log[1];
    const inline = (x: { text: string; params: unknown[] }) => x.text.replace(/\$(\d+)/g, (_, n) => `'${String(x.params[Number(n) - 1]).replace(/'/g, "''")}'`);
    const race = (stmt: string, reset: string) => {
      pg.exec(reset);
      writeFileSync("/tmp/spine-p2-oref-stmt.sql", stmt + ";");
      const sh = `docker cp /tmp/spine-p2-oref-stmt.sql ${pg.name}:/tmp/s.sql &&
        (docker exec ${pg.name} psql -qAt -U postgres -c "BEGIN" -f /tmp/s.sql -c "SELECT pg_sleep(2)" -c "COMMIT" > /tmp/spine-p2-oref-a.out 2>&1 &) ; sleep 0.7;
        docker exec ${pg.name} psql -qAt -U postgres -f /tmp/s.sql > /tmp/spine-p2-oref-b.out 2>&1; echo "b=$?"; sleep 2; cat /tmp/spine-p2-oref-a.out /tmp/spine-p2-oref-b.out`;
      return execFileSync("bash", ["-c", sh], { encoding: "utf8" });
    };
    const outFresh = race(inline(fresh), "UPDATE spine_signal SET encounter_id = NULL; TRUNCATE spine_link, spine_encounter, spine_job CASCADE;");
    expect(await num("SELECT count(*) FROM (SELECT key_kind, value FROM spine_link WHERE active GROUP BY 1,2 HAVING count(*) > 1) x")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(2);
    console.log("[oref race fresh]", outFresh.replace(/\s+/g, " ").slice(0, 300));
    // the move: restore the two-candidate state, then race the move statement
    const outMove = race(inline(move), `UPDATE spine_signal SET encounter_id = NULL; TRUNCATE spine_link, spine_encounter, spine_job CASCADE; ${inline(fresh)};`);
    expect(await num("SELECT count(*) FROM (SELECT key_kind, value FROM spine_link WHERE active GROUP BY 1,2 HAVING count(*) > 1) x")).toBe(0);
    expect(await num("SELECT count(*) FROM spine_link WHERE NOT active")).toBeLessThanOrEqual(1);
    console.log("[oref race move]", outMove.replace(/\s+/g, " ").slice(0, 300));
  }, 60_000);


  it("live never requeues a done job of the same key; a config read error means merge off", async () => {
    setConfig("merge", '"shadow"'); allStagesShadow();
    pulse(KA, iso(4), iso(4, 10));
    await runSpineMerge(NOW); await runSpineEnqueue(NOW);
    pg.exec("UPDATE spine_job SET status = 'done' WHERE stage = 'recut';");
    setConfig("jobs", '"live"'); setConfig("mode.recut", '"live"');
    await runSpineEnqueue(NOW);
    expect(await num("SELECT count(*) FROM spine_job WHERE stage = 'recut' AND status = 'done'")).toBe(1);
    pg.exec("ALTER TABLE spine_config RENAME TO spine_config_x;");
    try { expect(await runSpineMerge(NOW)).toEqual({ skipped: "off" }); } finally { pg.exec("ALTER TABLE spine_config_x RENAME TO spine_config;"); }
  });

  it("frozen transition is never written: with no new signal, a day past its horizon is not re-merged (stored flags lack `frozen`)", async () => {
    setConfig("merge", '"shadow"');
    pulse(KA, iso(4), iso(4, 10));
    await runSpineMerge(NOW);
    const c = await runSpineMerge(NOW + 80 * 3_600_000);
    expect(c.days).toBe(0);
    expect(await num("SELECT count(*) FROM spine_encounter WHERE flags @> ARRAY['frozen']")).toBe(0);   // documents behaviour (not asserted as a defect)
  });
});

import { parseIngestMode, parseMergeMode } from "@/lib/spine/config";
describe("oref pure: merge gate == ingest gate", () => {
  it("parseMergeMode(rows with key merge) equals parseIngestMode(same rows keyed ingest) for every value shape", () => {
    const vals: unknown[] = [undefined, null, "off", "shadow", "live", "on", '"shadow"', '"live"', "{\"mode\":\"live\"}", { mode: "shadow" }, { mode: "x" }, ["shadow"], 1, true];
    const kills: unknown[] = [undefined, false, true, { on: false }, { on: true }, "false", "yes", null, 0];
    for (const v of vals) for (const k of kills) {
      const rows = (key: string) => [...(v === undefined ? [] : [{ key, value: v }]), ...(k === undefined ? [] : [{ key: "kill_switch", value: k }])];
      expect(parseMergeMode(rows("merge"))).toBe(parseIngestMode(rows("ingest")));
      expect(parseMergeMode(rows("ingest"))).toBe("off");   // another step's key never opens merge
    }
  });
});
