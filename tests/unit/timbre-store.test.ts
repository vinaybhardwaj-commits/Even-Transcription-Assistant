/**
 * timbre-store.test.ts — Timbre T-9 (Architecture #78): migration 0155 file rules, the ingest payload validator and the
 * HMAC check for POST /api/timbre/ingest. The Postgres CHECK proofs (scorable without A/V, unscorable without reason or with
 * a score, reason sums, unknown reason, calibration payload/r2_key) and the idempotent load run in
 * tools/timbre/tests/test_store.py against a real Postgres. All ids are fake.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no db in unit tests"); } }));

import { validatePayload, PAYLOAD_VERSION } from "@/lib/timbre/store";
import { checkTimbreHmac, signTimbre } from "@/lib/timbre/auth";
import { INGEST_SQL, RESOLVE_SQL } from "@/lib/room-access/timbre-ingest-sql";

const MIG = "db/migrations/0155_timbre_affect.sql";
const DOWN = "db/rollbacks/0155_timbre_affect.down.sql";
const H40 = "a".repeat(40);
const H64 = "b".repeat(64);

const cal = (target: string, sha: string) => ({ target, sha256: sha, git_sha: H40, payload: { version: "timbre-calib-v1", global: { median: 0.4 } } });
const win = (over: Record<string, unknown> = {}) => ({
  consult_uid: "uid_1", cut_version: "sig:x", window_key: "uid_1_p0001000", start_ms: 1000, end_ms: 6000, diarize_engine: "segments",
  scorable: true, unscorable_reason: null, arousal_raw: 0.4, arousal_calibrated: 3, valence_raw: 2.8, valence_calibrated: 3.1,
  text_valence: null, text_arousal: null, text_status: null, text_language: null, ...over,
});
const payload = (over: Record<string, unknown> = {}, w: Record<string, unknown>[] = [win()]) => ({
  version: PAYLOAD_VERSION,
  calibration_arousal: cal("arousal", "1".repeat(64)),
  calibration_valence: cal("valence", "2".repeat(64)),
  run: { git_sha: H40, input_manifest_sha256: H64, compute: "lab_gpu", state: "ok", text_lane_on: false, n_windows: w.length, n_consults: 1 },
  windows: w,
  consults: [{ consult_uid: "uid_1", cut_version: "sig:x", n_windows: w.length }],
  ...over,
});

describe("migration 0155 files", () => {
  const up = readFileSync(MIG, "utf8");
  it("is the next number after 0154 and 0152 stays absent", () => {
    const files = readdirSync("db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(files.some((f) => f.startsWith("0152_"))).toBe(false);
    expect(files.filter((f) => f.startsWith("0155_"))).toEqual(["0155_timbre_affect.sql"]);
  });
  it("the down-migration lives in db/rollbacks, never in db/migrations", () => {
    expect(existsSync(DOWN)).toBe(true);
    expect(readdirSync("db/migrations").some((f) => /down/i.test(f) && f.startsWith("0155"))).toBe(false);
    const down = readFileSync(DOWN, "utf8");
    expect(down).toMatch(/DELETE FROM schema_migrations WHERE version = 155/);
    expect(down).not.toMatch(/room_emotion_window|room_span_emotion|consult_index/);
  });
  it("is additive, idempotent and self-records", () => {
    const ddl = up.replace(/--.*$/gm, "").replace(/ON DELETE CASCADE/g, "");
    expect(ddl).not.toMatch(/\bALTER TABLE\b|\bDROP\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b/i);
    for (const t of ["affect_calibration_map", "affect_run", "affect_window", "affect_consult"]) expect(up).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    expect(up).toContain("CREATE OR REPLACE VIEW affect_consult_latest");
    expect(up).toMatch(/VALUES \(155, '0155_timbre_affect'\)\s*ON CONFLICT DO NOTHING/);
    expect(up).not.toMatch(/\bGRANT\b|brain_svc TO|TO brain_svc/i);
  });
  it("affect_window has no identity, role or text column; raw AND calibrated are both stored", () => {
    const body = up.slice(up.indexOf("CREATE TABLE IF NOT EXISTS affect_window"), up.indexOf("CREATE TABLE IF NOT EXISTS affect_consult"));
    const cols = [...body.matchAll(/^\s{2}([a-z_]+)\s+(text|integer|bigint|double|boolean|timestamptz)/gm)].map((m) => m[1]!);
    for (const bad of ["role", "clinician_id", "doctor_uid", "patient", "name", "transcript", "text"]) expect(cols).not.toContain(bad);
    for (const need of ["arousal_raw", "arousal_calibrated", "valence_raw", "valence_calibrated"]) expect(cols).toContain(need);
    const consult = up.slice(up.indexOf("CREATE TABLE IF NOT EXISTS affect_consult"));
    for (const need of ["arousal_raw_median", "valence_raw_median", "valence_raw_open"]) expect(consult).toContain(need);
  });
  it("names model_error among the reasons", () => expect(up).toContain("'model_error'"));
});

describe("validatePayload", () => {
  it("accepts a well-formed payload", () => expect(validatePayload(payload())).toMatchObject({ ok: true }));
  it("refuses a scorable window without scores", () =>
    expect(validatePayload(payload({}, [win({ valence_raw: null })]))).toEqual({ ok: false, error: "scorable_without_scores" }));
  it("refuses an unscorable window with a score, and an unknown reason", () => {
    expect(validatePayload(payload({}, [win({ scorable: false, unscorable_reason: "low_purity" })]))).toEqual({ ok: false, error: "unscorable_with_scores" });
    expect(validatePayload(payload({}, [win({ scorable: false, unscorable_reason: "neutral", arousal_raw: null, arousal_calibrated: null, valence_raw: null, valence_calibrated: null })]))).toEqual({ ok: false, error: "bad_reason" });
  });
  it("refuses text-lane values when the run had it off", () =>
    expect(validatePayload(payload({}, [win({ text_valence: 4 })]))).toEqual({ ok: false, error: "text_lane_off" }));
  it("refuses forbidden fields (names, urls, transcripts, audio keys)", () => {
    for (const k of ["doctor_name", "transcript", "clip_url", "r2_key", "audio_path"])
      expect(validatePayload(payload({}, [win({ [k]: "x" })]))).toEqual({ ok: false, error: "forbidden_field" });
  });
  it("refuses a calibration map that carries rows", () => {
    const bad = { ...cal("arousal", "1".repeat(64)), payload: { window_ids: ["w"] } };
    expect(validatePayload(payload({ calibration_arousal: bad }))).toEqual({ ok: false, error: "calibration_arousal_not_aggregate" });
  });
  it("refuses bad shas, compute and counts", () => {
    expect(validatePayload(payload({ run: { ...payload().run, git_sha: "abc" } }))).toEqual({ ok: false, error: "bad_git_sha" });
    expect(validatePayload(payload({ run: { ...payload().run, compute: "laptop" } }))).toEqual({ ok: false, error: "bad_compute" });
    expect(validatePayload(payload({ run: { ...payload().run, n_windows: 9 } }))).toEqual({ ok: false, error: "count_mismatch" });
  });
});

describe("checkTimbreHmac", () => {
  const env = { TIMBRE_INGEST_SECRET: "s3cret\n" };
  const h = (ts: number, sig: string) => new Headers({ "x-timbre-ts": String(ts), "x-timbre-signature": sig });
  it("fails closed when unconfigured", () => expect(checkTimbreHmac(h(1, "x"), "{}", {})).toEqual({ status: 503, error: "not_configured" }));
  it("accepts the store.py signature and refuses a wrong or stale one", () => {
    const now = 1_790_000_000;
    expect(checkTimbreHmac(h(now, signTimbre("{}", "s3cret", now)), "{}", env, now)).toBeNull();
    expect(checkTimbreHmac(h(now, signTimbre("{x}", "s3cret", now)), "{}", env, now)).toEqual({ status: 401, error: "unauthorized" });
    expect(checkTimbreHmac(h(now - 3600, signTimbre("{}", "s3cret", now - 3600)), "{}", env, now)).toEqual({ status: 401, error: "stale" });
  });
});

describe("ingest SQL", () => {
  it("is one statement keyed on $1 and never touches brain_svc or the 0089/0097 tables", () => {
    expect(INGEST_SQL.startsWith("WITH p AS (SELECT $1::jsonb AS j)")).toBe(true);
    expect(INGEST_SQL).toContain("WHERE NOT EXISTS (SELECT 1 FROM prior)");
    for (const s of [INGEST_SQL, ...RESOLVE_SQL]) expect(s).not.toMatch(/brain_svc|room_emotion_window|room_span_emotion/);
  });
});
