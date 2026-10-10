/**
 * diarize-nemotron-identity-pg.test.ts — 0141 and the nemotron_identity job against real Postgres 16 (epic #23 c).
 *
 * Proves the SQL the job and the enqueue send: the one-statement ok write (pass + speakers, nothing on a second
 * run), the failed-pass attempt counting and the terminal bound, the constraints, the blind refusal, both
 * centroid loaders, and the enqueue's choice of rows. The Mini and R2 are fakes; every vector is typed by hand.
 * All ids are fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  bytes: null as Uint8Array | null,
  embed: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => H.bytes }));
vi.mock("@/lib/diarize-embed", async (orig) => ({ ...(await orig<typeof import("@/lib/diarize-embed")>()), embedSpeakers: H.embed }));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: H.submit }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-nemotron-0141");

const FIXTURE_DDL = `
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  state text NOT NULL, grid_aligned boolean NOT NULL DEFAULT false, clip_r2_key text, source_mic text);
CREATE TABLE clinician (id text PRIMARY KEY, full_name text, status text NOT NULL, deleted_at timestamptz);
CREATE TABLE voice_print (doctor_id text PRIMARY KEY, centroid bytea);
CREATE TABLE scribe_job (id text PRIMARY KEY, kind text NOT NULL, args jsonb NOT NULL, status text NOT NULL);
-- what lib/room-access/check.ts reads to place a window (the held-out guard and the chooser's blindWindowIds)
CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz);
CREATE TABLE bench_chunk (session_id text NOT NULL, ended_at timestamptz);
CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text);
CREATE TABLE room_turn_speaker (window_id text, room_day_id text);
CREATE TABLE jev_window_text (window_id text, room_day_id text);
CREATE TABLE room_span_emotion (window_id text, room_day_id text);
`;
/** One (IST date, room) pair of the held-out set, typed by hand (as diarize-nemotron-pg.test.ts). */
const BLIND_DAY = "2026-09-28";
const BLIND_ROOM = "room_qyzghzaf";

/** float32 LE, as SQL bytea hex and as base64 — typed here, not taken from the module. */
const f32 = (...xs: number[]) => { const b = Buffer.alloc(xs.length * 4); xs.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
const [FA, FB, FGONE] = [1, 2, 3].map((n) => makeFakeClinician(n));
const A = FA.id, B = FB.id, GONE = FGONE.id;

type Kind = typeof import("@/lib/jobs/kinds/nemotron-identity");
type Enq = typeof import("@/lib/diarize-nemotron/identity-enqueue");
let kind: Kind;
let enq: Enq;

const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> => {
  const s = Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
  return (await H.sql!(s)) as T[];
};
const fails = (text: string) => { try { pg.exec(text); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };
const runJob = (row_id: number, centroid_set = "voice_print") =>
  kind.nemotronIdentityKind.run({ job: {} as never, step: "embed", args: kind.nemotronIdentityKind.parseArgs({ row_id, centroid_set }), progress: {} });

/** A stored Nemotron row. Returns its id. */
let nextWin = 0;
async function nemoRow(o: { rd?: string; status?: "ok" | "empty"; turns?: unknown } = {}): Promise<number> {
  const w = `bw_fake${String(++nextWin).padStart(4, "0")}`;
  // each window gets its own session, in the room and on the IST day of its room-day
  const [room, day] = o.rd === "rd_blind" ? [BLIND_ROOM, BLIND_DAY] : ["room_fake1", "2026-10-01"];
  pg.exec(`INSERT INTO bench_session (id, room_id, started_at, ended_at) VALUES ('bs_${w}', '${room}', '${day} 10:00+05:30', '${day} 11:00+05:30');
           INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, state, grid_aligned, clip_r2_key)
           VALUES ('${w}', 'bs_${w}', '${o.rd ?? "rd_1"}', 0, 900000, 'closed', true, 'clips/${w}.webm');`);
  const turns = JSON.stringify(o.turns ?? [[0, 10000, "spk0"], [10000, 15000, "spk1"], [20000, 50000, "spk0"], [50000, 120000, "spk1"]]);
  const rows = await q<{ id: string }>(`INSERT INTO diarize_nemotron_window (window_id, room_day_id, engine, model, model_rev, config, config_hash,
      worker_id, machine, audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status, error_code)
    VALUES ('${w}', '${o.rd ?? "rd_1"}', 'nemotron', 'm', 'r', '{}', 'h', 'wk', 'box', 900000, '${turns}', 2, 4, 115000, 0, 'p', '${o.status ?? "ok"}', NULL)
    RETURNING id`);
  return Number(rows[0]!.id);
}

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  pg.exec(FIXTURE_DDL);
  pg.exec(readFileSync("db/migrations/0113_voice_centroid.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0117_diarize_window_label.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0140_diarize_nemotron.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0141_diarize_nemotron_identity.sql", "utf8"));
  pg.exec(`INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_1', 'room_fake1', '2026-10-01'), ('rd_blind', '${BLIND_ROOM}', '${BLIND_DAY}');`);
  // A and B active with voiceprints; GONE has one but is deleted, so it is never offered
  pg.exec(`INSERT INTO clinician (id, full_name, status, deleted_at) VALUES
    ('${A}', '${FA.full_name}', 'active', NULL), ('${B}', '${FB.full_name}', 'active', NULL), ('${GONE}', '${FGONE.full_name}', 'active', now());
    INSERT INTO voice_print (doctor_id, centroid) VALUES
    ('${A}', '\\x${f32(1, 0, 0).toString("hex")}'), ('${B}', '\\x${f32(0, 1, 0).toString("hex")}'), ('${GONE}', '\\x${f32(0, 0, 1).toString("hex")}');`);
  H.sql = pg.sql as never;
  kind = await import("@/lib/jobs/kinds/nemotron-identity");
  enq = await import("@/lib/diarize-nemotron/identity-enqueue");
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });
beforeEach(() => {
  H.bytes = new Uint8Array([1, 2, 3]);
  H.embed.mockReset();
  H.submit.mockReset();
});

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/diarize-nemotron-identity-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("migration 0141", () => {
  it("applies a second time without error and registers once", async () => {
    pg.exec(readFileSync("db/migrations/0141_diarize_nemotron_identity.sql", "utf8"));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations WHERE version = 141"))[0]!.n).toBe(1);
  });
  it("has no vector, bytea, array or name column", async () => {
    const cols = await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name IN ('diarize_nemotron_identity','diarize_nemotron_speaker')
        AND (data_type IN ('bytea','ARRAY') OR column_name ~ '(embedding|vector|centroid_base64|name)')`);
    expect(cols[0]!.n).toBe(0);
  });
  it("constraints: a name needs its match, a losing candidate only for the unclaimed, labels, sets, failed-with-code", async () => {
    const id = await nemoRow();
    const ins = (v: string) => `INSERT INTO diarize_nemotron_speaker (window_row_id, centroid_set, speaker_label, speech_ms, clinician_id,
      match_confidence, losing_clinician_id, losing_score, centroids_offered, attribution) VALUES (${id}, ${v});`;
    expect(fails(ins(`'voice_print', 'spk0', 1, '${A}', NULL, NULL, NULL, 2, 'voiceprint'`))).toMatch(/match_chk/);
    expect(fails(ins(`'voice_print', 'spk0', 1, '${A}', 0.9, NULL, NULL, 2, 'none'`))).toMatch(/match_chk/);
    expect(fails(ins(`'voice_print', 'spk0', 1, '${A}', 0.9, '${B}', 0.4, 2, 'voiceprint'`))).toMatch(/losing_chk/);
    expect(fails(ins(`'voice_print', 'spk0', 1, NULL, NULL, '${B}', NULL, 2, 'voiceprint'`))).toMatch(/losing_chk/);
    expect(fails(ins(`'voice_print', 'speaker0', 1, NULL, NULL, NULL, NULL, 2, 'none'`))).toMatch(/label_chk/);
    expect(fails(ins(`'everyone', 'spk0', 1, NULL, NULL, NULL, NULL, 2, 'none'`))).toMatch(/set_chk/);
    expect(fails(`INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state, error_code) VALUES (${id}, 'voice_print', 'failed', NULL);`)).toMatch(/error_chk/);
    expect(fails(`INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state, error_code) VALUES (${id}, 'voice_print', 'ok', 'x');`)).toMatch(/error_chk/);
  });
});

describe.runIf(HAVE)("the job", () => {
  // speech: spk1 75 s (rank 0), spk0 40 s (rank 1). The Mini matches rank 0 to A; rank 1 loses to B at 0.6.
  const answer = () => ({ ok: true, latencyMs: 1, speakers: [
    { idx: 0, embedding_base64: f32(1, 0, 0).toString("base64"), clinician_id: A, confidence: 1.0 },
    { idx: 1, embedding_base64: f32(0, 0.6, 0.8).toString("base64") },
  ] });

  it("writes the pass and one row per speaker, sends ranks and 0.65, and offers only active voiceprints", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValueOnce(answer());
    const out = await runJob(id);
    expect(out).toMatchObject({ kind: "done", result: { state: "ok", speakers: 2, embedded: 2, matched: 1, shadow_trusted: true } });
    const [audio, request, centroids, opts] = H.embed.mock.calls[0]!;
    expect(audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(request).toEqual([
      { idx: 0, start_s: 50, end_s: 120, total_speech_sec: 75 },
      { idx: 1, start_s: 20, end_s: 50, total_speech_sec: 40 },
    ]);
    expect((centroids as Array<{ clinician_id: string }>).map((c) => c.clinician_id)).toEqual([A, B]);
    expect(opts).toMatchObject({ batchThreshold: 0.65 });
    const spk = await q(`SELECT speaker_label, speech_ms, clinician_id, match_confidence, losing_clinician_id, round(losing_score::numeric, 3)::float AS losing,
                                centroids_offered, attribution FROM diarize_nemotron_speaker WHERE window_row_id = ${id} ORDER BY speaker_label`);
    expect(spk).toEqual([
      { speaker_label: "spk0", speech_ms: 40000, clinician_id: null, match_confidence: null, losing_clinician_id: B, losing: 0.6, centroids_offered: 2, attribution: "voiceprint" },
      { speaker_label: "spk1", speech_ms: 75000, clinician_id: A, match_confidence: 1, losing_clinician_id: null, losing: null, centroids_offered: 2, attribution: "voiceprint" },
    ]);
    expect(await q(`SELECT state, attempts, error_code, centroids_offered, speakers_embedded, shadow_trusted FROM diarize_nemotron_identity WHERE window_row_id = ${id}`))
      .toEqual([{ state: "ok", attempts: 1, error_code: null, centroids_offered: 2, speakers_embedded: 2, shadow_trusted: true }]);
  });

  it("a second job for the same key writes nothing", async () => {
    const id = await nemoRow();
    H.embed.mockResolvedValue(answer());
    await runJob(id);
    const again = await runJob(id);
    expect(again).toMatchObject({ result: { state: "already_ok" } });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_speaker WHERE window_row_id = ${id}`))[0]!.n).toBe(2);
    expect((await q<{ attempts: number }>(`SELECT attempts FROM diarize_nemotron_identity WHERE window_row_id = ${id}`))[0]!.attempts).toBe(1);
  });

  it("a failure is recorded and counted; a later success turns the pass ok", async () => {
    const id = await nemoRow();
    H.bytes = null;
    await runJob(id);
    H.embed.mockResolvedValueOnce({ ok: false, error: "embed_failed", retryable: true });
    H.bytes = new Uint8Array([9]);
    await runJob(id);
    expect(await q(`SELECT state, attempts, error_code FROM diarize_nemotron_identity WHERE window_row_id = ${id}`))
      .toEqual([{ state: "failed", attempts: 2, error_code: "embed_failed" }]);
    H.embed.mockResolvedValueOnce(answer());
    await runJob(id);
    expect(await q(`SELECT state, attempts, error_code FROM diarize_nemotron_identity WHERE window_row_id = ${id}`))
      .toEqual([{ state: "ok", attempts: 3, error_code: null }]);
  });

  it("malformed turns and an undefined centroid set are written at the bound, without calling the Mini", async () => {
    const bad = await nemoRow({ turns: [[0, 10, "speaker"]] });
    await runJob(bad);
    const id = await nemoRow();
    await runJob(id, "confirmed6");
    expect(H.embed).not.toHaveBeenCalled();
    expect(await q(`SELECT window_row_id = ${bad} AS bad, centroid_set, state, attempts, error_code FROM diarize_nemotron_identity
                     WHERE window_row_id IN (${bad}, ${id}) ORDER BY window_row_id`)).toEqual([
      { bad: true, centroid_set: "voice_print", state: "failed", attempts: 3, error_code: "bad_turns" },
      { bad: false, centroid_set: "confirmed6", state: "failed", attempts: 3, error_code: "centroid_set_undefined" },
    ]);
  });

  it("a blind room-day and a non-ok row are skipped and nothing is written", async () => {
    const blind = await nemoRow({ rd: "rd_blind" });
    const empty = await nemoRow({ status: "empty", turns: [] });
    expect(await runJob(blind)).toMatchObject({ result: { skipped: "blind_room_day" } });
    expect(await runJob(empty)).toMatchObject({ result: { skipped: "not_ok" } });
    expect(H.embed).not.toHaveBeenCalled();
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_identity WHERE window_row_id IN (${blind}, ${empty})`))[0]!.n).toBe(0);
  });

  it("the held-out guard places a row through its window: blind refused, clean passes, a missing row is left to the kind, a bad id fails closed", async () => {
    const guard = kind.nemotronIdentityKind.heldOut!;
    expect(kind.nemotronIdentityKind.roomData).toBe(true);
    expect(await guard({ row_id: await nemoRow({ rd: "rd_blind" }), centroid_set: "voice_print" })).toBe("blind_room_day");
    expect(await guard({ row_id: await nemoRow(), centroid_set: "voice_print" })).toBeNull();
    expect(await guard({ row_id: 999_999_999, centroid_set: "voice_print" })).toBeNull();
    expect(await guard({ row_id: "x", centroid_set: "voice_print" })).toBe("window_unplaced");
  });

  it("room_primary centroids come from voice_centroid, active and unretired only", async () => {
    pg.exec(`INSERT INTO voice_centroid (id, clinician_id, domain, embedding, embedding_model, embedding_dim, n_samples)
             VALUES ('vc_fake1', '${B}', 'room_primary', '{0,1,0}', 'ecapa', 3, 5), ('vc_fake2', '${GONE}', 'room_primary', '{1,0,0}', 'ecapa', 3, 5),
                    ('vc_fake3', '${A}', 'phone', '{1,0,0}', 'ecapa', 3, 5);`);
    const id = await nemoRow();
    H.embed.mockResolvedValueOnce({ ok: true, latencyMs: 1, speakers: [] });
    await runJob(id, "voice_centroid:room_primary");
    const centroids = H.embed.mock.calls[0]![2] as Array<{ clinician_id: string; centroid_base64: string }>;
    expect(centroids).toEqual([{ clinician_id: B, full_name: FB.full_name, centroid_base64: f32(0, 1, 0).toString("base64") }]);
  });
});

describe.runIf(HAVE)("the enqueue", () => {
  it("off: queues nothing and reads nothing", async () => {
    delete process.env.NEMOTRON_IDENTITY_ENABLED;
    expect(await enq.enqueueNemotronIdentity({ actor: "t" })).toEqual({ enabled: false, centroid_set: null, scanned: 0, n_blind_excluded: 0, enqueued: [] });
    expect(H.submit).not.toHaveBeenCalled();
  });

  it("on: new ok rows first, then failed passes under the bound; never an ok pass, an exhausted one, or one with an open job", async () => {
    pg.exec(`DELETE FROM diarize_nemotron_speaker; DELETE FROM diarize_nemotron_identity; DELETE FROM diarize_nemotron_window;`);
    const fresh = await nemoRow();
    const retry = await nemoRow();
    const done = await nemoRow();
    const exhausted = await nemoRow();
    const queued = await nemoRow();
    await nemoRow({ status: "empty", turns: [] });
    await nemoRow({ rd: "rd_blind" }); // a fresh ok row on a held-out day: never chosen, counted
    pg.exec(`INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state, attempts, error_code) VALUES
      (${retry}, 'voice_print', 'failed', 2, 'embed_failed'), (${exhausted}, 'voice_print', 'failed', 3, 'embed_failed');
      INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state) VALUES (${done}, 'voice_print', 'ok');
      INSERT INTO scribe_job (id, kind, args, status) VALUES ('job_fake1', 'nemotron_identity', '{"row_id": ${queued}, "centroid_set": "voice_print"}', 'running');`);
    process.env.NEMOTRON_IDENTITY_ENABLED = "1";
    let n = 0;
    H.submit.mockImplementation(async () => ({ id: `job_new${++n}` }));
    try {
      const r = await enq.enqueueNemotronIdentity({ actor: "cron:test" });
      expect(r.enqueued).toEqual([{ row_id: fresh, job_id: "job_new1", retry: false }, { row_id: retry, job_id: "job_new2", retry: true }]);
      const blindWindows = (await q<{ n: number }>("SELECT count(*)::int AS n FROM bench_window WHERE room_day_id = 'rd_blind'"))[0]!.n;
      expect(blindWindows).toBeGreaterThan(0);
      expect(r.n_blind_excluded).toBe(blindWindows);
      expect(H.submit.mock.calls[0]![0]).toMatchObject({ kind: "nemotron_identity", args: { row_id: fresh, centroid_set: "voice_print" }, actor: "cron:test" });
    } finally {
      delete process.env.NEMOTRON_IDENTITY_ENABLED;
    }
  });
});
