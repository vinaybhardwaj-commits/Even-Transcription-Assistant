/**
 * S6B — voice search on a real postgres:16 (bound parameters, as the Neon driver sends them), fixture vectors: held-out pairs and unplaced windows are excluded IN SQL and counted,
 * the ranking is by real cosine over stored embeddings, the clinician a hit matched comes from room_turn_speaker, and nothing is written.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); }, { transaction: async () => [] }) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-s6b-voice-search");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;

const vec = (c: number): string => { const f = new Float32Array(192); f[0] = c; f[1] = Math.sqrt(Math.max(0, 1 - c * c)); return Buffer.from(f.buffer).toString("base64"); };
const spk = (idx: number, c: number) => ({ idx, label: `S${idx}`, embedding_base64: vec(c) });

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL, UNIQUE (room_id, ist_date));
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL);
    CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text);
    CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text, state text NOT NULL, speakers_json jsonb, last_run_id text);
    CREATE TABLE room_turn_speaker (window_id text NOT NULL, source_ref text NOT NULL, speaker_idx integer NOT NULL, clinician_id text, role text, run_id text, PRIMARY KEY (window_id, source_ref));
    CREATE TABLE clinician (id text PRIMARY KEY, status text NOT NULL, deleted_at timestamptz);
    CREATE TABLE voice_print (doctor_id text PRIMARY KEY, centroid bytea);
  `);
  H.sql = pg.sql as never;
  const J = (o: unknown) => JSON.stringify(o).replace(/'/g, "''");
  pg.exec(`
    INSERT INTO room_day VALUES ('rd_ok', 'r1', '2026-10-02'), ('rd_ok2', 'r2', '2026-10-03'), ('rd_blind', '${BR}', '${BD}'), ('rd_old', 'r1', '2026-08-01');
    INSERT INTO bench_session VALUES ('bs1', 'r1', '2026-10-02T04:00:00Z'), ('bs3', 'r1', '2026-10-02T05:00:00Z'), ('bsb', '${BR}', '${BD}T04:00:00Z');
    INSERT INTO bench_window VALUES ('q', 'bs1', 'rd_ok'), ('wa', 'bs1', 'rd_ok'), ('wb', 'bs1', 'rd_ok'), ('wc', 'bs1', 'rd_ok2'), ('wblind', 'bsb', 'rd_blind'), ('wun', 'bs3', NULL), ('wold', 'bs1', 'rd_old'), ('wbad', 'bs1', 'rd_ok'), ('wfail', 'bs1', 'rd_ok'), ('wsplit', 'bs1', 'rd_blind'), ('widx', 'bs1', 'rd_ok');
    INSERT INTO room_diarize_window VALUES
      ('q', 'rd_ok', 'ok', '${J([spk(0, 1), spk(1, 0.7)])}'),
      ('wa', 'rd_ok', 'ok', '${J([spk(0, 0.91), spk(1, 0.2)])}'),
      ('wb', 'rd_ok', 'ok', '${J([spk(0, 0.8)])}'),
      ('wc', 'rd_ok2', 'ok', '${J([spk(3, 0.66)])}'),
      ('wblind', 'rd_blind', 'ok', '${J([spk(0, 0.99)])}'),
      ('wun', NULL, 'ok', '${J([spk(0, 0.98)])}'),
      ('wold', 'rd_old', 'ok', '${J([spk(0, 0.97)])}'),
      ('wbad', 'rd_ok', 'ok', '${J([{ idx: 0, embedding_base64: Buffer.from(new Float32Array(50).fill(1).buffer).toString("base64") }])}'),
      ('wfail', 'rd_ok', 'failed', '${J([spk(0, 0.99)])}'),
      ('widx', 'rd_ok', 'ok', '${J([{ idx: "http://evil.example", embedding_base64: vec(0.99) }, { idx: -1, embedding_base64: vec(0.99) }, { idx: 1.5, embedding_base64: vec(0.99) }])}'), -- S2: idx that is not a non-negative integer
      ('wsplit', 'rd_ok', 'ok', '${J([spk(0, 0.99)])}'); -- Y1: bench_window on a held-out day, the diarize row on a clean one in scope
    UPDATE room_diarize_window SET last_run_id = 'run2' WHERE window_id IN ('wa', 'wb');
    INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, clinician_id, role, run_id) VALUES
      ('wa', 't1', 0, 'docA', 'clinician', 'run2'), ('wa', 't2', 1, NULL, NULL, 'run2'),
      ('wa', 't3', 0, 'docStale', 'clinician', 'run1'),   -- S1: a row of an OLDER diarize run is not the window's current attribution
      ('wb', 't1', 0, 'docB', 'clinician', 'run2'), ('wb', 't2', 0, 'docC', 'clinician', 'run2');   -- S1: two clinicians for one speaker
    INSERT INTO clinician VALUES ('docA', 'active', NULL), ('docOff', 'disabled', NULL);
    INSERT INTO voice_print VALUES ('docA', decode('${Buffer.from(new Uint8Array(new Float32Array(192).fill(0).map((_, i) => (i === 0 ? 1 : 0)).buffer)).toString("base64")}', 'base64')), ('docOff', decode('${Buffer.from(new Float32Array(192).fill(1).buffer).toString("base64")}', 'base64'));
  `);
});
afterAll(() => { if (HAVE) pg.stop(); });

const maybe = HAVE ? describe : describe.skip;
maybe("voice search on real postgres", () => {
  const SCOPE = { rooms: ["r1", "r2", BR], from: "2026-10-01", to: "2026-10-07" };
  it("a window speaker query: real cosines, ranked, own speaker out, held-out and unplaced windows out and counted, failed and out-of-range windows invisible, bad dims counted", async () => {
    const { voiceSearch } = await import("@/lib/voice-search");
    const r = await voiceSearch({ window_id: "q", speaker_idx: 0, ...SCOPE }) as { ok: boolean; hits: Array<Record<string, unknown>>; n_blind_excluded: number; n_unplaced_excluded: number; n_bad_dim: number; n_speakers_compared: number; n_windows_in_scope: number };
    expect(r.ok).toBe(true);
    expect(r.hits.map((h) => [h.window_id, h.speaker_idx, h.cosine, h.clinician_id, h.clinician_ambiguous])).toEqual([["wa", 0, 0.91, "docA", false], ["wb", 0, 0.8, null, true], ["q", 1, 0.7, null, false], ["wc", 3, 0.66, null, false]]);
    expect(r.hits[0]).toMatchObject({ room_id: "r1", ist_date: "2026-10-02" });
    expect(r.n_blind_excluded).toBe(1); // wsplit (Y1: either placement held out); the range itself holds no held-out date
    expect(r.n_unplaced_excluded).toBe(1);
    expect(r.n_bad_dim).toBe(4); // wbad (10 floats) + three entries with an idx that is not a non-negative integer (S2)
    expect(r.n_windows_in_scope).toBe(6); // q, wa, wb, wc, wbad, widx
    expect(JSON.stringify(r)).not.toMatch(/embedding|wblind|wun|wold|wfail|wsplit|evil/);
  });
  it("a scope that reaches a held-out room-day excludes it in SQL and counts it; the query window on a held-out day is refused", async () => {
    const { voiceSearch } = await import("@/lib/voice-search");
    const r = await voiceSearch({ window_id: "q", speaker_idx: 0, rooms: [BR], from: BD, to: BD }) as { ok: boolean; hits: unknown[]; n_blind_excluded: number };
    expect(r).toMatchObject({ ok: true, hits: [], n_blind_excluded: 1 });
    expect(await voiceSearch({ window_id: "wblind", speaker_idx: 0, ...SCOPE })).toEqual({ ok: false, error: "blind_room_day" });
    expect(await voiceSearch({ window_id: "wun", speaker_idx: 0, ...SCOPE })).toEqual({ ok: false, error: "window_unplaced" });
  });
  it("a clinician query uses the active centroid; a disabled clinician has none; nothing was ever written", async () => {
    const { voiceSearch } = await import("@/lib/voice-search");
    const r = await voiceSearch({ clinician_id: "docA", ...SCOPE, min_cosine: 0.9 }) as { hits: Array<Record<string, unknown>>; query: unknown };
    expect(r.query).toEqual({ kind: "clinician" });
    expect(r.hits.map((h) => [h.window_id, h.cosine])).toEqual([["q", 1], ["wa", 0.91]]);
    expect(await voiceSearch({ clinician_id: "docOff", ...SCOPE })).toEqual({ ok: false, error: "no_voiceprint" });
    for (const s of H.statements) expect(s.trimStart()).toMatch(/^SELECT/);
    expect(pg.sql`SELECT count(*)::int AS n FROM room_turn_speaker`).resolves.toEqual([{ n: 5 }]);
  });
});
