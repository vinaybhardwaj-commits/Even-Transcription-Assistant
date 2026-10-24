/**
 * spine-s7a-r2-adv-pg.test.ts — the Opus refute R1 adversarial tests of spine S7a (2a0628e5), adopted as permanent regression tests (A1-A9 unchanged in what they assert; A10 / A11 updated to the R2 behaviour). postgres:16 only. Synthetic ids, placeholder words, append-only (no DELETE).
 * Each `it` asserts the REQUIRED behaviour from the brief; 
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), stmts: 0, blind: [["2026-10-17", "room_blindtest"], ["2026-10-16", "room_abcd2345"]] as Array<[string, string]> }));
vi.mock("@/lib/db", () => {
  const run = (text: string, params: unknown[]) => {
    const order: number[] = []; const parts = text.split(/\$(\d+)/); const strings: string[] = [];
    for (let i = 0; i < parts.length; i += 2) { strings.push(parts[i]); if (i + 1 < parts.length) order.push(Number(parts[i + 1]) - 1); }
    return H.tag!(Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray, ...order.map((n) => params[n]));
  };
  const sql = (a: unknown, ...rest: unknown[]) => { H.stmts += 1; return typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest); };
  return { sql };
});
vi.mock("@/lib/rubrics/blind-room-days", async (orig) => {
  const real = await orig<typeof import("@/lib/rubrics/blind-room-days")>();
  return { ...real, BLIND_ROOM_DAYS: H.blind, isBlindRoomDay: (d: string | null | undefined, r: string | null | undefined) => typeof d === "string" && typeof r === "string" && H.blind.some(([bd, br]) => bd === d.slice(0, 10) && br === r) };
});

import { runSpineEnqueue } from "@/lib/spine/enqueue-store";
import { runTranscriptFinal, type Deps } from "@/lib/spine/transcript-final-store";
import { MAX_OFFERS_PER_PASS, MAX_WAIT_MS } from "@/lib/spine/transcript-final";
import { readCoveringWindows, readRunTexts } from "@/lib/room-access/readers/spine-transcript";
import { CLOSE_GRACE_MS, FREE_STAGES } from "@/lib/spine/enqueue";
import { RELEASE_BACKOFF_MS } from "@/lib/spine/retry";
import { GET as tfGet } from "@/app/api/spine/transcript-final/route";
import { POST as claimPost } from "@/app/api/spine/claim/route";
import { NextRequest } from "next/server";

const HAVE_DOCKER = dockerAvailable();
const pg = pgContainer("eta-s7a-r2-adv");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");
const d = HAVE_DOCKER ? describe : describe.skip;

const MIN = 60_000;
const ORIGIN = "https://x.test";
const T_OPEN = Date.parse("2026-10-18T04:00:00Z");
const T_CLOSE = Date.parse("2026-10-18T04:20:00Z");
const NOW = Date.parse("2026-10-18T05:00:00Z");
const ROOM = "room_abcd2345", ROOM_OFF = "room_offf2345";
const iso = (ms: number) => new Date(ms).toISOString();
const q = async (text: string): Promise<Array<Record<string, unknown>>> => (await H.tag!(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const num = async (text: string) => Number(Object.values((await q(text))[0])[0]);
const setConfig = (key: string, json: string) => pg.exec(`INSERT INTO spine_config (key, value) VALUES ('${key}', '${json}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
const live = () => { setConfig("jobs", '"live"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, '"live"'); };
function enc(id: string, o: { status?: string; open?: number; close?: number; room?: string; date?: string } = {}) {
  pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version, flags)
    VALUES ('${id}', '${o.date ?? "2026-10-18"}', '${o.room ?? ROOM}', '${iso(o.open ?? T_OPEN)}', '${iso(o.close ?? T_CLOSE)}', '${o.status ?? "confirmed"}', 0, 'v_test', '{}');`);
}
let wseq = 0;
function bw(o: { room?: string; rd: string; start: number; mins?: number; state: string; mic?: string; run?: boolean }): string {
  const id = `bw_${(o.room ?? ROOM).slice(5, 13)}_${String(o.start)}_${o.mic ?? "primary"}_${(wseq++).toString(36)}`;
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at)
    VALUES ('${id}', 's_${o.room ?? ROOM}', '${o.rd}', ${o.start}, ${o.start + (o.mins ?? 15) * MIN}, '${o.mic ?? "primary"}', true, '${o.state}', '${iso(o.start + 15 * MIN)}');`);
  if (o.run ?? o.state === "transcribed") pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, transcript_original, transcript_english) VALUES ('run_${id}', 'bench_window', '${id}', 'route', 'placeholder words', 'english words');`);
  return id;
}
/** The real room reader, a spy drain. */
function deps(o: { drainOn?: boolean } = {}) {
  const offered: string[] = [];
  const dd: Deps = { readWindows: readCoveringWindows, readRuns: readRunTexts, offer: async (id) => { offered.push(id); return "enqueued"; }, drainOn: () => o.drainOn ?? true, cooldownMs: 3_600_000, rng: () => 0.5 };
  return { offered, dd };
}
const events = () => q("SELECT counts FROM spine_tick WHERE kind = 'transcript_final_event' ORDER BY id");
const get = (qs: string, auth?: string) => tfGet(new NextRequest(`https://x.test/api/spine/transcript-final${qs}`, { headers: auth ? { authorization: auth } : {} }));

d("S7a R1 refute tests (adopted) on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
    pg.exec(`
      CREATE TABLE room (id text PRIMARY KEY, transcript_enabled boolean NOT NULL DEFAULT false);
      CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
      CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL);
      CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL, source_mic text NOT NULL, grid_aligned boolean NOT NULL DEFAULT true, state text NOT NULL, closed_at timestamptz, auto_drain_refused_at timestamptz, auto_drain_refused_reason text);
      CREATE INDEX idx_bench_window_session ON bench_window (session_id, start_ms); CREATE INDEX idx_bench_window_state ON bench_window (state);
      CREATE TABLE room_diarize_window (window_id text, room_day_id text);
      CREATE TABLE room_turn_speaker (window_id text, room_day_id text);
      CREATE TABLE jev_window_text (window_id text, room_day_id text);
      CREATE TABLE room_span_emotion (window_id text, room_day_id text);
      CREATE TABLE scribe_job (kind text, args jsonb, status text, created_at timestamptz DEFAULT now());
      CREATE TABLE transcription_run (id text PRIMARY KEY, subject_type text, subject_id text, engine text, error text, transcript_original text, transcript_english text, created_at timestamptz DEFAULT now());
      CREATE INDEX idx_transcription_run_subject ON transcription_run (subject_type, subject_id);
      INSERT INTO room VALUES ('${ROOM}', true), ('${ROOM_OFF}', false), ('room_blindtest', true);
      INSERT INTO bench_session VALUES ('s_${ROOM}', '${ROOM}'), ('s_${ROOM_OFF}', '${ROOM_OFF}'), ('s_room_blindtest', 'room_blindtest');
      INSERT INTO room_day VALUES ('rd_a18', '${ROOM}', '2026-10-18'), ('rd_a19', '${ROOM}', '2026-10-19'), ('rd_o18', '${ROOM_OFF}', '2026-10-18'), ('rd_b17', 'room_blindtest', '2026-10-17');
    `);
  });
  afterAll(() => { pg.stop(); });
  beforeEach(() => { pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE; TRUNCATE bench_window, transcription_run, scribe_job, room_turn_speaker;"); H.blind.splice(0, H.blind.length, ["2026-10-17", "room_blindtest"], ["2026-10-16", ROOM]); });

  // ---- 1. SECURITY of GET /api/spine/transcript-final ------------------------------------------------------------------------
  it("A1 route: 503 unset, 401 missing / wrong / Basic / bearer-prefix, 200 right; limit clamped to 200; no text in the body", async () => {
    delete process.env.SPINE_BEARER_TOKEN;
    expect((await get("", "Bearer tok_test")).status).toBe(503);
    process.env.SPINE_BEARER_TOKEN = "tok_test";
    for (const h of [undefined, "Bearer nope", "Basic tok_test", "Bearer tok_tes", "tok_test"]) expect((await get("", h)).status).toBe(401);
    live(); enc("enc_aaaaaaaaaaaaaaaa"); await runSpineEnqueue(NOW);
    bw({ rd: "rd_a18", start: T_OPEN, state: "transcribed" }); bw({ rd: "rd_a18", start: T_OPEN + 15 * MIN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    const r = await get("?limit=999999&after=0", "Bearer tok_test");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toMatch(/placeholder words|english words/);
    expect(JSON.parse(body).events.length).toBe(1);
    expect((await get("?limit=-1&after=abc", "Bearer tok_test")).status).toBe(200);
    delete process.env.SPINE_BEARER_TOKEN;
  });

  it("A2 blind at READ time: a room-day that becomes held out after its event was written is never served by the poll", async () => {
    process.env.SPINE_BEARER_TOKEN = "tok_test";
    live(); enc("enc_bbbbbbbbbbbbbbbb"); await runSpineEnqueue(NOW);
    bw({ rd: "rd_a18", start: T_OPEN, state: "transcribed" }); bw({ rd: "rd_a18", start: T_OPEN + 15 * MIN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    expect((await events()).length).toBe(1);
    H.blind.push(["2026-10-18", ROOM]);
    const body = (await (await get("", "Bearer tok_test")).json()) as { events: unknown[] };
    delete process.env.SPINE_BEARER_TOKEN;
    expect(body.events, "held-out room-day served by the poll").toEqual([]);
  });

  it("A3 held-out windows never appear in the feed, not even as a count", async () => {
    live(); enc("enc_cccccccccccccccc"); await runSpineEnqueue(NOW);
    bw({ rd: "rd_a18", start: T_OPEN, state: "transcribed" });
    const held = bw({ rd: "rd_a18", start: T_OPEN, state: "transcribed", mic: "backup" });
    bw({ rd: "rd_a18", start: T_OPEN + 15 * MIN, state: "transcribed" });
    pg.exec(`INSERT INTO room_day VALUES ('rd_a16', '${ROOM}', '2026-10-16') ON CONFLICT DO NOTHING; INSERT INTO room_turn_speaker VALUES ('${held}', 'rd_a16');`);
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    const ev = (await events())[0].counts as { windows: Record<string, number>; window_ids: string[] };
    expect(ev.window_ids).not.toContain(held);
    expect(ev.windows.blind_excluded, "feed event carries a held-out window count").toBeUndefined();
  });

  // ---- 3. executor ------------------------------------------------------------------------------------------------------------
  it("A4 offer cap: at most MAX_OFFERS_PER_PASS offers in ONE executor pass (3 jobs, each with 3 pending windows)", async () => {
    live();
    const ids = ["enc_dddddddddddddddd", "enc_eeeeeeeeeeeeeeee", "enc_ffffffffffffffff"];
    ids.forEach((id, i) => enc(id, { open: T_OPEN + i * 60 * MIN, close: T_OPEN + i * 60 * MIN + 40 * MIN }));
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) bw({ rd: "rd_a18", start: T_OPEN + i * 60 * MIN + k * 15 * MIN, state: "closed" });
    const later = T_OPEN + 4 * 3_600_000;
    await runSpineEnqueue(later);
    const { offered, dd } = deps();
    const c = await runTranscriptFinal(later, ORIGIN, dd);
    expect(c).toMatchObject({ claimed: 3 });
    expect(offered.length, `offered ${offered.length} in one pass`).toBeLessThanOrEqual(MAX_OFFERS_PER_PASS);
  });

  it("A5 the room Transcript switch: a window of a Transcript-OFF room is never offered (no legacy stt_subject_job row is minted for it)", async () => {
    live(); enc("enc_gggggggggggggggg", { room: ROOM_OFF }); await runSpineEnqueue(NOW);
    bw({ room: ROOM_OFF, rd: "rd_o18", start: T_OPEN, state: "closed" });
    const { offered, dd } = deps();
    await runTranscriptFinal(NOW, ORIGIN, dd);
    expect(offered, "offered a Transcript-off window to the drain").toEqual([]);
  });

  it("A6 IST midnight: an encounter that runs past 00:00 IST is not finalised from the first room-day's windows alone", async () => {
    live();
    const open = Date.parse("2026-10-18T18:20:00Z"), close = Date.parse("2026-10-18T18:40:00Z");   // 23:50 -> 00:10 IST
    enc("enc_hhhhhhhhhhhhhhhh", { open, close }); await runSpineEnqueue(close + 20 * MIN);
    const pre = bw({ rd: "rd_a18", start: Date.parse("2026-10-18T18:15:00Z"), state: "transcribed" });
    const post = bw({ rd: "rd_a19", start: Date.parse("2026-10-18T18:30:00Z"), state: "transcribed" });
    await runTranscriptFinal(close + 20 * MIN, ORIGIN, deps().dd);
    const ev = (await events())[0]?.counts as { window_ids: string[] } | undefined;
    expect(ev?.window_ids ?? [pre, post], "event missing the after-midnight window").toEqual([pre, post]);
  });

  it("A7 tail coverage: a final is not emitted while [t_open, t_close] is not covered (the 04:15 window is not cut yet)", async () => {
    live(); enc("enc_iiiiiiiiiiiiiiii"); await runSpineEnqueue(NOW);
    bw({ rd: "rd_a18", start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    expect(await events(), "event emitted with a 5-minute hole at the tail").toEqual([]);
  });

  it("A8 two mics on one span: primary wins, a transcribed backup does not stand in for a pending primary", async () => {
    live(); enc("enc_jjjjjjjjjjjjjjjj", { close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const p = bw({ rd: "rd_a18", start: T_OPEN, state: "closed" });
    bw({ rd: "rd_a18", start: T_OPEN, state: "transcribed", mic: "backup" });
    const { offered, dd } = deps();
    expect(await runTranscriptFinal(NOW, ORIGIN, dd)).toMatchObject({ waiting: 1, done: 0 });
    expect(offered).toEqual([p]);
  });

  it("A9 the box: a shadow (would_run) claim and a live claim never take transcript_final in either mode", async () => {
    process.env.SPINE_BEARER_TOKEN = "tok_test";
    for (const m of ['"live"', '"shadow"']) {
      pg.exec("TRUNCATE spine_job, spine_encounter, spine_config RESTART IDENTITY CASCADE;");
      setConfig("jobs", '"live"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, m);
      enc("enc_kkkkkkkkkkkkkkkk"); await runSpineEnqueue(NOW);
      for (const liveClaim of [true, false]) {
        const res = await claimPost(new Request("https://x.test/api/spine/claim", { method: "POST", headers: { authorization: "Bearer tok_test" }, body: JSON.stringify({ owner: "spine-cron:transcript_final", limit: 5, live: liveClaim }) }) as never);
        const b = (await res.json()) as { jobs: Array<{ stage: string }> };
        expect(b.jobs.map((j) => j.stage)).not.toContain("transcript_final");
      }
    }
    delete process.env.SPINE_BEARER_TOKEN;
  });

  // ---- 7. the builder's open risks, as R2 resolves them -------------------------------------------------------------------------
  it("A10 (R2, F6) windows_not_ready is revived: the window transcribes later, the job is re-planned as a new attempt and the event appears; a rerun adds nothing", async () => {
    live(); enc("enc_llllllllllllllll", { close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const id = bw({ rd: "rd_a18", start: T_OPEN, state: "closed" });
    const late = T_OPEN + 15 * MIN + CLOSE_GRACE_MS + MAX_WAIT_MS + RELEASE_BACKOFF_MS;
    await runTranscriptFinal(late, ORIGIN, deps({ drainOn: false }).dd);
    expect((await q("SELECT status, last_error_code FROM spine_job WHERE stage = 'transcript_final'"))[0]).toMatchObject({ status: "failed", last_error_code: "windows_not_ready" });
    pg.exec(`UPDATE bench_window SET state = 'transcribed' WHERE id = '${id}'; INSERT INTO transcription_run (id, subject_type, subject_id, engine) VALUES ('run_late_${id}', 'bench_window', '${id}', 'route');`);
    const after = late + 31 * MIN;   // the failure counts toward the stage breaker for 30 min
    await runSpineEnqueue(after); await runTranscriptFinal(after, ORIGIN, deps().dd);
    expect((await q("SELECT status FROM spine_job WHERE stage = 'transcript_final'"))[0].status).toBe("done");
    expect((await events()).length).toBe(1);
    await runSpineEnqueue(after + MIN); expect(await runTranscriptFinal(after + MIN, ORIGIN, deps().dd)).toMatchObject({ revived: 0, claimed: 0 });
    expect((await events()).length).toBe(1);
  });

  it("A11 (R2, F7) a forced re-transcription after the event appends ONE revised event (original stays); the feed returns both in order", async () => {
    process.env.SPINE_BEARER_TOKEN = "tok_test";
    live(); enc("enc_mmmmmmmmmmmmmmmm", { close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const id = bw({ rd: "rd_a18", start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, transcript_original, created_at) VALUES ('run_redo_${id}', 'bench_window', '${id}', 'route', 'other words', now() + interval '1 hour');`);
    await runSpineEnqueue(NOW + 10 * MIN); await runTranscriptFinal(NOW + 10 * MIN, ORIGIN, deps().dd);
    await runTranscriptFinal(NOW + 11 * MIN, ORIGIN, deps().dd);
    const ev = (await events()).map((e) => e.counts as { event: string; run_ids: string[] });
    expect(ev.map((e) => [e.event, e.run_ids])).toEqual([["encounter.transcript_final", [`run_${id}`]], ["encounter.transcript_final_revised", [`run_redo_${id}`]]]);
    const body = (await (await get("", "Bearer tok_test")).json()) as { events: Array<{ event: string }> };
    expect(body.events.map((e) => e.event)).toEqual(["encounter.transcript_final", "encounter.transcript_final_revised"]);
    delete process.env.SPINE_BEARER_TOKEN;
  });
});
