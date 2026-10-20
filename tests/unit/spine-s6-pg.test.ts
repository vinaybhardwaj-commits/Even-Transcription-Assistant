/**
 * spine-s6-pg.test.ts — S6 on a REAL postgres:16 with migration 0173: N3 (shadow spent for live), the consult_uid link in a live claim, artefact reports. Synthetic ids only.
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
const pg = pgContainer("eta-spine-s6");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8");

describe("REQUIRED PROOF — spine S6 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-s6-pg.test.ts needs Docker for postgres:16. Set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
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

  // ------------------------------------------------------------ N3
  it("N3: a key spent in shadow is NOT enqueued again by default, but requeueShadow puts that one row back to queued for live", async () => {
    await q("DELETE FROM spine_job");
    const { e, id } = await mkJob("recut", "c1", "n3a");
    await q("UPDATE spine_job SET status = 'shadow', attempts = 0 WHERE job_id = ?::bigint", id);
    const key = { encounter_id: e, stage: "recut", cut_version: "c1", input_key: "n3a" };
    expect(await enqueue(key)).toBeNull();
    expect((await row(id)).status).toBe("shadow");
    expect(await enqueue({ ...key, requeueShadow: true })).toBe(id);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, next_attempt_at: null, lease_owner: null, last_error_class: null });
    const got = await claimJobs("r-live", ["recut"], 1, T0);
    expect(got.map((j) => j.job_id)).toEqual([id]);
    expect(await q("SELECT count(*)::int AS n FROM spine_job WHERE encounter_id = ?", e)).toEqual([{ n: 1 }]);   // same row, no second job
  });

  it("N3: requeueShadow never touches a row in any other status", async () => {
    await q("DELETE FROM spine_job");
    for (const st of ["queued", "leased", "done", "failed", "dead", "superseded"]) {
      const { e, id } = await mkJob("recut", "c1", `n3-${st}`);
      await q("UPDATE spine_job SET status = ?, attempts = 3, last_error_code = 'keep' WHERE job_id = ?::bigint", st, id);
      expect(await enqueue({ encounter_id: e, stage: "recut", cut_version: "c1", input_key: `n3-${st}`, requeueShadow: true }), st).toBeNull();
      expect(await row(id), st).toMatchObject({ status: st, attempts: 3, last_error_code: "keep" });
    }
  });

  it("N3: a shadow claim reported AFTER the stage went live is re-queued, not consumed as shadow; live then takes it", async () => {
    await q("DELETE FROM spine_job");
    const { id } = await mkJob("recut", "c1", "flip");
    await setCfg({ jobs: "live", "mode.recut": "shadow" });
    const c = await (await claimPOST(claimReq({ owner: "runner-s", limit: 1, live: false }))).json() as { jobs: Array<{ job_id: number }> };
    expect(c.jobs.map((j) => j.job_id)).toEqual([id]);
    await setCfg({ jobs: "live", "mode.recut": "live" });   // the flip, between claim and report
    const r = await reportPOST(reportReq({ job_id: id, owner: "runner-s", outcome: "shadow" }));
    expect(r.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, lease_owner: null });
    vi.useFakeTimers({ toFake: ["Date"] });   // R4: the re-queue is a release, which backs off 60 s
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const live = await (await claimPOST(claimReq({ owner: "runner-l", limit: 1, live: true }))).json() as { jobs: Array<{ job_id: number; mode: string }> };
    expect(live.jobs.map((j) => [j.job_id, j.mode])).toEqual([[id, "live"]]);
    vi.useRealTimers();
  });

  it("N3: with the stage still shadow (or off) a shadow report is consumed as shadow, as before", async () => {
    for (const cfg of [{ jobs: "live", "mode.recut": "shadow" }, { jobs: "live", "mode.recut": "off" }, {}]) {
      await q("DELETE FROM spine_job");
      const { id } = await mkJob("recut", "c1", "stay");
      await q("UPDATE spine_job SET status = 'leased', attempts = 1, lease_owner = 'rr', lease_until = now() + interval '10 min' WHERE job_id = ?::bigint", id);
      await setCfg(cfg);
      expect((await reportPOST(reportReq({ job_id: id, owner: "rr", outcome: "shadow" }))).status).toBe(200);
      expect(await row(id)).toMatchObject({ status: "shadow", attempts: 0 });
    }
  });

  // ------------------------------------------------------------ consult_uid in a live claim
  it("a live claim carries the active consult_uid link; none gives null; a would_run claim never sees the key; an inactive link is ignored", async () => {
    await q("DELETE FROM spine_job");
    const a = await mkJob("recut", "c1", "u1");
    const b = await mkJob("recut", "c1", "u2");
    const c = await mkJob("recut", "c1", "u3");
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES (?, 'consult_uid', 'uid_test_01', 'exact')", a.e);
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis, active) VALUES (?, 'consult_uid', 'uid_test_old', 'exact', false)", c.e);
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES (?, 'consult_key', 'ck_test_02', 'exact')", b.e);
    const live = await claimJobs("r1", ["recut"], 5, T0, undefined, true);
    expect(Object.fromEntries(live.map((j) => [j.job_id, j.consult_uid]))).toEqual({ [a.id]: "uid_test_01", [b.id]: null, [c.id]: null });
    await q("UPDATE spine_job SET status = 'queued', lease_owner = NULL, lease_until = NULL, attempts = 0");
    const plain = await claimJobs("r2", ["recut"], 5, T0);
    expect(plain.length).toBe(3);
    for (const j of plain) expect("consult_uid" in j).toBe(false);
  });

  it("the claim route returns consult_uid only for live=true", async () => {
    await q("DELETE FROM spine_job");
    const a = await mkJob("acoustics", "c1", "ur");
    await q("INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES (?, 'consult_uid', 'uid_test_03', 'exact')", a.e);
    await setCfg({ jobs: "live", "mode.acoustics": "live" });
    const live = await (await claimPOST(claimReq({ owner: "r-live", limit: 1, live: true }))).json() as { jobs: Array<Record<string, unknown>> };
    expect(live.jobs[0]).toMatchObject({ job_id: a.id, consult_uid: "uid_test_03", mode: "live" });
    await q("UPDATE spine_job SET status = 'queued', lease_owner = NULL, lease_until = NULL, attempts = 0");
    await setCfg({ jobs: "live", "mode.acoustics": "shadow" });
    const sh = await (await claimPOST(claimReq({ owner: "r-sh", limit: 1, live: false }))).json() as { jobs: Array<Record<string, unknown>> };
    expect(sh.jobs[0]).toBeDefined();
    expect("consult_uid" in sh.jobs[0]!).toBe(false);
  });

  // ------------------------------------------------------------ F4: enqueue wires requeueShadow itself
  it("F4: enqueue of a key spent in shadow re-queues that one row when the stage is live NOW, and leaves it alone when it is not", async () => {
    await q("DELETE FROM spine_job");
    const { e, id } = await mkJob("recut", "c1", "f4");
    await q("UPDATE spine_job SET status = 'shadow', attempts = 0 WHERE job_id = ?::bigint", id);
    const key = { encounter_id: e, stage: "recut", cut_version: "c1", input_key: "f4" };
    await setCfg({ jobs: "live", "mode.recut": "shadow" });
    expect(await enqueue(key)).toBeNull();
    expect((await row(id)).status).toBe("shadow");
    await setCfg({ jobs: "off", "mode.recut": "live" });   // jobs off: not live
    expect(await enqueue(key)).toBeNull();
    await setCfg({ jobs: "live", "mode.recut": "live" });
    expect(await enqueue(key)).toBe(id);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, next_attempt_at: null });
    expect(await q("SELECT count(*)::int AS n FROM spine_job WHERE encounter_id = ?", e)).toEqual([{ n: 1 }]);
    expect(await enqueue(key)).toBeNull();   // now queued: a further enqueue is a no-op
    // a sibling encounter's shadow row is untouched
    const sib = await mkJob("recut", "c1", "f4");
    await q("UPDATE spine_job SET status = 'shadow' WHERE job_id = ?::bigint", sib.id);
    expect(await enqueue(key)).toBeNull();
    expect((await row(sib.id)).status).toBe("shadow");
  });

  // ------------------------------------------------------------ F3: no consult_uid link is BLOCKED, not a failure
  it("F3: 10 jobs reported blocked/no_consult_uid never open the breaker, spend no attempt, are not claimable, and come back on unblock", async () => {
    await q("DELETE FROM spine_job"); await q("DELETE FROM spine_tick");
    await setCfg({ jobs: "live", "mode.recut": "live" });
    const ids: Array<{ e: string; id: number }> = [];
    for (let i = 0; i < 10; i++) ids.push(await mkJob("recut", "c1", `f3-${i}`));
    for (const j of ids) {
      const c = await (await claimPOST(claimReq({ owner: "rb", limit: 1, live: true }))).json() as { jobs: Array<{ job_id: number; consult_uid: string | null }> };
      expect(c.jobs.length).toBe(1);
      expect(c.jobs[0]!.consult_uid).toBeNull();
      const r = await reportPOST(reportReq({ job_id: c.jobs[0]!.job_id, owner: "rb", outcome: "blocked", error_code: "no_consult_uid" }));
      expect(r.status).toBe(200);
    }
    for (const j of ids) expect(await row(j.id)).toMatchObject({ status: "queued", attempts: 0, last_error_code: "no_consult_uid", last_error_class: null, lease_owner: null });
    expect(await q("SELECT count(*)::int AS n FROM spine_tick WHERE kind = 'attempt:recut'")).toEqual([{ n: 0 }]);
    expect(await openBreakers(["recut"], T0)).toEqual([]);
    expect(await claimJobs("rb", ["recut"], 5, new Date("2099-01-01T00:00:00Z"))).toEqual([]);   // held: not retried, however late
    // a link appears: the enqueuer re-queues exactly that row
    const first = ids[0]!;
    expect(await enqueue({ encounter_id: first.e, stage: "recut", cut_version: "c1", input_key: "f3-0" })).toBeNull();   // no flag: untouched
    expect(await enqueue({ encounter_id: first.e, stage: "recut", cut_version: "c1", input_key: "f3-0", unblock: true })).toBe(first.id);
    expect(await row(first.id)).toMatchObject({ status: "queued", attempts: 0, next_attempt_at: null, last_error_code: null });
    expect((await claimJobs("rb", ["recut"], 5, T0)).map((j) => j.job_id)).toEqual([first.id]);
  });

  // ------------------------------------------------------------ artefact reports
  const leased = async (stage = "recut", key = "art") => {
    const j = await mkJob(stage, "cutA", key);
    await q("UPDATE spine_job SET status = 'leased', attempts = 1, lease_owner = 'rr', lease_until = now() + interval '10 min' WHERE job_id = ?::bigint", j.id);
    return j;
  };

  it("done + artefact records one spine_artefact row (ref + sha, no body); an identical re-report is idempotent", async () => {
    const j = await leased();
    const r = await reportJob({ job_id: j.id, owner: "rr", outcome: "done", artefact: { ...ART }, now: T0, rng: () => 0.5 });
    expect(r).toEqual({ ok: true, status: "done", artefact: "recorded" });
    expect(await q("SELECT stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status FROM spine_artefact WHERE encounter_id = ?", j.e))
      .toEqual([{ stage: "recut", engine: "cutter", version: "v1", cfg8: "0a1b2c3d", cut_version: "cutA", store: "box", bucket: null, object_key: "consult.flac", sha256: SHA_A, status: "ok" }]);
    // a second job with the same artefact key (e.g. a re-run after a lost report) is `existing`, not a duplicate row
    await q("UPDATE spine_job SET status = 'leased', attempts = 1, lease_owner = 'rr', lease_until = now() + interval '10 min' WHERE job_id = ?::bigint", j.id);
    expect(await reportJob({ job_id: j.id, owner: "rr", outcome: "done", artefact: { ...ART }, now: T0, rng: () => 0.5 })).toEqual({ ok: true, status: "done", artefact: "existing" });
    expect(await q("SELECT count(*)::int AS n FROM spine_artefact WHERE encounter_id = ?", j.e)).toEqual([{ n: 1 }]);
  });

  it("a DIFFERENT sha for an existing artefact key never overwrites it and fails the job permanent sha_conflict", async () => {
    const j = await leased("recut", "art2");
    await reportJob({ job_id: j.id, owner: "rr", outcome: "done", artefact: { ...ART }, now: T0, rng: () => 0.5 });
    await q("UPDATE spine_job SET status = 'leased', attempts = 1, lease_owner = 'rr', lease_until = now() + interval '10 min', done_at = NULL, last_error_class = NULL WHERE job_id = ?::bigint", j.id);
    const r = await reportJob({ job_id: j.id, owner: "rr", outcome: "done", artefact: { ...ART, sha256: SHA_B }, now: T0, rng: () => 0.5 });
    expect(r).toEqual({ ok: true, status: "failed", artefact: "conflict" });
    expect(await row(j.id)).toMatchObject({ status: "failed", last_error_class: "permanent", last_error_code: "sha_conflict" });
    expect(await q("SELECT sha256 FROM spine_artefact WHERE encounter_id = ?", j.e)).toEqual([{ sha256: SHA_A }]);
  });

  it("a lost lease records no artefact", async () => {
    const j = await leased("recut", "art3");
    const r = await reportJob({ job_id: j.id, owner: "someone-else", outcome: "done", artefact: { ...ART }, now: T0, rng: () => 0.5 });
    expect(r).toEqual({ ok: false, error: "lease_lost" });
    expect(await q("SELECT count(*)::int AS n FROM spine_artefact WHERE encounter_id = ?", j.e)).toEqual([{ n: 0 }]);
  });

  it("the report route: artefact on a non-done outcome or a malformed artefact is 400 and changes nothing; a good one is 200", async () => {
    const j = await leased("nemotron", "art4");
    for (const bad of [{ outcome: "transient", artefact: ART }, { outcome: "done", artefact: { ...ART, sha256: "xyz" } }, { outcome: "done", artefact: { ...ART, object_key: "../etc/x" } },
      { outcome: "done", artefact: { ...ART, store: "disk" } }, { outcome: "done", artefact: "str" }, { outcome: "done", artefact: { ...ART, engine: "cut ter" } }]) {
      const r = await reportPOST(reportReq({ job_id: j.id, owner: "rr", ...bad }));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await row(j.id)).toMatchObject({ status: "leased" });
    expect((await reportPOST(reportReq({ job_id: j.id, owner: "rr", outcome: "done", artefact: ART }))).status).toBe(200);
    expect(await row(j.id)).toMatchObject({ status: "done" });
  });
});

describe("parseArtefact", () => {
  it("accepts a ref, refuses text-ish / path-escaping / digit-run engine", () => {
    expect(parseArtefact(ART)).toMatchObject({ engine: "cutter", sha256: SHA_A, bucket: null });
    expect(parseArtefact({ ...ART, version: "12345678" })).not.toBeNull();            // a hex revision may be all digits
    expect(parseArtefact({ ...ART, object_key: "tracks/diar.nemotron__12345678__12345678.json" })).not.toBeNull();   // the box-generated version / cfg8 parts may hold a digit run
    // F6: object_key gets the digit-run and identity-word screen too
    for (const bad of ["tracks/20261019123456/x.json", "2026-10-19/consult.flac", "room_a/consult.flac", "tracks/uid_test_01.json", "enc_testaaaaaaaaaaaa/consult.flac", "tracks/patient.json", "tracks/12345678.json", "tracks/diar.nemotron12345678__v1__0123abcd.json"])
      expect(parseArtefact({ ...ART, object_key: bad }), bad).toBeNull();
    expect(parseArtefact({ ...ART, engine: "e12345678" })).toBeNull();
    for (const bad of [null, [], "x", {}, { ...ART, cfg8: "ABCDEFGH" }, { ...ART, cfg8: "abc" }, { ...ART, status: "weird" }, { ...ART, bucket: "a b" }, { ...ART, object_key: "a/../b" }, { ...ART, object_key: "a b" }]) expect(parseArtefact(bad)).toBeNull();
  });
});
