/**
 * OREF (refuter, throwaway) — spine S6 room scoping, eaf21998. Real postgres:16, real claim/report routes, real enqueuer.
 * The oracle below is written from the brief, NOT from lib/spine/config.ts. Append-only: rows are INSERTed fresh per combo;
 * leftovers are retired by production paths (a live claim leases them). No DELETE. Synthetic ids only.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});

import { NextRequest } from "next/server";
import { POST as claimPOST } from "@/app/api/spine/claim/route";
import { POST as reportPOST } from "@/app/api/spine/report/route";
import { runSpineEnqueue } from "@/lib/spine/enqueue-store";

const pg = pgContainer("eta-spine-s6scope-oref2");
const d = dockerAvailable() ? describe : describe.skip;
const q = async (text: string, ...v: unknown[]) => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const cfg = (k: string, v: unknown) => q("INSERT INTO spine_config (key, value) VALUES (?, ?::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", k, JSON.stringify(v));
const req = (path: string, body: unknown) => new NextRequest(`http://x/api/spine/${path}`, { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) });
type J = { job_id: number; encounter_id: string; mode: string; stage: string };
const claim = async (live: boolean, owner = "ro") => ((await (await claimPOST(req("claim", { owner, limit: 5, live }))).json()) as { jobs: J[] }).jobs;
const report = (job_id: number, outcome: string, owner = "ro") => reportPOST(req("report", { job_id, owner, outcome }));

const A = "abcdefghijklmnopqrstuvwxyz234567";
let seq = 0;
const newId = () => { let n = ++seq, s = ""; for (let i = 0; i < 16; i++) { s = A[n % 32] + s; n = Math.floor(n / 32); } return `enc_${s}`; };
const insEnc = async (room: string | null, istDate: string, status = "confirmed") => { const id = newId(); await q("INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version) VALUES (?, ?::date, ?, '2026-10-19T03:00:00Z', '2026-10-19T03:20:00Z', ?, 1, 'mv1')", id, istDate, room, status); return id; };
const insJob = async (enc: string) => Number((await q("INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status) VALUES (?, 'recut', 'r1', 'kq', 'queued') RETURNING job_id", enc))[0]!.job_id);
const statusOf = async (enc: string) => String((await q("SELECT status FROM spine_job WHERE encounter_id = ? AND stage = 'recut'", enc))[0]?.status ?? "none");
const NOW = Date.parse("2026-10-19T06:10:00Z");

// ---- independent oracle (from the brief)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const declared = (v: unknown) => { const m = isObj(v) ? v.mode : v; return m === "live" || m === "shadow" ? m : "off"; };
const hasRooms = (v: unknown) => isObj(v) && "rooms" in v;
const validRooms = (v: unknown): string[] => { if (!isObj(v)) return []; const r = v.rooms; return Array.isArray(r) && r.every((x) => typeof x === "string" && x !== "") ? (r as string[]) : []; };
const killed = (k: unknown) => !(k === false || (isObj(k) && k.on === false));
const jobsOf = (j: unknown) => declared(j);
const listed = (v: unknown, room: string | null) => !hasRooms(v) || (room !== null && validRooms(v).includes(room));
function oracleClaim(live: boolean, k: unknown, j: unknown, m: unknown, room: string | null): boolean {
  if (killed(k) || jobsOf(j) === "off") return false;
  const dm = declared(m);
  if (live) return jobsOf(j) === "live" && dm === "live" && listed(m, room);
  return (dm === "shadow" && listed(m, room)) || (dm === "live" && hasRooms(m) && !listed(m, room));
}
function oraclePlan(k: unknown, j: unknown, m: unknown, room: string | null): string {
  if (killed(k) || jobsOf(j) === "off") return "none";
  const dm = declared(m);
  if (dm === "off") return "none";
  if (dm === "shadow") return listed(m, room) ? "shadow" : "none";
  return listed(m, room) && jobsOf(j) === "live" ? "queued" : "shadow";
}

const KILLS: unknown[] = [false, { on: false }, "yes"];
const JOBS: unknown[] = ["off", "shadow", "live", "LIVE", { mode: "live" }, 7];
const MODES: unknown[] = ["live", { mode: "live" }, { mode: "live", rooms: ["room_a"] }, { mode: "live", rooms: ["room_a", "room_b"] }, { mode: "live", rooms: [] },
  { mode: "live", rooms: "room_a" }, { mode: "live", rooms: null }, { mode: "live", rooms: ["room_a", 3] }, { mode: "live", rooms: ["room_zzz"] },
  { mode: "shadow", rooms: ["room_a"] }, "shadow", "off", { mode: "LIVE", rooms: ["room_a"] }, { rooms: ["room_a"] }];
const ROOMS: Array<string | null> = ["room_a", "room_b", null];
const FAST = process.env.OREF_FAST === "1";   // mutant runs: a smaller matrix
const KILLS_C = FAST ? [false, "yes"] : KILLS;
const JOBS_C = FAST ? ["shadow", "live", 7] : JOBS;

d("OREF S6 scope R2 on postgres:16", () => {
  beforeAll(async () => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    for (const f of ["0119_room_alert_outbox", "0138_room_alert_outbox_session_reaped", "0164_room_alert_outbox_ops_kinds", "0165_room_alert_outbox_fr1_kinds", "0173_spine", "0176_spine_encounter_single_proxy", "0177_spine_tick_breaker_idx"]) pg.exec(readFileSync(`db/migrations/${f}.sql`, "utf8"));
    process.env.SPINE_BEARER_TOKEN = "tok";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));   // 11:40 IST
  }, 120_000);
  afterAll(() => { vi.useRealTimers(); pg.stop(); });

  // drain = production path: a live claim under plain "live" leases every leftover queued row (lease 15 min; the clock is frozen)
  const drain = async () => { await cfg("kill_switch", false); await cfg("jobs", "live"); await cfg("mode.recut", "live"); for (let i = 0; i < 400; i++) { const g = await claim(true, "drain"); if (g.length === 0) return; for (const x of g) expect((await report(x.job_id, "done", "drain")).status).toBe(200); } throw new Error("drain"); };
  const drainLease = async () => { await cfg("kill_switch", false); await cfg("jobs", "live"); await cfg("mode.recut", "live"); for (let i = 0; i < 400; i++) if ((await claim(true, "drain")).length === 0) return; throw new Error("drain"); };

  it("room removed mid-flight: leased row finishes (done) under the new list; expired lease not re-claimed live; nothing deleted; re-added -> claimable; enqueue never revives it", async () => {
    await drain();
    await cfg("mode.recut", { mode: "live", rooms: ["room_a"] });
    const ea = await insEnc("room_a", "2026-10-19"), ea2 = await insEnc("room_a", "2026-10-19");
    await runSpineEnqueue(NOW);
    expect([await statusOf(ea), await statusOf(ea2)]).toEqual(["queued", "queued"]);
    const c1 = await claim(true);
    expect(c1.map((x) => x.encounter_id).sort()).toEqual([ea, ea2].sort());
    const total = Number((await q("SELECT count(*)::int AS n FROM spine_job"))[0]!.n);
    await cfg("mode.recut", { mode: "live", rooms: ["room_b"] });   // room_a leaves while both are leased
    await runSpineEnqueue(NOW);
    expect([await statusOf(ea), await statusOf(ea2)]).toEqual(["leased", "leased"]);   // enqueue does not touch leased rows
    const j1 = c1.find((x) => x.encounter_id === ea)!;
    const r = await report(j1.job_id, "done");
    expect(r.status).toBe(200);
    expect(await statusOf(ea)).toBe("done");   // in-flight finishes (G5)
    vi.setSystemTime(new Date(NOW + 20 * 60_000));   // ea2's lease expires
    expect((await claim(true)).map((x) => x.encounter_id)).not.toContain(ea2);
    const wr = await claim(false);   // a would_run claim may take it (unlisted room = shadow)
    expect(wr.map((x) => [x.encounter_id, x.mode])).toEqual([[ea2, "shadow"]]);
    expect((await report(wr[0]!.job_id, "shadow")).status).toBe(200);
    expect(await statusOf(ea2)).toBe("shadow");
    expect(Number((await q("SELECT count(*)::int AS n FROM spine_job"))[0]!.n)).toBe(total);
    await cfg("mode.recut", { mode: "live", rooms: ["room_b", "room_a"] });
    await runSpineEnqueue(NOW + 20 * 60_000);
    expect(await statusOf(ea2)).toBe("queued");
    expect(await statusOf(ea)).toBe("done");   // done never revived
    expect((await claim(true)).map((x) => x.encounter_id)).toEqual([ea2]);
    vi.setSystemTime(new Date(NOW));
  }, 120_000);

  it("a live-claimed job whose room is removed then reports release goes back to queued and is not live-claimable under an empty list", async () => {
    vi.setSystemTime(new Date(NOW + 60 * 60_000));
    await drain();
    await cfg("mode.recut", { mode: "live", rooms: ["room_a"] });
    const e = await insEnc("room_a", "2026-10-01");
    await insJob(e);
    const c = await claim(true);
    expect(c.map((x) => x.encounter_id)).toEqual([e]);
    await cfg("mode.recut", { mode: "live", rooms: [] });
    expect((await report(c[0]!.job_id, "release")).status).toBe(200);
    expect(await statusOf(e)).toBe("queued");   // released, attempts given back
    expect(await claim(true)).toEqual([]);   // empty list: live for no room
    vi.setSystemTime(new Date(NOW));
  }, 120_000);

  it("room ids are matched exactly (case, whitespace, json-ish)", async () => {
    vi.setSystemTime(new Date(NOW + 2 * 60 * 60_000));
    await drain();
    const odd = ['room"x', "Room_A", " room_a", "room_a"];
    const encs = [];
    for (const r of odd) { const e = await insEnc(r, "2026-10-01"); await insJob(e); encs.push(e); }
    await cfg("mode.recut", { mode: "live", rooms: ['room"x', "room_a"] });
    const got = (await claim(true)).map((x) => x.encounter_id).sort();
    expect(got).toEqual([encs[0], encs[3]].sort());
    vi.setSystemTime(new Date(NOW));
  }, 120_000);
  it("M12 killer: a superseded row (spent attempt) re-planned by the enqueuer gets a fresh budget (attempts 0); only the blocked revive keeps attempts", async () => {
    const T = NOW + 150 * 60_000;
    vi.setSystemTime(new Date(T));
    await drain();
    await cfg("mode.recut", { mode: "live", rooms: ["room_b"] });
    const e = await insEnc("room_b", "2026-10-19");
    await runSpineEnqueue(T);
    const c = await claim(true);
    expect(c.map((x) => x.encounter_id)).toEqual([e]);
    expect((await report(c[0]!.job_id, "transient")).status).toBe(200);
    const mid = (await q("SELECT status, attempts FROM spine_job WHERE encounter_id = ? AND stage = 'recut'", e))[0]!;
    expect([mid.status, Number(mid.attempts)]).toEqual(["queued", 1]);
    await q("UPDATE spine_encounter SET status = 'rejected' WHERE encounter_id = ?", e);   // the merger's move
    await runSpineEnqueue(T);
    expect(await statusOf(e)).toBe("superseded");
    await q("UPDATE spine_encounter SET status = 'confirmed' WHERE encounter_id = ?", e);
    await runSpineEnqueue(T);
    const after = (await q("SELECT status, attempts FROM spine_job WHERE encounter_id = ? AND stage = 'recut'", e))[0]!;
    expect([after.status, Number(after.attempts)]).toEqual(["queued", 0]);
    vi.setSystemTime(new Date(NOW));
  }, 120_000);

  it("enqueue x rooms matrix: planned status per room == oracle (and == claim oracle for live)", async () => {
    vi.setSystemTime(new Date(NOW + 3 * 3600e3));
    const mismatches: string[] = [];
    for (const k of [false, "yes"]) for (const j of JOBS_C) for (const m of MODES) {
      const encs = await Promise.all(ROOMS.map((r) => insEnc(r, "2026-10-19")));
      await cfg("kill_switch", k); await cfg("jobs", j); await cfg("mode.recut", m);
      await runSpineEnqueue(NOW + 3 * 3600e3);
      for (let i = 0; i < ROOMS.length; i++) {
        const want = oraclePlan(k, j, m, ROOMS[i]!);
        const got = await statusOf(encs[i]!);
        if (want !== got) mismatches.push(JSON.stringify({ k, j, m, room: ROOMS[i], want, got }));
        if ((got === "queued") !== oracleClaim(true, k, j, m, ROOMS[i]!)) mismatches.push(`parity ${JSON.stringify({ k, j, m, room: ROOMS[i] })}`);
      }
      await q("UPDATE spine_encounter SET status = 'rejected' WHERE encounter_id = ANY(?::text[])", `{${encs.join(",")}}`);   // the merger's move; the next live pass supersedes their rows
    }
    expect(mismatches).toEqual([]);
  }, 600_000);

  it("F1 x rooms matrix: claim(live|would_run) over kill x jobs x mode/rooms x room == oracle", async () => {
    vi.setSystemTime(new Date(NOW + 4 * 3600e3));   // after every other test: leases taken here never expire inside this file
    const mismatches: string[] = []; let combos = 0;
    for (const k of KILLS_C) for (const j of JOBS_C) for (const m of MODES) for (const live of [true, false]) {
      await drainLease();
      const encs = await Promise.all(ROOMS.map((r) => insEnc(r, "2026-10-01")));   // outside the enqueue horizon: only the claim sees them
      for (const e of encs) await insJob(e);
      await cfg("kill_switch", k); await cfg("jobs", j); await cfg("mode.recut", m);
      const got = await claim(live);
      combos++;
      ROOMS.forEach((r, i) => {
        const want = oracleClaim(live, k, j, m, r);
        const has = got.some((x) => x.encounter_id === encs[i]);
        if (want !== has) mismatches.push(JSON.stringify({ k, j, m, live, room: r, want, has }));
      });
      for (const x of got) if (x.mode !== (live ? "live" : "shadow") || x.stage !== "recut") mismatches.push(`mode/stage ${JSON.stringify(x)}`);
    }
    expect(combos).toBe(KILLS_C.length * JOBS_C.length * MODES.length * 2);
    expect(mismatches).toEqual([]);
  }, 1_800_000);

});
