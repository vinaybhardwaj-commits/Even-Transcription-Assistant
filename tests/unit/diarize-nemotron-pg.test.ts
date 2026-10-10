/**
 * diarize-nemotron-pg.test.ts — REQUIRED PROOF for epic #23 ticket (b) on a real postgres:16 (bound parameters, as the
 * Neon driver sends them):
 *   1. migration 0140 applies twice, registers once, and its constraints hold; 0117's label CHECK now admits nemotron;
 *   2. lib/diarize-nemotron/store.ts's real SQL: claim eligibility, the 15-min lease, a dead worker's lease stolen, the
 *      3-attempt bound, idempotent ingest, 409 on a different payload, terminal vs retryable failures, the heartbeat upsert.
 * The fixture DDL carries only the bench_window columns the store reads (mirrors 0057; not applied: its FKs reach tables
 * this suite does not need). DOCKER: runs on the CI host only (no Docker on the Mini). All ids are fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-nemotron-0140");

const FIXTURE_DDL = `
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  state text NOT NULL, grid_aligned boolean NOT NULL DEFAULT false, clip_r2_key text, source_mic text);
`;
const MIGRATION = "db/migrations/0140_diarize_nemotron.sql";
/** One (IST date, room) pair of the held-out set, typed by hand — the guard test below proves the module agrees. */
const BLIND_DAY = "2026-09-28";
const BLIND_ROOM = "room_qyzghzaf";

type Store = typeof import("@/lib/diarize-nemotron/store");
type Validate = typeof import("@/lib/diarize-nemotron/validate");
let store: Store;
let V: Validate;

const CONFIG = { chunk: 340, fifo: 40 };
const body = (o: Record<string, unknown> = {}) => ({
  window_id: "bw_a", room_day_id: "rd_1", engine: "nemotron", model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1",
  config: CONFIG, config_hash: V.configHash(CONFIG), worker_id: "box-1", machine: "box", audio_ms: 900000,
  clip_sha256: "c".repeat(64), status: "ok", error_code: null, turns: [[0, 4210, "spk0"], [3900, 9100, "spk1"]], ...o,
});
const ingest = async (o: Record<string, unknown> = {}) => {
  const v = V.checkIngest(body(o));
  if (!v.ok) throw new Error(`fixture refused: ${v.error}`);
  return store.recordIngest(v.body, v.derived, v.payload_sha256);
};
const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> => {
  const s = Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
  return (await H.sql!(s)) as T[];
};
const fails = (text: string) => { try { pg.exec(text); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };
/** Expire every live lease, as 15 minutes passing would. */
const expireLeases = () => pg.exec(`UPDATE diarize_nemotron_claim SET lease_until = now() - interval '1 second' WHERE done_at IS NULL;`);

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  pg.exec(FIXTURE_DDL);
  // 0117 first, as production has it, so 0140's widening of its CHECK is proven against the real constraint.
  pg.exec(readFileSync("db/migrations/0117_diarize_window_label.sql", "utf8"));
  pg.exec(readFileSync(MIGRATION, "utf8"));
  pg.exec(readFileSync("db/migrations/0143_nemotron_lab.sql", "utf8")); // the ingest INSERT names probs_r2_key (0143)
  pg.exec(readFileSync("db/migrations/0147_nemotron_claim_machine.sql", "utf8")); // claimPending writes claim.machine (0147)
  // the encounter windows (0123 + 0124), for the anchors' blind refusal
  pg.exec(readFileSync("db/migrations/0123_eta_encounter_windows.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0124_encounter_windows_warehouse_attribution.sql", "utf8"));
  // room-days: rd_1 is an ordinary day; rd_blind is a pair typed by hand from the held-out set
  pg.exec(`INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_1', 'room_fake1', '2026-10-01'), ('rd_blind', '${BLIND_ROOM}', '${BLIND_DAY}');`);
  H.sql = pg.sql as never;
  store = await import("@/lib/diarize-nemotron/store");
  V = await import("@/lib/diarize-nemotron/validate");
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/diarize-nemotron-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("migration 0140", () => {
  it("applies a second time without error and registers once", async () => {
    pg.exec(readFileSync(MIGRATION, "utf8"));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations WHERE version = 140"))[0]!.n).toBe(1);
  });
  it("has no text, transcript or embedding column", async () => {
    const cols = await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name IN ('diarize_nemotron_window','diarize_nemotron_claim','diarize_nemotron_worker')
        AND column_name IN ('text','transcript','english','embedding','embeddings','name','patient')`);
    expect(cols[0]!.n).toBe(0);
  });
  it("constraints hold: engine, machine, status, error-with-failed, counts, the unique key", () => {
    const ins = (o: string) => `INSERT INTO diarize_nemotron_window (window_id, room_day_id, engine, model, model_rev, config, config_hash, worker_id, machine,
      audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status, error_code) VALUES ${o};`;
    const row = (p: Partial<Record<string, string>> = {}) => {
      const d = { w: "'x'", engine: "'nemotron'", machine: "'box'", audio: "900000", spk: "1", speech: "100", overlap: "0", status: "'ok'", err: "NULL", ...p };
      return `(${d.w}, 'rd', ${d.engine}, 'm', 'r', '{}', 'h', 'wk', ${d.machine}, ${d.audio}, '[]', ${d.spk}, 1, ${d.speech}, ${d.overlap}, 'p', ${d.status}, ${d.err})`;
    };
    expect(fails(ins(row()))).toBe("");
    expect(fails(ins(row({ w: "'y'", engine: "'pyannoteai'" })))).toMatch(/engine_chk/);
    expect(fails(ins(row({ w: "'y'", machine: "'laptop'" })))).toMatch(/machine_chk/);
    expect(fails(ins(row({ w: "'y'", status: "'done'" })))).toMatch(/status_chk/);
    expect(fails(ins(row({ w: "'y'", err: "'decode_failed'" })))).toMatch(/error_chk/);
    expect(fails(ins(row({ w: "'y'", status: "'failed'" })))).toMatch(/error_chk/);
    expect(fails(ins(row({ w: "'y'", spk: "9" })))).toMatch(/counts_chk/);
    expect(fails(ins(row({ w: "'y'", speech: "900001" })))).toMatch(/counts_chk/);
    expect(fails(ins(row({ w: "'y'", overlap: "101" })))).toMatch(/counts_chk/);
    expect(fails(ins(row({ w: "'y'", audio: "0" })))).toMatch(/counts_chk/);
    expect(fails(ins(row({ w: "'z'", audio: "0", status: "'failed'", err: "'decode_failed'", spk: "0", speech: "0" })))).toBe("");
    expect(fails(ins(row()))).toMatch(/diarize_nemotron_window_once/);
    expect(fails(`INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until, attempts) VALUES ('c', 'w', now(), 4);`)).toMatch(/attempts_chk/);
    pg.exec(`DELETE FROM diarize_nemotron_window; DELETE FROM diarize_nemotron_claim;`);
  });
  it("0117's label CHECK now admits nemotron, and still refuses an unknown engine", () => {
    const lab = (engine: string, run: string) =>
      `INSERT INTO diarize_window_label (id, window_id, room_day_id, engine, run_id, segments_json, speaker_count, segment_count) VALUES ('${run}', 'w', 'rd', '${engine}', '${run}', '[]', 0, 0);`;
    expect(fails(lab("nemotron", "l1"))).toBe("");
    expect(fails(lab("sortformer", "l2"))).toMatch(/engine_known/);
    pg.exec(`DELETE FROM diarize_window_label;`);
  });
});

describe.runIf(HAVE)("store: claim, lease and the attempt bound", () => {
  beforeEach(() => {
    pg.exec(`DELETE FROM diarize_nemotron_window; DELETE FROM diarize_nemotron_claim; DELETE FROM diarize_nemotron_worker; DELETE FROM bench_window;
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, state, grid_aligned, clip_r2_key) VALUES
        ('bw_a', 's', 'rd_1', 1000, 901000, 'closed', true, 'clips/a'),
        ('bw_b', 's', 'rd_1', 2000, 902000, 'transcribed', true, 'clips/b'),
        ('bw_open', 's', 'rd_1', 500, 900500, 'open', true, 'clips/o'),
        ('bw_nogrid', 's', 'rd_1', 600, 900600, 'closed', false, 'clips/n'),
        ('bw_noclip', 's', 'rd_1', 700, 900700, 'closed', true, NULL),
        ('bw_noday', 's', NULL, 800, 900800, 'closed', true, 'clips/d');`);
  });

  it("offers only eligible windows, newest first, and leases them", async () => {
    const got = await store.claimPending("box-1", 8);
    expect(got.map((w) => w.window_id)).toEqual(["bw_b", "bw_a"]);
    expect(got[1]).toEqual({ window_id: "bw_a", room_day_id: "rd_1", start_ms: 1000, end_ms: 901000, clip_r2_key: "clips/a", attempts: 1 });
    const lease = await q<{ ok: boolean }>(`SELECT bool_and(lease_until > now() + interval '14 minutes' AND lease_until <= now() + interval '15 minutes') AS ok FROM diarize_nemotron_claim`);
    expect(lease[0]!.ok).toBe(true);
  });

  it("respects the limit", async () => {
    expect((await store.claimPending("box-1", 1)).map((w) => w.window_id)).toEqual(["bw_b"]);
  });

  it("a live lease is not offered to anyone; an expired one is stolen and counts an attempt", async () => {
    await store.claimPending("box-1", 8);
    expect(await store.claimPending("box-2", 8)).toEqual([]);
    expireLeases();
    const stolen = await store.claimPending("hf-1", 1);
    expect(stolen).toMatchObject([{ window_id: "bw_b", attempts: 2 }]);
    expect((await q<{ worker_id: string }>(`SELECT worker_id FROM diarize_nemotron_claim WHERE window_id = 'bw_b'`))[0]!.worker_id).toBe("hf-1");
  });

  it("after 3 claims with nothing stored, the window is exhausted, counted, and never offered again", async () => {
    for (let i = 1; i <= 3; i++) {
      expect(await store.claimPending("box-1", 1)).toMatchObject([{ window_id: "bw_b", attempts: i }]);
      expireLeases();
    }
    const next = await store.claimPending("box-1", 8);
    expect(next.map((w) => w.window_id)).toEqual(["bw_a"]);
    expect(await store.countExhausted()).toBe(1);
  });

  it("a stored row of any revision means the window is done; its unstored neighbour is offered again", async () => {
    await store.claimPending("box-1", 8);
    await ingest();
    expireLeases();
    // bw_a has a row (done); bw_b was claimed alongside it but nothing was stored, so its expired lease is stolen.
    expect(await store.claimPending("box-2", 8)).toMatchObject([{ window_id: "bw_b", attempts: 2 }]);
  });

  it("releaseClaim gives an unhanded claim back: a first claim vanishes, a later one steps back an attempt; another worker's is untouched", async () => {
    await store.claimPending("box-1", 8); // bw_b and bw_a, attempts 1 each
    await store.releaseClaim("box-2", "bw_b"); // not box-2's lease: nothing changes
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_claim`))[0]!.n).toBe(2);
    await store.releaseClaim("box-1", "bw_b");
    expect((await q<{ id: string }>(`SELECT window_id AS id FROM diarize_nemotron_claim ORDER BY 1`)).map((r) => r.id)).toEqual(["bw_a"]);
    expect(await store.claimPending("box-1", 8)).toMatchObject([{ window_id: "bw_b", attempts: 1 }]);
    expireLeases();
    expect(await store.claimPending("box-2", 1)).toMatchObject([{ window_id: "bw_b", attempts: 2 }]);
    await store.releaseClaim("box-2", "bw_b");
    const c = (await q<{ attempts: number; live: boolean }>(`SELECT attempts, lease_until > now() AS live FROM diarize_nemotron_claim WHERE window_id = 'bw_b'`))[0]!;
    expect(c).toEqual({ attempts: 1, live: false });
    // offered again at once, and the refunded attempt is not counted twice
    expect(await store.claimPending("box-2", 1)).toMatchObject([{ window_id: "bw_b", attempts: 2 }]);
  });
});

describe.runIf(HAVE)("store: ingest", () => {
  beforeEach(() => {
    pg.exec(`DELETE FROM diarize_nemotron_window; DELETE FROM diarize_nemotron_claim; DELETE FROM bench_window;
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, state, grid_aligned, clip_r2_key) VALUES
        ('bw_a', 's', 'rd_1', 1000, 901000, 'closed', true, 'clips/a');`);
  });

  it("stores ok with derived counts, closes the claim; an identical re-post is a duplicate; a different one a conflict", async () => {
    await store.claimPending("box-1", 1);
    expect(await ingest()).toMatchObject({ result: "stored", label: "skipped" });
    const row = (await q(`SELECT speaker_count, turn_count, speech_ms, overlap_ms, status, engine, machine FROM diarize_nemotron_window`))[0]!;
    // [0,4210] ∪ [3900,9100] = 9100 speech; overlap [3900,4210] = 310.
    expect(row).toEqual({ speaker_count: 2, turn_count: 2, speech_ms: 9100, overlap_ms: 310, status: "ok", engine: "nemotron", machine: "box" });
    expect((await q<{ done: boolean }>(`SELECT done_at IS NOT NULL AS done FROM diarize_nemotron_claim`))[0]!.done).toBe(true);
    expect(await ingest()).toEqual({ result: "duplicate" });
    // The same turns from the other machine are the same result: a duplicate, never a conflict.
    expect(await ingest({ worker_id: "hf-1", machine: "hf" })).toEqual({ result: "duplicate" });
    expect(await ingest({ turns: [[0, 4211, "spk0"], [3900, 9100, "spk1"]] })).toEqual({ result: "conflict" });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_window`))[0]!.n).toBe(1);
    // A NEW revision is a new key, stored beside the old one.
    expect(await ingest({ model_rev: "rev2" })).toMatchObject({ result: "stored" });
  });

  it("an unknown window, or a room-day that is not the window's, stores nothing", async () => {
    expect(await ingest({ window_id: "bw_none" })).toEqual({ result: "unknown_window" });
    expect(await ingest({ room_day_id: "rd_other" })).toEqual({ result: "room_day_mismatch" });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_window`))[0]!.n).toBe(0);
  });

  it("a retryable failure is recorded on the claim and releases it; a replay changes nothing", async () => {
    await store.claimPending("box-1", 1);
    const failed = { status: "failed", error_code: "gpu_oom", turns: [], clip_sha256: null };
    expect(await ingest(failed)).toEqual({ result: "failure_recorded", attempts: 1 });
    const c = (await q<{ live: boolean; last_error_code: string; n: number }>(
      `SELECT lease_until > now() AS live, last_error_code, jsonb_array_length(failure_history)::int AS n FROM diarize_nemotron_claim`))[0]!;
    expect(c).toEqual({ live: false, last_error_code: "gpu_oom", n: 1 });
    expect(await ingest(failed)).toEqual({ result: "no_live_claim" });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_window`))[0]!.n).toBe(0);
    // Released, so it is offered again at once — and a later success still lands.
    expect(await store.claimPending("box-1", 1)).toMatchObject([{ window_id: "bw_a", attempts: 2 }]);
    expect(await ingest()).toMatchObject({ result: "stored" });
  });

  it("a failure from a worker that does not hold the lease changes nothing", async () => {
    await store.claimPending("box-1", 1);
    expect(await ingest({ worker_id: "box-2", status: "failed", error_code: "gpu_oom", turns: [], clip_sha256: null })).toEqual({ result: "no_live_claim" });
  });

  it("decode_failed is terminal: a failed row at once, the window is done", async () => {
    await store.claimPending("box-1", 1);
    expect(await ingest({ status: "failed", error_code: "decode_failed", turns: [], clip_sha256: null, audio_ms: 0 })).toMatchObject({ result: "stored" });
    const row = (await q(`SELECT status, error_code FROM diarize_nemotron_window`))[0]!;
    expect(row).toEqual({ status: "failed", error_code: "decode_failed" });
    expect(await store.claimPending("box-1", 1)).toEqual([]);
  });

  it("a FINAL failure whose row is refused (room-day mismatch) keeps its lease: nobody else can take the window and burn an attempt", async () => {
    await store.claimPending("box-1", 1);
    expect(await ingest({ room_day_id: "rd_other", status: "failed", error_code: "decode_failed", turns: [], clip_sha256: null, audio_ms: 0 }))
      .toEqual({ result: "room_day_mismatch" });
    const c = (await q<{ live: boolean; done: boolean; attempts: number; last_error_code: string }>(
      `SELECT lease_until > now() AS live, done_at IS NOT NULL AS done, attempts, last_error_code FROM diarize_nemotron_claim`))[0]!;
    expect(c).toEqual({ live: true, done: false, attempts: 1, last_error_code: "decode_failed" });
    expect(await store.claimPending("box-2", 8)).toEqual([]);
    // the holder can still post the corrected final row inside its lease
    expect(await ingest({ status: "failed", error_code: "decode_failed", turns: [], clip_sha256: null, audio_ms: 0 })).toMatchObject({ result: "stored" });
  });

  it("an insert refused because the key already has a row still closes the claim", async () => {
    await store.claimPending("box-1", 1);
    expect(await ingest()).toMatchObject({ result: "stored" });
    pg.exec(`UPDATE diarize_nemotron_claim SET done_at = NULL, lease_until = now() + interval '10 minutes';`);
    expect(await ingest()).toEqual({ result: "duplicate" });
    expect((await q<{ done: boolean }>(`SELECT done_at IS NOT NULL AS done FROM diarize_nemotron_claim`))[0]!.done).toBe(true);
    pg.exec(`UPDATE diarize_nemotron_claim SET done_at = NULL, lease_until = now() + interval '10 minutes';`);
    expect(await ingest({ turns: [[0, 4211, "spk0"], [3900, 9100, "spk1"]] })).toEqual({ result: "conflict" });
    expect((await q<{ done: boolean }>(`SELECT done_at IS NOT NULL AS done FROM diarize_nemotron_claim`))[0]!.done).toBe(true);
  });

  it("the third failure is final: a failed row, no fourth attempt", async () => {
    const failed = { status: "failed", error_code: "gpu_oom", turns: [], clip_sha256: null };
    for (let i = 1; i <= 2; i++) {
      await store.claimPending("box-1", 1);
      expect(await ingest(failed)).toEqual({ result: "failure_recorded", attempts: i });
    }
    await store.claimPending("box-1", 1);
    expect(await ingest(failed)).toMatchObject({ result: "stored" });
    expect((await q(`SELECT status, error_code FROM diarize_nemotron_window`))[0]!).toEqual({ status: "failed", error_code: "gpu_oom" });
    expect(await store.claimPending("box-1", 1)).toEqual([]);
    expect(await store.countExhausted()).toBe(0); // it has a row: done, not exhausted
  });
});

describe.runIf(HAVE)("store: heartbeat", () => {
  it("upserts one row per worker with the latest payload", async () => {
    await store.recordHeartbeat("box-1", { queue_depth: 3 });
    await store.recordHeartbeat("box-1", { queue_depth: 5 });
    const rows = await q<{ worker_id: string; depth: number }>(`SELECT worker_id, (payload->>'queue_depth')::int AS depth FROM diarize_nemotron_worker`);
    expect(rows).toEqual([{ worker_id: "box-1", depth: 5 }]);
  });
});

describe.runIf(HAVE)("formerly BLIND room-days (N1, N2; rule lifted by V 10 Oct 2026): such a day is processed like any clean day", () => {
  beforeEach(() => {
    pg.exec(`DELETE FROM diarize_nemotron_window; DELETE FROM diarize_nemotron_claim; DELETE FROM bench_window; DELETE FROM eta_encounter_windows;
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, state, grid_aligned, clip_r2_key) VALUES
        ('bw_a', 's', 'rd_1', 1000, 901000, 'closed', true, 'clips/a'),
        ('bw_blind', 's', 'rd_blind', 5000, 905000, 'closed', true, 'clips/x');`);
  });

  it("guard: the hand-typed pair is no longer in the held-out set (nor is rd_1's)", async () => {
    const { isBlindRoomDay } = await import("@/lib/rubrics/blind-room-days");
    expect(isBlindRoomDay(BLIND_DAY, BLIND_ROOM)).toBe(false);
    expect(isBlindRoomDay("2026-10-01", "room_fake1")).toBe(false);
  });

  it("N1 claim: a formerly blind room-day's window is offered like any other, newest first", async () => {
    expect((await store.claimPending("box-1", 8)).map((w) => w.window_id)).toEqual(["bw_blind", "bw_a"]);
    expireLeases();
    expect((await store.claimPending("box-2", 8)).map((w) => [w.window_id, w.attempts])).toEqual([["bw_blind", 2], ["bw_a", 2]]);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_claim WHERE window_id = 'bw_blind'`))[0]!.n).toBe(1);
  });

  it("N1 ingest: a post for a formerly blind window is stored (never refused blind_room_day)", async () => {
    expect(await ingest({ window_id: "bw_blind", room_day_id: "rd_blind" })).toMatchObject({ result: "stored" });
    expect(await ingest({ window_id: "bw_blind", room_day_id: "rd_blind", status: "failed", error_code: "decode_failed", turns: [], clip_sha256: null, audio_ms: 0 }))
      .toEqual({ result: "no_live_claim" }); // the first post consumed the claim; the point is that it is no longer a blind_room_day refusal
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_window WHERE window_id = 'bw_blind'`))[0]!.n).toBe(1);
    // an ordinary window still stores
    expect(await ingest()).toMatchObject({ result: "stored" });
  });

  const win = (key: string, room: string, tOpen: string) =>
    `('${key}', 'm1', '${room}', 'rows', '${tOpen}', '${tOpen}'::timestamptz + interval '10 minutes', 'endConsult', 'clean', 'r1')`;
  const seedWindows = (...v: string[]) =>
    pg.exec(`INSERT INTO eta_encounter_windows (consult_key, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version) VALUES ${v.join(", ")};`);

  it("N2 anchors: a formerly blind (room, IST day) is not refused; its anchors are returned", async () => {
    const { loadAnchors } = await import("@/lib/encounter-clock/anchors");
    seedWindows(win("k_blind", BLIND_ROOM, "2026-09-28T04:30:00Z")); // 10:00 IST on the blind day
    const calls: number[] = [];
    const spy = ((s: TemplateStringsArray, ...v: unknown[]) => { calls.push(1); return pg.sql(s, ...v); }) as never;
    const out = await loadAnchors(spy, BLIND_ROOM, BLIND_DAY);
    if ("refused" in out) throw new Error("a formerly blind day must not be refused");
    expect(out.anchors.map((a) => a.consult_key)).toEqual(["k_blind"]);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("N2 anchors: the day before a formerly blind day reads normally and its look-ahead onto that day is kept", async () => {
    const { loadAnchors } = await import("@/lib/encounter-clock/anchors");
    seedWindows(
      win("k_before", BLIND_ROOM, "2026-09-27T04:30:00Z"), // 10:00 IST 27 Sep
      win("k_blind", BLIND_ROOM, "2026-09-28T04:30:00Z"), // 10:00 IST 28 Sep, blind
      win("k_ok1", "room_fake1", "2026-09-27T04:30:00Z"),
      win("k_ok2", "room_fake1", "2026-09-28T04:30:00Z"), // an ordinary next day: the control
    );
    const blindNext = await loadAnchors(pg.sql as never, BLIND_ROOM, "2026-09-27");
    if ("refused" in blindNext) throw new Error("27 Sep is not blind");
    expect(blindNext.anchors.map((a) => [a.consult_key, a.next_start_ms])).toEqual([["k_before", Date.parse("2026-09-28T04:30:00Z")]]);
    const control = await loadAnchors(pg.sql as never, "room_fake1", "2026-09-27");
    if ("refused" in control) throw new Error("room_fake1 is not blind");
    expect(control.anchors.map((a) => [a.consult_key, a.next_start_ms])).toEqual([["k_ok1", Date.parse("2026-09-28T04:30:00Z")]]);
  });
});
