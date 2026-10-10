/**
 * (10 Oct 2026: the held-out rule is LIFTED, BLIND_ROOM_DAYS is empty. The "blind" fixtures below sit on a formerly held-out pair and every tool / reader / job now SERVES or PROCESSES them; nothing is refused or excluded.)
 * REL2-R3 K3 on a real postgres:16 with ALL migrations applied (the refuter's repro fixtures, seeded through the real CHECKs): K3-1 the Bench session tools, K3-2 the job doors, K3-3 scratch ids, K3-4 aggregates.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { FORMER_BLIND_PAIRS } from "../support/former-blind-pairs";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); }, { transaction: async () => [] }) }));
const R2 = vi.hoisted(() => ({ presign: 0, get: 0 }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => { R2.presign++; return "https://r2.example/x"; }, getObjectBytes: async () => { R2.get++; return new Uint8Array([1]); } }));
vi.mock("@/lib/cookie", async (orig) => ({ ...((await orig()) as object), readAdminCookie: async () => "admin-cookie" }));
vi.mock("@/lib/auth", async (orig) => ({ ...((await orig()) as object), verifyAdminJwt: async () => ({ sub: "admin" }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-rel2-r3-k3");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
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

(HAVE ? describe : describe.skip)("K3-1 the Bench session tools on real SQL: a session on a formerly held-out day is listed, reported, replayed, served and presigned like any other", () => {
  beforeAll(() => { seed(); });
  it("scribe_list_sessions: by room + date the formerly held-out session is listed; unfiltered lists all four; nothing is counted as excluded", async () => {
    const byPair = await call("scribe_list_sessions", { room_id: BR, ist_date: BD });
    expect(byPair.sessions.map((x: { id: string }) => x.id)).toEqual(["bs_blind"]);
    expect(byPair.n_blind_excluded ?? 0).toBe(0);
    const all = await call("scribe_list_sessions", {});
    expect(all.sessions.map((x: { id: string }) => x.id).sort()).toEqual(["bs_blind", "bs_clean", "bs_win"]);
    expect(all.n_blind_excluded ?? 0).toBe(0);
  });
  it("scribe_day_report: the formerly held-out room + day is reported with its session; the clean day lists its session; nothing is left out", async () => {
    const blind = await call("scribe_day_report", { room_id: BR, ist_date: BD, detail: "summary" });
    expect(blind.error).toBeUndefined();
    expect(blind.sessions.map((x: { session_id?: string; id?: string }) => x.session_id ?? x.id)).toEqual(["bs_blind"]);
    const clean = await call("scribe_day_report", { room_id: "r_clean", ist_date: CLEAN_DAY, detail: "summary" });
    expect(clean.sessions.map((x: { session_id?: string; id?: string }) => x.session_id ?? x.id).sort()).toEqual(["bs_clean", "bs_win"]);
    expect(clean.n_blind_excluded ?? 0).toBe(0);
  });
  it("scribe_replay_session, scribe_get_session and scribe_get_recording (every mode) SERVE the formerly held-out sessions, presigning and reading as for a clean one", async () => {
    H.statements.length = 0; R2.presign = 0; R2.get = 0;
    expect(await call("scribe_replay_session", { session_id: "bs_blind" })).toMatchObject({ session_id: "bs_blind" });
    expect(await call("scribe_replay_session", { session_id: "bs_win" })).toMatchObject({ session_id: "bs_win" });
    for (const id of ["bs_blind", "bs_win", "bs_clean"]) {
      expect(await call("scribe_get_session", { session_id: id }), id).toMatchObject({ session: { id } });
      for (const mode of ["manifest", "timeline", "chunk"]) expect((await call("scribe_get_recording", { session_id: id, mode, chunk_idx: 0 }, )).error, `${id} ${mode}`).not.toBe("blind_room_day");
    }
    expect((await call("scribe_get_recording", { session_id: "bs_blind", mode: "manifest" })).error).toBeUndefined();
    expect(R2.presign).toBeGreaterThan(0);
  });
});

const sessionRow = (id: string, hourUtc: number) => `INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('${id}', 'r_clean', '${CLEAN_DAY}T0${hourUtc}:00:00Z', '${CLEAN_DAY}T0${hourUtc}:30:00Z', 'ended');`;
const winRow = (id: string, session: string, hourUtc: number) => `INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES ('${id}', '${session}', 'rd_clean', ${Date.parse(`${CLEAN_DAY}T0${hourUtc}:00:00Z`)}, ${Date.parse(`${CLEAN_DAY}T0${hourUtc}:10:00Z`)}, 'primary');`;

(HAVE ? describe : describe.skip)("B3-1 / B3-2 the session guard on real SQL: no placement and no span refuses a session any more", () => {
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
  it("B3-1: a session whose window sits on the formerly held-out day by its turn rows, window text or emotion rows is SERVED (the guard answers null, the tool returns it, the listing holds nothing)", async () => {
    const { guardSessionSpan, sessionsBlindAny } = await import("@/lib/room-access/check");
    for (const id of ["bs_rts", "bs_txt", "bs_emo"]) {
      expect(await guardSessionSpan(id), id).toBe(null);
      expect(await call("scribe_get_session", { session_id: id }), id).toMatchObject({ session: { id } });
    }
    expect([...(await sessionsBlindAny(["bs_rts", "bs_txt", "bs_emo", "bs_clean"]))]).toEqual([]);
  });
  it("B3-2: a session whose span touches the formerly held-out IST day is SERVED whatever the range; the extract / transcribe tools do not refuse it", async () => {
    const { guardSessionSpan } = await import("@/lib/room-access/check");
    const dayEnd = dayStart + 86_400_000;
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('bs_span', '${BR}', '${T(dayStart - 3_600_000)}', '${T(dayStart - 1_800_000)}', 'ended');
             INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state) VALUES ('bc_span', 'bs_span', 0, 'bench/k_span', 'audio/webm', '${T(dayStart - 3_600_000)}', '${T(dayStart + 600_000)}', 300000, 1000, 'verified');`);
    expect(await guardSessionSpan("bs_span", { startMs: dayStart - 3_500_000, endMs: dayStart - 3_000_000 })).toBe(null);
    expect(await guardSessionSpan("bs_span")).toBe(null);
    expect(await guardSessionSpan("bs_clean", { startMs: dayEnd - 60_000, endMs: dayEnd + 60_000 })).toBe(null);
    expect((await call("scribe_extract_audio", { session_id: "bs_span", start: T(dayStart - 3_500_000), end: T(dayStart - 3_000_000) })).error).not.toBe("blind_room_day");
    expect(await call("scribe_transcribe_range", { session_id: "bs_span", start: T(dayStart - 3_500_000), end: T(dayStart - 3_000_000), dry_run: true })).not.toMatchObject({ error: "blind_room_day" });
  });
});

const jobCount = async () => Number(((await H.sql!`SELECT count(*)::int AS n FROM scribe_job` as Array<{ n: number }>)[0]!.n));

(HAVE ? describe : describe.skip)("K3-2 the job doors: a formerly held-out input is QUEUED like any other; a job inserted directly is not failed for blind_room_day", () => {
  beforeAll(() => {
    pg.exec(`
      ${sessionRow("bs_rdw", 5)} ${sessionRow("bs_ok", 6)}
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES ('bw_rdw', 'bs_rdw', 'rd_clean', ${Date.parse(CLEAN_DAY + "T04:20:00Z")}, ${Date.parse(CLEAN_DAY + "T04:30:00Z")}, 'primary');
      INSERT INTO room_diarize_window (window_id, room_day_id, state) VALUES ('bw_rdw', 'rd_blind', 'ok');
    `);
  });
  it("transcribe_range on the formerly held-out session, diarize_window on wRdw, jev_window_run on the formerly held-out room-day: all accepted, one job row each", async () => {
    const n0 = await jobCount();
    expect(await call("scribe_job_submit", { kind: "transcribe_range", args: { session_id: "bs_blind", start: T(dayStart + 3_600_000), end: T(dayStart + 3_900_000) } })).toMatchObject({ ok: true });
    expect(await call("scribe_job_submit", { kind: "diarize_window", args: { window_id: "bw_rdw" } })).toMatchObject({ ok: true });
    expect((await call("scribe_jev_window_run", { room_day_id: "rd_blind" })).error).not.toBe("blind_room_day");
    expect(await jobCount()).toBeGreaterThanOrEqual(n0 + 2);
  });
  it("B3-3: async:true on scribe_transcribe_range and scribe_extract_audio for the formerly held-out session is accepted: a job row each", async () => {
    const n0 = await jobCount();
    const a = { session_id: "bs_blind", start: T(dayStart + 3_600_000), end: T(dayStart + 3_900_000), async: true };
    expect(await call("scribe_transcribe_range", a)).toMatchObject({ ok: true, async: true });
    expect(await call("scribe_extract_audio", a)).toMatchObject({ ok: true, async: true });
    expect(await jobCount()).toBe(n0 + 2);
  });
  it("every other room kind accepts its formerly held-out input at submit (none answers blind_room_day): stitch, room_window, emotion_window, jev_english, jev_role, route_transcribe (bench key and clips key), day_manifest; a row is written for each accepted one", async () => {
    const n0 = await jobCount();
    const win = { session_id: "bs_blind", start: T(dayStart + 3_600_000), end: T(dayStart + 3_900_000) };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["stitch", win], ["room_window", { window_id: "bw_rdw", origin: "x", actor: "a", via: "mcp" }], ["emotion_window", { window_id: "bw_blind" }],
      ["jev_english", { room_day_id: "rd_blind" }], ["jev_role", { room_day_id: "rd_blind" }], ["jev_window", { room_day_id: "rd_blind" }],
      ["route_transcribe", { clip_key: `bench/blind-room/${BD}/bs_blind/chunk_00000.webm` }], ["route_transcribe", { clip_key: "clips/bs_blind/1-2-primary.webm" }],
      ["day_manifest", { room: "blind-room", ist_date: BD }], ["audio_measure", { clip_key: "clips/bs_win/1-2-primary.webm" }],
    ];
    let accepted = 0;
    for (const [kind, args] of cases) {
      const r = await call("scribe_job_submit", { kind, args });
      expect(r.error, `${kind} ${JSON.stringify(r)}`).not.toBe("blind_room_day");
      if (r.ok === true) accepted++;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(await jobCount()).toBe(n0 + accepted);
    const ok = await call("scribe_job_submit", { kind: "stitch", args: { session_id: "bs_ok", start: T(Date.parse(CLEAN_DAY + "T06:00:00Z")), end: T(Date.parse(CLEAN_DAY + "T06:05:00Z")) } });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(await jobCount()).toBe(n0 + accepted + 1);
  });
  it("a job inserted straight into scribe_job (past submit) is NOT failed for blind_room_day at its first step", async () => {
    const { readJob } = await import("@/lib/jobs/store");
    const { runOneStep } = await import("@/lib/jobs/runner");
    for (const [id, kind, args] of [["job_direct_1", "diarize_window", { window_id: "bw_rdw" }], ["job_direct_2", "transcribe_range", { session_id: "bs_blind", start: dayStart + 3_600_000, end: dayStart + 3_900_000, source: "primary" }], ["job_direct_3", "jev_window", { room_day_id: "rd_blind", force: false, prompt_version: "v" }]] as const) {
      pg.exec(`INSERT INTO scribe_job (id, kind, args, actor, status, lease_owner, lease_until) VALUES ('${id}', '${kind}', '${JSON.stringify(args)}'::jsonb, 'test', 'running', 'r1', now() + interval '4 minutes');`);
      const job = (await readJob(id))!;
      await runOneStep(job, "r1");
      const after = (await readJob(id))!;
      expect(String(after.error ?? ""), id).not.toContain("blind_room_day");
    }
  });
  it("scribe_clinical_route_replay on the formerly held-out room-day is not refused for blind_room_day", async () => {
    expect((await call("scribe_clinical_route_replay", { room_day_id: "rd_blind" })).error).not.toBe("blind_room_day");
  });
});

(HAVE ? describe : describe.skip)("K3-3 scribe_replay_write copies a session on a formerly held-out day into scratch like any other", () => {
  it("an ENDED session on the formerly held-out day (and one with a window placed on it) gets past the guard: no blind_room_day", async () => {
    for (const id of ["bs_blind", "bs_win", "bs_ok"]) {
      expect((await call("scribe_replay_write", { session_id: id }, )).error, id).not.toBe("blind_room_day");
    }
  });
});


(HAVE ? describe : describe.skip)("K3-4 aggregates (route_tripwires, diarize_spend) count the rows on formerly held-out days and exclude nothing", () => {
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
  it("scribe_route_tripwires counts all 3 runs (the two on formerly held-out windows too) and excludes none", async () => {
    const out = await call("scribe_route_tripwires", { days: 30 });
    expect(out.n_blind_excluded ?? 0).toBe(0);
    const route = out.engines.find((e: { engine: string }) => e.engine === "route");
    expect(route).toMatchObject({ runs: 3, chars: "hello".length + "held out words".length + "held out by turn rows".length, audio_seconds: 60 });
  });
  it("scribe_diarize_spend counts every label (4 labels, including the window, the room-day and the turn-row placements on the formerly held-out day) and excludes none", async () => {
    const out = await call("scribe_diarize_spend", { days: 30 });
    expect(out.n_blind_excluded ?? 0).toBe(0);
    expect(out.totals.windows_labelled).toBeGreaterThanOrEqual(3);
    expect(out.days.reduce((n: number, r: { windows: number }) => n + r.windows, 0)).toBe(out.totals.windows_labelled);
  });
});

(HAVE ? describe : describe.skip)("K4-1 key-taking jobs: an ALLOWLIST of audio key prefixes, each mapped to its placement; an unknown prefix is refused (a window on a formerly held-out day is queued)", () => {
  it("vad-trim/<window>/<run>.wav for windows that were held out (turn rows, text, emotion, diarize, bench placement) is QUEUED for route_transcribe, audio_measure and stt_fanout when the window exists; one row each", async () => {
    const n0 = await jobCount();
    let queued = 0;
    for (const win of ["bw_rts", "bw_txt", "bw_emo", "bw_rdw", "bw_blind"]) {
      for (const [kind, extra] of [["route_transcribe", {}], ["audio_measure", {}], ["stt_fanout", { engines: ["whisper"] }]] as const) {
        const r = await call("scribe_job_submit", { kind, args: { clip_key: `vad-trim/${win}/run1.wav`, ...extra } });
        expect(r.error, `${kind} ${win}`).not.toBe("blind_room_day");
        expect(r, `${kind} ${win}`).toMatchObject({ ok: true });
        queued++;
      }
    }
    expect(await jobCount()).toBe(n0 + queued);
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

(HAVE ? describe : describe.skip)("K4-2 room-day jobs process every window of a day, including one with turn rows on a formerly held-out day (nothing excluded)", () => {
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

  it("jev_english: both windows get a jev_window_text row (the one with turn rows on the formerly held-out day too); n_blind_excluded 0", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const out = await KIND_BY_NAME.get("jev_english")!.run(stepCtx("classify", { room_day_id: "rd_k4", force: true }));
    expect(out).toMatchObject({ kind: "done", result: { windows: 2 } });
    expect((out as { result: Record<string, unknown> }).result.n_blind_excluded ?? 0).toBe(0);
    const text = (await H.sql!`SELECT window_id FROM jev_window_text WHERE room_day_id = 'rd_k4' ORDER BY window_id` as Array<{ window_id: string }>).map((r) => r.window_id);
    expect(text).toEqual(["bw_k4ok", "bw_k4rts"]);
  });
  it("jev_window: both windows are collected; n_blind_excluded 0", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const out = await KIND_BY_NAME.get("jev_window")!.run(stepCtx("collect", { room_day_id: "rd_k4", force: true, prompt_version: "v" }));
    expect(out).toMatchObject({ kind: "done", result: { windows_total: 2 } });
    expect((out as { result: Record<string, unknown> }).result.n_blind_excluded ?? 0).toBe(0);
  });
  it("jev_role: both windows are processed; n_blind_excluded 0", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const out = await KIND_BY_NAME.get("jev_role")!.run(stepCtx("run", { room_day_id: "rd_k4", force: true, prompt_version: "v" }));
    expect(out).toMatchObject({ kind: "done", result: { windows_total: 2 } });
    expect((out as { result: Record<string, unknown> }).result.n_blind_excluded ?? 0).toBe(0);
  });
  it("clinical_route_replay: both windows are in the run, none excluded (the flag on, the model call spied)", async () => {
    pg.exec(`INSERT INTO jev_window_text (window_id, room_day_id, source, char_count, english) VALUES ('bw_k4rts', 'rd_k4', 'run_english', 5, 'held out words') ON CONFLICT (window_id) DO UPDATE SET english = 'held out words', room_day_id = 'rd_k4'`);
    process.env.JEV_CLINICAL_ROUTE = "true";
    const { runClinicalRouteAsync } = await import("@/lib/jev/clinical-route");
    const jev = await import("@/lib/jev/ask");
    const spy = vi.spyOn(jev, "askJev").mockResolvedValue({ results: {} } as never);
    const out = await runClinicalRouteAsync("rd_k4").catch((e) => ({ err: String(e) }));
    spy.mockRestore();
    delete process.env.JEV_CLINICAL_ROUTE;
    expect(JSON.stringify(out)).toContain("\"windowsTotal\":2");
    expect(JSON.stringify(out)).toContain("\"nBlindExcluded\":0");
  });
});

(HAVE ? describe : describe.skip)("K4-3 the runner no longer fails a later-step job for blind_room_day", () => {
  it("jobs inserted at a LATER step (diarize_window at local_label, stitch at join, emotion_window at score) on the formerly held-out inputs are not failed for blind_room_day", async () => {
    const { readJob } = await import("@/lib/jobs/store");
    const { runOneStep } = await import("@/lib/jobs/runner");
    const cases = [
      ["job_late_1", "diarize_window", "local_label", { window_id: "bw_rdw" }, {}],
      ["job_late_2", "stitch", "join", { session_id: "bs_blind", start: dayStart + 3_600_000, end: dayStart + 3_900_000, source: "primary", format: "webm" }, { pieces: [{ start: dayStart + 3_600_000, end: dayStart + 3_900_000 }], done: [], total_ms: 300000 }],
      ["job_late_3", "emotion_window", "score", { window_id: "bw_blind" }, { window_id: "bw_blind" }],
    ] as const;
    for (const [id, kind, step, args, progress] of cases) {
      pg.exec(`INSERT INTO scribe_job (id, kind, args, progress, step, actor, status, lease_owner, lease_until) VALUES ('${id}', '${kind}', '${JSON.stringify(args)}'::jsonb, '${JSON.stringify(progress)}'::jsonb, '${step}', 'test', 'running', 'r1', now() + interval '4 minutes');`);
      await runOneStep((await readJob(id))!, "r1");
      expect(String((await readJob(id))!.error ?? ""), id).not.toContain("blind_room_day");
    }
  });
});

(HAVE ? describe : describe.skip)("K4-4 scribe_silence_readjudicate: the formerly held-out room-day and windows are previewed and applied like any other, nothing excluded", () => {
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
  it("the dry run: the formerly held-out room-day is not refused; the unscoped preview counts all 3 silent windows and excludes none", async () => {
    expect((await call("scribe_silence_readjudicate", { room_day_id: "rd_blind" })).error).not.toBe("blind_room_day");
    const out = await call("scribe_silence_readjudicate", {});
    expect(out).toMatchObject({ ok: true });
    expect(out.n_blind_excluded ?? 0).toBe(0);
    expect(out.would.eligible.total).toBe(3);
  });
  it("the apply moves all 3 silent windows, the ones on the formerly held-out placements included", async () => {
    const dry = await call("scribe_silence_readjudicate", {});
    const out = await call("scribe_silence_readjudicate", { apply: true, all_rooms: true, detector: "d1", reason: "k4", as_of: dry.would.as_of });
    expect(out).toMatchObject({ ok: true, reopened: 3 });
    expect(out.n_blind_excluded ?? 0).toBe(0);
    expect([...out.window_ids].sort()).toEqual(["bw_sil_day", "bw_sil_ok", "bw_sil_rts"]);
    for (const id of ["bw_sil_ok", "bw_sil_rts", "bw_sil_day"]) expect(await stateOf(id), id).toBe("closed");
  });
});

(HAVE ? describe : describe.skip)("REL2-R4 G1 /api/diarize-segments + scribe_diarize_segments, G2 the encounter shadow evidence: windows on a formerly held-out day are served and counted", () => {
  const seg = async (q: Record<string, unknown>) => { const { lookupSegments } = await import("@/lib/diarize-segments"); return lookupSegments(q as never); };
  it("G1 window path: a window with turn rows on the formerly held-out day (bw_k4rts) is served by the lookup and the tool like a clean one", async () => {
    expect(await seg({ window_id: "bw_k4rts" })).toMatchObject({ ok: true });
    expect((await call("scribe_diarize_segments", { window_id: "bw_k4rts" })).error).not.toBe("blind_room_day");
    expect(await seg({ window_id: "bw_k4ok" })).toMatchObject({ ok: true });
  });
  it("G1 session path: bs_k4b (holds the turn-row window) is served whole: get_session, the lookup and the tool", async () => {
    expect(await call("scribe_get_session", { session_id: "bs_k4b" })).toMatchObject({ session: { id: "bs_k4b" } });
    expect(await seg({ session_id: "bs_k4b" })).toMatchObject({ ok: true });
    expect((await call("scribe_diarize_segments", { session_id: "bs_k4b" })).error).not.toBe("blind_room_day");
    expect(((await seg({ session_id: "bs_rdw" })) as { error?: string }).error).not.toBe("blind_room_day");
  });
  it("G1 nemotron path: the shadow store is read for the turn-row window (not refused for blind_room_day)", async () => {
    process.env.DIARIZE_NEMOTRON_SHADOW = "on";
    try {
      expect(((await seg({ window_id: "bw_k4rts", engine: "nemotron" })) as { error?: string }).error).not.toBe("blind_room_day");
    } finally { delete process.env.DIARIZE_NEMOTRON_SHADOW; }
  });
  it("G2: a day with 3 transcribed windows, 2 with other placements on the formerly held-out day (turn rows; window text) -> loadDayEvidence uses all 3, excludes 0", async () => {
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
    expect(ev!.windows).toHaveLength(3);
    expect(ev!.windows.map((w) => w.text)).toContain("ok words");
    expect(ev!.n_blind_excluded ?? 0).toBe(0);
  });
});

(HAVE ? describe : describe.skip)("GUARD — the readers that used to carry their own SQL (REB index route, store stats, rooms, the admin STT-lab / drain / calibration / windows routes) now serve formerly held-out targets through lib/room-access", () => {
  beforeAll(() => {
    pg.exec(`
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) VALUES
        ('w_ok', '${CLEAN_DAY}', 'r_clean', 'stt', 'e', 'v1', 'c1', 'ok', 'k1', 'aa'), ('w_blind', '${BD}', '${BR}', 'stt', 'e', 'v1', 'c2', 'ok', 'k2', 'bb');
    `);
  });
  it("the bearer route GET /api/reb/index lists both rows, the one on the formerly held-out pair too", async () => {
    const { rebIndexRows } = await import("@/lib/room-access/tool-reads");
    const rows = await rebIndexRows({ cursor: 0, windowId: null, day: null, layer: null, engine: null, roomId: null, withShadow: true, limit: 50 });
    expect(rows.map((r) => r.window_id).sort()).toEqual(["w_blind", "w_ok"]);
    const byDay = await rebIndexRows({ cursor: 0, windowId: null, day: BD, layer: null, engine: null, roomId: BR, withShadow: true, limit: 50 });
    expect(byDay.map((r) => r.window_id)).toEqual(["w_blind"]);
  });
  it("scribe_store_stats counts every session and excludes none; scribe_list_rooms shows the formerly held-out room's last session", async () => {
    const out = await call("scribe_store_stats", {});
    expect(out.bench.n_blind_excluded ?? 0).toBe(0);
    const { benchSessionTotals } = await import("@/lib/room-access/tool-reads");
    const t = await benchSessionTotals();
    const all = Number(((await H.sql!`SELECT count(*)::int AS n FROM bench_session` as Array<{ n: number }>)[0]!.n));
    expect(t.nBlindExcluded).toBe(0);
    expect(t.total).toBe(all);
    const rooms = await call("scribe_list_rooms", {});
    const blindRoom = (rooms.rooms as Array<{ id: string; last_session_at: string | null }>).find((r) => r.id === BR);
    expect(blindRoom?.last_session_at ?? null).not.toBe(null);
  });
  it("the admin routes' reads: sessions / windows on the formerly held-out day are served like a clean one", async () => {
    const R = await import("@/lib/room-access/tool-reads");
    for (const id of ["bs_blind", "bs_win", "bs_rts"]) {
      expect("rows" in (await R.adminSessionWindows(id)), id).toBe(true);
      expect(await R.adminDiarizeAnswers(id), id).not.toEqual({ error: "blind_room_day" });
      expect(await R.adminDrainRows(id), id).not.toEqual({ error: "blind_room_day" });
    }
    expect(await R.adminWindowRow("bw_rts")).not.toEqual({ error: "blind_room_day" });
    expect(await R.adminWindowRow("bw_blind")).toMatchObject({ rows: [expect.objectContaining({ id: "bw_blind" })] });
    expect("rows" in (await R.adminSessionWindows("bs_ok"))).toBe(true);
    expect("rows" in (await R.adminWindowRow("bw_ok_none"))).toBe(true);
    const pending = await R.measurePendingCount();
    expect(pending).toBeGreaterThanOrEqual(0);
  });
});

(HAVE ? describe : describe.skip)("GUARD-3 G-2: the admin bench-session GETs and the encounter-windows read serve the formerly held-out pair", () => {
  it("GET /api/bench/sessions?room_id=<formerly held-out>&ist_date=<its day> lists the session, nothing excluded; the unfiltered list holds the formerly held-out sessions too", async () => {
    const { GET } = await import("@/app/api/bench/sessions/route");
    const { NextRequest } = await import("next/server");
    const get = async (qs: string) => (await (await GET(new NextRequest(`http://x/api/bench/sessions${qs}`))).json()) as { data?: Record<string, any>; sessions?: any[]; n_blind_excluded?: number };
    const one = await get(`?room_id=${BR}&ist_date=${BD}`);
    const body = (one.data ?? one) as { sessions: Array<{ id: string }>; n_blind_excluded: number };
    expect(body.sessions.map((x) => x.id)).toEqual(["bs_blind"]);
    expect(body.n_blind_excluded ?? 0).toBe(0);
    const all = ((await get("")).data ?? (await get(""))) as { sessions: Array<{ id: string }> };
    for (const id of ["bs_blind", "bs_win", "bs_rts", "bs_span"]) expect(all.sessions.map((x) => x.id), id).toContain(id);
  });
  it("GET /api/bench/sessions/<id> is 200 for the formerly held-out sessions too (chunks and events are read)", async () => {
    const { GET } = await import("@/app/api/bench/sessions/[id]/route");
    const { NextRequest } = await import("next/server");
    const get = (id: string) => GET(new NextRequest(`http://x/api/bench/sessions/${id}`), { params: Promise.resolve({ id }) });
    for (const id of ["bs_blind", "bs_win", "bs_rts", "bs_ok"]) expect((await get(id)).status, id).toBe(200);
  });
  it("queryWindows (GET /api/encounter-windows, the clock anchors): a consult window opened or closed on the formerly held-out (room, IST day) is returned like any other", async () => {
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
    expect(rows.map((r) => r.consult_key).sort()).toEqual(["cw_cross", "cw_ok", "cw_open", "cw_other_room"]);
    expect((await queryWindows(sql as never, { room_id: BR, limit: 100 })).map((r) => r.consult_key).sort()).toEqual(["cw_cross", "cw_open"]);
  });
});

(HAVE ? describe : describe.skip)("GUARD-3 G-3: getRoomDayTape and listRoomDays serve the formerly held-out pair", () => {
  it("GET /api/admin/rooms/<room>/days/<formerly held-out day> is served (not 403) and the lookup resolves with the tape", async () => {
    const { getRoomDayTape } = await import("@/lib/room-access/room-day-admin");
    expect(JSON.stringify(await getRoomDayTape(BR, BD))).toContain("bs_blind");
    const { GET } = await import("@/app/api/admin/rooms/[roomId]/days/[date]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ roomId: BR, date: BD }) });
    expect(res.status).toBe(200);
  });
  it("a clean room's tape holds the sessions that were held out (turn rows, text, emotion, diarize) as well as the clean one", async () => {
    const { getRoomDayTape } = await import("@/lib/room-access/room-day-admin");
    const tape = await getRoomDayTape("r_clean", CLEAN_DAY);
    const text = JSON.stringify(tape);
    for (const id of ["bs_clean", "bs_rts", "bs_txt", "bs_emo"]) expect(text, id).toContain(id);
  });
  it("the day BEFORE the formerly held-out day: the tape resolves (the session that runs into the day is an ordinary session)", async () => {
    const { getRoomDayTape } = await import("@/lib/room-access/room-day-admin");
    const prev = new Date(Date.parse(`${BD}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const tape = await getRoomDayTape(BR, prev);
    expect(tape).toBeTruthy();
  });
  it("listRoomDays: the formerly held-out (room, day) is listed; a clean day's count includes every window", async () => {
    const { listRoomDays } = await import("@/lib/room-access/room-day-admin");
    const blindRoom = await listRoomDays(BR);
    expect(blindRoom.map((r) => r.ist_date)).toContain(BD);
    const clean = (await listRoomDays("r_clean")).find((r) => r.ist_date === CLEAN_DAY)!;
    const rows = (await H.sql!`SELECT w.id, s.id AS sid FROM bench_window w JOIN bench_session s ON s.id = w.session_id WHERE s.room_id = 'r_clean' AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = ${CLEAN_DAY}::date` as Array<{ id: string; sid: string }>);
    const { windowsBlindAny, sessionsBlindAny } = await import("@/lib/room-access/check");
    expect((await windowsBlindAny(rows.map((r) => r.id))).size).toBe(0);
    expect((await sessionsBlindAny([...new Set(rows.map((r) => r.sid))])).size).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
    expect(clean.window_count).toBe(rows.length);
  });
});

(HAVE ? describe : describe.skip)("REL3-FU G3-1: ?occupancy=1&as_of=<formerly held-out day> returns that room-day's consulting doctor like any other", () => {
  it("the warehouse occupant of a machine whose latest consult is on the formerly held-out (room, day) is returned (as_of names a past time), as is a clean room's machine", async () => {
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version, attribution_source, consulting_doctor_uid, consulting_doctor_name) VALUES
        ('cw_occ_blind', 'm-blind', '${BR}', 'none', '${T(dayStart + 4 * 3_600_000)}', '${T(dayStart + 4 * 3_600_000 + 600_000)}', 'endConsult', 'clean', 'v1', 'warehouse', 'doc_blind', 'Held Out Doctor'),
        ('cw_occ_ok', 'm-ok', 'r_clean', 'none', '${T(dayStart + 4 * 3_600_000)}', '${T(dayStart + 4 * 3_600_000 + 600_000)}', 'endConsult', 'clean', 'v1', 'warehouse', 'doc_ok', 'Clean Doctor');
    `);
    const asOf = T(dayStart + 4 * 3_600_000 + 1_200_000); // 10:20 IST-ish on the held-out day
    const { consultingDoctorForMachine, machineOccupancy } = await import("@/lib/encounter-windows/occupant");
    const { sql } = await import("@/lib/db");
    expect(await consultingDoctorForMachine(sql as never, "m-blind", asOf)).toMatchObject({ uid: "doc_blind" });
    expect(await consultingDoctorForMachine(sql as never, "m-ok", asOf)).toMatchObject({ uid: "doc_ok" });
    const machines = await machineOccupancy(sql as never, asOf);
    expect(JSON.stringify(machines)).toContain("doc_blind");
  });
});

(HAVE ? describe : describe.skip)("REL3-FU2 listRoomDays: every window of a session with turn rows on the formerly held-out day is counted", () => {
  it("a session with one clean window and one window with turn rows on the formerly held-out day contributes BOTH windows to the day's count", async () => {
    pg.exec(`
      ${sessionRow("bs_mixed", 2)}
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES
        ('bw_mixed_clean', 'bs_mixed', 'rd_clean', ${Date.parse(CLEAN_DAY + "T02:00:00Z")}, ${Date.parse(CLEAN_DAY + "T02:10:00Z")}, 'primary'),
        ('bw_mixed_rts', 'bs_mixed', 'rd_clean', ${Date.parse(CLEAN_DAY + "T02:10:00Z")}, ${Date.parse(CLEAN_DAY + "T02:20:00Z")}, 'primary');
      INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, speaker_idx, no_role_reason) VALUES ('bw_mixed_rts', 't1', 'rd_blind', 0, 'no_match');
    `);
    const { listRoomDays } = await import("@/lib/room-access/room-day-admin");
    const { guardSessionSpan } = await import("@/lib/room-access/check");
    expect(await guardSessionSpan("bs_mixed")).toBe(null);
    const row = (await listRoomDays("r_clean")).find((r) => r.ist_date === CLEAN_DAY)!;
    const ok = (await H.sql!`SELECT w.id, s.id AS sid FROM bench_window w JOIN bench_session s ON s.id = w.session_id WHERE s.room_id = 'r_clean' AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = ${CLEAN_DAY}::date` as Array<{ id: string; sid: string }>);
    expect(row.window_count).toBe(ok.length);
    expect(ok.some((x) => x.id === "bw_mixed_clean")).toBe(true);
    expect(ok.some((x) => x.id === "bw_mixed_rts")).toBe(true);
  });
});

(HAVE ? describe : describe.skip)("REL3-FU2 scope: transcription_run and bench_chunk readers are in the module and count formerly held-out rows", () => {
  it("/api/admin/stt-spend: window-run spend counts every run, those on formerly held-out windows included, and excludes none", async () => {
    const { sttSpendRaw } = await import("@/lib/room-access/tool-reads");
    const all = Number(((await H.sql!`SELECT count(*)::int AS n FROM transcription_run WHERE subject_type = 'bench_window'` as Array<{ n: number }>)[0]!.n));
    const { raw, nBlindExcluded } = await sttSpendRaw();
    const counted = raw.reduce((n, r) => n + Number(r.n_runs), 0);
    expect(nBlindExcluded).toBe(0);
    expect(counted).toBe(all);
    expect(counted).toBeGreaterThanOrEqual(3);
  });
  it("F2-S1 /api/admin/stt-spend: a run whose window row is gone still counts (cost included); nothing is excluded", async () => {
    const { sttSpendRaw } = await import("@/lib/room-access/tool-reads");
    const sum = (r: Array<Record<string, unknown>>) => ({ n: r.reduce((a, x) => a + Number(x.n_runs), 0), cost: r.reduce((a, x) => a + Number(x.cost_usd_total), 0) });
    const before = await sttSpendRaw();
    pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, mode, tier, transcript_original, cost_usd) VALUES
      ('tr_orph1', 'bench_window', 'bw_gone', 'route', 'batch', 'asr', 'x', 0.05), ('tr_orph2', 'bench_window', 'bw_gone2', 'route', 'batch', 'asr', 'y', 0.03)`);
    const after = await sttSpendRaw();
    expect(sum(after.raw).n - sum(before.raw).n).toBe(2);
    expect(Number((sum(after.raw).cost - sum(before.raw).cost).toFixed(4))).toBe(0.08);
    expect(before.nBlindExcluded).toBe(0);
    expect(after.nBlindExcluded).toBe(0);
  });
  it("LINT-FU /api/admin/stt-spend: an ORPHAN run (bench_window row gone) with turn rows on the formerly held-out room-day counts like the orphan on a clean day and the one with none; nothing is excluded", async () => {
    const { sttSpendRaw } = await import("@/lib/room-access/tool-reads");
    const sum = (r: Array<Record<string, unknown>>) => ({ n: r.reduce((a, x) => a + Number(x.n_runs), 0), cost: r.reduce((a, x) => a + Number(x.cost_usd_total), 0) });
    const before = await sttSpendRaw();
    pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, mode, tier, transcript_original, cost_usd) VALUES
      ('tr_lf_held', 'bench_window', 'bw_lf_held', 'route', 'batch', 'asr', 'x', 0.5), ('tr_lf_clean', 'bench_window', 'bw_lf_clean', 'route', 'batch', 'asr', 'y', 0.25), ('tr_lf_none', 'bench_window', 'bw_lf_none', 'route', 'batch', 'asr', 'z', 0.125);
      INSERT INTO room_turn_speaker (window_id, source_ref, room_day_id, speaker_idx, no_role_reason) VALUES ('bw_lf_held', 't1', 'rd_blind', 0, 'no_match'), ('bw_lf_clean', 't1', 'rd_clean', 0, 'no_match');`);
    const after = await sttSpendRaw();
    expect(sum(after.raw).n - sum(before.raw).n).toBe(3); // held + clean + none: all count
    expect(sum(after.raw).cost - sum(before.raw).cost).toBeCloseTo(0.875, 6); // the 0.5 orphan with turn rows on the formerly held-out day is in the spend
    expect(after.nBlindExcluded - before.nBlindExcluded).toBe(0);
  });
  it("scribe_store_stats: chunk totals count every chunk, those of sessions on the formerly held-out day included, and exclude none", async () => {
    const { benchChunkTotals } = await import("@/lib/room-access/tool-reads");
    const rows = (await H.sql!`SELECT session_id AS sid FROM bench_chunk` as Array<{ sid: string }>);
    const t = await benchChunkTotals();
    const counted = Object.values(t.byState).reduce((n, v) => n + v.count, 0);
    expect(rows.length).toBeGreaterThan(0);
    expect(t.nBlindExcluded).toBe(0);
    expect(counted).toBe(rows.length);
    const st = (await call("scribe_store_stats", {})).bench;
    expect(st.chunks_by_upload_state).toEqual(t.byState);
    expect(st.n_blind_chunks_excluded ?? 0).toBe(0);
  });
  it("the runs readers behind scribe_get_stt_run, scribe_stt_windows and the admin run route serve a window on the formerly held-out day", async () => {
    const run = await call("scribe_get_stt_run", { subject_id: "bw_rts", include_text: true });
    expect(run.error).toBeUndefined();
    expect(run.runs.length).toBeGreaterThanOrEqual(1);
    expect((await call("scribe_stt_windows", { window_id: "bw_rts" })).error).toBeUndefined();
    const { sttRunsFor } = await import("@/lib/room-access/tool-reads");
    expect((await sttRunsFor("bw_clean")).length).toBeGreaterThanOrEqual(1);
    expect((await sttRunsFor("bw_rts")).length).toBeGreaterThanOrEqual(1);
  });
});

(HAVE ? describe : describe.skip)("REL3-FU2 F2-2: the STT leaderboard (subject bench_window / all) counts runs of formerly held-out windows", () => {
  it("counts them on the board, n_blind_excluded is 0, and encounter stays 0", async () => {
    const { computeLeaderboard } = await import("@/lib/room-access/stt-leaderboard");
    const runs = (await H.sql!`SELECT tr.subject_id AS wid FROM transcription_run tr WHERE tr.subject_type = 'bench_window' AND tr.mode = 'batch' AND tr.tier = 'asr'` as Array<{ wid: string }>);
    const { windowsBlindAny } = await import("@/lib/room-access/check");
    expect((await windowsBlindAny([...new Set(runs.map((r) => r.wid))])).size).toBe(0);
    expect(runs.length).toBeGreaterThan(0);
    const bw = await computeLeaderboard({ subjectKind: "bench_window" });
    expect(bw.n_blind_excluded ?? 0).toBe(0);
    expect(bw.total_runs).toBe(runs.length);
    const all = await computeLeaderboard({ subjectKind: "all" });
    expect(all.n_blind_excluded ?? 0).toBe(0);
    expect((await computeLeaderboard({})).n_blind_excluded ?? 0).toBe(0);
  });
});
