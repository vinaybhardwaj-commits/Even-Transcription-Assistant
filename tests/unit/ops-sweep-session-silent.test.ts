/**
 * ORDER SILENT-SESSION R2 — the standing sweep pages a session that is open and recording but delivers nothing. Pure planner plus the real queue path over an in-memory outbox that
 * applies the same (kind, room, dedupe key) rule as the SQL. Synthetic ids only; the one real-looking id is ORB2's never-live room id, taken from the steward config.
 */
import { describe, it, expect, vi } from "vitest";

const outbox = new Set<string>();
const inserted: Array<{ kind: string; room: string; key: string; subject: string; body: string }> = [];
let reads: { sessions?: unknown[]; chunks?: unknown[]; fail?: boolean } = {};
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^INSERT INTO room_alert_outbox/.test(text)) {
      const k = `${values[0]}|${values[1]}|${values[3]}`;
      if (outbox.has(k)) return Promise.resolve([]);
      outbox.add(k);
      inserted.push({ kind: String(values[0]), room: String(values[1]), key: String(values[3]), subject: String(values[4]), body: String(values[5]) });
      return Promise.resolve([{ id: inserted.length }]);
    }
    if (/FROM bench_chunk c WHERE c.session_id = s.id\) AS last_chunk_at/.test(text)) return reads.fail ? Promise.reject(new Error("boom")) : Promise.resolve(reads.sessions ?? []);
    if (/max\(c\.created_at\) AS last_chunk_at FROM bench_session s JOIN bench_chunk/.test(text)) return Promise.resolve(reads.chunks ?? []);
    return Promise.resolve([]);
  };
  return { sql, db: {} };
});

const S = await import("@/lib/alerts/ops-sweep");
const { NEVER_LIVE_ROOM_IDS } = await import("@/lib/steward/config");
const MIN = 60_000;
// 23:30 IST on a Tuesday: outside clinic hours, so the plain recorder_off rule is quiet and only the session rule can speak
const NIGHT = new Date("2026-10-13T23:30:00+05:30").getTime();
const CLINIC_NOW = new Date("2026-10-13T10:00:00+05:30").getTime();
const OT = "room_ot_synth";
const CLINIC = "room_clinic_synth";
const ORB2 = NEVER_LIVE_ROOM_IDS[0]!;
const OPD4 = "room_ux92qpws"; // in the sweep's ROOMS list
const ses = (id: string, room: string, startedAgoMin: number, pieceAgoMin: number | null, now = NIGHT) => ({ id, room_id: room, started_ms: now - startedAgoMin * MIN, last_piece_ms: pieceAgoMin === null ? null : now - pieceAgoMin * MIN });
const plan = (open: ReturnType<typeof ses>[] | null, now = NIGHT, extra: Partial<Parameters<typeof S.planOpsAlerts>[0]> = {}) =>
  S.planOpsAlerts({ now_ms: now, last_chunk_ms: null, live_installs: null, open_sessions: open, ...extra });
const silent = (p: ReturnType<typeof plan>) => p.filter((a) => a.session_silent);

describe("sweep: session_silent", () => {
  it("an OT room, a clinic room and ORB2, each with an open 0-piece session over 30 min, page once each, as recorder_off", () => {
    const p = silent(plan([ses("bs_a", OT, 31, null), ses("bs_b", CLINIC, 45, null), ses("bs_c", ORB2, 600, null)]));
    expect(p.map((a) => a.room_id).sort()).toEqual([CLINIC, ORB2, OT].sort());
    expect(p.every((a) => a.kind === "recorder_off" && !a.consult_open)).toBe(true);
    expect(p.find((a) => a.room_id === ORB2)).toMatchObject({ minutes: 600, session_silent: { session_id: "bs_c" } });
  });

  it("a stale piece pages, a fresh piece and a young session do not, whatever the session's age", () => {
    expect(silent(plan([ses("bs_a", OT, 900, 31)]))).toHaveLength(1);
    expect(silent(plan([ses("bs_a", OT, 900, 5)]))).toHaveLength(0);
    expect(silent(plan([ses("bs_a", OT, 29, null)]))).toHaveLength(0);
  });

  it("no session, an unread source, and the dev rooms give nothing", () => {
    expect(silent(plan([]))).toHaveLength(0);
    expect(silent(plan(null))).toHaveLength(0);
    expect(silent(plan([ses("bs_a", "room_scratch_x1", 120, null), ses("bs_b", "room_jwyrr4dc", 120, null)]))).toHaveLength(0);
  });

  it("no double page: a clinic room already paging recorder_off (plain) keeps that page alone", () => {
    const p = plan([ses("bs_a", OPD4, 120, null, CLINIC_NOW)], CLINIC_NOW, { last_chunk_ms: new Map() });
    expect(p.filter((a) => a.room_id === OPD4 && a.kind === "recorder_off")).toHaveLength(1);
    expect(silent(p).some((a) => a.room_id === OPD4)).toBe(false);
    // the same session outside clinic hours (plain rule silent) does page
    expect(silent(plan([ses("bs_a", OPD4, 120, null)], NIGHT, { last_chunk_ms: new Map() }))).toHaveLength(1);
  });

  it("an OT room inside clinic hours is not covered by the plain rule, so it pages", () => {
    expect(silent(plan([ses("bs_a", OT, 120, null, CLINIC_NOW)], CLINIC_NOW, { last_chunk_ms: new Map() }))).toHaveLength(1);
  });
});

describe("sweep: queue path and dedupe", () => {
  const run = async (sessionRows: unknown[]) => {
    reads = { sessions: sessionRows };
    return S.runOpsSweep(NIGHT);
  };
  const row = (id: string, room: string, startedAgoMin: number) => ({ id, room_id: room, started_at: new Date(NIGHT - startedAgoMin * MIN).toISOString(), last_chunk_at: null });

  it("pages once, not again on the next sweep, and a NEW session in the same room pages again", async () => {
    outbox.clear();
    inserted.length = 0;
    const r1 = await run([row("bs_one", OT, 40), row("bs_orb2", ORB2, 90)]);
    expect(r1.queued).toBe(2);
    expect(inserted.map((i) => i.room).sort()).toEqual([ORB2, OT].sort());
    expect(inserted.every((i) => i.kind === "recorder_off" && /SESSION SILENT/.test(i.subject) && /session_id=bs_/.test(i.body))).toBe(true);
    expect(JSON.stringify(inserted)).not.toMatch(new RegExp(["ho", "me"].join("") + "/|U" + "sers/"));
    const r2 = await run([row("bs_one", OT, 41), row("bs_orb2", ORB2, 91)]);
    expect(r2.queued).toBe(0);
    const r3 = await run([row("bs_two", OT, 35)]);
    expect(r3.queued).toBe(1);
    expect(inserted[inserted.length - 1]!.key).toBe("recorder_off_session:bs_two");
  });

  it("a session read that fails is named in degraded and pages nothing", async () => {
    outbox.clear();
    inserted.length = 0;
    reads = { fail: true };
    const r = await S.runOpsSweep(NIGHT);
    expect(r.degraded).toContain("open_sessions");
    expect(inserted).toHaveLength(0);
  });
});
