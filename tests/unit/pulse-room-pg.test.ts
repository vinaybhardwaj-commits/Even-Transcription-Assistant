/**
 * pulse-room-pg.test.ts — the 'pulse_room' centroid set on the nemotron_identity job, against real Postgres 16 (0141, 0142, 0145).
 *
 * Proves: the loader offers only ACTIVE rows of the exact ECAPA model, keyed by Pulse uid; a speaker matches at
 * 0.651 / margin 0.051 and abstains at 0.649 and at margin 0.049, recording both cosines; the voice_print path is
 * unchanged; and the pass is SUGGEST-ONLY (clinician_id stays NULL, room_turn_speaker is untouched). The Mini and R2
 * are fakes. Every vector is typed by hand and every id is fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  bytes: null as Uint8Array | null,
  embed: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => H.bytes }));
vi.mock("@/lib/diarize-embed", async (orig) => ({ ...(await orig<typeof import("@/lib/diarize-embed")>()), embedSpeakers: H.embed }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-pulse-room-0145");
const MODEL = "speechbrain/spkrec-ecapa-voxceleb";

const FIXTURE_DDL = `
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  state text NOT NULL, grid_aligned boolean NOT NULL DEFAULT false, clip_r2_key text, source_mic text);
CREATE TABLE clinician (id text PRIMARY KEY, full_name text, status text NOT NULL, deleted_at timestamptz);
CREATE TABLE voice_print (doctor_id text PRIMARY KEY, centroid bytea);
CREATE TABLE scribe_job (id text PRIMARY KEY, kind text NOT NULL, args jsonb NOT NULL, status text NOT NULL);
CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz);
CREATE TABLE bench_chunk (session_id text NOT NULL, ended_at timestamptz);
CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text);
CREATE TABLE room_turn_speaker (window_id text, room_day_id text, clinician_id text, consulting_doctor_uid text);
CREATE TABLE jev_window_text (window_id text, room_day_id text);
CREATE TABLE room_span_emotion (window_id text, room_day_id text);
`;

const f32 = (...xs: number[]) => { const b = Buffer.alloc(xs.length * 4); xs.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
/** With centroids e1, e2, e3 the cosines of (a, b, sqrt(1-a²-b²)) with e1, e2 are exactly a and b. */
const vec = (a: number, b: number) => f32(a, b, Math.sqrt(1 - a * a - b * b)).toString("base64");
const UID1 = "pulseDoctorUid000001", UID2 = "pulseDoctorUid000002", UID_OLD = "pulseDoctorUid000003", UID_OTHER = "pulseDoctorUid000004";
const [FA] = [1].map((n) => makeFakeClinician(n));

type Kind = typeof import("@/lib/jobs/kinds/nemotron-identity");
let kind: Kind;

const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> => {
  const s = Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
  return (await H.sql!(s)) as T[];
};
const fails = (text: string) => { try { pg.exec(text); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };
const runJob = (row_id: number, centroid_set = "pulse_room") =>
  kind.nemotronIdentityKind.run({ job: {} as never, step: "embed", args: kind.nemotronIdentityKind.parseArgs({ row_id, centroid_set }), progress: {} });

let nextWin = 0;
async function nemoRow(): Promise<number> {
  const w = `bw_prfake${String(++nextWin).padStart(4, "0")}`;
  pg.exec(`INSERT INTO bench_session (id, room_id, started_at, ended_at) VALUES ('bs_${w}', 'room_fake1', '2026-10-01 10:00+05:30', '2026-10-01 11:00+05:30');
           INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, state, grid_aligned, clip_r2_key)
           VALUES ('${w}', 'bs_${w}', 'rd_1', 0, 900000, 'closed', true, 'clips/${w}.webm');`);
  // spk1 has the most speech (rank 0), spk0 the next (rank 1)
  const turns = JSON.stringify([[0, 10000, "spk0"], [10000, 15000, "spk1"], [20000, 50000, "spk0"], [50000, 120000, "spk1"]]);
  const rows = await q<{ id: string }>(`INSERT INTO diarize_nemotron_window (window_id, room_day_id, engine, model, model_rev, config, config_hash,
      worker_id, machine, audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status, error_code)
    VALUES ('${w}', 'rd_1', 'nemotron', 'm', 'r', '{}', 'h', 'wk', 'box', 900000, '${turns}', 2, 4, 115000, 0, 'p', 'ok', NULL) RETURNING id`);
  return Number(rows[0]!.id);
}
const speakers = (id: number) => q(`SELECT speaker_label, decision, pulse_doctor_uid, match_source, clinician_id, match_confidence, losing_clinician_id,
  round(best_cosine::numeric, 3)::float AS best, round(runner_up_cosine::numeric, 3)::float AS runner, attribution, centroids_offered
  FROM diarize_nemotron_speaker WHERE window_row_id = ${id} AND centroid_set = 'pulse_room' ORDER BY speaker_label`);
/** The Mini answers with the speaker at rank 0 (spk1) and rank 1 (spk0) embeddings given as [best, second] cosines. */
const answer = (rank0: [number, number], rank1: [number, number]) => ({ ok: true, latencyMs: 1, speakers: [
  { idx: 0, embedding_base64: vec(...rank0) }, { idx: 1, embedding_base64: vec(...rank1) },
] });

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  pg.exec(FIXTURE_DDL);
  for (const m of ["0113_voice_centroid", "0117_diarize_window_label", "0140_diarize_nemotron", "0141_diarize_nemotron_identity", "0142_pulse_doctor_voice", "0145_nemotron_identity_pulse_room"]) {
    pg.exec(readFileSync(`db/migrations/${m}.sql`, "utf8"));
  }
  pg.exec(`INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_1', 'room_fake1', '2026-10-01');
    INSERT INTO clinician (id, full_name, status, deleted_at) VALUES ('${FA.id}', '${FA.full_name}', 'active', NULL);
    INSERT INTO voice_print (doctor_id, centroid) VALUES ('${FA.id}', '\\x${f32(1, 0, 0).toString("hex")}');
    INSERT INTO room_turn_speaker (window_id, room_day_id, clinician_id, consulting_doctor_uid) VALUES ('bw_untouched', 'rd_1', NULL, NULL);`);
  const pdv = (id: string, uid: string, gen: number, emb: string, model: string, retired: boolean) =>
    `INSERT INTO pulse_doctor_voice (id, pulse_doctor_uid, generation, embedding, embedding_model, embedding_dim, n_windows, n_days, windows_offered, support, retired_at, retired_by, retired_reason)
     VALUES ('${id}', '${uid}', ${gen}, '${emb}', '${model}', 3, 1, 1, 1, 1, ${retired ? "now()" : "NULL"}, ${retired ? "'t'" : "NULL"}, ${retired ? "'t'" : "NULL"});`;
  pg.exec([
    pdv("pdv_1", UID1, 1, "{1,0,0}", MODEL, false),
    pdv("pdv_2", UID2, 1, "{0,1,0}", MODEL, false),
    pdv("pdv_3", UID_OLD, 1, "{0,0,1}", MODEL, true),       // retired: never offered
    pdv("pdv_4", UID_OTHER, 1, "{0,0,1}", "other/model", false), // another model: never offered
  ].join("\n"));
  H.sql = pg.sql as never;
  kind = await import("@/lib/jobs/kinds/nemotron-identity");
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });
beforeEach(() => { H.bytes = new Uint8Array([1, 2, 3]); H.embed.mockReset(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/pulse-room-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("migration 0145", () => {
  it("applies a second time without error and registers once", async () => {
    pg.exec(readFileSync("db/migrations/0145_nemotron_identity_pulse_room.sql", "utf8"));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations WHERE version = 145"))[0]!.n).toBe(1);
  });
  it("adds no vector, bytea, array or name column", async () => {
    const cols = await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name IN ('diarize_nemotron_identity','diarize_nemotron_speaker')
        AND (data_type IN ('bytea','ARRAY') OR column_name ~ '(embedding|vector|centroid_base64|name)')`);
    expect(cols[0]!.n).toBe(0);
  });
  it("constraints: a pulse_room row never names a clinician; a match needs its uid and both cosines; other sets carry none of it", async () => {
    const id = await nemoRow();
    const ins = (set: string, cols: string, vals: string) => `INSERT INTO diarize_nemotron_speaker (window_row_id, centroid_set, speaker_label, speech_ms,
      centroids_offered, attribution, ${cols}) VALUES (${id}, '${set}', 'spk0', 1, 2, 'voiceprint', ${vals});`;
    const C = "decision, pulse_doctor_uid, match_source, best_cosine, runner_up_cosine";
    expect(fails(ins("pulse_room", C, `'match', '${UID1}', 'pulse_room', 0.7, 0.6`))).toBe("");
    pg.exec(`DELETE FROM diarize_nemotron_speaker WHERE window_row_id = ${id}`);
    expect(fails(ins("pulse_room", `${C}, clinician_id, match_confidence`, `'match', '${UID1}', 'pulse_room', 0.7, 0.6, '${FA.id}', 0.7`))).toMatch(/pulse_chk/);
    expect(fails(ins("pulse_room", C, `'match', NULL, 'pulse_room', 0.7, 0.6`))).toMatch(/pulse_chk/);
    expect(fails(ins("pulse_room", C, `'abstain', '${UID1}', 'pulse_room', 0.7, 0.69`))).toMatch(/pulse_chk/);
    expect(fails(ins("pulse_room", C, `'match', '${UID1}', 'pulse_room', 0.7, NULL`))).toMatch(/pulse_chk/);
    expect(fails(ins("pulse_room", C, `'match', '${UID1}', 'voice_print', 0.7, 0.6`))).toMatch(/pulse_chk/);
    expect(fails(ins("pulse_room", C, `'guess', NULL, 'pulse_room', 0.7, 0.6`))).toMatch(/pulse_chk/);
    expect(fails(ins("voice_print", C, `'abstain', NULL, 'pulse_room', 0.7, 0.6`))).toMatch(/pulse_chk/);
    expect(fails(ins("voice_print", "pulse_doctor_uid", `'${UID1}'`))).toMatch(/pulse_chk/);
  });
});

describe.runIf(HAVE)("pulse_room through the job", () => {
  it("offers only ACTIVE rows of the exact model, keyed by uid", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValueOnce(answer([0.651, 0.6], [0.649, 0.1]));
    await runJob(id);
    const centroids = H.embed.mock.calls[0]![2] as Array<{ clinician_id: string; centroid_base64: string }>;
    expect(centroids.map((c) => c.clinician_id)).toEqual([UID1, UID2]);
    expect(centroids[0]!.centroid_base64).toBe(f32(1, 0, 0).toString("base64"));
  });

  it("matches at 0.651 / margin 0.051 and abstains at 0.649, recording both cosines; clinician_id stays NULL", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValueOnce(answer([0.651, 0.6], [0.649, 0.1]));
    const out = await runJob(id);
    expect(out).toMatchObject({ kind: "done", result: { state: "ok", speakers: 2, embedded: 2, matched: 1 } });
    expect(await speakers(id)).toEqual([
      { speaker_label: "spk0", decision: "abstain", pulse_doctor_uid: null, match_source: "pulse_room", clinician_id: null, match_confidence: null,
        losing_clinician_id: null, best: 0.649, runner: 0.1, attribution: "voiceprint", centroids_offered: 2 },
      { speaker_label: "spk1", decision: "match", pulse_doctor_uid: UID1, match_source: "pulse_room", clinician_id: null, match_confidence: null,
        losing_clinician_id: null, best: 0.651, runner: 0.6, attribution: "voiceprint", centroids_offered: 2 },
    ]);
    expect(await q(`SELECT state, centroids_offered, speakers_embedded, shadow_trusted FROM diarize_nemotron_identity WHERE window_row_id = ${id} AND centroid_set = 'pulse_room'`))
      .toEqual([{ state: "ok", centroids_offered: 2, speakers_embedded: 2, shadow_trusted: null }]);
  });

  it("MARGIN: abstains at margin 0.049 though the best clears the floor; matches at 0.051", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValueOnce(answer([0.7, 0.651], [0.7, 0.649]));
    await runJob(id);
    expect(await speakers(id)).toMatchObject([
      { speaker_label: "spk0", decision: "match", pulse_doctor_uid: UID1, best: 0.7, runner: 0.649 },
      { speaker_label: "spk1", decision: "abstain", pulse_doctor_uid: null, best: 0.7, runner: 0.651 },
    ]);
  });

  it("an unembeddable speaker is recorded not_compared with no cosine", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValueOnce({ ok: true, latencyMs: 1, speakers: [{ idx: 0, embedding_base64: vec(0.9, 0.1) }, { idx: 1, embedding_base64: null }] });
    await runJob(id);
    expect(await speakers(id)).toMatchObject([
      { speaker_label: "spk0", decision: "not_compared", attribution: "none", best: null, runner: null, pulse_doctor_uid: null },
      { speaker_label: "spk1", decision: "match", pulse_doctor_uid: UID1 },
    ]);
  });

  it("a second job for the same key writes nothing", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValue(answer([0.9, 0.1], [0.1, 0.9]));
    await runJob(id);
    expect(await runJob(id)).toMatchObject({ result: { state: "already_ok" } });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_speaker WHERE window_row_id = ${id}`))[0]!.n).toBe(2);
  });

  it("SUGGEST-ONLY: no clinician_id anywhere, room_turn_speaker untouched", async () => {
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_speaker WHERE centroid_set = 'pulse_room' AND clinician_id IS NOT NULL`))[0]!.n).toBe(0);
    expect(await q(`SELECT window_id, clinician_id, consulting_doctor_uid FROM room_turn_speaker`)).toEqual([{ window_id: "bw_untouched", clinician_id: null, consulting_doctor_uid: null }]);
  });

  it("with no active pulse_doctor_voice row the pass is recorded, every speaker not_compared, centroids_offered 0", async () => {
    pg.exec(`UPDATE pulse_doctor_voice SET retired_at = now(), retired_by = 't', retired_reason = 't' WHERE retired_at IS NULL;`);
    try {
      const id = await nemoRow();
      H.embed.mockResolvedValueOnce(answer([0.9, 0.1], [0.9, 0.1]));
      await runJob(id);
      expect((await speakers(id)).map((s) => [s.decision, s.centroids_offered])).toEqual([["not_compared", 0], ["not_compared", 0]]);
    } finally {
      pg.exec(`UPDATE pulse_doctor_voice SET retired_at = NULL, retired_by = NULL, retired_reason = NULL WHERE id IN ('pdv_1','pdv_2','pdv_4');`);
    }
  });
});

describe.runIf(HAVE)("the voice_print path is unchanged", () => {
  it("writes the old row shape with NULL pulse columns and the clinician id", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValueOnce({ ok: true, latencyMs: 1, speakers: [
      { idx: 0, embedding_base64: f32(1, 0, 0).toString("base64"), clinician_id: FA.id, confidence: 1.0 },
      { idx: 1, embedding_base64: f32(0, 0.6, 0.8).toString("base64") },
    ] });
    expect(await runJob(id, "voice_print")).toMatchObject({ result: { state: "ok", speakers: 2, matched: 1, shadow_trusted: true } });
    expect(await q(`SELECT speaker_label, clinician_id, decision, pulse_doctor_uid, match_source, best_cosine, runner_up_cosine
                      FROM diarize_nemotron_speaker WHERE window_row_id = ${id} AND centroid_set = 'voice_print' ORDER BY speaker_label`)).toEqual([
      { speaker_label: "spk0", clinician_id: null, decision: null, pulse_doctor_uid: null, match_source: null, best_cosine: null, runner_up_cosine: null },
      { speaker_label: "spk1", clinician_id: FA.id, decision: null, pulse_doctor_uid: null, match_source: null, best_cosine: null, runner_up_cosine: null },
    ]);
    const centroids = H.embed.mock.calls[0]![2] as Array<{ clinician_id: string }>;
    expect(centroids.map((c) => c.clinician_id)).toEqual([FA.id]);
  });
});
