/**
 * zz-oref-r4 — Opus refute R4 of spine S7a (8155bfa7), I2b. Throwaway postgres:16. Synthetic ids, INSERT only.
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
const pg = pgContainer("eta-s7a-r4-oref4");
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

d("S7a R4 refute (oref4) on postgres:16", () => {
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

  // Synthetic append-only events (INSERT only), as production writes them: kind, encounter, cut, own windows, own stamps.
  type Ev = { enc: string; win: string; sha: string; rev?: string; close?: number; date?: string; kind?: string; cut?: string };
  const put = (e: Ev) => {
    const c = JSON.stringify({ event: e.rev ? "transcript_final_revised" : "encounter.transcript_final", encounter_id: e.enc, room_id: ROOM, ist_date: e.date ?? "2026-10-18", cut_version: e.cut ?? "r0", window_ids: [e.win],
      stamps: { t_open: iso(T_OPEN), t_close: iso(e.close ?? T_OPEN + 15 * MIN) }, text: { sha256: e.sha, native_chars: 1, english_chars: 1, ref: "r" }, ...(e.rev ? { revises_sha256: e.rev } : {}) });
    pg.exec(`INSERT INTO spine_tick (kind, counts) VALUES ('${e.kind ?? "transcript_final_event"}', '${c}'::jsonb);`);
  };
  const w = (mic: string) => bw({ rd: A18, start: T_OPEN, state: "transcribed", mic });
  type S = { encounter_id: string; text: { sha256: string }; revises_sha256?: string; event_id: number } & Record<string, unknown>;
  const pages = async (limit: number, shadow = false) => {
    const out: S[] = []; let after = 0;
    for (let k = 0; k < 100; k++) { const r = await get(`?after=${after}&limit=${limit}${shadow ? "&shadow=1" : ""}`); out.push(...(r.events as S[])); if (r.next_after === after) break; after = r.next_after; }
    return out;
  };
  // The invariant: every served revises_sha256 names a SERVED event of the same encounter (across all pages).
  const noDangling = (s: S[]) => { const ok = new Set(s.map((e) => `${e.encounter_id}:${e.text.sha256}`)); return s.filter((e) => e.revises_sha256 !== undefined && !ok.has(`${e.encounter_id}:${e.revises_sha256}`)).map((e) => e.text.sha256); };
  const shape = (s: S[]) => s.map((e) => [e.text.sha256, e.revises_sha256 ?? null]);

  for (const limit of [1, 2, 50]) {
    it(`D1 chain A->B->C, both A and B hidden (limit=${limit}): C served bare`, async () => {
      const e = enc(); const [a, b, c] = ["ma", "mb", "mc"].map(w);
      put({ enc: e, win: a, sha: "sA" }); put({ enc: e, win: b, sha: "sB", rev: "sA" }); put({ enc: e, win: c, sha: "sC", rev: "sB" });
      hold(a); hold(b);
      const s = await pages(limit); expect(shape(s)).toEqual([["sC", null]]); expect(noDangling(s)).toEqual([]);
    });
    it(`D2 chain, B hidden only (limit=${limit}): A bare, C bare; A visible on an earlier page`, async () => {
      const e = enc(); const [a, b, c] = ["ma", "mb", "mc"].map(w);
      put({ enc: e, win: a, sha: "sA" }); put({ enc: e, win: b, sha: "sB", rev: "sA" }); put({ enc: e, win: c, sha: "sC", rev: "sB" });
      hold(b);
      const s = await pages(limit); expect(shape(s)).toEqual([["sA", null], ["sC", null]]); expect(noDangling(s)).toEqual([]);
    });
    it(`D3 visible predecessor on an earlier page keeps revises (limit=${limit})`, async () => {
      const e = enc(); const [a, b, c] = ["ma", "mb", "mc"].map(w);
      put({ enc: e, win: a, sha: "sA" }); put({ enc: e, win: b, sha: "sB", rev: "sA" }); put({ enc: e, win: c, sha: "sC", rev: "sB" });
      const s = await pages(limit); expect(shape(s)).toEqual([["sA", null], ["sB", "sA"], ["sC", "sB"]]);
    });
    it(`D4 IST midnight: A closes on a held-out day 2 (day filter, not windows) (limit=${limit})`, async () => {
      H.blind.push(["2026-10-19", ROOM]);
      const e = enc(); const [a, b] = ["ma", "mb"].map(w);
      put({ enc: e, win: a, sha: "sA", close: Date.parse("2026-10-18T18:45:00Z") }); // 00:15 IST on the 19th
      put({ enc: e, win: b, sha: "sB", rev: "sA" });
      const s = await pages(limit); expect(shape(s)).toEqual([["sB", null]]);
    });
    it(`D5 A's ist_date is held out (open day) (limit=${limit})`, async () => {
      H.blind.push(["2026-10-17", ROOM]);
      const e = enc(); const [a, b] = ["ma", "mb"].map(w);
      put({ enc: e, win: a, sha: "sA", date: "2026-10-17" }); put({ enc: e, win: b, sha: "sB", rev: "sA" });
      const s = await pages(limit); expect(shape(s)).toEqual([["sB", null]]);
    });
  }
  it("D6 predecessor absent from storage -> bare", async () => {
    const e = enc(); put({ enc: e, win: w("ma"), sha: "sB", rev: "sNONE" });
    expect(shape(await pages(50))).toEqual([["sB", null]]);
  });
  it("D7 same sha in ANOTHER encounter is visible, own predecessor hidden -> still bare (keyed by encounter)", async () => {
    const e1 = enc(), e2 = enc(); const [a, b, x] = ["ma", "mb", "mx"].map(w);
    put({ enc: e1, win: a, sha: "sA" }); put({ enc: e1, win: b, sha: "sB", rev: "sA" }); put({ enc: e2, win: x, sha: "sA" });
    hold(a);
    expect(shape(await pages(50))).toEqual([["sB", null], ["sA", null]]);
  });
  it("D8 kind scoped: a live predecessor does not satisfy a shadow revision", async () => {
    const e = enc(); const [a, b] = ["ma", "mb"].map(w);
    put({ enc: e, win: a, sha: "sA" }); put({ enc: e, win: b, sha: "sB", rev: "sA", kind: "transcript_final_shadow" });
    expect(shape(await pages(50, true))).toEqual([["sB", null]]);
  });
  it("D9 storage unchanged by reads (append-only): revises still stored, row count same", async () => {
    const e = enc(); const [a, b] = ["ma", "mb"].map(w);
    put({ enc: e, win: a, sha: "sA" }); put({ enc: e, win: b, sha: "sB", rev: "sA" }); hold(a);
    const before = JSON.stringify(await q("SELECT id, kind, counts FROM spine_tick ORDER BY id"));
    await pages(1); await pages(50);
    expect(JSON.stringify(await q("SELECT id, kind, counts FROM spine_tick ORDER BY id"))).toBe(before);
    expect(((await events())[1].counts as { revises_sha256?: string }).revises_sha256).toBe("sA");
  });
  it("D10 nothing else about a bare event changes: same keys minus revises_sha256", async () => {
    const e = enc(); const [a, b, c] = ["ma", "mb", "mc"].map(w);
    put({ enc: e, win: a, sha: "sA" }); put({ enc: e, win: b, sha: "sB", rev: "sA" });
    const vis = (await pages(50))[1];
    hold(a);
    const bare = (await pages(50))[0];
    const { revises_sha256: _r, ...rest } = vis; void _r; void c;
    expect(bare).toEqual(rest);
    expect(JSON.stringify(bare)).not.toContain("sA");
  });
  it("D11 bounded: a page of 120 revisions over 120 encounters costs a constant number of statements", async () => {
    const cost = async (n: number) => {
      pg.exec("TRUNCATE spine_tick RESTART IDENTITY;");
      for (let i = 0; i < n; i++) { const e = `enc_d11${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}zzzzzzzzzz`; put({ enc: e, win: `bw_x${i}`, sha: `s${i}a` }); put({ enc: e, win: `bw_y${i}`, sha: `s${i}b`, rev: `s${i}a` }); }
      H.stmts = 0; const r = await get("?limit=200"); return { st: H.stmts, revs: (r.events as S[]).filter((x) => x.revises_sha256).length };
    };
    const small = await cost(2), big = await cost(100);
    expect(small.revs).toBe(2); expect(big.revs).toBe(100);
    expect(big.st).toBe(small.st);
  });
  it("D12 C3 through the real executor, paged limit=1", async () => {
    live(); enc({ close: T_OPEN + 15 * MIN }); await runSpineEnqueue(NOW);
    const b = bw({ rd: A18, start: T_OPEN, state: "transcribed", mic: "backup" });
    await runTranscriptFinal(NOW, ORIGIN, deps().dd);
    bw({ rd: A18, start: T_OPEN, state: "transcribed" });
    await runTranscriptFinal(NOW + 5 * MIN, ORIGIN, deps().dd);
    const vis = await pages(1); expect(vis.length).toBe(2); expect(vis[1].revises_sha256).toBe(vis[0].text.sha256);
    hold(b);
    const s = await pages(1); expect(s.length).toBe(1); expect(s[0].revises_sha256).toBeUndefined(); expect(JSON.stringify(s)).not.toContain(vis[0].text.sha256);
  });
});
