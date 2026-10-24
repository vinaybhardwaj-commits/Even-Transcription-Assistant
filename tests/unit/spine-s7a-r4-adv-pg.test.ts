/**
 * adopted from zz-oref-r3 (R4) — Opus refute R3 of spine S7a (e38ad691). Throwaway postgres:16. Synthetic ids, no DELETE.
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
const pg = pgContainer("eta-s7a-r3-oref3");
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

d("S7a R3 refute (oref3) on postgres:16", () => {
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

  const attempts = async () => Number((await q("SELECT count(*)::int AS n FROM spine_tick WHERE kind = 'attempt:transcript_final'"))[0].n);
  const hold = (w: string) => pg.exec(`INSERT INTO room_turn_speaker VALUES ('${w}', 'rd_a16');`);
  const dangling = async () => {
    const all = (await events()).map((r) => r.counts as { text: { sha256: string } });
    const served = (await get("")).events as Array<{ text: { sha256: string }; revises_sha256?: string }>;
    const shas = new Set(served.map((e) => e.text.sha256));
    return { all: all.length, served: served.length, dangling: served.filter((e) => e.revises_sha256 !== undefined && !shas.has(e.revises_sha256)).length };
  };

  it("C1 I1: 20 off-room + 3 hole (windows_not_ready) + 2 blind_room_day failures leave 0 attempt ticks; a healthy final is claimed the next pass", async () => {
    live();
    for (let i = 0; i < 20; i++) enc({ room: ROOM_OFF });
    for (let i = 0; i < 3; i++) enc({ room: RB });
    for (let i = 0; i < 2; i++) enc({ date: "2026-10-16", open: Date.parse("2026-10-16T04:00:00Z"), close: Date.parse("2026-10-16T04:20:00Z") });
    bw({ room: RB, rd: "rd_bbbb18", start: T_OPEN, state: "transcribed" });   // 04:00-04:15 only: a tail hole
    await runSpineEnqueue(NOW);
    const late = DEADLINE(T_CLOSE) + MIN;
    let failed = 0;
    for (let k = 0; k < 12; k++) failed += Number(((await runTranscriptFinal(late + k * MIN, ORIGIN, deps().dd)) as { failed?: number }).failed ?? 0);
    expect(failed).toBe(25);
    expect(await attempts()).toBe(0);
    const o = late - 3 * 3_600_000; enc({ open: o, close: o + 15 * MIN }); bw({ rd: A18, start: o, state: "transcribed" });
    await runSpineEnqueue(late + 15 * MIN);
    expect(await runTranscriptFinal(late + 15 * MIN, ORIGIN, deps().dd)).toMatchObject({ breaker_open: false, done: 1 });
  });

  it("C2 I1 other way: transient failures AFTER ready (readRuns throws) are ticked and open the breaker", async () => {
    live();
    for (let i = 0; i < 3; i++) { const o = T_OPEN - i * 20 * MIN; enc({ open: o, close: o + 15 * MIN }); bw({ rd: A18, start: o, state: "transcribed" }); }
    await runSpineEnqueue(NOW);
    const broken: Deps = { ...deps().dd, readRuns: async () => { throw new Error("io"); } };
    expect(await runTranscriptFinal(NOW, ORIGIN, broken)).toMatchObject({ errors: 3 });
    expect(await attempts()).toBe(3);
    expect(await runTranscriptFinal(NOW + 5 * MIN, ORIGIN, deps().dd)).toMatchObject({ breaker_open: true });
  });

  it("C3 I2: backup event A, primary arrives -> revision B, then the BACKUP is held out: no served event names a filtered sha", async () => {
    live(); enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const b = bw({ rd: A18, start: T_OPEN, state: "transcribed", mic: "backup" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW + 5 * MIN, ORIGIN, deps().dd);
    expect((await events()).length).toBe(2);
    hold(b);
    await runTranscriptFinal(NOW + 10 * MIN, ORIGIN, deps().dd);
    expect((await dangling()).dangling, "a served revision names the sha of an event the read filter drops").toBe(0);
  });

  it("C4 I2: revision then its window held out: nothing served, no further revision over 3 passes even with a new rerun", async () => {
    live(); enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const p = bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    redo(p, "x1"); await runTranscriptFinal(NOW + 5 * MIN, ORIGIN, deps().dd);
    expect((await events()).length).toBe(2);
    hold(p); redo(p, "x2", "third words");
    for (let k = 2; k < 5; k++) await runTranscriptFinal(NOW + k * 5 * MIN, ORIGIN, deps().dd);
    expect(await dangling()).toMatchObject({ all: 2, served: 0, dangling: 0 });
  });

  it("C5 I2 midnight: 2-window encounter across 00:00 IST; day-2 window held out, day-1 window rerun -> no revision (some, not every)", async () => {
    live();
    const o = Date.parse("2026-10-18T18:15:00Z"), cl = o + 30 * MIN, now = cl + 40 * MIN;
    enc({ open: o, close: cl }); await runSpineEnqueue(now);
    const w1 = bw({ rd: A18, start: o, state: "transcribed" }); const w2 = bw({ rd: A19, start: o + 15 * MIN, state: "transcribed" });
    expect(await runTranscriptFinal(now, ORIGIN, deps().dd)).toMatchObject({ done: 1 });
    hold(w2); redo(w1, "m1");
    for (let k = 1; k < 4; k++) await runTranscriptFinal(now + k * 5 * MIN, ORIGIN, deps().dd);
    expect(await dangling()).toMatchObject({ all: 1, served: 0, dangling: 0 });
  });

  it("C6 I2 liveness: once the hold-out is lifted, a genuine rerun still mints exactly one revision", async () => {
    live(); enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const p = bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    hold(p); await runTranscriptFinal(NOW + 5 * MIN, ORIGIN, deps().dd);
    pg.exec(`UPDATE room_turn_speaker SET room_day_id = 'rd_abcd18' WHERE window_id = '${p}';`);
    redo(p, "l1");
    for (let k = 2; k < 5; k++) await runTranscriptFinal(NOW + k * 5 * MIN, ORIGIN, deps().dd);
    expect(await dangling()).toMatchObject({ all: 2, served: 2, dangling: 0 });
  });

  it("C7 revival: one revived tick, one event, the job ends done, over 4 passes; the failed outcome had no breaker tick", async () => {
    live(); const e1 = enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const late = DEADLINE(T_OPEN + 15 * MIN) + RELEASE_BACKOFF_MS;
    await runTranscriptFinal(late, ORIGIN, deps({ drainOn: false }).dd);
    expect(await attempts()).toBe(0);
    bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    for (let k = 1; k < 5; k++) await runTranscriptFinal(late + k * MIN, ORIGIN, deps({ drainOn: false }).dd);
    const t = await q("SELECT counts FROM spine_tick WHERE kind = 'transcript_final_revived'");
    expect(t.length).toBe(1);
    expect(t[0].counts).toMatchObject({ encounter_id: e1, cut_version: "r0", prior_error_code: "no_covering_windows" });
    expect(Object.keys(t[0].counts as object).sort()).toEqual(["cut_version", "encounter_id", "job_id", "prior_error_code"]);
    expect((await events()).length).toBe(1);
    expect((await q("SELECT status FROM spine_job WHERE stage = 'transcript_final'"))[0].status).toBe("done");
    expect(await attempts()).toBe(1);
  });

  it("C8 defaults: jobs off and shadow mode write no attempt / revived tick and no event", async () => {
    enc({ close: T_OPEN + 15 * MIN }); bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    expect(await runTranscriptFinal(NOW, ORIGIN, deps().dd)).toEqual({ skipped: "off" });
    setConfig("jobs", '"live"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, '"live"'); setConfig("mode.transcript_final", '"shadow"');
    await runSpineEnqueue(NOW);
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    expect(Number((await q("SELECT count(*)::int AS n FROM spine_tick WHERE kind IN ('attempt:transcript_final', 'transcript_final_revived', 'transcript_final_event')"))[0].n)).toBe(0);
  });
  it("C9 I2 (kills some->every): 2 spans, span-2 primary held out while its backup is transcribed -> no revision is minted", async () => {
    live(); enc({ close: T_OPEN + 30 * MIN }); await runSpineEnqueue(NOW);
    bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    const p2 = bw({ rd: A18, start: T_OPEN + 15 * MIN, state: "transcribed" }); bw({ rd: A18, start: T_OPEN + 15 * MIN, state: "transcribed", mic: "backup" });
    expect(await runTranscriptFinal(NOW, ORIGIN, deps().dd)).toMatchObject({ done: 1 });
    hold(p2);
    for (let k = 1; k < 4; k++) await runTranscriptFinal(NOW + k * 5 * MIN, ORIGIN, deps().dd);
    expect(await dangling()).toMatchObject({ all: 1, served: 0, dangling: 0 });
  });

  // R4 chain cases: synthetic append-only event rows (INSERT only), A -> B -> C each over its own window.
  async function chain(hide: string[]) {
    const e = enc({ close: T_OPEN + 15 * MIN });
    const ws = ["a", "b", "c"].map((k) => bw({ rd: A18, start: T_OPEN, state: "transcribed", mic: `m${k}` }));
    const ev = (i: number) => JSON.stringify({ event: "transcript_final", encounter_id: e, room_id: ROOM, ist_date: "2026-10-18", cut_version: "r0", window_ids: [ws[i]], stamps: { t_open: iso(T_OPEN), t_close: iso(T_OPEN + 15 * MIN) }, text: { sha256: `sha_${i}`, native_chars: 1, english_chars: 1, ref: "r" }, ...(i > 0 ? { revises_sha256: `sha_${i - 1}` } : {}) });
    for (let i = 0; i < 3; i++) pg.exec(`INSERT INTO spine_tick (kind, counts) VALUES ('transcript_final_event', '${ev(i)}'::jsonb);`);
    for (const h of hide) hold(ws[Number(h)]);
    return (await get("")).events as Array<{ text: { sha256: string }; revises_sha256?: string }>;
  }
  it("R4 chain A->B->C: nothing hidden keeps both links", async () => {
    const s = await chain([]);
    expect(s.map((x) => x.revises_sha256)).toEqual([undefined, "sha_0", "sha_1"]);
  });
  it("R4 chain: only A hidden -> B served without revises, C still names B", async () => {
    const s = await chain(["0"]);
    expect(s.map((x) => [x.text.sha256, x.revises_sha256])).toEqual([["sha_1", undefined], ["sha_2", "sha_1"]]);
  });
  it("R4 chain: B hidden -> C served without revises", async () => {
    const s = await chain(["1"]);
    expect(s.map((x) => [x.text.sha256, x.revises_sha256])).toEqual([["sha_0", undefined], ["sha_2", undefined]]);
  });
});
