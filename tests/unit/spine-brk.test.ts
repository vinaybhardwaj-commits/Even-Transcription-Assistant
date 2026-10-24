/**
 * spine-brk: a data-driven recut skip (skip_no_session ...) must not trip the stage breaker. Real claim and report routes on postgres:16 (migrations 0173 + 0176; never Neon).
 * Synthetic ids only. spine_tick is append-only: nothing is deleted; states are reached by reports. Job rows are inserted (the enqueuer's own output shape), never removed.
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
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});

import { DATA_DRIVEN_CODES, isDataDrivenCode } from "@/lib/spine/data-skips";
import { openBreakers } from "@/lib/spine/jobs";
import { MAX_ATTEMPTS } from "@/lib/spine/retry";
import { POST as claimPost } from "@/app/api/spine/claim/route";
import { POST as reportPost } from "@/app/api/spine/report/route";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-brk");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");
const d = HAVE_DOCKER ? describe : describe.skip;

describe("REQUIRED PROOF — spine-brk runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-brk.test.ts needs Docker for postgres:16. Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe("the data-driven allowlist (pure)", () => {
  it("is exactly the data codes; engine and contention codes tick; unknown ticks", () => {
    for (const c of ["skip_no_session", "skip_no_tape_unexplained", "skip_no_tape_unexplained_recorder_on_", "skip_device_missing", "skip_power", "skip_recut_coverage_lower", "silent_audio", "blind_room_day"]) expect(isDataDrivenCode(c), c).toBe(true);
    for (const c of ["rc_1", "killed", "no_summary", "cut_error", "artefact_missing", "timeout", "spawn_failed", "usage", "lock_busy", "gpu_busy", "not_selected", "skip_unknown", "skip_something_new", "bad_consult_uid", "", null, undefined]) expect(isDataDrivenCode(c as string), String(c)).toBe(false);
  });
  it("pins every skip reason the cutter can emit (run.py skip_reason=, state.py no_tape_reason); a new one fails here until listed or consciously excluded", () => {
    const CONSCIOUSLY_EXCLUDED: string[] = [];   // none: every cutter skip reason is a fact about the data
    const run = readFileSync("tools/eta-consult-cutter/cutter/run.py", "utf8");
    const state = readFileSync("tools/eta-consult-cutter/cutter/state.py", "utf8");
    const reasons = new Set<string>();
    for (const m of run.matchAll(/status="skipped", skip_reason="([a-z_]+)"/g)) reasons.add(m[1]);
    for (const m of run.matchAll(/status="skipped", skip_reason=f"([a-z_]+) /g)) reasons.add(m[1]);
    for (const m of state.matchAll(/return f?"([a-z_]+)(?:\(\{state\}\))?"/g)) reasons.add(m[1]);
    expect([...reasons].sort()).toEqual(["blind_room_day", "device_missing", "no_session", "no_tape_unexplained", "power", "recut_coverage_lower", "silent_audio"]);   // the scan itself found them all
    for (const r of reasons) {
      if (CONSCIOUSLY_EXCLUDED.includes(r)) continue;
      const code = r === "silent_audio" || r === "blind_room_day" ? r : `skip_${r}`;
      expect(DATA_DRIVEN_CODES, `cutter skip reason ${r} -> ${code}`).toContain(code);
    }
  });
  it("the runner classifier maps a cutter reason to the same code (executors.py)", () => {
    const ex = readFileSync("tools/eta-spine/executors.py", "utf8");
    expect(ex).toContain('if reason in ("silent_audio", "blind_room_day"):');
    expect(ex).toContain('return Result("transient", f"skip_{reason}")');
  });
});

const ENC = "enc_brkaaaaaaaaaaaaa";
const AUTH = { authorization: "Bearer tok_test", "content-type": "application/json" };
const q = async (text: string): Promise<Array<Record<string, unknown>>> => (await H.tag!(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const num = async (text: string) => Number(Object.values((await q(text))[0])[0]);
const setConfig = (key: string, json: string) => pg.exec(`INSERT INTO spine_config (key, value) VALUES ('${key}', '${json}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);

/** n recut jobs, oldest first (created_at ascending in the order given). */
function seed(n: number, from = 0) {
  for (let i = from; i < from + n; i++) {
    pg.exec(`INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status, created_at) VALUES ('${ENC}', 'recut', 'r${i}', 'k${i}', 'queued', now() - interval '1 day' + (${i} * interval '1 second'));`);
  }
}
async function claim(limit = 5): Promise<Array<{ job_id: number; cut_version: string }>> {
  const res = await claimPost(new Request("https://x.test/api/spine/claim", { method: "POST", headers: AUTH, body: JSON.stringify({ owner: "box_test", limit, live: true }) }) as never);
  return ((await res.json()) as { jobs: Array<{ job_id: number; cut_version: string }> }).jobs;
}
async function claimN(n: number) { const out: Array<{ job_id: number; cut_version: string }> = []; while (out.length < n) { const j = await claim(Math.min(5, n - out.length)); if (j.length === 0) break; out.push(...j); } return out; }
async function report(job_id: number, outcome: string, error_code?: string) {
  const res = await reportPost(new Request("https://x.test/api/spine/report", { method: "POST", headers: AUTH, body: JSON.stringify({ job_id, owner: "box_test", outcome, ...(error_code ? { error_code } : {}) }) }) as never);
  expect(res.status).toBe(200);
}
const open = async () => (await openBreakers(["recut"], new Date())).includes("recut");
const ticks = () => num("SELECT count(*) FROM spine_tick WHERE kind = 'attempt:recut'");

d("spine-brk on postgres:16: real claim and report routes", () => {
  beforeAll(() => {
    process.env.SPINE_BEARER_TOKEN = "tok_test";
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); delete process.env.SPINE_BEARER_TOKEN; });
  beforeEach(() => {
    pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;");
    setConfig("jobs", '"live"'); setConfig("mode.recut", '"live"');
    pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version, flags) VALUES ('${ENC}', '2026-10-18', 'room_abcd2345', '2026-10-18T04:00:00Z', '2026-10-18T04:20:00Z', 'confirmed', 0, 'v_test', '{}');`);
  });

  it("10 skip_no_session reports leave the breaker closed, record no tick, and the next claim is a FRESH job", async () => {
    seed(12);
    const got = await claimN(10);
    expect(got.length).toBe(10);
    for (const j of got) await report(j.job_id, "transient", "skip_no_session");
    expect(await ticks()).toBe(0);
    expect(await open()).toBe(false);
    const next = await claim(1);
    expect(next.map((j) => j.cut_version)).toEqual(["r10"]);   // the 10 backed-off jobs are not due; the oldest fresh job is
  });

  it("10 rc_1 reports open it, as before (and a claim then returns nothing)", async () => {
    seed(12);
    const got = await claimN(10);
    for (const j of got) await report(j.job_id, "transient", "rc_1");
    expect(await ticks()).toBe(10);
    expect(await open()).toBe(true);
    expect(await claim(1)).toEqual([]);
  });

  it("mixed 5 rc_1 + 10 skip + 12 done: the ratio is over the 17 recorded ticks only (5/17 < 0.3: closed); counting the skips it would be 15/27 and open", async () => {
    seed(30);
    const got = await claimN(27);
    expect(got.length).toBe(27);
    for (const j of got.slice(0, 12)) await report(j.job_id, "done");
    for (const j of got.slice(12, 22)) await report(j.job_id, "transient", "skip_no_tape_unexplained");
    for (const j of got.slice(22)) await report(j.job_id, "transient", "rc_1");
    expect(await ticks()).toBe(17);
    expect(await open()).toBe(false);
  });

  it("mixed 5 rc_1 + 10 skip + 5 done: 5/10 recorded failed -> open", async () => {
    seed(20);
    const got = await claimN(20);
    for (const j of got.slice(0, 5)) await report(j.job_id, "done");
    for (const j of got.slice(5, 15)) await report(j.job_id, "transient", "skip_device_missing");
    for (const j of got.slice(15)) await report(j.job_id, "transient", "rc_1");
    expect(await ticks()).toBe(10);
    expect(await open()).toBe(true);
  });

  it("permanent silent_audio / blind_room_day: no tick, job failed permanent; an unknown code still ticks", async () => {
    seed(3);
    const [a, b, c] = await claimN(3);
    await report(a.job_id, "permanent", "silent_audio");
    await report(b.job_id, "permanent", "blind_room_day");
    expect(await ticks()).toBe(0);
    expect((await q("SELECT status, last_error_class, last_error_code FROM spine_job WHERE job_id IN (" + a.job_id + "," + b.job_id + ") ORDER BY job_id")).map((r) => [r.status, r.last_error_class, r.last_error_code])).toEqual([["failed", "permanent", "silent_audio"], ["failed", "permanent", "blind_room_day"]]);
    await report(c.job_id, "transient", "skip_never_seen_before");
    expect(await ticks()).toBe(1);
  });

  it("attempts and backoff are unchanged for skip codes: same status / attempts / backoff bounds as rc_1, and the job dies at MAX_ATTEMPTS", async () => {
    seed(2);
    const [a, b] = await claimN(2);
    await report(a.job_id, "transient", "skip_no_session");
    const first = async () => (await q(`SELECT status, attempts, last_error_class, last_error_code, extract(epoch FROM next_attempt_at - now()) AS wait FROM spine_job WHERE job_id = ${a.job_id}`))[0];
    const f = await first();
    expect([f.status, Number(f.attempts), f.last_error_class, f.last_error_code]).toEqual(["queued", 1, "transient", "skip_no_session"]);
    expect(Number(f.wait)).toBeGreaterThan(0); expect(Number(f.wait)).toBeLessThanOrEqual(7200);   // first backoff: the 2 min base, jittered
    // the backoff elapses (time, not a deletion), then the same job is claimed and skipped until the attempts run out
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      pg.exec(`UPDATE spine_job SET next_attempt_at = now() - interval '1 second' WHERE job_id = ${a.job_id};`);
      const j = (await claimN(20)).find((x) => x.job_id === a.job_id);
      expect(j, `attempt ${i + 1}`).toBeTruthy();
      await report(a.job_id, "transient", "skip_no_session");
    }
    const end = (await q(`SELECT status, attempts, last_error_code FROM spine_job WHERE job_id = ${a.job_id}`))[0];
    expect([end.status, Number(end.attempts), end.last_error_code]).toEqual(["dead", MAX_ATTEMPTS, "skip_no_session"]);
    expect(await ticks()).toBe(0);
    // the same first attempt reported rc_1 has the same status / attempts / class / backoff bounds (it differs only by its tick)
    await report(b.job_id, "transient", "rc_1");
    const g = (await q(`SELECT status, attempts, last_error_class, extract(epoch FROM next_attempt_at - now()) AS wait FROM spine_job WHERE job_id = ${b.job_id}`))[0];
    expect([g.status, Number(g.attempts), g.last_error_class]).toEqual(["queued", 1, "transient"]);
    expect(Number(g.wait)).toBeGreaterThan(0); expect(Number(g.wait)).toBeLessThanOrEqual(7200);
    expect(await ticks()).toBe(1);
  });
});
