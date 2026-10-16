/**
 * talk_time consult unit, G53 on the role-layer path (ported from the refuter's ttrole-rf tests, 16 Oct 2026): a failing DB or R2 read of the role/text track THROWS,
 * the job ends failed and no rubric_result row is stored (never an engine_error row). Real postgres:16 with reb_track_index rows and a fake R2 store.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({
  sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); }, { transaction: async (qs: Array<Promise<unknown>>) => Promise.all(qs) }),
}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-ttrole-g53");
const IST = (t: string) => `2026-10-08T${t}+05:30`;
const W1 = Date.parse(IST("10:00:00"));
const OPEN = W1;
const UID = "TtConsultUidRole0001";
const UID2 = "TtConsultUidRole0002";
const LEAK = "TT_TEXT_SENTINEL_XYZ";

const DDL = `
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL, UNIQUE (room_id, ist_date));
CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL);
CREATE TABLE cue (id text PRIMARY KEY, room_day_id text NOT NULL, type text NOT NULL, source_ref text, payload jsonb, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE room_turn_speaker (window_id text NOT NULL, source_ref text NOT NULL, speaker_idx integer NOT NULL, overlap_ms integer NOT NULL DEFAULT 0, room_day_id text,
  clinician_id text, role text, match_confidence double precision, no_role_reason text, PRIMARY KEY (window_id, source_ref));
CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text, state text NOT NULL);
CREATE TABLE eta_encounter_windows (id serial PRIMARY KEY, consult_key text NOT NULL UNIQUE, room_id text, t_open timestamptz NOT NULL, t_close timestamptz, quality text NOT NULL DEFAULT 'clean', attribution text NOT NULL DEFAULT 'rows', consult_uid text, warehouse_prescription_uid text);
`;

const sha = (b: string) => createHash("sha256").update(b, "utf8").digest("hex");
const mem = new Map<string, string>();
const keyOf = (uid: string, file: string) => `reb/2026-10-08/r1/_consults/${uid}/tracks/${file}.json`;
// relative ms -> absolute track segment (sarvam numeric speaker labels)
const seg = (a: number, b: number, speaker: string, lang = "en-IN") => ({ t0_ms: OPEN + a, t1_ms: OPEN + b, speaker, lang, text: LEAK, extras: {} });
const SEGS = [
  seg(0, 4000, "0"), seg(4000, 9000, "1"), seg(10000, 16000, "0"), seg(15000, 17000, "1"),
  seg(20000, 23000, "2"), seg(25000, 26000, "3"), seg(29000, 30500, "1") /* overruns close: clamped */, seg(31000, 32000, "1") /* outside: dropped */,
];
const ROLES = ["doctor", "patient", "doctor", "patient", "attender", "unknown", "patient", "patient"];
const sttDoc = (uid: string, segs = SEGS) => ({ config: {}, config_hash: "sttcfg_pg", engine: "sarvam-saaras-v3", extras: {}, layer: "stt", status: "ok", window_id: `consult-${uid}`, segments: segs });
const roleDoc = (uid: string, roles = ROLES, segs = SEGS) => ({ config: {}, config_hash: "rolecfg_pg", engine: "llm-roles", version: "v1", layer: "role", status: "ok", window_id: `consult-${uid}`, extras: { map: { "0": "doctor", "1": "patient" } },
  segments: segs.map((g, i) => ({ t0_ms: g.t0_ms, t1_ms: g.t1_ms, speaker: g.speaker, role: roles[i] })) });

let nextId = 0;
async function index(uid: string, layer: "stt" | "role", body: unknown, o: { badSha?: boolean; cfg?: string; finished?: string } = {}) {
  const text = JSON.stringify(body);
  const engine = layer === "role" ? "llm-roles" : "sarvam-saaras-v3";
  const cfg = o.cfg ?? (layer === "role" ? "rolecfg_pg" : "sttcfg_pg");
  const key = keyOf(uid, `${layer}.${engine}__v1__${cfg}`);
  mem.set(key, text);
  nextId += 1;
  await H.sql!`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256, finished_at)
    VALUES (${`consult-${uid}`}, '2026-10-08', 'r1', ${layer}, ${engine}, 'v1', ${cfg}, false, 'ok', ${key}, ${o.badSha ? "0".repeat(64) : sha(text)}, ${o.finished ?? IST("12:00:00")}::timestamptz)`;
}

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(DDL);
  pg.exec(readFileSync("db/migrations/0082_scribe_job.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0139_rubric_results.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0135_reb_track_index.sql", "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room_day VALUES ('rd1', 'r1', '2026-10-08');
    INSERT INTO bench_session VALUES ('bs1', 'r1', '${IST("08:00:00")}');
    INSERT INTO bench_window VALUES ('w1', 'bs1', 'rd1', ${W1}, ${W1 + 60000});
    INSERT INTO room_diarize_window VALUES ('w1', 'rd1', 'ok');
    INSERT INTO cue (id, room_day_id, type, source_ref, payload) VALUES
      ('c1','rd1','stt_turn','w1:t1','{"start_ms":${W1},"end_ms":${W1 + 15000},"text":"alpha","window":{"start_ms":${W1},"end_ms":${W1 + 60000}}}'),
      ('c2','rd1','stt_turn','w1:t2','{"start_ms":${W1 + 15000},"end_ms":${W1 + 27000},"text":"bravo","window":{"start_ms":${W1},"end_ms":${W1 + 60000}}}');
    INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, overlap_ms, room_day_id, clinician_id, role, match_confidence, no_role_reason) VALUES
      ('w1','w1:t1',0,15000,'rd1','clin_a','clinician',0.9,NULL), ('w1','w1:t2',1,12000,'rd1',NULL,NULL,NULL,'no_match');
    INSERT INTO eta_encounter_windows (consult_key, room_id, t_open, t_close, consult_uid) VALUES
      ('enc1@m1','r1','${IST("10:00:00")}','${IST("10:00:30")}','${UID}'),
      ('enc2@m1','r1','${IST("10:00:00")}','${IST("10:00:30")}','${UID2}');
  `);
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe.runIf(HAVE)("talk_time consult on PG: G53 on the role-layer path", () => {
  const saved = process.env.ETA_REB_ROLE_LLM;
  beforeAll(async () => {
    const L = await import("@/lib/sarvam-lab");
    L.setLabStoreForTests({ get: async (k) => (mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null), put: async (k, b) => { mem.set(k, b); return "ok"; }, list: async (p) => [...mem.keys()].filter((k) => k.startsWith(p)) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  beforeEach(() => { mem.clear(); H.statements.length = 0; pg.exec(`DELETE FROM reb_track_index; DELETE FROM scribe_job; DELETE FROM rubric_result; DELETE FROM rubric_run;`); delete process.env.ETA_REB_ROLE_LLM; });
  afterEach(() => { if (saved === undefined) delete process.env.ETA_REB_ROLE_LLM; else process.env.ETA_REB_ROLE_LLM = saved; });

  async function runRun(id: string) {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const { claimJobs } = await import("@/lib/jobs/store");
    const { runOneStep } = await import("@/lib/jobs/runner");
    const args = KIND_BY_NAME.get("rubric_run")!.parseArgs({ rubric_id: "talk_time", lab: true, unit: "consult", unit_keys: ["enc1@m1"] });
    await pg.sql`INSERT INTO scribe_job (id, kind, args, actor) VALUES (${id}, 'rubric_run', ${JSON.stringify(args)}::jsonb, 'mcp:tester')`;
    for (let i = 0; i < 20; i++) { const [job] = await claimJobs(1, 240_000, `r${i}`); if (!job) break; await runOneStep(job, `r${i}`); }
    return (await pg.sql`SELECT status, result, error FROM scribe_job WHERE id = ${id}`)[0] as Record<string, any>;
  }
  it("G53 on the new path: the role-track index query failing THROWS -> job failed, zero rubric_result rows", async () => {
    await index(UID, "stt", sttDoc(UID));
    await index(UID, "role", roleDoc(UID));
    const real = H.sql!;
    H.sql = (async (s: TemplateStringsArray, ...v: unknown[]) => { if (/layer = 'role' AND engine = 'llm-roles'/.test(s.join("?"))) throw new Error("db down"); return real(s, ...v); }) as never;
    const job = await runRun("job_tt_g53a");
    H.sql = real;
    expect(job.status).toBe("failed");
    expect(await pg.sql`SELECT 1 FROM rubric_result`).toEqual([]);
  });
  it("G53 on the new path: the text-track index query failing THROWS -> job failed, zero rows", async () => {
    await index(UID, "stt", sttDoc(UID));
    await index(UID, "role", roleDoc(UID));
    const real = H.sql!;
    H.sql = (async (s: TemplateStringsArray, ...v: unknown[]) => { if (/layer IN \('translate', 'stt'\)/.test(s.join("?"))) throw new Error("db down"); return real(s, ...v); }) as never;
    const job = await runRun("job_tt_g53b");
    H.sql = real;
    expect(job.status).toBe("failed");
    expect(await pg.sql`SELECT 1 FROM rubric_result`).toEqual([]);
  });
  it("G53 on the new path: R2 GET of the role track THROWS -> job failed, zero rows", async () => {
    await index(UID, "stt", sttDoc(UID));
    await index(UID, "role", roleDoc(UID));
    const L = await import("@/lib/sarvam-lab");
    L.setLabStoreForTests({ get: async (k) => { if (k.includes("role.llm-roles")) throw new Error("r2 down"); return mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null; }, put: async (k, b) => { mem.set(k, b); return "ok"; }, list: async () => [] });
    const job = await runRun("job_tt_g53c");
    L.setLabStoreForTests({ get: async (k) => (mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null), put: async (k, b) => { mem.set(k, b); return "ok"; }, list: async (p) => [...mem.keys()].filter((k) => k.startsWith(p)) });
    expect(job.status).toBe("failed");
    expect(await pg.sql`SELECT 1 FROM rubric_result`).toEqual([]);
  });
});
