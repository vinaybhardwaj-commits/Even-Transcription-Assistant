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
    CREATE TABLE bench_chunk (id serial PRIMARY KEY, session_id text NOT NULL, ended_at timestamptz NOT NULL);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
    CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL DEFAULT 'bs1', room_day_id text, start_ms bigint NOT NULL DEFAULT 0, end_ms bigint NOT NULL DEFAULT 1);
    CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text, state text NOT NULL DEFAULT 'ok', speakers_json jsonb, last_run_id text);
    CREATE TABLE room_turn_speaker (window_id text NOT NULL, source_ref text NOT NULL, speaker_idx integer NOT NULL DEFAULT 0, overlap_ms integer NOT NULL DEFAULT 0, room_day_id text, clinician_id text, role text,
      match_confidence double precision, losing_clinician_id text, run_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (window_id, source_ref));
    CREATE TABLE clinician (id text PRIMARY KEY, status text NOT NULL DEFAULT 'active', deleted_at timestamptz);
    CREATE TABLE voice_print (doctor_id text PRIMARY KEY, sample_count int DEFAULT 3, enrolled_at timestamptz DEFAULT now(), last_sample_at timestamptz DEFAULT now(), needs_reenrollment boolean DEFAULT false, centroid bytea);
    CREATE TABLE voice_sample (clinician_id text, source text, included boolean DEFAULT true, match_confidence double precision);
    CREATE TABLE voice_print_generation (clinician_id text, generation int, origin text, sample_count int, provenance_json jsonb, created_at timestamptz DEFAULT now());
    CREATE TABLE jev_window_text (window_id text PRIMARY KEY, room_day_id text NOT NULL, english text, source text NOT NULL DEFAULT 'run_english', char_count int NOT NULL DEFAULT 1);
    CREATE TABLE room_span_emotion (window_id text NOT NULL, room_day_id text, speaker_idx int NOT NULL DEFAULT 0, segment_start_ms bigint NOT NULL DEFAULT 0);
    CREATE TABLE eta_encounter_windows (id serial PRIMARY KEY, consult_key text NOT NULL, consult_uid text, room_id text, t_open timestamptz NOT NULL, t_close timestamptz, quality text NOT NULL DEFAULT 'clean', attribution text NOT NULL DEFAULT 'rows', warehouse_prescription_uid text);
    CREATE TABLE reb_track_index (id serial PRIMARY KEY, window_id text, status text, shadow boolean DEFAULT false, layer text);
    CREATE TABLE cue (id text PRIMARY KEY, room_day_id text, type text, payload jsonb);
    CREATE TABLE voice_centroid (clinician_id text, domain text, generation int, embedding_model text, embedding_dim int, n_samples int, created_at timestamptz DEFAULT now(), retired_at timestamptz, retired_by text, retired_reason text);
  `);
  H.sql = pg.sql as never;
  const cent = Buffer.from(new Float32Array(192).fill(0).map((_, i) => (i === 0 ? 1 : 0)).buffer).toString("base64");
  pg.exec(`
    INSERT INTO room_day VALUES ('rd_clean', 'r1', '2026-10-05'), ('rd_blind', '${BR}', '${BD}');
    -- the sweep windows: one placement each held out
    INSERT INTO bench_window VALUES ('sJev', 'bs1', 'rd_clean'), ('sEmo', 'bs1', 'rd_clean'), ('sRts', 'bs1', 'rd_clean'), ('sRdw', 'bs1', 'rd_clean'), ('sBench', 'bs1', 'rd_blind'), ('sClean', 'bs1', 'rd_clean');
    INSERT INTO room_diarize_window (window_id, room_day_id) VALUES ('sJev', 'rd_clean'), ('sEmo', 'rd_clean'), ('sRts', 'rd_clean'), ('sRdw', 'rd_blind'), ('sBench', 'rd_clean'), ('sClean', 'rd_clean');
    INSERT INTO jev_window_text (window_id, room_day_id) VALUES ('sJev', 'rd_blind'), ('sClean', 'rd_clean');
    INSERT INTO room_span_emotion (window_id, room_day_id) VALUES ('sEmo', 'rd_blind'), ('sClean', 'rd_clean');
    INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id) VALUES ('sRts', 't1', 'rd_blind'), ('sClean', 't1', 'rd_clean');
    -- consult_uid is NOT unique (one row per machine): U1 clean then blind, U2 blind then clean, U3 clean only
    INSERT INTO eta_encounter_windows (consult_key, consult_uid, room_id, t_open, t_close, warehouse_prescription_uid) VALUES
      ('u1_clean@m1', 'ConsultUid1AaaaaaaaaaaaaaZ', 'r1', '2026-10-05T04:00:00Z', '2026-10-05T04:30:00Z', 'rec1'), ('u1_blind@m2', 'ConsultUid1AaaaaaaaaaaaaaZ', '${BR}', '${BD}T04:00:00Z', '${BD}T04:30:00Z', 'rec1'),
      ('u2_blind@m2', 'ConsultUid2AaaaaaaaaaaaaaZ', '${BR}', '${BD}T04:00:00Z', '${BD}T04:30:00Z', 'rec2'), ('u2_clean@m1', 'ConsultUid2AaaaaaaaaaaaaaZ', 'r1', '2026-10-05T04:00:00Z', '2026-10-05T04:30:00Z', 'rec2'),
      ('u3_clean@m1', 'ConsultUid3AaaaaaaaaaaaaaZ', 'r1', '2026-10-05T04:00:00Z', '2026-10-05T04:30:00Z', 'rec3'),
      -- the SAME key on two rows (no unique constraint is assumed): clean then blind, and blind then clean
      ('k_dup_a', NULL, 'r1', '2026-10-05T04:00:00Z', '2026-10-05T04:30:00Z', NULL), ('k_dup_a', NULL, '${BR}', '${BD}T04:00:00Z', '${BD}T04:30:00Z', NULL),
      ('k_dup_b', NULL, '${BR}', '${BD}T04:00:00Z', '${BD}T04:30:00Z', NULL), ('k_dup_b', NULL, 'r1', '2026-10-05T04:00:00Z', '2026-10-05T04:30:00Z', NULL);
    INSERT INTO reb_track_index (window_id, status, shadow, layer) VALUES ('consult-ConsultUid1AaaaaaaaaaaaaaZ', 'ok', false, 'translate'), ('consult-ConsultUid2AaaaaaaaaaaaaaZ', 'ok', false, 'translate'), ('consult-ConsultUid3AaaaaaaaaaaaaaZ', 'ok', false, 'translate');
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

(HAVE ? describe : describe.skip)("SWEEP: every placement of a window, on real SQL", () => {
  it("windowBlindAny / windowsBlindAny: held out by the diarize row, the turn rows, the window text, the emotion rows or the bench placement; a clean window and an unknown id are not", async () => {
    const V = await import("@/lib/voice-blind");
    for (const w of ["sJev", "sEmo", "sRts", "sRdw", "sBench"]) expect(await V.windowBlindAny(w), w).toBe(true);
    expect(await V.windowBlindAny("sClean")).toBe(false);
    expect(await V.windowBlindAny("nope")).toBe(false);
    expect([...(await V.windowsBlindAny(["sJev", "sEmo", "sRts", "sRdw", "sBench", "sClean", "nope"]))].sort()).toEqual(["sBench", "sEmo", "sJev", "sRdw", "sRts"]);
  });
  it("the readers: a window held out only by its window-text or emotion row is refused by blindGuardWindow (before any content)", async () => {
    const { blindGuardWindow } = await import("@/lib/rubrics/readers/common");
    for (const w of ["sJev", "sEmo", "sRts", "sRdw"]) expect(await blindGuardWindow(w), w).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(await blindGuardWindow("sClean")).toBeNull();
  });
  it("consult_uid is NOT unique: a consult is refused if ANY row of its key or uid is on a held-out pair, whichever order the rows come in (consultPair, readConsultSpan, readPulseRecord); a unique clean uid is served", async () => {
    const C = await import("@/lib/rubrics/readers/common");
    const { readConsultSpan } = await import("@/lib/rubrics/readers/consult-span");
    const { readPulseRecord } = await import("@/lib/rubrics/readers/pulse-record");
    const REC = await import("@/lib/rubrics/evr/record");
    const queried: string[] = [];
    REC.setMetabaseForTests(async (q) => { queried.push(q); return []; });
    try {
      for (const key of ["u1_clean@m1", "u1_blind@m2", "u2_clean@m1", "u2_blind@m2", "k_dup_a", "k_dup_b"]) {
        expect(await readConsultSpan(key), key).toMatchObject({ ok: false, reason: "blind_room_day" });
        expect(await readPulseRecord(key), key).toMatchObject({ ok: false, reason: "blind_room_day" });
        expect(C.isRefusal(await C.consultPair(key)) ? "refused" : "pair", key).toBe("pair");
        const pair = await C.consultPair(key) as { room_id: string; ist_date: string };
        expect(`${pair.room_id}/${pair.ist_date}`, key).toBe(`${BR}/${BD}`); // the held-out pair is what comes back, so every caller's blindRefusal fires
      }
      expect(queried).toEqual([]); // the warehouse was never asked
      expect(await readConsultSpan("u3_clean@m1")).toMatchObject({ ok: true });
      expect(await C.blindPairOfUid("ConsultUid3AaaaaaaaaaaaaaZ")).toBeNull();
      expect(await C.blindPairOfUid(null)).toBeNull();
    } finally {
      REC.setMetabaseForTests(null);
    }
  });
  it("selectEvrWindows leaves out a consult whose uid has a held-out sibling row, in either order, and keeps the clean unique one", async () => {
    const { selectEvrWindows } = await import("@/lib/rubrics/evr/select");
    const keys = await selectEvrWindows(50, 1);
    expect(keys).toContain("u3_clean@m1");
    for (const k of ["u1_clean@m1", "u2_clean@m1"]) expect(keys, k).not.toContain(k);
  });
});

(HAVE ? describe : describe.skip)("B3 guardSessionSpan on real SQL: the session's day, the range's days (both midnight directions) and its windows' placements", () => {
  const dayStart = Date.parse(`${BD}T00:00:00+05:30`);
  const iso = (ms: number) => new Date(ms).toISOString();
  it("sessions: on the held-out day, ending into it, starting before it, a clean window-only session with a held-out window placement, and a clean session far away", async () => {
    const { guardSessionSpan } = await import("@/lib/voice-blind");
    pg.exec(`
      INSERT INTO bench_session (id, room_id, started_at, ended_at) VALUES
        ('bsOn', '${BR}', '${iso(dayStart + 3_600_000)}', '${iso(dayStart + 7_200_000)}'),
        ('bsBefore', '${BR}', '${iso(dayStart - 3_600_000)}', '${iso(dayStart - 1_800_000)}'),
        ('bsAfter', '${BR}', '${iso(dayStart + 86_400_000 + 600_000)}', '${iso(dayStart + 86_400_000 + 1_800_000)}'),
        ('bsWin', 'r1', '2026-10-05T04:00:00Z', '2026-10-05T05:00:00Z'),
        ('bsFar', 'r1', '2026-10-05T04:00:00Z', '2026-10-05T05:00:00Z'),
        ('bsOtherRoom', 'r1', '${iso(dayStart + 3_600_000)}', '${iso(dayStart + 7_200_000)}');
      INSERT INTO bench_window (id, session_id, room_day_id) VALUES ('bwWin', 'bsWin', 'rd_blind'), ('bwFar', 'bsFar', 'rd_clean');
      INSERT INTO bench_chunk (session_id, ended_at) VALUES ('bsBefore', '${iso(dayStart + 600_000)}');
    `);
    expect(await guardSessionSpan("bsOn")).toBe("blind_room_day");
    expect(await guardSessionSpan("bsWin")).toBe("blind_room_day"); // clean room and day; one of its windows is placed on a held-out room-day
    expect(await guardSessionSpan("bsBefore")).toBe("blind_room_day"); // started the evening before; its last CHUNK ends inside the held-out day
    expect(await guardSessionSpan("bsAfter")).toBe(null); // starts and ends the day after
    // a range on the clean session crossing midnight INTO the held-out day (forward), and one reaching BACK from the next day into it
    expect(await guardSessionSpan("bsAfter", { startMs: dayStart + 86_400_000 - 600_000, endMs: dayStart + 86_400_000 + 600_000 })).toBe("blind_room_day");
    expect(await guardSessionSpan("bsAfter", { startMs: dayStart - 600_000, endMs: dayStart + 86_400_000 + 600_000 })).toBe("blind_room_day");
    expect(await guardSessionSpan("bsAfter", { startMs: dayStart + 86_400_000 + 60_000, endMs: dayStart + 86_400_000 + 600_000 })).toBe(null);
    expect(await guardSessionSpan("bsOn", { startMs: dayStart + 86_400_000 + 60_000, endMs: dayStart + 86_400_000 + 600_000 })).toBe("blind_room_day"); // the range is on the next day, the SESSION began on the held-out one
    expect(await guardSessionSpan("bsFar")).toBe(null);
    expect(await guardSessionSpan("bsOtherRoom")).toBe(null); // same date, a room that is not held out on it
    expect(await guardSessionSpan("bs_unknown")).toBe(null);
  });
});
