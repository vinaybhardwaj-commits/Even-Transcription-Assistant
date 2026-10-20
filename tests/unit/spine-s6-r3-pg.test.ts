/**
 * spine-s6-r3-pg: the R2 Opus refute's adversarial tests, ported, plus the R3 fixes (F6 real track keys through the report route, F1b no K-lane claim in the hourly window). postgres:16.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: async (s: TemplateStringsArray, ...v: unknown[]) => H.tag!(s, ...v) }));

import { claimJobs, enqueue, openBreakers, reportJob } from "@/lib/spine/jobs";
import { parseArtefact } from "@/lib/spine/artefact";
import { NextRequest } from "next/server";
import { POST as claimPOST } from "@/app/api/spine/claim/route";
import { POST as reportPOST } from "@/app/api/spine/report/route";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-s6r3");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8");

describe("REQUIRED PROOF — spine S6 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-s6-r3-pg.test.ts needs Docker for postgres:16. Set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
const q = async (text: string, ...v: unknown[]) => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const setCfg = async (cfg: Record<string, unknown>) => { await q("DELETE FROM spine_config"); for (const [k, v] of Object.entries(cfg)) await q("INSERT INTO spine_config (key, value) VALUES (?, ?::jsonb)", k, JSON.stringify(v)); };
const req = (path: string, body: unknown) => new NextRequest(`http://x/api/spine/${path}`, { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) });
const claimReq = (body: unknown) => req("claim", body);
const reportReq = (body: unknown) => req("report", body);
const T0 = new Date("2026-10-19T06:00:00Z");
let seq = 100;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const mkEnc = async (): Promise<string> => {
  seq += 1;
  const id = `enc_testtesttestte${B32[seq % 32]}${B32[Math.floor(seq / 32) % 32]}`;
  await q("INSERT INTO spine_encounter (encounter_id, ist_date, t_open, status, merge_version) VALUES (?, '2026-10-19', now(), 'confirmed', 'mv1')", id);
  return id;
};
const mkJob = async (stage = "recut", cut = "c1", key = "k1") => { const e = await mkEnc(); const id = await enqueue({ encounter_id: e, stage, cut_version: cut, input_key: key }); return { e, id: id! }; };
const row = async (id: number) => (await q("SELECT * FROM spine_job WHERE job_id = ?::bigint", id))[0]!;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ART = { engine: "cutter", version: "v1", cfg8: "0a1b2c3d", store: "box", status: "ok", sha256: SHA_A, object_key: "consult.flac" } as const;

d("spine S6 on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    for (const f of ["0119_room_alert_outbox", "0138_room_alert_outbox_session_reaped", "0164_room_alert_outbox_ops_kinds", "0165_room_alert_outbox_fr1_kinds"]) pg.exec(readFileSync(`db/migrations/${f}.sql`, "utf8"));
    pg.exec(UP);
    process.env.SPINE_BEARER_TOKEN = "tok";
  });
  afterAll(() => { pg.stop(); });

  const leasedJob = async (stage: string, key: string, attempts = 1) => {
    const j = await mkJob(stage, "c1", key);
    await q("UPDATE spine_job SET status = 'leased', attempts = ?::int, lease_owner = 'ro', lease_until = now() + interval '10 min' WHERE job_id = ?::bigint", attempts, j.id);
    return j;
  };
  const rep = (id: number, outcome: string, extra: Record<string, unknown> = {}) => reportPOST(reportReq({ job_id: id, owner: "ro", outcome, ...extra }));

  it("ADV F3: a blocked row is never claimable, at any clock, and never reaped; last-attempt blocked gives the attempt back", async () => {
    await q("DELETE FROM spine_job"); await q("DELETE FROM spine_tick");
    const j = await leasedJob("recut", "b1", 6);
    expect((await rep(j.id, "blocked", { error_code: "no_consult_uid" })).status).toBe(200);
    expect(await row(j.id)).toMatchObject({ status: "queued", attempts: 5, lease_until: null });
    expect(String((await q("SELECT next_attempt_at::text AS t FROM spine_job WHERE job_id = ?::bigint", j.id))[0]!.t)).toBe("infinity");
    for (const at of [T0, new Date("2099-01-01T00:00:00Z"), new Date("9999-12-31T00:00:00Z")]) expect(await claimJobs("x", ["recut"], 5, at)).toEqual([]);
    const { reapExhausted } = await import("@/lib/spine/jobs");
    expect(await reapExhausted(new Date("9999-12-31T00:00:00Z"))).toBe(0);
    expect(await q("SELECT count(*)::int AS n FROM spine_tick")).toEqual([{ n: 0 }]);
  });

  it("ADV F3: a transient report is NOT held (finite backoff)", async () => {
    await q("DELETE FROM spine_job");
    const j = await leasedJob("recut", "t1");
    expect((await rep(j.id, "transient", { error_code: "lock_busy" })).status).toBe(200);
    expect(String((await q("SELECT next_attempt_at::text AS t FROM spine_job WHERE job_id = ?::bigint", j.id))[0]!.t)).not.toBe("infinity");
  });

  it("ADV F3: unblock touches ONLY a held row: a backing-off, leased, done, dead or shadow row is untouched", async () => {
    await q("DELETE FROM spine_job");
    const cases: Array<[string, string]> = [["queued", "now() + interval '1 hour'"], ["queued", "NULL"], ["leased", "NULL"], ["done", "NULL"], ["dead", "NULL"], ["shadow", "NULL"]];
    for (const [i, [st, nxt]] of cases.entries()) {
      const { e, id } = await mkJob("recut", "c1", `u${i}`);
      await q(`UPDATE spine_job SET status = ?, attempts = 3, next_attempt_at = ${nxt}, last_error_code = 'lock_busy' WHERE job_id = ?::bigint`, st, id);
      await setCfg({ jobs: "live", "mode.recut": "shadow" });
      expect(await enqueue({ encounter_id: e, stage: "recut", cut_version: "c1", input_key: `u${i}`, unblock: true }), `${st}/${nxt}`).toBeNull();
      expect(await row(id), `${st}/${nxt}`).toMatchObject({ status: st, attempts: 3, last_error_code: "lock_busy" });
    }
  });

  it("ADV F4: live re-queue touches one row only: same encounter's other-stage shadow rows and a held blocked row are untouched", async () => {
    await q("DELETE FROM spine_job");
    const e = await mkEnc();
    const ids: Record<string, number> = {};
    for (const s of ["recut", "acoustics", "nemotron"]) { ids[s] = (await enqueue({ encounter_id: e, stage: s, cut_version: "c1", input_key: "k" }))!; await q("UPDATE spine_job SET status = 'shadow' WHERE job_id = ?::bigint", ids[s]); }
    const blk = (await enqueue({ encounter_id: e, stage: "recut", cut_version: "c1", input_key: "kb" }))!;
    await q("UPDATE spine_job SET next_attempt_at = 'infinity' WHERE job_id = ?::bigint", blk);
    await setCfg({ jobs: "live", "mode.recut": "live", "mode.acoustics": "shadow", "mode.nemotron": "live" });
    expect(await enqueue({ encounter_id: e, stage: "recut", cut_version: "c1", input_key: "k" })).toBe(ids.recut);
    expect((await row(ids.acoustics!)).status).toBe("shadow");
    expect((await row(ids.nemotron!)).status).toBe("shadow");
    expect(await enqueue({ encounter_id: e, stage: "acoustics", cut_version: "c1", input_key: "k" })).toBeNull();
    expect(await enqueue({ encounter_id: e, stage: "recut", cut_version: "c1", input_key: "kb" })).toBeNull();   // live, but blocked needs unblock
    expect(String((await q("SELECT next_attempt_at::text AS t FROM spine_job WHERE job_id = ?::bigint", blk))[0]!.t)).toBe("infinity");
    expect(await q("SELECT count(*)::int AS n FROM spine_job WHERE status = 'queued' AND next_attempt_at IS NULL")).toEqual([{ n: 1 }]);
    await setCfg({ jobs: "live", "mode.recut": "LIVE" });   // malformed = off
    await q("UPDATE spine_job SET status = 'shadow' WHERE job_id = ?::bigint", ids.recut);
    expect(await enqueue({ encounter_id: e, stage: "recut", cut_version: "c1", input_key: "k" })).toBeNull();
  });

  it("ADV F6: the REAL clip_lanes acoustics track key is accepted by the report route", async () => {
    await q("DELETE FROM spine_job");
    const j = await leasedJob("acoustics", "a1");
    const art = { engine: "room_profile_acoustics", version: "v1", cfg8: "0a1b2c3d", store: "box", status: "ok", sha256: SHA_A, object_key: "tracks/acoustics.room_profile_acoustics__v1__0a1b2c3d.json" };
    const r = await rep(j.id, "done", { artefact: art });
    expect(r.status, JSON.stringify(await r.json())).toBe(200);
  });

  const keyRep = async (stage: string, engine: string, object_key: string) => {
    await q("DELETE FROM spine_job");
    const j = await leasedJob(stage, "k" + Math.random().toString(36).slice(2, 8));
    return rep(j.id, "done", { artefact: { engine, version: "v1", cfg8: "0a1b2c3d", store: "box", status: "ok", sha256: SHA_A, object_key } });
  };

  it("R3 F6: the real box keys are accepted through the report route", async () => {
    for (const [stage, engine, key] of [
      ["acoustics", "room_profile_acoustics", "tracks/acoustics.room_profile_acoustics__v1__0a1b2c3d.json"],
      ["nemotron", "nemotron", "tracks/diar.nemotron__f667ed73__0a1b2c3d.json"],
      ["nemotron", "nemotron", "tracks/diar.nemotron__12345678__87654321.json"],
      ["recut", "cutter", "consult.flac"],
    ] as const) { const r = await keyRep(stage, engine, key); expect(r.status, key).toBe(200); }
  });

  it("R3 F6: keys with a uid, a date, a room dir, an 8-digit dir or a free word are refused with 400 bad_artefact", async () => {
    for (const key of ["tracks/uid_test_01/acoustics.room_profile_acoustics__v1__0a1b2c3d.json", "2026-10-19/x/consult.flac", "tracks/12345678/consult.flac", "room_a/consult.flac", "room/consult.flac",
      "tracks/acoustics.room_profile_acoustics__2026-10-01__0a1b2c3d.json", "tracks/diar.nemotron__enc__0a1b2c3d.json", "tracks/12345678.json", "tracks/room_profile.json", "tracks/acoustics.room_profile_acoustics__v1__0a1b2c3d.json.bak"]) {
      const r = await keyRep("acoustics", "room_profile_acoustics", key);
      expect(r.status, key).toBe(400);
    }
  });

  it("R3 F6: parseArtefact on the closed lane list", () => {
    for (const k of ["tracks/diar.nemotron__f667ed73__0123abcd.json", "tracks/diar.nemotron__12345678__87654321.json", "tracks/stt.koyal__box-t4-koyal-1__0a1b2c3d.json", "consult.flac"]) expect(parseArtefact({ ...ART, object_key: k }), k).not.toBeNull();
    for (const k of ["tracks/uid_test_01/x.json", "2026-10-19/x/consult.flac", "tracks/12345678.json", "room_a/consult.flac", "tracks/diar.other_room__v1__0a1b2c3d.json", "tracks/diar.nemotron__v1__0A1B2C3D_room.json", "tracks//consult.flac"]) expect(parseArtefact({ ...ART, object_key: k }), k).toBeNull();
  });

  it("R3 F1b: the claim route hands out no K-lane job from :20 to :45 IST, and does at :45 and :19", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await setCfg({ jobs: "live", "mode.recut": "live", "mode.acoustics": "live", "mode.nemotron": "live" });
      for (const [istTime, expectK] of [["11:19:59", true], ["11:20:00", false], ["11:30:00", false], ["11:44:59", false], ["11:45:00", true], ["00:00:00", true]] as const) {
        await q("DELETE FROM spine_job"); await q("DELETE FROM spine_tick");
        const [h, m, s] = istTime.split(":").map(Number);
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 20, h! - 5, m! - 30, s!)));
        for (const st of ["recut", "acoustics", "nemotron"]) await mkJob(st, "c1", "w" + st);
        const r = await claimPOST(claimReq({ owner: "ro", limit: 5, live: true }));
        const stages = ((await r.json()) as { jobs: Array<{ stage: string }> }).jobs.map((j) => j.stage).sort();
        expect(stages, istTime).toEqual(expectK ? ["acoustics", "nemotron", "recut"] : ["recut"]);
      }
      // the skipped jobs are untouched: still queued, no attempt spent
      expect(await q("SELECT count(*)::int AS n FROM spine_job WHERE attempts = 0")).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("R3 F1b: one `release` (hourly_gap) never opens the breaker and spends no attempt", async () => {
    await q("DELETE FROM spine_job"); await q("DELETE FROM spine_tick");
    const j = await leasedJob("acoustics", "g1", 1);
    expect((await rep(j.id, "release", { error_code: "hourly_gap" })).status).toBe(200);
    expect(await row(j.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await q("SELECT count(*)::int AS n FROM spine_tick")).toEqual([{ n: 0 }]);
    expect(await openBreakers(["acoustics"], new Date())).toEqual([]);
  });
});
