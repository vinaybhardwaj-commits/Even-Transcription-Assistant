/**
 * zz-oref-r3-adv: R3 refuter adversarial tests, ported in R4 (attacks always on). Based on the R2 Opus refute's adversarial tests, ported, plus the R3 fixes (F6 real track keys through the report route, F1b no K-lane claim in the hourly window). postgres:16.
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
const pg = pgContainer("eta-spine-s6r4adv");
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
  // writer.track_filename(layer, engine, version, cfg8) for every clip_lanes LANES entry (versions as clip_lanes sets them; NEMOTRON_REV[:8])
  const tf = (layer: string, engine: string, version: string, cfg: string) => `${layer}.${engine}__${version}__${cfg}.json`;
  const REAL: Array<[string, string, string]> = [
    ["acoustics", "room_profile_acoustics", "tracks/" + tf("acoustics", "room_profile_acoustics", "v1", "0a1b2c3d")],
    ["nemotron", "nemotron", "tracks/" + tf("diar", "nemotron", "f667ed73", "9f8e7d6c")],
    ["nemotron", "nemotron", "tracks/" + tf("diar", "nemotron", "f667ed73", "12345678")],
    ["koyal", "koyal", "tracks/" + tf("stt", "koyal", "box-t4-koyal-1", "0a1b2c3d")],
    ["recut", "cutter", "consult.flac"],
  ];
  const keyRep = async (stage: string, engine: string, object_key: string) => {
    await q("DELETE FROM spine_job");
    const j = await leasedJob(stage === "koyal" ? "nemotron" : stage, "k" + Math.random().toString(36).slice(2, 8));
    const r = await rep(j.id, "done", { artefact: { engine, version: "v1", cfg8: "0a1b2c3d", store: "box", status: "ok", sha256: SHA_A, object_key } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown>, row: await row(j.id) };
  };

  it("OREF F6: every real clip_lanes track name and consult.flac is accepted by the REAL report route, and the job is done", async () => {
    for (const [stage, engine, key] of REAL) { const r = await keyRep(stage, engine, key); expect(r.status, key).toBe(200); expect(r.row.status, key).toBe("done"); }
  });

  it("OREF F6: uid / date / room / 8-digit / consult-tree keys are refused (400 bad_artefact) and the job stays leased", async () => {
    for (const key of ["2026-10-20/room_a/_consults/uid_test_01/tracks/acoustics.room_profile_acoustics__v1__0a1b2c3d.json", "_consults/uid_test_01/consult.flac", "uid_test_01/consult.flac",
      "tracks/2026-10-20/diar.nemotron__f667ed73__0a1b2c3d.json", "room_b/tracks/diar.nemotron__f667ed73__0a1b2c3d.json", "12345678/consult.flac", "tracks/x12345678y/consult.flac",
      "enc_testaaaaaaaaaaaa/consult.flac", "tracks/patient.json", "tracks/acoustics.room_profile_acoustics__uid__0a1b2c3d.json", "tracks/acoustics.room_profile_acoustics__v1__0A1B2C3D.json",
      "/consult.flac", "uid_test_01_consult.flac"]) {
      const r = await keyRep("acoustics", "room_profile_acoustics", key);
      expect(r.status, key).toBe(400); expect(r.body.error, key).toBe("bad_artefact"); expect(r.row.status, key).toBe("leased");
    }
  });

  // ATTACK: the "free parts" (unknown-lane file names, any directory) get only a word list, a date-with-dashes and an 8-digit screen.
  // Nothing the box writes has a free part (executors.py only ever emits `consult.flac` or `tracks/<lane file>`), so these should all be refused.
  const ATTACK = ["tracks/diar.nemotron__f667ed73__0a1b2c3d.json/", "tracks/stt.sarvam__v1__0a1b2c3d.json.bak", "tracks/priya_sharma.json", "opd4/consult.flac", "tracks/19-10-2026/consult.flac", "tracks/2026_10_20/consult.flac", "tracks/9876543.json", "ravi/kumar/consult.flac",
    "tracks/diar.nemotron__9876543210__0a1b2c3d.json", "tracks/diar.nemotron__priya-sharma__0a1b2c3d.json", "tracks/diar.nemotron__123456789012__0a1b2c3d.json"];
  for (const key of ATTACK) it(`OREF F6 ATTACK (expected refused): ${key}`, async () => {
    const r = await keyRep("nemotron", "nemotron", key);
    expect(r.status, key).toBe(400);
  });

  it("OREF F1b: 12 hourly_gap / budget releases across one window: 0 ticks, attempts net 0, breaker closed at every step", async () => {
    await q("DELETE FROM spine_job"); await q("DELETE FROM spine_tick");
    const j = await mkJob("nemotron", "c1", "hb");
    for (let i = 0; i < 12; i++) {
      await q("UPDATE spine_job SET status = 'leased', attempts = attempts + 1, lease_owner = 'ro', lease_until = now() + interval '10 min' WHERE job_id = ?::bigint", j.id);
      expect((await rep(j.id, "release", { error_code: i % 3 ? "hourly_gap" : "budget_too_small" })).status).toBe(200);
      expect(await openBreakers(["nemotron", "acoustics"], new Date())).toEqual([]);
    }
    expect(await row(j.id)).toMatchObject({ status: "queued", attempts: 0, last_error_code: null });
    expect(await q("SELECT count(*)::int AS n FROM spine_tick")).toEqual([{ n: 0 }]);
  });

  it("OREF F1b: the server skips K lanes over the whole :20-:45 window (every 30 s), recut is still handed out, skipped rows untouched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await setCfg({ jobs: "live", "mode.recut": "live", "mode.acoustics": "live", "mode.nemotron": "live" });
      await q("DELETE FROM spine_job"); await q("DELETE FROM spine_tick");
      const ka = await mkJob("acoustics", "c1", "wa"); const kn = await mkJob("nemotron", "c1", "wn");
      for (let s = 20 * 60; s < 45 * 60; s += 30) {
        const r = await mkJob("recut", "c1", "r" + s);
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 20, 5, 30, 0) + s * 1000));   // 11:00 IST + s
        const got = ((await (await claimPOST(claimReq({ owner: "ro", limit: 5, live: true }))).json()) as { jobs: Array<{ stage: string; job_id: number }> }).jobs;
        expect(got.map((g) => g.stage), String(s)).toEqual(["recut"]);
        await q("UPDATE spine_job SET status = 'done' WHERE job_id = ?::bigint", r.id);
      }
      for (const k of [ka, kn]) expect(await row(k.id)).toMatchObject({ status: "queued", attempts: 0, lease_owner: null });
      // a would_run (shadow) claim is NOT windowed: shadow stages are still handed out at :30
      await setCfg({ jobs: "live", "mode.acoustics": "shadow" });
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 20, 6, 0, 0)));
      const sh = ((await (await claimPOST(claimReq({ owner: "ro", limit: 5 }))).json()) as { jobs: Array<{ stage: string }> }).jobs;
      expect(sh.map((g) => g.stage)).toEqual(["acoustics"]);
    } finally { vi.useRealTimers(); }
  });

  it("R4 release backoff: box env window :10-:30 vs server :20-:45 -> at :15 the server hands the K job out and the box releases it, but it is NOT re-handed at the head: recut is reached; no tick, no attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await setCfg({ jobs: "live", "mode.recut": "live", "mode.nemotron": "live" });
      await q("DELETE FROM spine_job"); await q("DELETE FROM spine_tick");
      const k = await mkJob("nemotron", "c1", "dk");
      const r = await mkJob("recut", "c1", "dr");
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 20, 5, 45, 0)));   // 11:15 IST
      const seen: string[] = [];
      for (let i = 0; i < 2; i++) {
        const got = ((await (await claimPOST(claimReq({ owner: "ro", limit: 1, live: true }))).json()) as { jobs: Array<{ stage: string; job_id: number }> }).jobs;
        seen.push(got[0]!.stage);
        expect((await rep(Number(got[0]!.job_id), "release", { error_code: "hourly_gap" })).status).toBe(200);
      }
      expect(seen).toEqual(["nemotron", "recut"]);
      expect(await row(k.id)).toMatchObject({ status: "queued", attempts: 0 });
      expect(await row(r.id)).toMatchObject({ status: "queued", attempts: 0 });
      expect(await q("SELECT count(*)::int AS n FROM spine_tick")).toEqual([{ n: 0 }]);
    } finally { vi.useRealTimers(); }
  });
});
