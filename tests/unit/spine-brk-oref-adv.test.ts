/** spine-brk Opus refute adversarial suite (throwaway, not for commit). Real claim + report routes on postgres:16. Synthetic ids only. */
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

import { isDataDrivenCode } from "@/lib/spine/data-skips";
import { openBreakers } from "@/lib/spine/jobs";
import { MAX_ATTEMPTS } from "@/lib/spine/retry";
import { POST as claimPost } from "@/app/api/spine/claim/route";
import { POST as reportPost } from "@/app/api/spine/report/route";

const pg = pgContainer("eta-spine-brk-oadv");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");
const d = dockerAvailable() ? describe : describe.skip;
const ENC = "enc_oadvaaaaaaaaaaaa";
const AUTH = { authorization: "Bearer tok_test", "content-type": "application/json" };
const q = async (text: string): Promise<Array<Record<string, unknown>>> => (await H.tag!(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const num = async (text: string) => Number(Object.values((await q(text))[0])[0]);

function seed(n: number, from = 0) {
  for (let i = from; i < from + n; i++) pg.exec(`INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status, created_at) VALUES ('${ENC}', 'recut', 'r${i}', 'k${i}', 'queued', now() - interval '1 day' + (${i} * interval '1 second'));`);
}
async function claim(limit = 5): Promise<Array<{ job_id: number; cut_version: string }>> {
  const res = await claimPost(new Request("https://x.test/api/spine/claim", { method: "POST", headers: AUTH, body: JSON.stringify({ owner: "box_test", limit, live: true }) }) as never);
  return ((await res.json()) as { jobs: Array<{ job_id: number; cut_version: string }> }).jobs;
}
async function reportRaw(body: Record<string, unknown>) {
  return reportPost(new Request("https://x.test/api/spine/report", { method: "POST", headers: AUTH, body: JSON.stringify({ owner: "box_test", ...body }) }) as never);
}
async function report(job_id: number, outcome: string, error_code?: unknown) {
  const res = await reportRaw({ job_id, outcome, ...(error_code !== undefined ? { error_code } : {}) });
  expect(res.status).toBe(200);
}
const open = async () => (await openBreakers(["recut"], new Date())).includes("recut");
const ticks = () => num("SELECT count(*) FROM spine_tick WHERE kind = 'attempt:recut'");

describe("oref pure: fail-safe and prefix abuse", () => {
  it("near-misses, case, whitespace, broader prefixes and non-strings all tick", () => {
    for (const c of ["SKIP_NO_SESSION", " skip_no_session", "skip_no_session ", "skip_no_session_x", "skip_no_sessio", "skip_no_tape", "skip_no_tape_foo", "skip_no_tape_unexplainedx", "skip_", "skip_power_rc_1", "silent_audio_x", "xskip_no_session", "blind_refused", "stopped_x", "lock_unavailable", "recut_pending", "no_clip"])
      expect(isDataDrivenCode(c), c).toBe(false);
    for (const c of [123, {}, ["skip_no_session"], true]) expect(isDataDrivenCode(c as never), JSON.stringify(c)).toBe(false);
    // every real runner form after _token (python trace): the state suffix is truncated at 40 chars
    for (const c of ["skip_no_tape_unexplained_recording_", "skip_no_tape_unexplained_none_", "skip_no_tape_unexplained_a_very_long", "skip_no_tape_unexplained_ssssssssssssssssssss"]) expect(isDataDrivenCode(c), c).toBe(true);
  });
});

d("oref on postgres:16", () => {
  beforeAll(() => { process.env.SPINE_BEARER_TOKEN = "tok_test"; pg.start(); H.tag = pg.sql; pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);"); pg.exec(UP); });
  afterAll(() => { pg.stop(); delete process.env.SPINE_BEARER_TOKEN; });
  beforeEach(() => {
    pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;");
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('jobs', '"live"'), ('mode.recut', '"live"');`);
    pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version, flags) VALUES ('${ENC}', '2026-10-18', 'room_abcd2345', '2026-10-18T04:00:00Z', '2026-10-18T04:20:00Z', 'confirmed', 0, 'v_test', '{}');`);
  });

  it("LIVE LOOP replay: 7 done, then the 3 oldest retries skip_no_session round after round; the breaker stays shut and fresh jobs keep being claimed", async () => {
    seed(40);
    const first = await claim(5); first.push(...await claim(5)); first.sort((x, y) => x.job_id - y.job_id);
    expect(first.map((j) => j.cut_version)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
    for (const j of first.slice(0, 3)) await report(j.job_id, "transient", "skip_no_session");
    for (const j of first.slice(3)) await report(j.job_id, "done");
    const oldest = first.slice(0, 3).map((j) => j.job_id);
    const fresh: string[] = [];
    for (let round = 0; round < MAX_ATTEMPTS - 1; round++) {
      pg.exec(`UPDATE spine_job SET next_attempt_at = now() - interval '1 second' WHERE job_id IN (${oldest.join(",")}) AND status = 'queued';`);   // their backoff elapses
      const got = await claim(5);
      const retried = got.filter((j) => oldest.includes(j.job_id));
      expect(retried.length, `round ${round}`).toBe(3);   // claim order unchanged: the due retries still come first
      for (const j of retried) await report(j.job_id, "transient", "skip_no_session");
      for (const j of got.filter((j) => !oldest.includes(j.job_id))) { fresh.push(j.cut_version); await report(j.job_id, "done"); }
      expect(await open(), `round ${round}`).toBe(false);
    }
    expect(fresh.length).toBe(2 * (MAX_ATTEMPTS - 1));   // 2 fresh per round alongside the 3 retries
    expect(await ticks()).toBe(7 + fresh.length);         // only the done reports ticked
    expect((await q(`SELECT DISTINCT status FROM spine_job WHERE job_id IN (${oldest.join(",")})`)).map((r) => r.status)).toEqual(["dead"]);
    expect((await claim(5)).length).toBe(5);              // still claiming fresh work
  });

  it("an already-open breaker (legacy failed ticks) is NOT closed by skip reports; it opens/closes only on recorded ticks", async () => {
    seed(20);
    const got = [...await claim(5), ...await claim(5)];
    for (const j of got.slice(0, 3)) await report(j.job_id, "transient", "rc_1");
    for (const j of got.slice(3, 10)) await report(j.job_id, "done");   // 3/10 = 0.3 -> open
    expect(await open()).toBe(true);
    expect(await claim(1)).toEqual([]);
  });

  it("engine codes still tick and open: killed, no_summary, cut_error, artefact_missing, timeout, spawn_failed (transient) and usage (permanent)", async () => {
    seed(7);
    const got = [...await claim(5), ...await claim(5)];
    const codes = ["killed", "no_summary", "cut_error", "artefact_missing", "timeout", "spawn_failed"];
    for (let i = 0; i < 6; i++) await report(got[i].job_id, "transient", codes[i]);
    await report(got[6].job_id, "permanent", "usage");
    expect(await ticks()).toBe(7);
    expect(await open()).toBe(true);
  });

  it("route fail-safe: empty / null / absent / non-string / uppercase / lock_busy / gpu_busy codes tick", async () => {
    seed(9);
    const got = [...await claim(5), ...await claim(5)];
    const codes: unknown[] = [null, undefined, "SKIP_NO_SESSION", "lock_busy", "gpu_busy", "skip_no_tape_x", "not_selected", "skip_no_tape_unexplainedx"];
    for (let i = 0; i < codes.length; i++) await report(got[i].job_id, "transient", codes[i]);
    expect(await ticks()).toBe(codes.length);
    for (const bad of ["", 42, " skip_no_session", ["skip_no_session"]]) expect((await reportRaw({ job_id: got[8].job_id, outcome: "transient", error_code: bad })).status, JSON.stringify(bad)).toBe(400);   // rejected outright, job untouched
    expect((await q(`SELECT status FROM spine_job WHERE job_id = ${got[8].job_id}`))[0].status).toBe("leased");
  });

  it("outcome matters: done with a skip code ticks done; budget/release with a skip code tick nothing and give the attempt back", async () => {
    seed(3);
    const [a, b, c] = await claim(3);
    await report(a.job_id, "done", "skip_no_session");
    expect(await num("SELECT count(*) FROM spine_tick WHERE kind='attempt:recut' AND counts->>'failed'='0'")).toBe(1);
    await report(b.job_id, "budget", "skip_no_session");
    await report(c.job_id, "release", "skip_no_session");
    expect(await ticks()).toBe(1);
    expect((await q(`SELECT attempts FROM spine_job WHERE job_id IN (${b.job_id},${c.job_id}) ORDER BY job_id`)).map((r) => Number(r.attempts))).toEqual([0, 0]);
  });

  it("a skip report on a lost lease (wrong owner) changes nothing and ticks nothing", async () => {
    seed(1);
    const [a] = await claim(1);
    const res = await reportPost(new Request("https://x.test/api/spine/report", { method: "POST", headers: AUTH, body: JSON.stringify({ job_id: a.job_id, owner: "box_other", outcome: "transient", error_code: "skip_no_session" }) }) as never);
    expect(res.status).toBe(409);
    expect((await q(`SELECT status, attempts FROM spine_job WHERE job_id = ${a.job_id}`)).map((r) => [r.status, Number(r.attempts)])).toEqual([["leased", 1]]);   // the claim burnt it; the 409 changed nothing
    expect(await ticks()).toBe(0);
  });

  it("skip vs rc_1 at every attempt: identical status / attempts / class / backoff (Math.random pinned); done traffic keeps the rc_1 breaker shut", async () => {
    seed(2); seed(40, 2);
    const a = 1, b = 2;
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        pg.exec(`UPDATE spine_job SET next_attempt_at = now() - interval '1 hour' WHERE job_id IN (${a},${b}) AND status='queued';`);
        const g = await claim(6);
        expect(g.map((j) => j.job_id).filter((id) => id === a || id === b).sort(), `attempt ${i + 1}`).toEqual([a, b]);   // RETURNING order is not the claim order
        await report(a, "transient", "skip_no_session");
        await report(b, "transient", "rc_1");
        for (const j of g.filter((j) => j.job_id !== a && j.job_id !== b)) await report(j.job_id, "done");
        const rows = await q(`SELECT status, attempts, last_error_class, round(extract(epoch FROM next_attempt_at - now())/60) AS wmin FROM spine_job WHERE job_id IN (${a},${b}) ORDER BY job_id`);
        const [x, y] = rows.map((r) => [r.status, Number(r.attempts), r.last_error_class, r.wmin === null ? null : Number(r.wmin)]);
        expect(x, `attempt ${i + 1}`).toEqual(y);
        expect(await open()).toBe(false);
      }
    } finally { rnd.mockRestore(); }
    expect((await q(`SELECT status FROM spine_job WHERE job_id IN (${a},${b}) ORDER BY job_id`)).map((r) => r.status)).toEqual(["dead", "dead"]);
    expect(await num("SELECT count(*) FROM spine_tick WHERE kind='attempt:recut' AND counts->>'failed'='1'")).toBe(MAX_ATTEMPTS);   // only the rc_1 job ticked failed
  });
});
