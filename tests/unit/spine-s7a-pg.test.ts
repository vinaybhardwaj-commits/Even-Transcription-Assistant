/**
 * spine-s7a-pg.test.ts — SPINE S7a: the `transcript_final` stage on a REAL postgres:16 (migration 0173 + 0176; never on the Mini, never Neon).
 * The room side (windows, runs, the drain) is a stand-in object passed as `deps`; the room reader's own SQL is proven in the last describe against minimal stub tables.
 * Synthetic ids only; the "transcript" strings are placeholder words. Append-only: no DELETE anywhere; states are reached the way production reaches them (a new row, an UPDATE the writer itself makes).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => {
  const run = (text: string, params: unknown[]) => {
    const order: number[] = [];
    const parts = text.split(/\$(\d+)/);
    const strings: string[] = [];
    for (let i = 0; i < parts.length; i += 2) { strings.push(parts[i]); if (i + 1 < parts.length) order.push(Number(parts[i + 1]) - 1); }
    return H.tag!(Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray, ...order.map((n) => params[n]));
  };
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});
vi.mock("@/lib/rubrics/blind-room-days", async (orig) => {
  const real = await orig<typeof import("@/lib/rubrics/blind-room-days")>();
  const BLIND_ROOM_DAYS = [["2026-10-18", "room_blindtest"]] as const;
  return { ...real, BLIND_ROOM_DAYS, isBlindRoomDay: (d: string | null | undefined, r: string | null | undefined) => typeof d === "string" && typeof r === "string" && BLIND_ROOM_DAYS.some(([bd, br]) => bd === d.slice(0, 10) && br === r) };
});

import { runSpineEnqueue } from "@/lib/spine/enqueue-store";
import { runTranscriptFinal, recordFinal, type Deps } from "@/lib/spine/transcript-final-store";
import { MAX_WAIT_MS, type CoveringWindow, type RunText } from "@/lib/spine/transcript-final";
import { readFinalEvents } from "@/lib/spine/transcript-final-read";
import { readCoveringWindows, readRunTexts } from "@/lib/room-access/readers/spine-transcript";
import { CLOSE_GRACE_MS, FREE_STAGES } from "@/lib/spine/enqueue";
import { RELEASE_BACKOFF_MS } from "@/lib/spine/retry";
import { POST as claimPost } from "@/app/api/spine/claim/route";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-s7a");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");
const d = HAVE_DOCKER ? describe : describe.skip;

describe("REQUIRED PROOF — spine S7a runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-s7a-pg.test.ts needs Docker for postgres:16. Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const ORIGIN = "https://x.test";
const NOW = Date.parse("2026-10-18T08:00:00Z");
const T_OPEN = Date.parse("2026-10-18T04:00:00Z");
const T_CLOSE = Date.parse("2026-10-18T04:20:00Z");
const ROOM = "room_abcd2345";
const ENC = "enc_aaaaaaaaaaaaaaaa", ENC2 = "enc_bbbbbbbbbbbbbbbb", ENC3 = "enc_cccccccccccccccc", ENC4 = "enc_dddddddddddddddd", ENC5 = "enc_eeeeeeeeeeeeeeee";
const iso = (ms: number) => new Date(ms).toISOString();

const q = async (text: string, ...v: unknown[]): Promise<Array<Record<string, unknown>>> => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const num = async (text: string) => Number(Object.values((await q(text))[0])[0]);
const setConfig = (key: string, json: string) => pg.exec(`INSERT INTO spine_config (key, value) VALUES ('${key}', '${json}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
const live = () => { setConfig("jobs", '"live"'); for (const s of FREE_STAGES) setConfig(`mode.${s}`, '"live"'); };
function enc(id: string, o: { status?: string; rev?: number; open?: number; close?: number | null; flags?: string[]; room?: string } = {}) {
  const close = o.close === undefined ? T_CLOSE : o.close;
  pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, boundary_rev, merge_version, flags)
    VALUES ('${id}', '2026-10-18', '${o.room ?? ROOM}', '${iso(o.open ?? T_OPEN)}', ${close === null ? "NULL" : `'${iso(close)}'`}, '${o.status ?? "confirmed"}', ${o.rev ?? 0}, 'v_test', '{${(o.flags ?? []).join(",")}}');`);
}
const jobs = (stage = "transcript_final") => q(`SELECT encounter_id, cut_version, status, attempts, next_attempt_at, last_error_code, last_error_class FROM spine_job WHERE stage = '${stage}' ORDER BY job_id`);

// ---- the room stand-in -------------------------------------------------------------------------------------------------------
type Win = Partial<CoveringWindow> & { id: string; start: number };
const MIN = 60_000;
const win = (w: Win): CoveringWindow => ({
  id: w.id, start_ms: T_OPEN + w.start * 15 * MIN, end_ms: T_OPEN + (w.start + 1) * 15 * MIN, source_mic: w.source_mic ?? "primary", state: w.state ?? "transcribed",
  run_id: w.run_id === undefined ? (w.state === undefined || w.state === "transcribed" ? `run_${w.id}` : null) : w.run_id,
  run_at_ms: w.run_at_ms === undefined ? NOW - 3_600_000 : w.run_at_ms, closed_at_ms: w.closed_at_ms ?? T_OPEN, refused_at_ms: w.refused_at_ms ?? null, refused_reason: w.refused_reason ?? null, job_open: w.job_open ?? false,
});
function room(windows: CoveringWindow[], o: { drainOn?: boolean; blind?: number; engine?: string } = {}) {
  const st = { windows, offered: [] as string[], reads: 0, blind: o.blind ?? 0 };
  const deps: Deps = {
    readWindows: async () => { st.reads += 1; return { windows: st.windows, blind_excluded: st.blind }; },
    readRuns: async (ids) => ids.map((id): RunText => ({ run_id: id, window_id: id.replace("run_", ""), engine: o.engine ?? "route", original: `placeholder words ${id}`, english: `english words ${id}` })),
    offer: async (id) => { st.offered.push(id); return "enqueued"; },
    drainOn: () => o.drainOn ?? true, cooldownMs: 3_600_000, rng: () => 0.5,
  };
  return { st, deps };
}
const events = () => q("SELECT counts FROM spine_tick WHERE kind = 'transcript_final_event' ORDER BY id");

d("spine S7a transcript_final on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); });
  beforeEach(() => { pg.exec("TRUNCATE spine_signal, spine_encounter, spine_link, spine_job, spine_artefact, spine_tick, spine_config RESTART IDENTITY CASCADE;"); });

  describe("enqueue (P2): which encounters get the stage", () => {
    it("CONFIRMED only: never candidate, confirmed_single_proxy, merged or rejected; not inside the grace; idempotent rerun writes 0 rows", async () => {
      live();
      enc(ENC); enc(ENC2, { status: "candidate" }); enc(ENC3, { status: "confirmed_single_proxy" }); enc(ENC4, { status: "merged" }); enc(ENC5, { status: "rejected" });
      enc("enc_ffffffffffffffff", { open: NOW - 30 * MIN, close: NOW - 14 * MIN });        // closed 14 min ago: inside the 15 min grace
      enc("enc_gggggggggggggggg", { open: T_OPEN, close: null });                           // still open
      const a = await runSpineEnqueue(NOW);
      expect(a).toMatchObject({ jobs: "live" });
      expect((await jobs()).map((j) => [j.encounter_id, j.status, j.cut_version])).toEqual([[ENC, "queued", "r0"]]);
      const before = await num("SELECT count(*) FROM spine_job");
      const b = await runSpineEnqueue(NOW);
      expect(b).toMatchObject({ queued: 0, shadow: 0 });
      expect(await num("SELECT count(*) FROM spine_job")).toBe(before);
    });
    it("the grace: the job appears once t_close + 15 min has passed, not a millisecond before", async () => {
      live(); enc(ENC);
      await runSpineEnqueue(T_CLOSE + CLOSE_GRACE_MS - 1);
      expect(await jobs()).toEqual([]);
      await runSpineEnqueue(T_CLOSE + CLOSE_GRACE_MS);
      expect((await jobs()).length).toBe(1);
    });
    it("a boundary change re-plans: a new r<rev> job, the old cut superseded (never deleted)", async () => {
      live(); enc(ENC);
      await runSpineEnqueue(NOW);
      pg.exec(`UPDATE spine_encounter SET boundary_rev = 1 WHERE encounter_id = '${ENC}';`);
      await runSpineEnqueue(NOW + MIN);
      expect((await jobs()).map((j) => [j.cut_version, j.status])).toEqual([["r0", "superseded"], ["r1", "queued"]]);
    });
    it("jobs=shadow or mode shadow: the row is status shadow (never claimable)", async () => {
      setConfig("jobs", '"live"'); setConfig("mode.transcript_final", '"shadow"'); enc(ENC);
      await runSpineEnqueue(NOW);
      expect((await jobs()).map((j) => j.status)).toEqual(["shadow"]);
    });
  });

  describe("executor gate", () => {
    it("missing, off, malformed, killed -> skipped, nothing read, nothing written, not even a tick", async () => {
      enc(ENC); live(); await runSpineEnqueue(NOW);
      const r = room([win({ id: "w0", start: 0 })]);
      for (const cfg of [[], [["jobs", '"off"']], [["jobs", '"live"'], ["mode.transcript_final", '"off"']], [["jobs", '"live"'], ["mode.transcript_final", '"on"']], [["jobs", '"live"'], ["mode.transcript_final", '{"mode":"x"}']], [["jobs", '"live"'], ["mode.transcript_final", '"live"'], ["kill_switch", '{"on": true}']], [["jobs", '"live"'], ["mode.transcript_final", '"live"'], ["kill_switch", '"yes"']]] as Array<Array<[string, string]>>) {
        pg.exec("TRUNCATE spine_config;");
        for (const [k, v] of cfg) setConfig(k, v);
        const before = await num("SELECT count(*) FROM spine_tick");
        expect(await runTranscriptFinal(NOW, ORIGIN, r.deps)).toEqual({ skipped: "off" });
        expect(await num("SELECT count(*) FROM spine_tick")).toBe(before);
      }
      expect(r.st.reads).toBe(0);
      expect(r.st.offered).toEqual([]);
      expect((await jobs())[0].status).toBe("queued");
      expect(await num("SELECT count(*) FROM spine_artefact")).toBe(0);
    });
  });

  describe("live executor", () => {
    beforeEach(async () => { live(); enc(ENC); await runSpineEnqueue(NOW); });

    it("a missing window is requested through the drain, the job is requeued with a short next_attempt, and the event waits until every window is terminal", async () => {
      const r = room([win({ id: "w0", start: 0 }), win({ id: "w1", start: 1, state: "closed" }), win({ id: "w2", start: 2, state: "silent", run_id: null })]);
      const c = await runTranscriptFinal(NOW, ORIGIN, r.deps);
      expect(c).toMatchObject({ mode: "live", claimed: 1, waiting: 1, offered: 1, done: 0 });
      expect(r.st.offered).toEqual(["w1"]);
      const j = (await jobs())[0];
      expect(j).toMatchObject({ status: "queued", attempts: 0 });
      expect(Date.parse(String(j.next_attempt_at)) - NOW).toBe(RELEASE_BACKOFF_MS);
      expect(await events()).toEqual([]);
      expect(await num("SELECT count(*) FROM spine_artefact")).toBe(0);
      // not claimable before next_attempt
      expect(await runTranscriptFinal(NOW + 1000, ORIGIN, r.deps)).toMatchObject({ claimed: 0 });
      // the drain finishes w1; the next pass assembles
      r.st.windows[1] = win({ id: "w1", start: 1, run_at_ms: NOW + MIN });
      const later = NOW + RELEASE_BACKOFF_MS + 1000;
      expect(await runTranscriptFinal(later, ORIGIN, r.deps)).toMatchObject({ claimed: 1, done: 1, waiting: 0 });
      expect((await jobs())[0].status).toBe("done");
      const ev = (await events()).map((e) => e.counts as Record<string, unknown>);
      expect(ev.length).toBe(1);
      expect(ev[0]).toMatchObject({
        event: "encounter.transcript_final", mode: "live", encounter_id: ENC, cut_version: "r0", room_id: ROOM, ist_date: "2026-10-18", engine: "route",
        windows: { covering: 3, transcribed: 2, silent: 1, refused: 0, pending: 0, blind_excluded: 0 }, run_ids: ["run_w0", "run_w1"], window_ids: ["w0", "w1", "w2"],
        stamps: { t_close: iso(T_CLOSE), final_at: iso(later), windows_ready_at: iso(NOW + MIN) },
      });
      expect((ev[0].stamps as Record<string, string>).enqueued_at).toBeTruthy();
      expect(JSON.stringify(ev[0])).not.toContain("placeholder words");   // refs and counts only
      const art = await q("SELECT stage, engine, cut_version, store, object_key, status, source_table, length(sha256) AS n FROM spine_artefact");
      expect(art).toEqual([{ stage: "transcript_final", engine: "route", cut_version: "r0", store: "neon", object_key: "transcription_run:run_w0,run_w1", status: "ok", source_table: "transcription_run", n: 64 }]);
    });

    it("idempotent: a rerun (and a direct second record) adds 0 rows", async () => {
      const r = room([win({ id: "w0", start: 0 })]);
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      const snap = async () => [await num("SELECT count(*) FROM spine_artefact"), await num("SELECT count(*) FROM spine_tick WHERE kind = 'transcript_final_event'"), await num("SELECT count(*) FROM spine_job")];
      const before = await snap();
      expect(before).toEqual([1, 1, 2]);   // recut + transcript_final: the other stages wait for recut to be done
      await runTranscriptFinal(NOW + 1000, ORIGIN, r.deps);
      await runSpineEnqueue(NOW + 2000);
      expect(await snap()).toEqual(before);
      const ev = (await events())[0].counts as never;
      expect(await recordFinal(ev, { run_ids: ["run_w0"], sha256: "0".repeat(64), empty: false })).toEqual({ event: false, artefact: false });
      expect(await snap()).toEqual(before);
    });

    it("all windows silent or refused: still a final (artefact status empty), the counts say so", async () => {
      const r = room([win({ id: "w0", start: 0, state: "silent", run_id: null }), win({ id: "w1", start: 1, state: "failed", run_id: null })]);
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      expect(((await events())[0].counts as { windows: unknown }).windows).toMatchObject({ covering: 2, transcribed: 0, silent: 1, refused: 1 });
      expect((await q("SELECT status FROM spine_artefact"))[0].status).toBe("empty");
    });

    it("bounded wait: past t_close + grace + MAX_WAIT the job FAILS with a reason (no event, no more offers); before it, it keeps waiting", async () => {
      const r = room([win({ id: "w0", start: 0, state: "closed" })]);
      const deadline = T_CLOSE + CLOSE_GRACE_MS + MAX_WAIT_MS;
      await runTranscriptFinal(deadline - 1, ORIGIN, r.deps);
      expect((await jobs())[0].status).toBe("queued");
      const offers = r.st.offered.length;
      await runTranscriptFinal(deadline + RELEASE_BACKOFF_MS, ORIGIN, r.deps);
      expect(await jobs()).toMatchObject([{ status: "failed", last_error_code: "windows_not_ready", last_error_class: "permanent" }]);
      expect(r.st.offered.length).toBe(offers);
      expect(await events()).toEqual([]);
    });

    it("no covering windows at all: waits, then fails no_covering_windows (we never looked is not 'nothing there')", async () => {
      const r = room([]);
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      expect((await jobs())[0].status).toBe("queued");
      await runTranscriptFinal(T_CLOSE + CLOSE_GRACE_MS + MAX_WAIT_MS + RELEASE_BACKOFF_MS, ORIGIN, r.deps);
      expect((await jobs())[0]).toMatchObject({ status: "failed", last_error_code: "no_covering_windows" });
    });

    it("the drain switched off (ROOM_AUTO_DRAIN_ENABLED): no offer is made, the job just waits", async () => {
      const r = room([win({ id: "w0", start: 0, state: "closed" })], { drainOn: false });
      expect(await runTranscriptFinal(NOW, ORIGIN, r.deps)).toMatchObject({ waiting: 1, offered: 0 });
      expect(r.st.offered).toEqual([]);
    });

    it("never offers more than the cap per pass, nor a window already in the drain's queue or refused within the cooldown", async () => {
      const r = room([win({ id: "w0", start: 0, state: "closed", job_open: true }), win({ id: "w1", start: 1, state: "closed", refused_at_ms: NOW - MIN, refused_reason: "flag_off" }),
        win({ id: "w2", start: 2, state: "closed" }), win({ id: "w3", start: 3, state: "closed" }), win({ id: "w4", start: 4, state: "closed" })]);
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      expect(r.st.offered).toEqual(["w2", "w3"]);
    });

    it("a blind room-day is refused before ANY room read", async () => {
      pg.exec(`UPDATE spine_encounter SET room_id = 'room_blindtest' WHERE encounter_id = '${ENC}';`);
      const r = room([win({ id: "w0", start: 0 })]);
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      expect(r.st.reads).toBe(0);
      expect((await jobs())[0]).toMatchObject({ status: "failed", last_error_code: "blind_room_day" });
      expect(await events()).toEqual([]);
    });

    it("blind windows are only counted, never assembled", async () => {
      const r = room([win({ id: "w0", start: 0 })], { blind: 2 });
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      expect(((await events())[0].counts as { windows: { blind_excluded: number } }).windows.blind_excluded).toBe(2);
    });

    it("an encounter that is no longer confirmed (merged after the job was queued) gets no event", async () => {
      pg.exec(`UPDATE spine_encounter SET status = 'merged' WHERE encounter_id = '${ENC}';`);
      const r = room([win({ id: "w0", start: 0 })]);
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      expect((await jobs())[0]).toMatchObject({ status: "failed", last_error_code: "not_confirmed" });
      expect(await events()).toEqual([]);
      expect(r.st.reads).toBe(0);
    });

    it("a frozen encounter gets no event", async () => {
      pg.exec(`UPDATE spine_encounter SET flags = '{frozen}' WHERE encounter_id = '${ENC}';`);
      await runTranscriptFinal(NOW, ORIGIN, room([win({ id: "w0", start: 0 })]).deps);
      expect((await jobs())[0]).toMatchObject({ status: "failed", last_error_code: "frozen" });
    });

    it("O4: a run of any engine but route is refused at assembly (the job goes back, retried, no event)", async () => {
      const r = room([win({ id: "w0", start: 0 })], { engine: "sarvam" });
      expect(await runTranscriptFinal(NOW, ORIGIN, r.deps)).toMatchObject({ errors: 1, done: 0 });
      expect(await events()).toEqual([]);
      expect(await num("SELECT count(*) FROM spine_artefact")).toBe(0);
      expect((await jobs())[0]).toMatchObject({ status: "queued", last_error_class: "transient", last_error_code: "exec_error" });
    });

    it("a reader failure is a transient error: backoff, no event, no text in the code", async () => {
      const r = room([]); r.deps.readWindows = async () => { throw new Error("boom with words"); };
      expect(await runTranscriptFinal(NOW, ORIGIN, r.deps)).toMatchObject({ errors: 1 });
      expect((await jobs())[0]).toMatchObject({ status: "queued", attempts: 1, last_error_code: "exec_error" });
    });

    it("a boundary change makes a NEW event for the new cut; the old one stays and is no longer current", async () => {
      const r = room([win({ id: "w0", start: 0 })]);
      await runTranscriptFinal(NOW, ORIGIN, r.deps);
      pg.exec(`UPDATE spine_encounter SET boundary_rev = 1 WHERE encounter_id = '${ENC}';`);
      await runSpineEnqueue(NOW + MIN);
      await runTranscriptFinal(NOW + 2 * MIN, ORIGIN, r.deps);
      const ev = (await events()).map((e) => (e.counts as { cut_version: string }).cut_version);
      expect(ev).toEqual(["r0", "r1"]);
      expect(await num("SELECT count(*) FROM spine_artefact")).toBe(2);
      pg.exec(`INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC}', 'consult_uid', 'uid_test_01', 'exact'), ('${ENC}', 'consult_key', 'uid_test_01@mach_test', 'exact');`);
      const feed = await readFinalEvents();
      expect(feed.events.map((e) => [e.cut_version, e.current, e.consult_uid, e.consult_key])).toEqual([["r0", false, "uid_test_01", "uid_test_01@mach_test"], ["r1", true, "uid_test_01", "uid_test_01@mach_test"]]);
      expect((await readFinalEvents({ after: feed.events[0].event_id })).events.length).toBe(1);
    });
  });

  describe("shadow executor", () => {
    beforeEach(async () => { setConfig("jobs", '"live"'); setConfig("mode.transcript_final", '"shadow"'); enc(ENC); await runSpineEnqueue(NOW); });

    it("offers nothing, leases nothing, emits no live event or artefact; a job that WOULD emit is recorded once as a shadow tick", async () => {
      const r = room([win({ id: "w0", start: 0 }), win({ id: "w1", start: 1, state: "closed" })]);
      expect(await runTranscriptFinal(NOW, ORIGIN, r.deps)).toMatchObject({ mode: "shadow", waiting: 1, would_offer: 1, would_emit: 0, offered: 0 });
      expect(r.st.offered).toEqual([]);
      r.st.windows[1] = win({ id: "w1", start: 1 });
      expect(await runTranscriptFinal(NOW + MIN, ORIGIN, r.deps)).toMatchObject({ would_emit: 1 });
      expect(await runTranscriptFinal(NOW + 2 * MIN, ORIGIN, r.deps)).toMatchObject({ claimed: 0, would_emit: 0 });
      expect(await num("SELECT count(*) FROM spine_tick WHERE kind = 'transcript_final_shadow'")).toBe(1);
      const sh = (await q("SELECT counts FROM spine_tick WHERE kind = 'transcript_final_shadow'"))[0].counts as { mode: string; windows: unknown; stamps: Record<string, string> };
      expect(sh.mode).toBe("shadow");
      expect(sh.windows).toMatchObject({ covering: 2, transcribed: 2 });
      expect(sh.stamps.final_at).toBe(iso(NOW + MIN));
      expect(await events()).toEqual([]);
      expect(await num("SELECT count(*) FROM spine_artefact")).toBe(0);
      expect((await jobs())[0]).toMatchObject({ status: "shadow", attempts: 0 });
      expect((await readFinalEvents()).events).toEqual([]);
      expect((await readFinalEvents({ shadow: true })).events.length).toBe(1);
    });

    it("jobs=shadow caps a live stage at shadow", async () => {
      pg.exec("TRUNCATE spine_config;"); setConfig("jobs", '"shadow"'); setConfig("mode.transcript_final", '"live"');
      const r = room([win({ id: "w0", start: 0, state: "closed" })]);
      expect(await runTranscriptFinal(NOW, ORIGIN, r.deps)).toMatchObject({ mode: "shadow", offered: 0 });
      expect(r.st.offered).toEqual([]);
    });
  });

  describe("the box runner never gets this stage", () => {
    it("/api/spine/claim hands out other live jobs but never a transcript_final job", async () => {
      process.env.SPINE_BEARER_TOKEN = "tok_test";
      live(); enc(ENC); await runSpineEnqueue(NOW);
      const res = await claimPost(new Request("https://x.test/api/spine/claim", { method: "POST", headers: { authorization: "Bearer tok_test", "content-type": "application/json" }, body: JSON.stringify({ owner: "box_test", limit: 5, live: true }) }) as never);
      const body = (await res.json()) as { ok: boolean; jobs: Array<{ stage: string }> };
      expect(body.ok).toBe(true);
      expect(body.jobs.length).toBeGreaterThan(0);
      expect(body.jobs.map((j) => j.stage)).not.toContain("transcript_final");
      expect((await jobs())[0].status).toBe("queued");
      delete process.env.SPINE_BEARER_TOKEN;
    });
  });
});

// ---- the room reader's SQL, against minimal stub tables -------------------------------------------------------------------------
d("spine S7a room reader (stub room tables)", () => {
  const pg2 = pgContainer("eta-spine-s7a-room");
  beforeAll(() => {
    pg2.start();
    H.tag = pg2.sql;
    pg2.exec(`
      CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
      CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL);
      CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL, source_mic text NOT NULL, grid_aligned boolean NOT NULL DEFAULT true, state text NOT NULL, closed_at timestamptz, auto_drain_refused_at timestamptz, auto_drain_refused_reason text);
      CREATE TABLE room_diarize_window (window_id text, room_day_id text);
      CREATE TABLE room_turn_speaker (window_id text, room_day_id text);
      CREATE TABLE jev_window_text (window_id text, room_day_id text);
      CREATE TABLE room_span_emotion (window_id text, room_day_id text);
      CREATE TABLE scribe_job (kind text, args jsonb, status text);
      CREATE TABLE transcription_run (id text PRIMARY KEY, subject_type text, subject_id text, engine text, error text, transcript_original text, transcript_english text, created_at timestamptz DEFAULT now());
      INSERT INTO room_day VALUES ('rd_1', 'room_abcd2345', '2026-10-18'), ('rd_2', 'room_abcd2345', '2026-10-19'), ('rd_b', 'room_blindtest', '2026-10-18');
      INSERT INTO bench_session VALUES ('s1', 'room_abcd2345'), ('s2', 'room_blindtest');
    `);
  });
  afterAll(() => { pg2.stop(); H.tag = pg.sql; });
  const ms = (m: number) => T_OPEN + m * MIN;
  const w = (id: string, sess: string, rd: string | null, s: number, e: number, state: string, mic = "primary", grid = true) =>
    `INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state) VALUES ('${id}', '${sess}', ${rd ? `'${rd}'` : "NULL"}, ${ms(s)}, ${ms(e)}, '${mic}', ${grid}, '${state}');`;

  it("returns the grid windows of the room-day that overlap [t_open, t_close], with the route run and the drain's marks; others are not returned", async () => {
    pg2.exec(`
      ${w("wa", "s1", "rd_1", -15, 0, "transcribed")}      -- ends exactly at t_open: no overlap
      ${w("wb", "s1", "rd_1", 0, 15, "transcribed")}
      ${w("wc", "s1", "rd_1", 15, 30, "closed")}
      ${w("wd", "s1", "rd_1", 30, 45, "closed")}           -- starts after t_close (20)
      ${w("we", "s1", "rd_2", 0, 15, "transcribed")}       -- another day
      ${w("wf", "s1", null, 0, 15, "transcribed")}         -- no room-day: cannot be placed
      ${w("wg", "s1", "rd_1", 0, 15, "transcribed", "backup", false)}   -- not grid aligned
      INSERT INTO transcription_run (id, subject_type, subject_id, engine, transcript_original, transcript_english) VALUES
        ('run_wb', 'bench_window', 'wb', 'route', 'alpha words', 'beta words'), ('run_sarvam_wb', 'bench_window', 'wb', 'sarvam', 'other', 'other'), ('run_we', 'bench_window', 'we', 'route', 'x', 'y');
      INSERT INTO scribe_job VALUES ('room_window', '{"window_id":"wc"}', 'running');
    `);
    const r = await readCoveringWindows({ room_id: ROOM, ist_date: "2026-10-18", t_open_ms: T_OPEN, t_close_ms: T_CLOSE });
    expect(r.blind_excluded).toBe(0);
    expect(r.windows.map((x) => [x.id, x.state, x.run_id, x.job_open])).toEqual([["wb", "transcribed", "run_wb", false], ["wc", "closed", null, true]]);
    const t = await readRunTexts(["run_wb", "run_sarvam_wb"]);
    expect(t.map((x) => [x.run_id, x.engine])).toEqual(expect.arrayContaining([["run_wb", "route"]]));
  });

  it("a held-out window is dropped and counted, never returned (window-level placement)", async () => {
    pg2.exec(`
      ${w("wh", "s1", "rd_1", 0, 15, "transcribed", "backup")}
      INSERT INTO room_turn_speaker VALUES ('wh', 'rd_b');
    `);
    const r = await readCoveringWindows({ room_id: ROOM, ist_date: "2026-10-18", t_open_ms: T_OPEN, t_close_ms: T_CLOSE });
    expect(r.blind_excluded).toBe(1);
    expect(r.windows.map((x) => x.id)).not.toContain("wh");
  });
});
