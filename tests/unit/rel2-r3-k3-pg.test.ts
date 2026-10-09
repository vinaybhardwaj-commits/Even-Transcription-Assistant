/**
 * REL2-R3 K3 on a real postgres:16 with ALL migrations applied (the refuter's repro fixtures, seeded through the real CHECKs): K3-1 the Bench session tools, K3-2 the job doors, K3-3 scratch ids, K3-4 aggregates.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); }, { transaction: async () => [] }) }));
const R2 = vi.hoisted(() => ({ presign: 0, get: 0 }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => { R2.presign++; return "https://r2.example/x"; }, getObjectBytes: async () => { R2.get++; return new Uint8Array([1]); } }));
vi.mock("@/lib/cookie", async (orig) => ({ ...((await orig()) as object), readAdminCookie: async () => "admin-cookie" }));
vi.mock("@/lib/auth", async (orig) => ({ ...((await orig()) as object), verifyAdminJwt: async () => ({ sub: "admin" }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-rel2-r3-k3");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const ctx = { origin: "x", actor: "a", scopes: new Set(["read", "invoke", "write"]) } as never;
const call = async (name: string, args: Record<string, unknown>) => { const { CALLABLE_TOOLS } = await import("@/lib/mcp/surface"); return (await CALLABLE_TOOLS.get(name)!.handler({ ...args }, ctx)) as Record<string, any>; };

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  const files = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
});
afterAll(() => { if (HAVE) pg.stop(); });

const T = (ms: number) => new Date(ms).toISOString();
const dayStart = Date.parse(`${BD}T00:00:00+05:30`);
const CLEAN_DAY = "2026-10-05";

function seed(): void {
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('${BR}', 'blind-room', 'Blind Room', 'x'), ('r_clean', 'clean-room', 'Clean Room', 'x');
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_blind', '${BR}', '${BD}'), ('rd_clean', 'r_clean', '${CLEAN_DAY}');
    -- bs_blind: a session on the held-out pair with a chunk (the refuter's K3-1 repro); bs_clean: a clean session; bs_win: clean room and day, one window placed on the held-out room-day
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES
      ('bs_blind', '${BR}', '${T(dayStart + 3_600_000)}', '${T(dayStart + 7_200_000)}', 'ended'),
      ('bs_clean', 'r_clean', '${CLEAN_DAY}T04:00:00Z', '${CLEAN_DAY}T05:00:00Z', 'ended'),
      ('bs_win', 'r_clean', '${CLEAN_DAY}T06:00:00Z', '${CLEAN_DAY}T07:00:00Z', 'ended');
    INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state) VALUES
      ('bc_blind', 'bs_blind', 0, 'bench/k_blind', 'audio/webm', '${T(dayStart + 3_600_000)}', '${T(dayStart + 3_900_000)}', 300000, 1000, 'verified'),
      ('bc_clean', 'bs_clean', 0, 'bench/k_clean', 'audio/webm', '${CLEAN_DAY}T04:00:00Z', '${CLEAN_DAY}T04:05:00Z', 300000, 1000, 'verified'),
      ('bc_win', 'bs_win', 0, 'bench/k_win', 'audio/webm', '${CLEAN_DAY}T06:00:00Z', '${CLEAN_DAY}T06:05:00Z', 300000, 1000, 'verified');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES
      ('bw_blind', 'bs_blind', 'rd_blind', ${dayStart + 3_600_000}, ${dayStart + 4_500_000}, 'primary'),
      ('bw_win', 'bs_win', 'rd_blind', ${Date.parse(CLEAN_DAY + "T06:00:00Z")}, ${Date.parse(CLEAN_DAY + "T06:15:00Z")}, 'primary'),
      ('bw_clean', 'bs_clean', 'rd_clean', ${Date.parse(CLEAN_DAY + "T04:00:00Z")}, ${Date.parse(CLEAN_DAY + "T04:15:00Z")}, 'primary');
  `);
}

(HAVE ? describe : describe.skip)("K3-1 the Bench session tools on real SQL: a held-out session is not listed, reported, replayed, served or presigned", () => {
  beforeAll(() => { seed(); });
  it("scribe_list_sessions: by room + date the held-out session is absent and counted; the window-only session is excluded too; the clean one is listed; unfiltered lists only the clean one", async () => {
    const byPair = await call("scribe_list_sessions", { room_id: BR, ist_date: BD });
    expect(byPair.sessions).toEqual([]);
    expect(byPair.n_blind_excluded).toBe(1);
    const all = await call("scribe_list_sessions", {});
    expect(all.sessions.map((x: { id: string }) => x.id)).toEqual(["bs_clean"]);
    expect(all.n_blind_excluded).toBe(2); // bs_blind (its room and day) and bs_win (one window placed on a held-out room-day)
  });
  it("scribe_day_report: the held-out room + day is refused before any session read; a clean day lists its session; the window-only session is left out and counted", async () => {
    H.statements.length = 0;
    expect(await call("scribe_day_report", { room_id: BR, ist_date: BD })).toMatchObject({ sessions: [], error: "blind_room_day" });
    expect(H.statements.filter((t) => /FROM bench_session s/.test(t))).toEqual([]);
    const clean = await call("scribe_day_report", { room_id: "r_clean", ist_date: CLEAN_DAY, detail: "summary" });
    expect(clean.sessions.map((x: { session_id?: string; id?: string }) => x.session_id ?? x.id)).toEqual(["bs_clean"]);
    expect(clean.n_blind_excluded).toBe(1);
  });
  it("scribe_replay_session: refused with 0 event reads; scribe_get_session and scribe_get_recording (every mode, the refuter's repro): refused, 0 presigns", async () => {
    H.statements.length = 0; R2.presign = 0; R2.get = 0;
    expect(await call("scribe_replay_session", { session_id: "bs_blind" })).toMatchObject({ cues: [], error: "blind_room_day" });
    expect(await call("scribe_replay_session", { session_id: "bs_win" })).toMatchObject({ cues: [], error: "blind_room_day" });
    expect(H.statements.filter((t) => /FROM bench_event|FROM bench_chunk c WHERE|FROM bench_chunk\s+WHERE/.test(t) && !/FROM bench_session s WHERE/.test(t))).toEqual([]);
    for (const id of ["bs_blind", "bs_win"]) {
      expect(await call("scribe_get_session", { session_id: id }), id).toMatchObject({ session: null, error: "blind_room_day" });
      for (const mode of ["manifest", "timeline", "chunk", "zip"]) expect(await call("scribe_get_recording", { session_id: id, mode, chunk_idx: 0 }), `${id} ${mode}`).toMatchObject({ error: "blind_room_day" });
    }
    expect(R2).toEqual({ presign: 0, get: 0 });
    // the clean session is still served (the guard is not a blanket)
    expect(await call("scribe_get_session", { session_id: "bs_clean" })).toMatchObject({ session: { id: "bs_clean" } });
    expect((await call("scribe_get_recording", { session_id: "bs_clean", mode: "manifest" })).error).toBeUndefined();
    expect(R2.presign).toBeGreaterThan(0);
    expect(await call("scribe_replay_session", { session_id: "bs_clean" })).toMatchObject({ session_id: "bs_clean" });
  });
});

const sessionRow = (id: string, hourUtc: number) => `INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('${id}', 'r_clean', '${CLEAN_DAY}T0${hourUtc}:00:00Z', '${CLEAN_DAY}T0${hourUtc}:30:00Z', 'ended');`;
const winRow = (id: string, session: string, hourUtc: number) => `INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES ('${id}', '${session}', 'rd_clean', ${Date.parse(`${CLEAN_DAY}T0${hourUtc}:00:00Z`)}, ${Date.parse(`${CLEAN_DAY}T0${hourUtc}:10:00Z`)}, 'primary');`;

(HAVE ? describe : describe.skip)("B3-1 / B3-2 the session guard on real SQL: every placement of every window; the whole session span, whatever the range", () => {
  beforeAll(() => {
    pg.exec(`
      ${sessionRow("bs_rts", 1)} ${winRow("bw_rts", "bs_rts", 1)}
      ${sessionRow("bs_txt", 2)} ${winRow("bw_txt", "bs_txt", 2)}
      ${sessionRow("bs_emo", 3)} ${winRow("bw_emo", "bs_emo", 3)}
      INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, speaker_idx, no_role_reason) VALUES ('bw_rts', 't1', 'rd_blind', 0, 'no_match');
      INSERT INTO jev_window_text (window_id, room_day_id, source, char_count) VALUES ('bw_txt', 'rd_blind', 'run_english', 0);
      INSERT INTO room_span_emotion (window_id, room_day_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms, speaker_idx, source_refs, clip_start_s, clip_end_s, state, reason) VALUES ('bw_emo', 'rd_blind', 'dr1', 0, 1000, 0, 1, 0, 1000, 0, '{}', 0, 1, 'skipped', 'too_short');
    `);
  });
  it("B3-1: a session whose window is held out ONLY by its turn rows, its window text or its emotion rows is refused (the guard, the listing and the tools)", async () => {
    const { guardSessionSpan, sessionsBlindAny } = await import("@/lib/room-access/check");
    for (const id of ["bs_rts", "bs_txt", "bs_emo"]) {
      expect(await guardSessionSpan(id), id).toBe("blind_room_day");
      expect(await call("scribe_get_session", { session_id: id }), id).toMatchObject({ error: "blind_room_day" });
    }
    expect([...(await sessionsBlindAny(["bs_rts", "bs_txt", "bs_emo", "bs_clean"]))].sort()).toEqual(["bs_emo", "bs_rts", "bs_txt"]);
  });
  it("B3-2: a session whose span touches a held-out IST day is refused WHATEVER the range (even one entirely on a clean day); a range reaching out of a clean session into the day is refused too", async () => {
    const { guardSessionSpan } = await import("@/lib/room-access/check");
    const dayEnd = dayStart + 86_400_000;
    // bs_before started the evening before and its last chunk ends inside the held-out day (see the guard test above)
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('bs_span', '${BR}', '${T(dayStart - 3_600_000)}', '${T(dayStart - 1_800_000)}', 'ended');
             INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state) VALUES ('bc_span', 'bs_span', 0, 'bench/k_span', 'audio/webm', '${T(dayStart - 3_600_000)}', '${T(dayStart + 600_000)}', 300000, 1000, 'verified');`);
    expect(await guardSessionSpan("bs_span", { startMs: dayStart - 3_500_000, endMs: dayStart - 3_000_000 })).toBe("blind_room_day"); // the range is the clean evening hour; the session's span is not
    expect(await guardSessionSpan("bs_span")).toBe("blind_room_day");
    expect(await guardSessionSpan("bs_clean", { startMs: dayEnd - 60_000, endMs: dayEnd + 60_000 })).toBe(null); // other room: nothing held out
    expect(await call("scribe_extract_audio", { session_id: "bs_span", start: T(dayStart - 3_500_000), end: T(dayStart - 3_000_000) })).toMatchObject({ error: "blind_room_day" });
    expect(await call("scribe_transcribe_range", { session_id: "bs_span", start: T(dayStart - 3_500_000), end: T(dayStart - 3_000_000), dry_run: true })).toMatchObject({ error: "blind_room_day" });
  });
});

const jobCount = async () => Number(((await H.sql!`SELECT count(*)::int AS n FROM scribe_job` as Array<{ n: number }>)[0]!.n));

(HAVE ? describe : describe.skip)("K3-2 the job doors: refused at submit with NO row; a job inserted directly fails at its first step with zero reads", () => {
  beforeAll(() => {
    pg.exec(`
      ${sessionRow("bs_rdw", 5)} ${sessionRow("bs_ok", 6)}
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES ('bw_rdw', 'bs_rdw', 'rd_clean', ${Date.parse(CLEAN_DAY + "T04:20:00Z")}, ${Date.parse(CLEAN_DAY + "T04:30:00Z")}, 'primary');
      INSERT INTO room_diarize_window (window_id, room_day_id, state) VALUES ('bw_rdw', 'rd_blind', 'ok');
    `);
  });
  it("the refuter's three queued repros: transcribe_range on the held-out session, diarize_window on wRdw, jev_window_run on the held-out room-day: all refused, 0 rows", async () => {
    const n0 = await jobCount();
    expect(await call("scribe_job_submit", { kind: "transcribe_range", args: { session_id: "bs_blind", start: T(dayStart + 3_600_000), end: T(dayStart + 3_900_000) } })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await call("scribe_job_submit", { kind: "diarize_window", args: { window_id: "bw_rdw" } })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await call("scribe_jev_window_run", { room_day_id: "rd_blind" })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await jobCount()).toBe(n0);
  });
  it("B3-3: async:true on scribe_transcribe_range and scribe_extract_audio for a held-out session is refused IN THE CALL, no job row", async () => {
    const n0 = await jobCount();
    const a = { session_id: "bs_blind", start: T(dayStart + 3_600_000), end: T(dayStart + 3_900_000), async: true };
    expect(await call("scribe_transcribe_range", a)).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await call("scribe_extract_audio", a)).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await jobCount()).toBe(n0);
  });
  it("every other room kind refuses its held-out input at submit: stitch, room_window, emotion_window, jev_english, jev_role, route_transcribe (bench key and clips key), day_manifest; and a clean one is queued", async () => {
    const n0 = await jobCount();
    const win = { session_id: "bs_blind", start: T(dayStart + 3_600_000), end: T(dayStart + 3_900_000) };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["stitch", win], ["room_window", { window_id: "bw_rdw", origin: "x", actor: "a", via: "mcp" }], ["emotion_window", { window_id: "bw_blind" }],
      ["jev_english", { room_day_id: "rd_blind" }], ["jev_role", { room_day_id: "rd_blind" }], ["jev_window", { room_day_id: "rd_blind" }],
      ["route_transcribe", { clip_key: `bench/blind-room/${BD}/bs_blind/chunk_00000.webm` }], ["route_transcribe", { clip_key: "clips/bs_blind/1-2-primary.webm" }],
      ["day_manifest", { room: "blind-room", ist_date: BD }], ["audio_measure", { clip_key: "clips/bs_win/1-2-primary.webm" }],
    ];
    for (const [kind, args] of cases) expect(await call("scribe_job_submit", { kind, args }), kind).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await jobCount()).toBe(n0);
    const ok = await call("scribe_job_submit", { kind: "stitch", args: { session_id: "bs_ok", start: T(Date.parse(CLEAN_DAY + "T06:00:00Z")), end: T(Date.parse(CLEAN_DAY + "T06:05:00Z")) } });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(await jobCount()).toBe(n0 + 1);
  });
  it("a job inserted straight into scribe_job (past submit) fails at its FIRST step: blind_room_day, failed, 0 reads of room data, 0 R2 reads", async () => {
    const { readJob } = await import("@/lib/jobs/store");
    const { runOneStep } = await import("@/lib/jobs/runner");
    for (const [id, kind, args] of [["job_direct_1", "diarize_window", { window_id: "bw_rdw" }], ["job_direct_2", "transcribe_range", { session_id: "bs_blind", start: dayStart + 3_600_000, end: dayStart + 3_900_000, source: "primary" }], ["job_direct_3", "jev_window", { room_day_id: "rd_blind", force: false, prompt_version: "v" }]] as const) {
      pg.exec(`INSERT INTO scribe_job (id, kind, args, actor, status, lease_owner, lease_until) VALUES ('${id}', '${kind}', '${JSON.stringify(args)}'::jsonb, 'test', 'running', 'r1', now() + interval '4 minutes');`);
      H.statements.length = 0; R2.get = 0; R2.presign = 0;
      const job = (await readJob(id))!;
      const rep = await runOneStep(job, "r1");
      expect(rep.outcome, id).toBe("failed");
      expect(await readJob(id), id).toMatchObject({ status: "failed", error: expect.stringContaining("blind_room_day") });
      expect(H.statements.filter((t) => /FROM (cue|transcription_run|jev_window_signal|bench_event)|INSERT INTO (room_|jev_|cue|transcription)/.test(t)), id).toEqual([]);
      expect(R2).toEqual({ presign: 0, get: 0 });
    }
  });
  it("scribe_clinical_route_replay on the held-out room-day: blind_room_day, no window text read", async () => {
    H.statements.length = 0;
    expect(await call("scribe_clinical_route_replay", { room_day_id: "rd_blind" })).toMatchObject({ ran: false, error: "blind_room_day" });
    expect(H.statements.filter((t) => /FROM jev_window_text jt|jev_window_text WHERE room_day_id|FROM bench_window WHERE room_day_id/.test(t))).toEqual([]);
  });
});

(HAVE ? describe : describe.skip)("K3-3 scribe_replay_write refuses to copy a held-out session into scratch", () => {
  it("an ENDED held-out session (and one with a held-out window placement): blind_room_day, 0 events read, no scratch graph; a clean ended session gets past the guard", async () => {
    H.statements.length = 0;
    for (const id of ["bs_blind", "bs_win"]) {
      expect(await call("scribe_replay_write", { session_id: id }), id).toMatchObject({ ok: false, error: "blind_room_day", written: 0 });
    }
    expect(H.statements.filter((t) => /FROM bench_event/.test(t))).toEqual([]);
    expect((await call("scribe_replay_write", { session_id: "bs_ok" })).error).not.toBe("blind_room_day");
  });
});


(HAVE ? describe : describe.skip)("K3-4 aggregates (route_tripwires, diarize_spend) exclude held-out rows and report n_blind_excluded", () => {
  beforeAll(() => {
    pg.exec(`
      INSERT INTO transcription_run (id, subject_type, subject_id, engine, mode, tier, transcript_original, metrics_json) VALUES
        ('tr_clean', 'bench_window', 'bw_clean', 'route', 'batch', 'asr', 'hello', '{"audio_seconds": 10}'),
        ('tr_blind', 'bench_window', 'bw_blind', 'route', 'batch', 'asr', 'held out words', '{"audio_seconds": 20}'),
        ('tr_rts', 'bench_window', 'bw_rts', 'route', 'batch', 'asr', 'held out by turn rows', '{"audio_seconds": 30}');
      INSERT INTO diarize_window_label (id, window_id, room_day_id, engine, run_id, segments_json, speaker_count, segment_count, audio_seconds) VALUES
        ('dl_clean', 'bw_clean', 'rd_clean', 'local', 'r1', '[]', 1, 1, 100),
        ('dl_blind', 'bw_blind', 'rd_blind', 'local', 'r2', '[]', 1, 1, 200),
        ('dl_day', 'bw_clean', 'rd_blind', 'local', 'r3', '[]', 1, 1, 400),
        ('dl_rts', 'bw_rts', 'rd_clean', 'local', 'r4', '[]', 1, 1, 800);
    `);
  });
  it("scribe_route_tripwires counts only the clean run (3 runs, 2 held out), and says how many were left out", async () => {
    const out = await call("scribe_route_tripwires", { days: 30 });
    expect(out.n_blind_excluded).toBe(2);
    const route = out.engines.find((e: { engine: string }) => e.engine === "route");
    expect(route).toMatchObject({ runs: 1, chars: 5, audio_seconds: 10 });
  });
  it("scribe_diarize_spend counts only the clean label (4 labels: the window, the label's own room-day, and the turn-row placement are held out)", async () => {
    const out = await call("scribe_diarize_spend", { days: 30 });
    expect(out.n_blind_excluded).toBe(3);
    expect(out.totals.windows_labelled).toBe(1);
    expect(out.days.reduce((n: number, r: { windows: number }) => n + r.windows, 0)).toBe(1);
  });
});

(HAVE ? describe : describe.skip)("K4-1 key-taking jobs: an ALLOWLIST of audio key prefixes, each mapped to its placement; an unknown prefix is refused", () => {
  it("the refuter's repro: vad-trim/<window>/<run>.wav for a window held out only by its turn rows is refused for route_transcribe, audio_measure and stt_fanout, with NO row", async () => {
    const n0 = await jobCount();
    for (const win of ["bw_rts", "bw_txt", "bw_emo", "bw_rdw", "bw_blind"]) {
      for (const [kind, extra] of [["route_transcribe", {}], ["audio_measure", {}], ["stt_fanout", { engines: ["whisper"] }]] as const) {
        expect(await call("scribe_job_submit", { kind, args: { clip_key: `vad-trim/${win}/run1.wav`, ...extra } }), `${kind} ${win}`).toMatchObject({ ok: false, error: "blind_room_day" });
      }
    }
    expect(await jobCount()).toBe(n0);
  });
  it("a clean window's vad-trim key, an encounter key and a whisper-buffer key are queued; an unknown window, an unknown prefix, a traversal and a malformed key are refused window_unplaced", async () => {
    expect(await call("scribe_job_submit", { kind: "route_transcribe", args: { clip_key: "vad-trim/bw_ok_win/run1.wav" } })).toMatchObject({ ok: false, error: "window_unplaced" }); // no such window
    pg.exec(`${sessionRow("bs_k4", 7)} ${winRow("bw_k4", "bs_k4", 7)}`);
    expect(await call("scribe_job_submit", { kind: "route_transcribe", args: { clip_key: "vad-trim/bw_k4/run1.wav" } })).toMatchObject({ ok: true });
    expect(await call("scribe_job_submit", { kind: "audio_measure", args: { clip_key: "encounters/enc_abc.webm" } })).toMatchObject({ ok: true });
    expect(await call("scribe_job_submit", { kind: "audio_measure", args: { clip_key: "whisper-buffer/enc_abc.webm" } })).toMatchObject({ ok: true });
    const n0 = await jobCount();
    for (const key of ["voice-samples/doc/x.webm", "mcp-sarvam/job_1.json", "rubric/a/1.0.0/x.json", "consult-clips/2026-10-08/r/uid/consult.flac", "foo.webm", "bench/../x", "/vad-trim/bw_k4/r.wav", "vad-trim/bw_k4", "clips/bs_k4", "bench/blind-room/x", "encounters/a/b.webm"]) {
      expect(await call("scribe_job_submit", { kind: "route_transcribe", args: { clip_key: key } }), key).toMatchObject({ ok: false, error: "window_unplaced" });
    }
    expect(await jobCount()).toBe(n0);
  });
});

(HAVE ? describe : describe.skip)("K4-2 room-day jobs leave out windows held out by ANOTHER placement, counted (the refuter's repro: a clean room-day, one window with held-out turn rows)", () => {
  beforeAll(() => {
    pg.exec(`
      INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_k4', 'r_clean', '2026-10-06');
      ${sessionRow("bs_k4b", 4)}
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES
        ('bw_k4ok', 'bs_k4b', 'rd_k4', ${Date.parse("2026-10-05T04:00:00Z")}, ${Date.parse("2026-10-05T04:10:00Z")}, 'primary'),
        ('bw_k4rts', 'bs_k4b', 'rd_k4', ${Date.parse("2026-10-05T04:10:00Z")}, ${Date.parse("2026-10-05T04:20:00Z")}, 'primary');
      INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, speaker_idx, no_role_reason) VALUES ('bw_k4rts', 't1', 'rd_blind', 0, 'no_match');
      INSERT INTO room_diarize_window (window_id, room_day_id, state) VALUES ('bw_k4ok', 'rd_k4', 'ok'), ('bw_k4rts', 'rd_k4', 'ok');
    `);
  });
  const stepCtx = (step: string, args: Record<string, unknown>, progress: Record<string, unknown> = {}) => ({ job: { id: "job_k4", actor: "t", created_at: "2026-10-09T00:00:00Z" }, step, args, progress }) as never;

  it("jev_english: the blind window gets no jev_window_text row, the clean one does; n_blind_excluded 1", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const out = await KIND_BY_NAME.get("jev_english")!.run(stepCtx("classify", { room_day_id: "rd_k4", force: true }));
    expect(out).toMatchObject({ kind: "done", result: { windows: 1, n_blind_excluded: 1 } });
    const text = (await H.sql!`SELECT window_id FROM jev_window_text WHERE room_day_id = 'rd_k4' ORDER BY window_id` as Array<{ window_id: string }>).map((r) => r.window_id);
    expect(text).toEqual(["bw_k4ok"]);
  });
  it("jev_window: skip rows / signals only for the clean window; n_blind_excluded 1", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const out = await KIND_BY_NAME.get("jev_window")!.run(stepCtx("collect", { room_day_id: "rd_k4", force: true, prompt_version: "v" }));
    expect(out).toMatchObject({ kind: "done", result: { windows_total: 1, n_blind_excluded: 1 } });
    expect(((await H.sql!`SELECT window_id FROM jev_window_signal WHERE room_day_id = ${"rd_k4"}::text` as Array<{ window_id: string }>).map((r) => r.window_id))).not.toContain("bw_k4rts");
  });
  it("jev_role: the blind window is not processed; n_blind_excluded 1", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const out = await KIND_BY_NAME.get("jev_role")!.run(stepCtx("run", { room_day_id: "rd_k4", force: true, prompt_version: "v" }));
    expect(out).toMatchObject({ kind: "done", result: { windows_total: 1, n_blind_excluded: 1 } });
  });
  it("clinical_route_replay: the blind window's text is not classified or sent (the flag on, the model call spied)", async () => {
    pg.exec(`INSERT INTO jev_window_text (window_id, room_day_id, source, char_count, english) VALUES ('bw_k4rts', 'rd_k4', 'run_english', 5, 'held out words') ON CONFLICT (window_id) DO UPDATE SET english = 'held out words', room_day_id = 'rd_k4'`);
    process.env.JEV_CLINICAL_ROUTE = "true";
    const { runClinicalRouteAsync } = await import("@/lib/jev/clinical-route");
    const jev = await import("@/lib/jev/ask");
    const spy = vi.spyOn(jev, "askJev").mockResolvedValue({ results: {} } as never);
    const out = await runClinicalRouteAsync("rd_k4").catch((e) => ({ err: String(e) }));
    spy.mockRestore();
    delete process.env.JEV_CLINICAL_ROUTE;
    expect(JSON.stringify(out)).toContain("\"nBlindExcluded\":1");
    for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain("held out words");
  });
});

(HAVE ? describe : describe.skip)("K4-3 the runner re-checks the held-out rule at EVERY step start", () => {
  it("jobs inserted at a LATER step (diarize_window at local_label on a held-out window, stitch at join on a held-out session) fail blind_room_day with 0 room reads and 0 R2 reads", async () => {
    const { readJob } = await import("@/lib/jobs/store");
    const { runOneStep } = await import("@/lib/jobs/runner");
    const cases = [
      ["job_late_1", "diarize_window", "local_label", { window_id: "bw_rdw" }, {}],
      ["job_late_2", "stitch", "join", { session_id: "bs_blind", start: dayStart + 3_600_000, end: dayStart + 3_900_000, source: "primary", format: "webm" }, { pieces: [{ start: dayStart + 3_600_000, end: dayStart + 3_900_000 }], done: [], total_ms: 300000 }],
      ["job_late_3", "emotion_window", "score", { window_id: "bw_blind" }, { window_id: "bw_blind" }],
    ] as const;
    for (const [id, kind, step, args, progress] of cases) {
      pg.exec(`INSERT INTO scribe_job (id, kind, args, progress, step, actor, status, lease_owner, lease_until) VALUES ('${id}', '${kind}', '${JSON.stringify(args)}'::jsonb, '${JSON.stringify(progress)}'::jsonb, '${step}', 'test', 'running', 'r1', now() + interval '4 minutes');`);
      H.statements.length = 0; R2.get = 0; R2.presign = 0;
      const rep = await runOneStep((await readJob(id))!, "r1");
      expect(rep.outcome, id).toBe("failed");
      expect(await readJob(id), id).toMatchObject({ status: "failed", error: expect.stringContaining("blind_room_day") });
      expect(H.statements.filter((t) => /FROM (cue|transcription_run|jev_window_signal|bench_event)|INSERT INTO (room_|jev_|cue|transcription)|FROM bench_chunk\s+WHERE/.test(t)), id).toEqual([]);
      expect(R2).toEqual({ presign: 0, get: 0 });
    }
  });
});

(HAVE ? describe : describe.skip)("K4-4 scribe_silence_readjudicate: a held-out room-day is refused; held-out windows are left out of the preview and the apply, counted", () => {
  const SILENT = "silent";
  beforeAll(() => {
    pg.exec(`
      ${sessionRow("bs_sil", 5)}
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, state) VALUES
        ('bw_sil_ok', 'bs_sil', 'rd_clean', ${Date.parse("2026-10-05T05:00:00Z")}, ${Date.parse("2026-10-05T05:10:00Z")}, 'primary', '${SILENT}'),
        ('bw_sil_rts', 'bs_sil', 'rd_clean', ${Date.parse("2026-10-05T05:10:00Z")}, ${Date.parse("2026-10-05T05:20:00Z")}, 'primary', '${SILENT}'),
        ('bw_sil_day', 'bs_sil', 'rd_blind', ${Date.parse("2026-10-05T05:20:00Z")}, ${Date.parse("2026-10-05T05:30:00Z")}, 'primary', '${SILENT}');
      INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, speaker_idx, no_role_reason) VALUES ('bw_sil_rts', 't1', 'rd_blind', 0, 'no_match');
    `);
  });
  const stateOf = async (id: string) => ((await H.sql!`SELECT state FROM bench_window WHERE id = ${id}::text` as Array<{ state: string }>)[0]!.state);
  it("the dry run: a held-out room-day is blind_room_day; the unscoped preview counts only the clean window and says how many were left out", async () => {
    expect(await call("scribe_silence_readjudicate", { room_day_id: "rd_blind" })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await call("scribe_silence_readjudicate", { room_day_id: "rd_blind", apply: true, detector: "d1", reason: "r", as_of: new Date().toISOString() })).toMatchObject({ ok: false, error: "blind_room_day" });
    const out = await call("scribe_silence_readjudicate", {});
    expect(out).toMatchObject({ ok: true, n_blind_excluded: 2 });
    expect(out.would.eligible.total).toBe(1);
    expect(out.would.would?.windows ?? out.would.windows).toBe(1);
  });
  it("the apply moves only the clean window; both held-out windows stay silent", async () => {
    const dry = await call("scribe_silence_readjudicate", {});
    const out = await call("scribe_silence_readjudicate", { apply: true, all_rooms: true, detector: "d1", reason: "k4", as_of: dry.would.as_of });
    expect(out).toMatchObject({ ok: true, reopened: 1, n_blind_excluded: 2 });
    expect(out.window_ids).toEqual(["bw_sil_ok"]);
    expect(await stateOf("bw_sil_ok")).toBe("closed");
    expect(await stateOf("bw_sil_rts")).toBe(SILENT);
    expect(await stateOf("bw_sil_day")).toBe(SILENT);
  });
});

(HAVE ? describe : describe.skip)("REL2-R4 G1 /api/diarize-segments + scribe_diarize_segments, G2 the encounter shadow evidence: the full any-placement set", () => {
  const seg = async (q: Record<string, unknown>) => { const { lookupSegments } = await import("@/lib/diarize-segments"); return lookupSegments(q as never); };
  it("G1 window path: a window held out ONLY via its turn rows (bw_k4rts) is 403 blind_room_day from the lookup, the tool and the bearer route's shared function; a clean window is served", async () => {
    expect(await seg({ window_id: "bw_k4rts" })).toMatchObject({ ok: false, status: 403, error: "blind_room_day" });
    expect(await call("scribe_diarize_segments", { window_id: "bw_k4rts" })).toMatchObject({ error: "blind_room_day" });
    expect(await seg({ window_id: "bw_k4ok" })).toMatchObject({ ok: true });
  });
  it("G1 session path: a session scribe_get_session refuses whole (bs_k4b holds the turn-row window) refuses ALL its windows, bw_k4ok included, and the clean session lists", async () => {
    expect(await call("scribe_get_session", { session_id: "bs_k4b" })).toMatchObject({ error: "blind_room_day" });
    expect(await seg({ session_id: "bs_k4b" })).toMatchObject({ ok: false, status: 403, error: "blind_room_day" });
    expect(await call("scribe_diarize_segments", { session_id: "bs_k4b" })).toMatchObject({ error: "blind_room_day" });
    expect((await seg({ session_id: "bs_rdw" })).ok).toBe(false); // held out by the diarize row
  });
  it("G1 nemotron path: the shadow store is refused for the turn-row window before it is read", async () => {
    process.env.DIARIZE_NEMOTRON_SHADOW = "on";
    try {
      expect(await seg({ window_id: "bw_k4rts", engine: "nemotron" })).toMatchObject({ ok: false, status: 403, error: "blind_room_day" });
    } finally { delete process.env.DIARIZE_NEMOTRON_SHADOW; }
  });
  it("G2: a clean day with 3 transcribed windows, 2 held out by ANOTHER placement (turn rows; window text on the held-out day) -> loadDayEvidence uses only 1 and counts 2", async () => {
    pg.exec(`
      INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_g2', 'r_clean', '2026-10-07');
      ${sessionRow("bs_g2", 3)}
      INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state) VALUES ('bc_g2', 'bs_g2', 0, 'bench/g2', 'audio/webm', '${CLEAN_DAY}T03:00:00Z', '${CLEAN_DAY}T03:30:00Z', 1800000, 1000, 'verified');
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES
        ('bw_g2a', 'bs_g2', 'rd_g2', ${Date.parse(CLEAN_DAY + "T03:00:00Z")}, ${Date.parse(CLEAN_DAY + "T03:10:00Z")}, 'primary'),
        ('bw_g2b', 'bs_g2', 'rd_g2', ${Date.parse(CLEAN_DAY + "T03:10:00Z")}, ${Date.parse(CLEAN_DAY + "T03:20:00Z")}, 'primary'),
        ('bw_g2c', 'bs_g2', 'rd_g2', ${Date.parse(CLEAN_DAY + "T03:20:00Z")}, ${Date.parse(CLEAN_DAY + "T03:30:00Z")}, 'primary');
      INSERT INTO transcription_run (id, subject_type, subject_id, engine, mode, tier, transcript_original) VALUES
        ('tr_g2a', 'bench_window', 'bw_g2a', 'whisper', 'batch', 'asr', 'ok words'), ('tr_g2b', 'bench_window', 'bw_g2b', 'whisper', 'batch', 'asr', 'held out words b'), ('tr_g2c', 'bench_window', 'bw_g2c', 'whisper', 'batch', 'asr', 'held out words c');
      INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, speaker_idx, no_role_reason) VALUES ('bw_g2b', 't1', 'rd_blind', 0, 'no_match');
      INSERT INTO jev_window_text (window_id, room_day_id, source, char_count) VALUES ('bw_g2c', 'rd_blind', 'run_english', 3);
    `);
    const { loadDayEvidence } = await import("@/lib/encounter-clock/shadow-io");
    const ev = await loadDayEvidence("r_clean", "rd_g2", "2026-10-07", new Date("2026-10-09T00:00:00Z"));
    expect(ev).not.toBeNull();
    expect(ev!.windows).toHaveLength(1);
    expect(ev!.windows[0]!.text).toBe("ok words");
    expect(ev!.n_blind_excluded).toBe(2);
  });
});

(HAVE ? describe : describe.skip)("GUARD — the readers that used to carry their own SQL (REB index route, store stats, rooms, the admin STT-lab / drain / calibration / windows routes) now refuse or exclude held-out targets through lib/room-access", () => {
  beforeAll(() => {
    pg.exec(`
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) VALUES
        ('w_ok', '${CLEAN_DAY}', 'r_clean', 'stt', 'e', 'v1', 'c1', 'ok', 'k1', 'aa'), ('w_blind', '${BD}', '${BR}', 'stt', 'e', 'v1', 'c2', 'ok', 'k2', 'bb');
    `);
  });
  it("the bearer route GET /api/reb/index (it had NO held-out filter) lists only the clean row", async () => {
    const { rebIndexRows } = await import("@/lib/room-access/tool-reads");
    const rows = await rebIndexRows({ cursor: 0, windowId: null, day: null, layer: null, engine: null, roomId: null, withShadow: true, limit: 50 });
    expect(rows.map((r) => r.window_id)).toEqual(["w_ok"]);
    const byDay = await rebIndexRows({ cursor: 0, windowId: null, day: BD, layer: null, engine: null, roomId: BR, withShadow: true, limit: 50 });
    expect(byDay).toEqual([]);
  });
  it("scribe_store_stats leaves held-out sessions out of the totals and says how many; scribe_list_rooms never shows a held-out session as a room's last", async () => {
    const out = await call("scribe_store_stats", {});
    expect(out.bench.n_blind_excluded).toBeGreaterThanOrEqual(2);
    const { benchSessionTotals } = await import("@/lib/room-access/tool-reads");
    const t = await benchSessionTotals();
    const all = Number(((await H.sql!`SELECT count(*)::int AS n FROM bench_session` as Array<{ n: number }>)[0]!.n));
    expect(t.total + t.nBlindExcluded).toBe(all);
    const rooms = await call("scribe_list_rooms", {});
    const blindRoom = (rooms.rooms as Array<{ id: string; last_session_at: string | null }>).find((r) => r.id === BR);
    expect(blindRoom?.last_session_at ?? null).toBe(null); // its only sessions are held out
  });
  it("the admin routes' reads: a held-out session / window is refused; a clean one is served", async () => {
    const R = await import("@/lib/room-access/tool-reads");
    for (const id of ["bs_blind", "bs_win", "bs_rts"]) {
      expect(await R.adminSessionWindows(id), id).toEqual({ error: "blind_room_day" });
      expect(await R.adminDiarizeAnswers(id), id).toEqual({ error: "blind_room_day" });
      expect(await R.adminDrainRows(id), id).toEqual({ error: "blind_room_day" });
    }
    expect(await R.adminWindowRow("bw_rts")).toEqual({ error: "blind_room_day" });
    expect(await R.adminWindowRow("bw_blind")).toEqual({ error: "blind_room_day" });
    expect("rows" in (await R.adminSessionWindows("bs_ok"))).toBe(true);
    expect("rows" in (await R.adminWindowRow("bw_ok_none"))).toBe(true);
    const pending = await R.measurePendingCount();
    expect(pending).toBeGreaterThanOrEqual(0);
  });
});

(HAVE ? describe : describe.skip)("GUARD-3 G-2: the admin bench-session GETs and the encounter-windows read go through lib/room-access with the held-out rule", () => {
  it("GET /api/bench/sessions?room_id=<held-out>&ist_date=<held-out day> lists nothing and counts; the unfiltered list leaves the held-out sessions out", async () => {
    const { GET } = await import("@/app/api/bench/sessions/route");
    const { NextRequest } = await import("next/server");
    const get = async (qs: string) => (await (await GET(new NextRequest(`http://x/api/bench/sessions${qs}`))).json()) as { data?: Record<string, any>; sessions?: any[]; n_blind_excluded?: number };
    const one = await get(`?room_id=${BR}&ist_date=${BD}`);
    const body = (one.data ?? one) as { sessions: Array<{ id: string }>; n_blind_excluded: number };
    expect(body.sessions).toEqual([]);
    expect(body.n_blind_excluded).toBeGreaterThanOrEqual(1);
    const all = ((await get("")).data ?? (await get(""))) as { sessions: Array<{ id: string }> };
    for (const bad of ["bs_blind", "bs_win", "bs_rts", "bs_span"]) expect(all.sessions.map((x) => x.id), bad).not.toContain(bad);
  });
  it("GET /api/bench/sessions/<held-out id> is 403 blind_room_day (chunks, events and marks are not read); a clean session is 200", async () => {
    const { GET } = await import("@/app/api/bench/sessions/[id]/route");
    const { NextRequest } = await import("next/server");
    const get = (id: string) => GET(new NextRequest(`http://x/api/bench/sessions/${id}`), { params: Promise.resolve({ id }) });
    H.statements.length = 0;
    for (const id of ["bs_blind", "bs_win", "bs_rts"]) expect((await get(id)).status, id).toBe(403);
    expect(H.statements.filter((t) => /FROM bench_chunk\s+WHERE|FROM bench_event/.test(t) && !/FROM bench_session s WHERE/.test(t))).toEqual([]);
    expect((await get("bs_ok")).status).toBe(200);
  });
  it("queryWindows (GET /api/encounter-windows, the clock anchors): a consult window opened or closed on a held-out (room, IST day) is never returned", async () => {
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version) VALUES
        ('cw_ok', 'm1', 'r_clean', 'none', '${CLEAN_DAY}T04:00:00Z', '${CLEAN_DAY}T04:20:00Z', 'endConsult', 'clean', 'v1'),
        ('cw_open', 'm1', '${BR}', 'none', '${T(dayStart + 3_600_000)}', '${T(dayStart + 4_000_000)}', 'endConsult', 'clean', 'v1'),
        ('cw_cross', 'm1', '${BR}', 'none', '${T(dayStart - 600_000)}', '${T(dayStart + 600_000)}', 'endConsult', 'clean', 'v1'),
        ('cw_other_room', 'm1', 'r_clean', 'none', '${T(dayStart + 3_600_000)}', '${T(dayStart + 4_000_000)}', 'endConsult', 'clean', 'v1');
    `);
    const { queryWindows } = await import("@/lib/encounter-windows");
    const { sql } = await import("@/lib/db");
    const rows = await queryWindows(sql as never, { from: T(dayStart - 86_400_000), to: T(Date.parse(CLEAN_DAY) + 2 * 86_400_000), limit: 100 });
    expect(rows.map((r) => r.consult_key).sort()).toEqual(["cw_other_room", "cw_ok"].sort());
    expect((await queryWindows(sql as never, { room_id: BR, limit: 100 })).map((r) => r.consult_key)).toEqual([]);
  });
});

(HAVE ? describe : describe.skip)("GUARD-3 G-3: getRoomDayTape and listRoomDays run the held-out check", () => {
  it("GET /api/admin/rooms/<held-out room>/days/<held-out day> is 403 blind_room_day (it was 200 with the tape); the lookup throws BlindRoomDayError", async () => {
    const { getRoomDayTape } = await import("@/lib/room-access/room-day-admin");
    const { BlindRoomDayError } = await import("@/lib/rubrics/blind-room-days");
    await expect(getRoomDayTape(BR, BD)).rejects.toBeInstanceOf(BlindRoomDayError);
    const { GET } = await import("@/app/api/admin/rooms/[roomId]/days/[date]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ roomId: BR, date: BD }) });
    expect(res.status).toBe(403);
    // the day after (clean) is not refused by the day rule
    const next = new Date(Date.parse(`${BD}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const ok = await GET(new Request("http://x"), { params: Promise.resolve({ roomId: BR, date: next }) });
    expect(ok.status).not.toBe(403);
  });
  it("a clean room's tape leaves out the held-out sessions and windows of that day (turn rows, text, emotion, diarize)", async () => {
    const { getRoomDayTape } = await import("@/lib/room-access/room-day-admin");
    const tape = await getRoomDayTape("r_clean", CLEAN_DAY);
    const text = JSON.stringify(tape);
    for (const bad of ["bs_win", "bs_rts", "bs_txt", "bs_emo", "bs_rdw", "bw_win", "bw_rts", "bw_txt", "bw_emo", "bw_rdw"]) expect(text, bad).not.toContain(bad);
    expect(text).toContain("bs_clean");
  });
  it("the day BEFORE a held-out day: a session that runs into the held-out day is not part of that day's tape", async () => {
    const { getRoomDayTape } = await import("@/lib/room-access/room-day-admin");
    const prev = new Date(Date.parse(`${BD}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const tape = await getRoomDayTape(BR, prev);
    expect(JSON.stringify(tape)).not.toContain("bs_span");
  });
  it("listRoomDays: a held-out (room, day) is not listed; a clean day's counts leave held-out windows out", async () => {
    const { listRoomDays } = await import("@/lib/room-access/room-day-admin");
    const blindRoom = await listRoomDays(BR);
    expect(blindRoom.map((r) => r.ist_date)).not.toContain(BD);
    const clean = (await listRoomDays("r_clean")).find((r) => r.ist_date === CLEAN_DAY)!;
    const rows = (await H.sql!`SELECT w.id, s.id AS sid FROM bench_window w JOIN bench_session s ON s.id = w.session_id WHERE s.room_id = 'r_clean' AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = ${CLEAN_DAY}::date` as Array<{ id: string; sid: string }>);
    const { windowsBlindAny, sessionsBlindAny } = await import("@/lib/room-access/check");
    const held = await windowsBlindAny(rows.map((r) => r.id));
    const heldS = await sessionsBlindAny([...new Set(rows.map((r) => r.sid))]);
    expect(held.size).toBeGreaterThan(0);
    // REL3-FU2: windows of a session refused WHOLE are not counted either
    expect(clean.window_count).toBe(rows.filter((r) => !held.has(r.id) && !heldS.has(r.sid)).length);
  });
});

(HAVE ? describe : describe.skip)("REL3-FU G3-1: ?occupancy=1&as_of=<held-out day> never returns a held-out room-day's consulting doctor", () => {
  it("the warehouse occupant of a machine whose latest consult is on a held-out (room, day) is excluded (as_of names a past time); a clean room's machine on the same day is served", async () => {
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version, attribution_source, consulting_doctor_uid, consulting_doctor_name) VALUES
        ('cw_occ_blind', 'm-blind', '${BR}', 'none', '${T(dayStart + 4 * 3_600_000)}', '${T(dayStart + 4 * 3_600_000 + 600_000)}', 'endConsult', 'clean', 'v1', 'warehouse', 'doc_blind', 'Held Out Doctor'),
        ('cw_occ_ok', 'm-ok', 'r_clean', 'none', '${T(dayStart + 4 * 3_600_000)}', '${T(dayStart + 4 * 3_600_000 + 600_000)}', 'endConsult', 'clean', 'v1', 'warehouse', 'doc_ok', 'Clean Doctor');
    `);
    const asOf = T(dayStart + 4 * 3_600_000 + 1_200_000); // 10:20 IST-ish on the held-out day
    const { consultingDoctorForMachine, machineOccupancy } = await import("@/lib/encounter-windows/occupant");
    const { sql } = await import("@/lib/db");
    expect(await consultingDoctorForMachine(sql as never, "m-blind", asOf)).toBeNull();
    expect(await consultingDoctorForMachine(sql as never, "m-ok", asOf)).toMatchObject({ uid: "doc_ok" });
    const machines = await machineOccupancy(sql as never, asOf);
    expect(JSON.stringify(machines)).not.toContain("doc_blind");
    expect(JSON.stringify(machines)).not.toContain("Held Out Doctor");
  });
});

(HAVE ? describe : describe.skip)("REL3-FU2 listRoomDays: a clean window of a session that is refused WHOLE is not counted", () => {
  it("a session with one clean window and one window held out only by its turn rows contributes 0 windows to the day's count", async () => {
    pg.exec(`
      ${sessionRow("bs_mixed", 2)}
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES
        ('bw_mixed_clean', 'bs_mixed', 'rd_clean', ${Date.parse(CLEAN_DAY + "T02:00:00Z")}, ${Date.parse(CLEAN_DAY + "T02:10:00Z")}, 'primary'),
        ('bw_mixed_rts', 'bs_mixed', 'rd_clean', ${Date.parse(CLEAN_DAY + "T02:10:00Z")}, ${Date.parse(CLEAN_DAY + "T02:20:00Z")}, 'primary');
      INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, speaker_idx, no_role_reason) VALUES ('bw_mixed_rts', 't1', 'rd_blind', 0, 'no_match');
    `);
    const { listRoomDays } = await import("@/lib/room-access/room-day-admin");
    const { guardSessionSpan } = await import("@/lib/room-access/check");
    expect(await guardSessionSpan("bs_mixed")).toBe("blind_room_day");
    const row = (await listRoomDays("r_clean")).find((r) => r.ist_date === CLEAN_DAY)!;
    // the count is exactly the windows of the sessions that are NOT refused whole
    const ok = (await H.sql!`SELECT w.id, s.id AS sid FROM bench_window w JOIN bench_session s ON s.id = w.session_id WHERE s.room_id = 'r_clean' AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = ${CLEAN_DAY}::date` as Array<{ id: string; sid: string }>);
    const { sessionsBlindAny, windowsBlindAny } = await import("@/lib/room-access/check");
    const heldS = await sessionsBlindAny([...new Set(ok.map((x) => x.sid))]);
    const heldW = await windowsBlindAny(ok.map((x) => x.id));
    const expected = ok.filter((x) => !heldS.has(x.sid) && !heldW.has(x.id)).length;
    expect(heldS.has("bs_mixed")).toBe(true);
    expect(row.window_count).toBe(expected);
    expect(ok.some((x) => x.id === "bw_mixed_clean")).toBe(true); // it exists, and is not counted
  });
});
