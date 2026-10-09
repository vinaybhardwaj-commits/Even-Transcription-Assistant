/**
 * REL2-R3 (GATING #10632) on a real postgres:16 — the either-placement rule over EVERY placement a turn row has: its own room_turn_speaker.room_day_id, its bench_window.room_day_id and its
 * room_diarize_window.room_day_id. B1 (scribe_window_speakers), B2 (the voice console and voice search), and the sweep's other readers (added below the B2 block).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); }, { transaction: async () => [] }) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-rel2-r3-blind");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const vec = (c: number): string => { const f = new Float32Array(192); f[0] = c; f[1] = Math.sqrt(Math.max(0, 1 - c * c)); return Buffer.from(f.buffer).toString("base64"); };
const spk = (idx: number, c: number) => ({ idx, embedding_base64: vec(c) });

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL DEFAULT 'bs1', room_day_id text);
    CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text, state text NOT NULL DEFAULT 'ok', speakers_json jsonb, last_run_id text);
    CREATE TABLE room_turn_speaker (window_id text NOT NULL, source_ref text NOT NULL, speaker_idx integer NOT NULL DEFAULT 0, overlap_ms integer NOT NULL DEFAULT 0, room_day_id text, clinician_id text, role text,
      match_confidence double precision, losing_clinician_id text, run_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (window_id, source_ref));
    CREATE TABLE clinician (id text PRIMARY KEY, status text NOT NULL DEFAULT 'active', deleted_at timestamptz);
    CREATE TABLE voice_print (doctor_id text PRIMARY KEY, sample_count int DEFAULT 3, enrolled_at timestamptz DEFAULT now(), last_sample_at timestamptz DEFAULT now(), needs_reenrollment boolean DEFAULT false, centroid bytea);
    CREATE TABLE voice_sample (clinician_id text, source text, included boolean DEFAULT true, match_confidence double precision);
    CREATE TABLE voice_print_generation (clinician_id text, generation int, origin text, sample_count int, provenance_json jsonb, created_at timestamptz DEFAULT now());
    CREATE TABLE voice_centroid (clinician_id text, domain text, generation int, embedding_model text, embedding_dim int, n_samples int, created_at timestamptz DEFAULT now(), retired_at timestamptz, retired_by text, retired_reason text);
  `);
  H.sql = pg.sql as never;
  const cent = Buffer.from(new Float32Array(192).fill(0).map((_, i) => (i === 0 ? 1 : 0)).buffer).toString("base64");
  pg.exec(`
    INSERT INTO room_day VALUES ('rd_clean', 'r1', '2026-10-05'), ('rd_blind', '${BR}', '${BD}');
    INSERT INTO clinician VALUES ('docA'), ('docB');
    INSERT INTO voice_print (doctor_id, centroid) VALUES ('docA', decode('${cent}', 'base64')), ('docB', decode('${cent}', 'base64'));
    -- wOK: clean everywhere. wRts: bench and diarize clean, its two turn rows on a held-out day (GATING's repro). wRdw: bench clean, diarize row AND its turn rows held out. wBench: bench held out, rest clean.
    INSERT INTO bench_window VALUES ('q', 'bs1', 'rd_clean'), ('wOK', 'bs1', 'rd_clean'), ('wRts', 'bs1', 'rd_clean'), ('wRdw', 'bs1', 'rd_clean'), ('wBench', 'bs1', 'rd_blind');
    INSERT INTO room_diarize_window (window_id, room_day_id, speakers_json, last_run_id) VALUES
      ('q', 'rd_clean', '${JSON.stringify([spk(0, 1)])}', 'run1'), ('wOK', 'rd_clean', '${JSON.stringify([spk(0, 0.9)])}', 'run1'), ('wRts', 'rd_clean', '${JSON.stringify([spk(0, 0.95)])}', 'run1'),
      ('wRdw', 'rd_blind', '${JSON.stringify([spk(0, 0.96)])}', 'run1'), ('wBench', 'rd_clean', '${JSON.stringify([spk(0, 0.97)])}', 'run1');
    INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, clinician_id, role, match_confidence, losing_clinician_id, run_id) VALUES
      ('wOK', 't1', 'rd_clean', 'docA', 'clinician', 0.9, 'docB', 'run1'),
      ('wRts', 't1', 'rd_blind', 'docA', 'clinician', 0.9, 'docB', 'run1'), ('wRts', 't2', 'rd_blind', 'docA', 'clinician', 0.9, NULL, 'run1'),
      ('wRdw', 't1', 'rd_blind', 'docA', 'clinician', 0.9, NULL, 'run1'),
      ('wBench', 't1', 'rd_clean', 'docA', 'clinician', 0.9, NULL, 'run1');
  `);
});
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("B1 scribe_window_speakers: a clean window whose turn rows sit on a held-out day is refused", () => {
  const speakers = async (args: Record<string, unknown>) => {
    const { CALLABLE_TOOLS } = await import("@/lib/mcp/surface");
    return (await CALLABLE_TOOLS.get("scribe_window_speakers")!.handler({ ...args }, { origin: "x", actor: "a", scopes: new Set(["read"]) } as never)) as Record<string, any>;
  };
  it("GATING repro: window wRts (bench and diarize placement clean, its rows on a held-out day) = blind_room_day and no span (it was 1 span before); a window with a clean row is served; the room-day filter refuses too", async () => {
    expect(await speakers({ window_id: "wRts" })).toMatchObject({ error: "blind_room_day", spans: [] });
    expect(await speakers({ window_id: "wRdw" })).toMatchObject({ error: "blind_room_day", spans: [] }); // the diarize row and the rows held out
    const ok = await speakers({ window_id: "wOK" });
    expect(ok.error).toBeUndefined();
    expect(ok.spans).toHaveLength(1);
    expect(await speakers({ room_day_id: "rd_blind" })).toMatchObject({ error: "blind_room_day" });
    // a clean room-day listing that would reach a window with a held-out placement is refused as a whole (wBench: bench held out, rows clean)
    expect(await speakers({ window_id: "wBench" })).toMatchObject({ error: "blind_room_day" });
  });
});

(HAVE ? describe : describe.skip)("B2 the voice console and voice search: a turn row with ANY held-out placement is excluded and counted", () => {
  it("GATING repro: the console counts only the clean row: n_matched 0 for the held-out ones (bench clean, diarize + turn rows held out), n_blind_excluded counts them", async () => {
    const C = await import("@/lib/voice-console");
    const ov = await C.consoleOverview() as { clinicians: Array<Record<string, any>>; n_blind_excluded: number };
    const a = ov.clinicians.find((x) => x.clinician_id === "docA")!;
    expect(a.n_matched_30d).toBe(1); // wOK only
    expect(ov.clinicians.find((x) => x.clinician_id === "docB")!.n_lost_30d).toBe(1); // wOK's losing row; wRts t1's is held out
    expect(ov.n_blind_excluded).toBe(4); // wRts t1, t2, wRdw t1, wBench t1: the held-out ones by ANY placement
    const cl = await C.consoleClinician("docA") as { daily_30d: Array<Record<string, any>>; n_blind_excluded: number };
    expect(cl.daily_30d).toEqual([expect.objectContaining({ day: "2026-10-05", n_matched: 1 })]);
    expect(cl.n_blind_excluded).toBe(4);
    const pairs = await C.consolePairs(0.5) as { pairs: Array<Record<string, any>>; n_blind_excluded: number };
    expect(pairs.pairs[0]).toMatchObject({ a_won_b_lost_30d: 1, n_contested_30d: 1 }); // wRts t1's contested row is held out and not counted
    expect(pairs.n_blind_excluded).toBe(4);
  });
  it("voice search: candidates whose diarize, bench OR turn-row placement is held out are excluded and counted; a query window whose turn rows are held out is refused", async () => {
    const { voiceSearch } = await import("@/lib/voice-search");
    const scope = { rooms: ["r1", BR], from: "2026-10-01", to: "2026-10-07" };
    const r = await voiceSearch({ window_id: "q", speaker_idx: 0, ...scope, min_cosine: 0.5 }) as { ok: boolean; hits: Array<Record<string, any>>; n_blind_excluded: number };
    expect(r.ok).toBe(true);
    expect(r.hits.map((h) => h.window_id)).toEqual(["wOK"]); // wRts (turn rows), wRdw (diarize + rows) and wBench (bench) are all held out by one placement or another
    expect(r.n_blind_excluded).toBeGreaterThanOrEqual(2);
    expect(await voiceSearch({ window_id: "wRts", speaker_idx: 0, ...scope })).toEqual({ ok: false, error: "blind_room_day" });
  });
});
