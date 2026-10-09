/**
 * S6A — the voice console on real postgres:16 (bound parameters, as the Neon driver sends them). Fixture tables carry only the columns the console reads.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); } }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-voice-console");
const vec = (c: number): string => { const f = new Float32Array(192); f[0] = c; f[1] = Math.sqrt(1 - c * c); return Buffer.from(f.buffer).toString("base64"); };

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE clinician (id text PRIMARY KEY, status text NOT NULL DEFAULT 'active', deleted_at timestamptz);
    CREATE TABLE voice_print (doctor_id text PRIMARY KEY, centroid bytea NOT NULL, sample_count int NOT NULL DEFAULT 0, samples_json jsonb NOT NULL DEFAULT '[]', enrolled_at timestamptz NOT NULL DEFAULT now(), last_sample_at timestamptz NOT NULL DEFAULT now(), needs_reenrollment boolean NOT NULL DEFAULT false);
    CREATE TABLE voice_sample (id text PRIMARY KEY, clinician_id text NOT NULL, source text NOT NULL, embedding bytea NOT NULL, audio_r2_key text, match_confidence double precision, included boolean NOT NULL DEFAULT true);
    CREATE TABLE voice_print_generation (id text PRIMARY KEY, clinician_id text NOT NULL, generation int NOT NULL, origin text NOT NULL, centroid bytea NOT NULL, sample_count int NOT NULL DEFAULT 0, samples_json jsonb NOT NULL DEFAULT '[]', provenance_json jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE voice_centroid (id text PRIMARY KEY, clinician_id text NOT NULL, domain text NOT NULL, generation int NOT NULL DEFAULT 1, embedding real[] NOT NULL, embedding_model text NOT NULL, embedding_dim int NOT NULL, n_samples int NOT NULL, source jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT now(), retired_at timestamptz, retired_by text, retired_reason text);
    CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
    CREATE TABLE bench_window (id text PRIMARY KEY, room_day_id text);
    CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text);
    CREATE TABLE room_turn_speaker (window_id text NOT NULL, source_ref text NOT NULL, speaker_idx int NOT NULL DEFAULT 0, role text, clinician_id text, match_confidence double precision, losing_clinician_id text, room_day_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (window_id, source_ref));
    INSERT INTO clinician VALUES ('docA', 'active', NULL), ('docB', 'disabled', NULL), ('docC', 'active', NULL);
    INSERT INTO voice_print (doctor_id, centroid, sample_count) VALUES ('docA', decode('${vec(1)}', 'base64'), 4), ('docB', decode('${vec(0.8)}', 'base64'), 2), ('docC', decode('${vec(0.2)}', 'base64'), 1);
    INSERT INTO voice_sample VALUES ('s1','docA','enrollment', decode('00','hex'), 'secret/key.webm', NULL, true), ('s2','docA','enrollment', decode('00','hex'), NULL, NULL, false),
      ('s3','docA','passive', decode('00','hex'), NULL, 0.70, true), ('s4','docA','passive', decode('00','hex'), NULL, 0.80, true), ('s5','docA','passive', decode('00','hex'), NULL, 0.90, false);
    INSERT INTO voice_print_generation (id, clinician_id, generation, origin, centroid, sample_count, provenance_json) VALUES
      ('g1','docA',1,'enrolment_clip', decode('00','hex'), 3, '{}'), ('g2','docA',2,'room_audio', decode('00','hex'), 9, '{"windows": 4, "speech_s": 61.5, "manifest": "mf_secret"}');
    INSERT INTO voice_centroid (id, clinician_id, domain, generation, embedding, embedding_model, embedding_dim, n_samples, retired_at, retired_by, retired_reason) VALUES
      ('vc1','docA','room_primary',1,'{0.1,0.2}','ecapa-192',2,5,now(),'actor_x','superseded_by:vc2'), ('vc2','docA','room_primary',2,'{0.1,0.2}','ecapa-192',2,6,NULL,NULL,NULL);
    INSERT INTO room_day VALUES ('rd_ok','r1',(now() AT TIME ZONE 'Asia/Kolkata')::date), ('rd_blind','room_ux92qpws','2026-09-13');
    INSERT INTO bench_window VALUES ('w_ok','rd_ok'), ('w_blind','rd_blind'), ('w_none', NULL);
    INSERT INTO room_turn_speaker (window_id, source_ref, role, clinician_id, match_confidence, losing_clinician_id) VALUES
      ('w_ok','t1','clinician','docA',0.80,NULL), ('w_ok','t2','clinician','docA',0.90,NULL), ('w_ok','t3','clinician','docA',0.70,NULL), ('w_ok','t4','clinician','docA',0.85,'docB'), ('w_ok','t5','clinician','docB',0.75,'docA'),
      ('w_blind','b1','clinician','docA',0.80,NULL), ('w_blind','b2','clinician','docA',0.80,'docB'),
      ('w_none','u1','clinician','docA',0.80,NULL);
  `);
  H.sql = pg.sql as never;
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe.runIf(HAVE)("voice console on real postgres", () => {
  it("overview: the real SQL runs; counts, percentiles, generations, centroid counts, matches and losses are right; the held-out and unplaced turns are excluded and counted", async () => {
    const C = await import("@/lib/voice-console");
    const o = await C.consoleOverview() as { clinicians: Array<Record<string, any>>; summary: Record<string, number>; n_blind_excluded: number; n_unplaced_excluded: number };
    expect(o.summary).toEqual({ total: 3, matchable: 2 });
    const a = o.clinicians.find((x) => x.clinician_id === "docA")!, b = o.clinicians.find((x) => x.clinician_id === "docB")!;
    expect(a).toMatchObject({ samples: { enrollment: 2, enrollment_included: 1, passive: 3, passive_included: 2 }, passive_match_confidence: { p10: 0.72, p50: 0.8, p90: 0.88 },
      generations: { count: 2, latest_generation: 2, latest_origin: "room_audio" }, centroids: [{ domain: "room_primary", active: 1, retired: 1 }], n_matched_30d: 4, n_lost_30d: 1 });
    expect(b).toMatchObject({ matchable: false, clinician_status: "disabled", n_matched_30d: 1, n_lost_30d: 1 });
    expect(o.n_blind_excluded).toBe(2); // b1, b2 on a held-out pair
    expect(o.n_unplaced_excluded).toBe(1); // u1 has no room-day
    expect(JSON.stringify(o)).not.toMatch(/secret|samples_json/);
  });
  it("clinician: generation provenance counts only, centroid rows with no vector, the daily series excludes the held-out day", async () => {
    const C = await import("@/lib/voice-console");
    const r = await C.consoleClinician("docA") as Record<string, any>;
    expect(r.generation_history.map((g: any) => [g.generation, g.provenance_counts])).toEqual([[1, {}], [2, { windows: 4, speech_s: 61.5 }]]);
    expect(r.voice_centroids.map((c: any) => [c.generation, c.retired_by, c.retired_reason])).toEqual([[1, "actor_x", "superseded_by:vc2"], [2, null, null]]);
    expect(JSON.stringify(r)).not.toMatch(/mf_secret|embedding\b"?:\s*\[/);
    expect(r.daily_30d).toHaveLength(1);
    expect(r.daily_30d[0]).toMatchObject({ n_matched: 4 });
    expect(r.daily_30d[0].match_confidence_p50).toBeCloseTo(0.825, 3);
  });
  it("pairs: active prints only, cosine 3 dp from the stored bytes, the 30-day contested counts, the floor", async () => {
    const C = await import("@/lib/voice-console");
    const p = await C.consolePairs() as { pairs: any[]; n_active_prints: number };
    expect(p.n_active_prints).toBe(2); // docB is disabled
    expect(p.pairs).toEqual([]); // A-C is far apart, B excluded: nothing near
    // activate docB to see the pair
    await pg.exec(`UPDATE clinician SET status = 'active' WHERE id = 'docB'`);
    const q = await C.consolePairs() as { pairs: any[] };
    expect(q.pairs).toEqual([
      { a: "docA", b: "docB", cosine: 0.8, a_won_b_lost_30d: 1, b_won_a_lost_30d: 1, n_contested_30d: 2 }, // the blind row b2 is not counted
      { a: "docB", b: "docC", cosine: 0.748, a_won_b_lost_30d: 0, b_won_a_lost_30d: 0, n_contested_30d: 0 },
    ]);
    expect((await C.consolePairs(0.1) as { min_cosine: number }).min_cosine).toBe(0.5);
    await pg.exec(`UPDATE clinician SET status = 'disabled' WHERE id = 'docB'`);
  });
});
