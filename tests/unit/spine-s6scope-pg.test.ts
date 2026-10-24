/**
 * spine-s6scope-pg.test.ts — per-room scoping of live stages (S6 gap G1) on a REAL postgres:16: the enqueuer, the claim route and the report route agree.
 * Append-only: config moves by upsert, jobs by the production paths (enqueue pass, claim, report). No DELETE anywhere. Synthetic ids; no host-local paths.
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

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-s6scope");

describe("REQUIRED PROOF — spine S6 room scoping runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-s6scope-pg.test.ts needs Docker for postgres:16. Set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
const q = async (text: string, ...v: unknown[]) => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const cfg = (k: string, v: unknown) => q("INSERT INTO spine_config (key, value) VALUES (?, ?::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", k, JSON.stringify(v));
const req = (path: string, body: unknown) => new NextRequest(`http://x/api/spine/${path}`, { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) });
const claim = async (live: boolean) => ((await (await claimPOST(req("claim", { owner: "ro", limit: 5, live }))).json()) as { jobs: Array<{ job_id: number; encounter_id: string; mode: string }> }).jobs;
const report = (job_id: number, outcome: string) => reportPOST(req("report", { job_id, owner: "ro", outcome }));

const NOW = Date.parse("2026-10-19T06:00:00Z");
const E = { a: "enc_testaaaaaaaaaaaa", b: "enc_testbbbbbbbbbbbb", n: "enc_testcccccccccccc" };   // room_a, room_b, no room
const status = async (enc: string, stage = "recut") => String((await q("SELECT status FROM spine_job WHERE encounter_id = ? AND stage = ?", enc, stage))[0]?.status ?? "none");
const jobCount = async () => Number((await q("SELECT count(*)::int AS n FROM spine_job"))[0]!.n);

d("spine S6 room scoping on postgres:16", () => {
  beforeAll(async () => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    for (const f of ["0119_room_alert_outbox", "0138_room_alert_outbox_session_reaped", "0164_room_alert_outbox_ops_kinds", "0165_room_alert_outbox_fr1_kinds"]) pg.exec(readFileSync(`db/migrations/${f}.sql`, "utf8"));
    pg.exec(readFileSync("db/migrations/0173_spine.sql", "utf8"));
    process.env.SPINE_BEARER_TOKEN = "tok";
    const ins = (id: string, room: string | null) => q("INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version) VALUES (?, '2026-10-19', ?, '2026-10-19T03:00:00Z', '2026-10-19T03:20:00Z', 'confirmed', 1, 'mv1')", id, room);
    await ins(E.a, "room_a"); await ins(E.b, "room_b"); await ins(E.n, null);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T06:10:00Z"));   // 11:40 IST: outside the K-lane window
  });
  afterAll(() => { vi.useRealTimers(); pg.stop(); });

  it("a room list: only the listed room is queued live; the others are planned shadow; a live claim takes only the listed room", async () => {
    await cfg("kill_switch", false); await cfg("jobs", "live");
    await cfg("mode.recut", { mode: "live", rooms: ["room_a"] });
    const r = await runSpineEnqueue(NOW);
    expect(r).toMatchObject({ jobs: "live", queued: 1, shadow: 2 });
    expect([await status(E.a), await status(E.b), await status(E.n)]).toEqual(["queued", "shadow", "shadow"]);
    const got = await claim(true);
    expect(got.map((j) => [j.encounter_id, j.mode])).toEqual([[E.a, "live"]]);
    expect(await claim(true)).toEqual([]);   // nothing else is live-claimable
    expect((await claim(false)).length).toBe(0);   // shadow rows are never claimable
  });

  it("a room taken out mid-flight: its queued row is not claimed live (nothing deleted); a would_run claim takes it as shadow; the shadow report consumes it", async () => {
    await cfg("mode.recut", "live");   // every room again
    await runSpineEnqueue(NOW);   // shadow rows of b and the no-room encounter revive as queued
    expect([await status(E.a), await status(E.b), await status(E.n)]).toEqual(["leased", "queued", "queued"]);   // a is still leased from the previous test
    await q("UPDATE spine_job SET status = 'done', lease_owner = NULL, lease_until = NULL, done_at = now() WHERE encounter_id = ?", E.a);   // the runner finished it
    const before = await jobCount();
    await cfg("mode.recut", { mode: "live", rooms: ["room_a"] });   // b leaves the list while its row is queued
    await runSpineEnqueue(NOW);
    expect(await jobCount()).toBe(before);   // nothing deleted
    expect(await status(E.b)).toBe("queued");
    expect(await claim(true)).toEqual([]);   // not claimed live
    const wr = await claim(false);   // a would_run runner sees it as shadow
    expect(wr.map((j) => [j.encounter_id, j.mode]).sort()).toEqual([[E.b, "shadow"], [E.n, "shadow"]].sort());
    for (const j of wr) expect((await report(j.job_id, "shadow")).status).toBe(200);
    expect([await status(E.b), await status(E.n)]).toEqual(["shadow", "shadow"]);   // consumed as shadow, not bounced back to queued
    // b comes back into the list: the enqueue pass revives its shadow row
    await cfg("mode.recut", { mode: "live", rooms: ["room_a", "room_b"] });
    await runSpineEnqueue(NOW);
    expect([await status(E.b), await status(E.n)]).toEqual(["queued", "shadow"]);
    expect((await claim(true)).map((j) => j.encounter_id)).toEqual([E.b]);
  });

  it("a shadow report for a room that is live now is re-queued (release); for a room that is not, consumed", async () => {
    // n (no room) is shadow; give it a leased would_run row and report: shadow stays shadow
    await q("UPDATE spine_job SET status = 'leased', attempts = 1, lease_owner = 'ro', lease_until = now() + interval '10 min' WHERE encounter_id = ? AND stage = 'recut'", E.n);
    expect((await report(Number((await q("SELECT job_id FROM spine_job WHERE encounter_id = ?", E.n))[0]!.job_id), "shadow")).status).toBe(200);
    expect(await status(E.n)).toBe("shadow");
    // b is listed (live): a would_run runner reporting shadow for it is a release
    await q("UPDATE spine_job SET status = 'leased', attempts = 1, lease_owner = 'ro', lease_until = now() + interval '10 min' WHERE encounter_id = ? AND stage = 'recut'", E.b);
    expect((await report(Number((await q("SELECT job_id FROM spine_job WHERE encounter_id = ?", E.b))[0]!.job_id), "shadow")).status).toBe(200);
    expect(await status(E.b)).toBe("queued");
  });

  it("malformed, empty and unknown-room lists: live for no room", async () => {
    await q("UPDATE spine_job SET status = 'done', lease_owner = NULL, lease_until = NULL, done_at = now() WHERE stage = 'recut'");
    await q("INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status) VALUES (?, 'recut', 'r1', 'kq', 'queued')", E.a);   // a queued row in room_a that only a valid list may release
    for (const bad of [{ mode: "live", rooms: "room_a" }, { mode: "live", rooms: null }, { mode: "live", rooms: [] }, { mode: "live", rooms: ["room_zzz"] }, { mode: "live", rooms: [7] }]) {
      await cfg("mode.recut", bad);
      await runSpineEnqueue(NOW);
      expect(await claim(true), JSON.stringify(bad)).toEqual([]);
    }
    await cfg("mode.recut", { mode: "live", rooms: ["room_a"] });   // positive control: the same row, a valid list
    expect((await claim(true)).map((j) => j.encounter_id)).toEqual([E.a]);
    await q("UPDATE spine_job SET status = 'done', lease_owner = NULL, lease_until = NULL, done_at = now() WHERE stage = 'recut'");
  });

  it("kill_switch, jobs=shadow and a paid stage: nothing live-claimable whatever the room list says", async () => {
    // a fresh queued row in room_a under the plain 'live' string
    await cfg("mode.recut", "live");
    await q("INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status) VALUES (?, 'recut', 'r9', 'kx', 'queued')", E.a);
    await cfg("mode.recut", { mode: "live", rooms: ["room_a"] });
    await cfg("jobs", "shadow");
    expect(await claim(true)).toEqual([]);
    await cfg("jobs", "live"); await cfg("kill_switch", true);
    expect(await claim(true)).toEqual([]);
    await cfg("kill_switch", false);
    // sarvam is paid: a queued row (impossible from the enqueuer, forced here) is never handed out
    await cfg("mode.sarvam", { mode: "live", rooms: ["room_a"] });
    await q("INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status) VALUES (?, 'sarvam', 'r9', 'kx', 'queued')", E.a);
    const got = await claim(true);
    expect(got.map((j) => j.encounter_id)).toEqual([E.a]);
    expect(String((await q("SELECT stage FROM spine_job WHERE job_id = ?::bigint", got[0]!.job_id))[0]!.stage)).toBe("recut");
    expect(await claim(true)).toEqual([]);
    expect(await status(E.a, "sarvam")).toBe("queued");
  });
});
