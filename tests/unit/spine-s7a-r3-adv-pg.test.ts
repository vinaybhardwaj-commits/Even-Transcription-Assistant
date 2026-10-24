/**
 * zz-oref-r2-adv-pg.test.ts — Opus refute R2 of spine S7a (3320fecb). Throwaway postgres:16 only. Synthetic ids, placeholder words, no DELETE. A failing `it` is a finding.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), stmts: 0, blind: [["2026-10-16", "room_abcd2345"]] as Array<[string, string]> }));
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
import { runTranscriptFinal, OWNER, type Deps } from "@/lib/spine/transcript-final-store";
import { MAX_OFFERS_PER_PASS, MAX_WAIT_MS, COVER_TOLERANCE_MS } from "@/lib/spine/transcript-final";
import { readCoveringWindows, readRunTexts } from "@/lib/room-access/readers/spine-transcript";
import { CLOSE_GRACE_MS, FREE_STAGES } from "@/lib/spine/enqueue";
import { RELEASE_BACKOFF_MS } from "@/lib/spine/retry";
import { GET as tfGet } from "@/app/api/spine/transcript-final/route";
import { NextRequest } from "next/server";

const HAVE_DOCKER = dockerAvailable();
const pg = pgContainer("eta-s7a-r2-oref2");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");
const d = HAVE_DOCKER ? describe : describe.skip;

const MIN = 60_000;
const ORIGIN = "https://x.test";
const T_OPEN = Date.parse("2026-10-18T04:00:00Z");
const T_CLOSE = Date.parse("2026-10-18T04:20:00Z");
const NOW = Date.parse("2026-10-18T05:00:00Z");
const ROOM = "room_abcd2345", ROOM_OFF = "room_offf2345", RB = "room_bbbb2345", RC = "room_cccc2345", RF = "room_flip2345";
const DEADLINE = (close: number) => close + CLOSE_GRACE_MS + MAX_WAIT_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const q = async (text: string): Promise<Array<Record<string, unknown>>> => (await H.tag!(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const setConfig = (key: string, json: string) => pg.exec(`INSERT INTO spine_config (key, value) VALUES ('${key}', '${json}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
const live = () => { setConfig("jobs", '"live"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, '"live"'); };
let eseq = 0;
function enc(o: { status?: string; open?: number; close?: number; room?: string; date?: string } = {}): string {
  const id = `enc_r2${String.fromCharCode(97 + (eseq % 26))}${String.fromCharCode(97 + Math.floor(eseq / 26) % 26)}zzzzzzzzzzzz`; eseq++;
  pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version, flags)
    VALUES ('${id}', '${o.date ?? "2026-10-18"}', '${o.room ?? ROOM}', '${iso(o.open ?? T_OPEN)}', '${iso(o.close ?? T_CLOSE)}', '${o.status ?? "confirmed"}', 0, 'v_test', '{}');`);
  return id;
}
let wseq = 0;
function bw(o: { room?: string; rd: string; start: number; mins?: number; state: string; mic?: string; run?: boolean }): string {
  const id = `bw_r2_${(o.room ?? ROOM).slice(5, 9)}_${o.mic ?? "primary"}_${(wseq++).toString(36)}`;
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at)
    VALUES ('${id}', 's_${o.room ?? ROOM}', '${o.rd}', ${o.start}, ${o.start + (o.mins ?? 15) * MIN}, '${o.mic ?? "primary"}', true, '${o.state}', '${iso(o.start + 15 * MIN)}');`);
  if (o.run ?? o.state === "transcribed") pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, transcript_original, transcript_english) VALUES ('run_${id}', 'bench_window', '${id}', 'route', 'placeholder words', 'english words');`);
  return id;
}
function deps(o: { drainOn?: boolean } = {}) {
  const offered: string[] = [];
  const dd: Deps = { readWindows: readCoveringWindows, readRuns: readRunTexts, offer: async (id) => { offered.push(id); return "enqueued"; }, drainOn: () => o.drainOn ?? true, cooldownMs: 3_600_000, rng: () => 0.5 };
  return { offered, dd };
}
const events = () => q("SELECT id, counts FROM spine_tick WHERE kind = 'transcript_final_event' ORDER BY id");
const get = async (qs: string) => (await (await tfGet(new NextRequest(`https://x.test/api/spine/transcript-final${qs}`, { headers: { authorization: "Bearer tok_r2" } }))).json()) as { events: Array<Record<string, unknown>>; next_after: number };
const redo = (w: string, tag: string, text = "other words") => pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, transcript_original, created_at) VALUES ('run_${tag}_${w}', 'bench_window', '${w}', 'route', '${text}', now() + interval '1 hour');`);

d("S7a R2 refute (oref) on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    process.env.SPINE_BEARER_TOKEN = "tok_r2";
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
    const rooms = [ROOM, RB, RC, RF];
    pg.exec(`
      CREATE TABLE room (id text PRIMARY KEY, transcript_enabled boolean NOT NULL DEFAULT false);
      CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
      CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL);
      CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL, source_mic text NOT NULL, grid_aligned boolean NOT NULL DEFAULT true, state text NOT NULL, closed_at timestamptz, auto_drain_refused_at timestamptz, auto_drain_refused_reason text);
      CREATE TABLE room_diarize_window (window_id text, room_day_id text);
      CREATE TABLE room_turn_speaker (window_id text, room_day_id text);
      CREATE TABLE jev_window_text (window_id text, room_day_id text);
      CREATE TABLE room_span_emotion (window_id text, room_day_id text);
      CREATE TABLE scribe_job (kind text, args jsonb, status text, created_at timestamptz DEFAULT now());
      CREATE TABLE transcription_run (id text PRIMARY KEY, subject_type text, subject_id text, engine text, error text, transcript_original text, transcript_english text, created_at timestamptz DEFAULT now());
      INSERT INTO room VALUES ${rooms.map((r) => `('${r}', true)`).join(", ")}, ('${ROOM_OFF}', false);
      INSERT INTO bench_session VALUES ${[...rooms, ROOM_OFF].map((r) => `('s_${r}', '${r}')`).join(", ")};
      INSERT INTO room_day VALUES ${[...rooms, ROOM_OFF].map((r) => `('rd_${r.slice(5, 9)}18', '${r}', '2026-10-18'), ('rd_${r.slice(5, 9)}19', '${r}', '2026-10-19')`).join(", ")}, ('rd_a16', '${ROOM}', '2026-10-16');
    `);
  });
  afterAll(() => { pg.stop(); delete process.env.SPINE_BEARER_TOKEN; });
  beforeEach(() => {
    pg.exec(`TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE; TRUNCATE bench_window, transcription_run, scribe_job, room_turn_speaker; UPDATE room SET transcript_enabled = (id <> '${ROOM_OFF}');`);
    H.blind.splice(0, H.blind.length, ["2026-10-16", ROOM]);
  });
  const A18 = "rd_abcd18", A19 = "rd_abcd19";

  // ---- F1 ------------------------------------------------------------------------------------------------------------------
  it("B1 F1: a covering window held out after emission drops its event; limit=1 never wedges; a revised event is filtered too", async () => {
    live();
    enc(); const e2open = T_OPEN + 60 * MIN; enc({ open: e2open, close: e2open + 20 * MIN });
    const w1 = bw({ rd: A18, start: T_OPEN, state: "transcribed" }); bw({ rd: A18, start: T_OPEN + 15 * MIN, state: "transcribed" });
    const w3 = bw({ rd: A18, start: e2open, state: "transcribed" }); const w4 = bw({ rd: A18, start: e2open + 15 * MIN, state: "transcribed" });
    const at = e2open + 60 * MIN;
    await runSpineEnqueue(at); await runTranscriptFinal(at, ORIGIN, deps().dd);
    const ev = await events(); expect(ev.length).toBe(2);
    const first = (ev[0].counts as { window_ids: string[] }).window_ids;   // claim order decides which encounter wrote first
    const [hide, keepA, keepB] = first.includes(w1) ? [w1, w3, w4] : [w3, w1, w1];
    pg.exec(`INSERT INTO room_turn_speaker VALUES ('${hide}', 'rd_a16');`);
    const p1 = await get("?limit=1");
    expect(p1.events).toEqual([]); expect(p1.next_after).toBe(Number(ev[0].id));
    const p2 = await get(`?limit=1&after=${p1.next_after}`);
    expect(p2.events.map((e) => e.event_id)).toEqual([Number(ev[1].id)]);
    expect((await get("")).events.length).toBe(1);
    redo(keepA, "redo"); await runTranscriptFinal(at + 10 * MIN, ORIGIN, deps().dd);
    expect((await events()).length).toBe(3);
    expect((await get("")).events.map((e) => e.event)).toEqual(["encounter.transcript_final", "encounter.transcript_final_revised"]);
    pg.exec(`INSERT INTO room_turn_speaker VALUES ('${keepB === w1 ? w1 : w4}', 'rd_a16');`);
    expect((await get("")).events).toEqual([]);
  });

  it("B2 F1: an IST-midnight encounter whose CLOSE day is held out after emission is not served", async () => {
    live();
    const open = Date.parse("2026-10-18T18:20:00Z"), close = Date.parse("2026-10-18T18:40:00Z");
    enc({ open, close }); await runSpineEnqueue(close + 20 * MIN);
    bw({ rd: A18, start: Date.parse("2026-10-18T18:15:00Z"), state: "transcribed" }); bw({ rd: A19, start: Date.parse("2026-10-18T18:30:00Z"), state: "transcribed" });
    await runTranscriptFinal(close + 20 * MIN, ORIGIN, deps().dd);
    expect((await get("")).events.length).toBe(1);
    H.blind.push(["2026-10-19", ROOM]);
    expect((await get("")).events).toEqual([]);
  });

  // ---- F2 ------------------------------------------------------------------------------------------------------------------
  it("B3 F2: a window held out after emission does not mint a served revision that names the hidden event's sha", async () => {
    live(); enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const p = bw({ rd: A18, start: T_OPEN, state: "transcribed" }); bw({ rd: A18, start: T_OPEN, state: "transcribed", mic: "backup" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    pg.exec(`INSERT INTO room_turn_speaker VALUES ('${p}', 'rd_a16');`);
    await runTranscriptFinal(NOW + 10 * MIN, ORIGIN, deps().dd);
    const served = (await get("")).events as Array<{ text: { sha256: string }; revises_sha256?: string }>;
    const shas = new Set(served.map((e) => e.text.sha256));
    const dangling = served.filter((e) => e.revises_sha256 !== undefined && !shas.has(e.revises_sha256));
    expect(dangling.length, "served revision points at a held-out event's sha (a hold-out change is visible in the feed)").toBe(0);
  });

  it("B4 F2: the pass tick counts held-out windows without ids; no event carries blind_excluded", async () => {
    live(); enc(); await runSpineEnqueue(NOW);
    bw({ rd: A18, start: T_OPEN, state: "transcribed" }); const h = bw({ rd: A18, start: T_OPEN, state: "transcribed", mic: "backup" }); bw({ rd: A18, start: T_OPEN + 15 * MIN, state: "transcribed" });
    pg.exec(`INSERT INTO room_turn_speaker VALUES ('${h}', 'rd_a16');`);
    const c = await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    expect(c).toMatchObject({ blind_excluded: 1, done: 1 });
    const ticks = await q("SELECT kind, counts::text AS c FROM spine_tick");
    for (const t of ticks) expect(String(t.c)).not.toContain(h);
    for (const t of ticks.filter((x) => x.kind === "transcript_final_event")) expect(String(t.c)).not.toContain("blind");
  });

  // ---- F3 ------------------------------------------------------------------------------------------------------------------
  it("B5 F3: 4 jobs over 3 rooms, each pending: <= MAX_OFFERS_PER_PASS per pass, never two in one room, over 3 passes", async () => {
    live();
    const rooms = [ROOM, ROOM, RB, RC];
    rooms.forEach((r, i) => { const o = T_OPEN + i * 60 * MIN; enc({ room: r, open: o, close: o + 25 * MIN }); bw({ room: r, rd: `rd_${r.slice(5, 9)}18`, start: o, state: "closed" }); bw({ room: r, rd: `rd_${r.slice(5, 9)}18`, start: o + 15 * MIN, state: "closed" }); });
    let at = T_OPEN + 5 * 3_600_000; await runSpineEnqueue(at);
    const roomOf = (id: string) => id.slice(6, 10);
    for (let pass = 0; pass < 3; pass++) {
      const { offered, dd } = deps();
      await runTranscriptFinal(at, ORIGIN, dd);
      expect(offered.length).toBeLessThanOrEqual(MAX_OFFERS_PER_PASS);
      expect(new Set(offered.map(roomOf)).size, `two offers in one room: ${offered}`).toBe(offered.length);
      at += RELEASE_BACKOFF_MS + MIN;
    }
  });

  // ---- F4 ------------------------------------------------------------------------------------------------------------------
  it("B6 F4: a room turned Transcript-off mid-wait is not offered again; a transcribed off-room window gives no event", async () => {
    live(); enc({ room: RF, close: T_OPEN + 25 * MIN }); await runSpineEnqueue(NOW);
    bw({ room: RF, rd: "rd_flip18", start: T_OPEN, state: "closed" }); bw({ room: RF, rd: "rd_flip18", start: T_OPEN + 15 * MIN, state: "closed" });
    const a = deps(); await runTranscriptFinal(NOW, ORIGIN, a.dd); expect(a.offered.length).toBe(1);
    pg.exec(`UPDATE room SET transcript_enabled = false WHERE id = '${RF}'`);
    const b = deps(); await runTranscriptFinal(NOW + RELEASE_BACKOFF_MS + MIN, ORIGIN, b.dd); expect(b.offered).toEqual([]);
    enc({ room: ROOM_OFF }); await runSpineEnqueue(NOW + 20 * MIN);
    bw({ room: ROOM_OFF, rd: "rd_offf18", start: T_OPEN, state: "transcribed" }); bw({ room: ROOM_OFF, rd: "rd_offf18", start: T_OPEN + 15 * MIN, state: "transcribed" });
    const c = deps(); await runTranscriptFinal(NOW + 30 * MIN, ORIGIN, c.dd);
    expect(c.offered).toEqual([]); expect(await events()).toEqual([]);
  });

  it("B7 F4 x breaker: Transcript-off encounters failing no_covering_windows must not open the stage breaker for every other room", async () => {
    live();
    for (let i = 0; i < 3; i++) enc({ room: ROOM_OFF });
    await runSpineEnqueue(NOW);
    const late = DEADLINE(T_CLOSE) + MIN;
    expect(await runTranscriptFinal(late, ORIGIN, deps().dd)).toMatchObject({ failed: 3 });
    const o = late - 3 * 3_600_000; enc({ open: o, close: o + 15 * MIN }); bw({ rd: A18, start: o, state: "transcribed" });
    await runSpineEnqueue(late + 5 * MIN);
    const c = await runTranscriptFinal(late + 5 * MIN, ORIGIN, deps().dd);
    expect(c, "a healthy room's final is blocked by the breaker that Transcript-off rooms opened").toMatchObject({ breaker_open: false, done: 1 });
  });

  // ---- F5 ------------------------------------------------------------------------------------------------------------------
  it("B8 F5: a mid hole waits then fails windows_not_ready; tolerance edges at exactly COVER_TOLERANCE_MS and +1 s", async () => {
    live();
    enc({ open: T_OPEN, close: T_OPEN + 45 * MIN });
    bw({ rd: A18, start: T_OPEN, state: "transcribed" }); bw({ rd: A18, start: T_OPEN + 30 * MIN, state: "transcribed" });
    await runSpineEnqueue(NOW);
    expect(await runTranscriptFinal(NOW + 30 * MIN, ORIGIN, deps().dd)).toMatchObject({ done: 0, waiting: 1 });
    expect(await runTranscriptFinal(DEADLINE(T_OPEN + 45 * MIN) + RELEASE_BACKOFF_MS, ORIGIN, deps().dd)).toMatchObject({ failed: 1 });
    expect((await q("SELECT last_error_code FROM spine_job WHERE stage = 'transcript_final'"))[0].last_error_code).toBe("windows_not_ready");
    expect(await events()).toEqual([]);
    const base = DEADLINE(T_OPEN + 45 * MIN) + RELEASE_BACKOFF_MS + 31 * MIN;   // past the breaker the failure opened
    const o2 = T_OPEN + 2 * 3_600_000; enc({ open: o2, close: o2 + 15 * MIN + COVER_TOLERANCE_MS }); bw({ rd: A18, start: o2, state: "transcribed" });
    const o3 = T_OPEN + 3 * 3_600_000; enc({ open: o3, close: o3 + 15 * MIN + COVER_TOLERANCE_MS + 1000 }); bw({ rd: A18, start: o3, state: "transcribed" });
    const o4 = T_OPEN + 4 * 3_600_000; enc({ open: o4 - COVER_TOLERANCE_MS - 1000, close: o4 + 15 * MIN }); bw({ rd: A18, start: o4, state: "transcribed" });
    const at = base; await runSpineEnqueue(at); await runTranscriptFinal(at, ORIGIN, deps().dd);
    const ws = (await events()).map((e) => (e.counts as { stamps: { t_close: string } }).stamps.t_close);
    expect(ws).toEqual([iso(o2 + 15 * MIN + COVER_TOLERANCE_MS)]);
  });

  // ---- F6 ------------------------------------------------------------------------------------------------------------------
  it("B9 F6: no_covering_windows revives when windows appear; a never-ready failure is not revived over 5 passes; a stale cut is not revived", async () => {
    live();
    const e1 = enc({ close: T_OPEN + 15 * MIN });
    const o2 = T_OPEN + 60 * MIN; const e2 = enc({ open: o2, close: o2 + 15 * MIN }); bw({ rd: A18, start: o2, state: "closed" });
    const o3 = T_OPEN + 120 * MIN; const e3 = enc({ open: o3, close: o3 + 15 * MIN });
    await runSpineEnqueue(o3 + 40 * MIN);
    const late = DEADLINE(o3 + 15 * MIN) + RELEASE_BACKOFF_MS;
    await runTranscriptFinal(late, ORIGIN, deps({ drainOn: false }).dd);
    const st = async () => Object.fromEntries((await q("SELECT encounter_id, status, last_error_code, attempts FROM spine_job WHERE stage = 'transcript_final' ORDER BY job_id")).map((r) => [r.encounter_id, `${r.status}:${r.last_error_code}:${r.attempts}`]));
    const s0 = await st();
    expect(s0[e1]).toMatch(/^failed:no_covering_windows/); expect(s0[e2]).toMatch(/^failed:windows_not_ready/); expect(s0[e3]).toMatch(/^failed:no_covering_windows/);
    bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    bw({ rd: A18, start: o3, state: "transcribed" }); pg.exec(`UPDATE spine_encounter SET boundary_rev = 1 WHERE encounter_id = '${e3}'`);
    let t = late + 31 * MIN; let revived = 0;
    for (let i = 0; i < 5; i++) { const c = await runTranscriptFinal(t, ORIGIN, deps({ drainOn: false }).dd); revived += (c as { revived: number }).revived; t += 6 * MIN; }
    const s1 = await st();
    expect(revived).toBe(1);
    expect(s1[e1]).toMatch(/^done/); expect(s1[e2]).toBe(s0[e2]);
    const evs = (await events()).map((e) => (e.counts as { encounter_id: string }).encounter_id);
    expect(evs).toEqual([e1]);
  });

  // ---- F7 ------------------------------------------------------------------------------------------------------------------
  it("B10 F7: one revision per change, no storm over 6 passes, A->B->C chains keep order, a re-cut encounter's old cut is not revised", async () => {
    live(); const e = enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const w = bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    redo(w, "b");
    for (let i = 1; i <= 6; i++) await runTranscriptFinal(NOW + i * 6 * MIN, ORIGIN, deps().dd);
    expect((await events()).length).toBe(2);
    pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, transcript_original, created_at) VALUES ('run_c_${w}', 'bench_window', '${w}', 'route', 'third words', now() + interval '2 hour');`);
    await runTranscriptFinal(NOW + 50 * MIN, ORIGIN, deps().dd);
    const ev = (await events()).map((x) => x.counts as { event: string; run_ids: string[]; text: { sha256: string }; revises_sha256?: string });
    expect(ev.map((x) => x.run_ids[0])).toEqual([`run_${w}`, `run_b_${w}`, `run_c_${w}`]);
    expect(ev[2].revises_sha256).toBe(ev[1].text.sha256); expect(ev[1].revises_sha256).toBe(ev[0].text.sha256);
    pg.exec(`UPDATE spine_encounter SET boundary_rev = 1 WHERE encounter_id = '${e}'`);
    pg.exec(`INSERT INTO transcription_run (id, subject_type, subject_id, engine, transcript_original, created_at) VALUES ('run_d_${w}', 'bench_window', '${w}', 'route', 'fourth words', now() + interval '3 hour');`);
    await runTranscriptFinal(NOW + 60 * MIN, ORIGIN, deps().dd);
    expect((await events()).filter((x) => (x.counts as { cut_version: string }).cut_version === "r0").length).toBe(3);
  });

  it("B11 F7: two passes at once append at most ONE revision", async () => {
    live(); enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const w = bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    redo(w, "b");
    await Promise.all([runTranscriptFinal(NOW + 6 * MIN, ORIGIN, deps().dd), runTranscriptFinal(NOW + 6 * MIN, ORIGIN, deps().dd), runTranscriptFinal(NOW + 6 * MIN, ORIGIN, deps().dd)]);
    expect((await events()).length).toBe(2);
  });

  // ---- reaper, defaults --------------------------------------------------------------------------------------------------
  it("B12 reaper: an exhausted transcript_final lease is reaped by the pass; another stage's is not; jobs off = no statement past the config read", async () => {
    live(); enc(); await runSpineEnqueue(NOW);
    pg.exec(`UPDATE spine_job SET status = 'leased', attempts = 6, lease_owner = '${OWNER}', lease_until = '${iso(NOW - MIN)}' WHERE stage IN ('transcript_final', 'recut');`);
    const c = await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    expect(c).toMatchObject({ reaped: 1 });
    const st = Object.fromEntries((await q("SELECT stage, status FROM spine_job WHERE stage IN ('transcript_final', 'recut')")).map((r) => [r.stage, r.status]));
    expect(st).toEqual({ transcript_final: "dead", recut: "leased" });
    for (const v of ['"off"', '"bogus"']) {
      setConfig("jobs", v);
      const n0 = Number((await q("SELECT count(*)::int AS n FROM spine_tick"))[0].n);
      H.stmts = 0;
      expect(await runTranscriptFinal(NOW + 10 * MIN, ORIGIN, deps().dd)).toEqual({ skipped: "off" });
      expect(H.stmts).toBeLessThanOrEqual(1);
      expect(Number((await q("SELECT count(*)::int AS n FROM spine_tick"))[0].n)).toBe(n0);
    }
    setConfig("jobs", '"live"'); setConfig("mode.transcript_final", '"bogus"');
    expect(await runTranscriptFinal(NOW + 20 * MIN, ORIGIN, deps().dd)).toEqual({ skipped: "off" });
  });

  it("B13 BUDGET worst live pass: 6 revivals + 3 claims with offers + 6 revision candidates, statement count", async () => {
    live();
    const ws: string[] = [];
    for (let i = 0; i < 6; i++) { const o = T_OPEN + i * 20 * MIN; enc({ open: o, close: o + 15 * MIN }); ws.push(bw({ rd: A18, start: o, state: "transcribed" })); }
    let at = T_OPEN + 4 * 3_600_000; await runSpineEnqueue(at);
    await runTranscriptFinal(at, ORIGIN, deps().dd); await runTranscriptFinal(at + 6 * MIN, ORIGIN, deps().dd);
    expect((await events()).length).toBe(6);
    const fw: string[] = [];
    for (let i = 0; i < 6; i++) { const o = T_OPEN + 3 * 3_600_000 + i * 20 * MIN; enc({ open: o, close: o + 15 * MIN }); fw.push(bw({ rd: A18, start: o, state: "closed" })); }
    for (let i = 0; i < 3; i++) { const o = T_OPEN + 10 * 3_600_000 + i * 20 * MIN; const r = [ROOM, RB, RC][i]; enc({ room: r, open: o, close: o + 15 * MIN }); bw({ room: r, rd: `rd_${r.slice(5, 9)}18`, start: o, state: "closed" }); }
    at = DEADLINE(T_OPEN + 3 * 3_600_000 + 115 * MIN) + RELEASE_BACKOFF_MS; await runSpineEnqueue(T_OPEN + 10 * 3_600_000);
    await runTranscriptFinal(at, ORIGIN, deps({ drainOn: false }).dd); at += 31 * MIN; await runTranscriptFinal(at, ORIGIN, deps({ drainOn: false }).dd);   // 3 failures open the breaker for 30 min (see B7)
    expect(Number((await q("SELECT count(*)::int AS n FROM spine_job WHERE stage = 'transcript_final' AND status = 'failed'"))[0].n)).toBe(6);
    await runSpineEnqueue(at + 7 * MIN);
    ws.forEach((w) => redo(w, "b"));
    fw.forEach((w) => { pg.exec(`UPDATE bench_window SET state = 'transcribed' WHERE id = '${w}'; INSERT INTO transcription_run (id, subject_type, subject_id, engine) VALUES ('run_${w}', 'bench_window', '${w}', 'route');`); });
    const { offered, dd } = deps();
    const dd2: Deps = { ...dd, offer: async (id) => { offered.push(id); for (let k = 0; k < 10; k++) await q("SELECT 1"); return "enqueued"; } };
    H.stmts = 0; const t0 = Date.now();
    const c = await runTranscriptFinal(at + 40 * MIN, ORIGIN, dd2);
    const wall = Date.now() - t0; const stmts = H.stmts + offered.length * 10;
    console.log(`[oref-r2-budget] ${JSON.stringify(c)} offered ${offered.length} statements ${stmts} wall_ms ${wall} est_neon_ms_at_57ms ${stmts * 57}`);
    expect(stmts * 57).toBeLessThan(60_000);
  }, 120_000);

  // ---- R3 (builder) -----------------------------------------------------------------------------------------------------------
  it("R3 I1: data-driven failures leave no breaker tick; a genuine run of transient failures still opens the breaker", async () => {
    live();
    for (let i = 0; i < 3; i++) enc({ room: ROOM_OFF });
    await runSpineEnqueue(NOW);
    const late = DEADLINE(T_CLOSE) + MIN;
    expect(await runTranscriptFinal(late, ORIGIN, deps().dd)).toMatchObject({ failed: 3 });
    expect(Number((await q("SELECT count(*)::int AS n FROM spine_tick WHERE kind = 'attempt:transcript_final'"))[0].n)).toBe(0);
    pg.exec("TRUNCATE spine_job, spine_encounter, spine_tick RESTART IDENTITY CASCADE;");
    for (let i = 0; i < 3; i++) enc();
    await runSpineEnqueue(NOW);
    const broken: Deps = { ...deps().dd, readWindows: async () => { throw new Error("io"); } };
    expect(await runTranscriptFinal(NOW + 20 * MIN, ORIGIN, broken)).toMatchObject({ errors: 3, breaker_open: false });
    expect(await runTranscriptFinal(NOW + 25 * MIN, ORIGIN, deps().dd)).toMatchObject({ breaker_open: true });
  });

  it("R3 revival: the failure it had stays visible as a transcript_final_revived tick (job, encounter, prior code)", async () => {
    live(); const e1 = enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const late = DEADLINE(T_OPEN + 15 * MIN) + RELEASE_BACKOFF_MS;
    await runTranscriptFinal(late, ORIGIN, deps({ drainOn: false }).dd);
    bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    expect(await runTranscriptFinal(late + MIN, ORIGIN, deps({ drainOn: false }).dd)).toMatchObject({ revived: 1, done: 1 });
    const t = await q("SELECT counts FROM spine_tick WHERE kind = 'transcript_final_revived'");
    expect(t.length).toBe(1);
    expect(t[0].counts).toMatchObject({ encounter_id: e1, prior_error_code: "no_covering_windows" });
  });
});
