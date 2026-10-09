/**
 * The held-out room-day guard on the two admin routes that read a bench session's data:
 * /api/admin/speaker-calibration and /api/bench/sessions/{id}/manifest. Each guard is pinned on its own
 * (remove only that route's guard and only that route's blind test fails). Mocked, no database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const [BD, BR] = BLIND_ROOM_DAYS.find(([d]) => d === "2026-09-13")!;
const dayBefore = "2026-09-12";

const dataReads: string[] = [];
let session: { id: string; room_id: string; started_at: string; ended_at: string | null } | null = null;

let lookupFails = false;
let windowRows: unknown[] = [];
let chunkRows: Array<{ started_at: string }> = [];
const windowQueries: Array<{ text: string; values: unknown[] }> = [];
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (/FROM bench_session/.test(text)) { if (lookupFails) throw new Error("db down"); return session ? [session] : []; }
    dataReads.push(text); windowQueries.push({ text, values }); return windowRows;
  },
}));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => "c" }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({}) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.invalid/x" }));
vi.mock("@/lib/bench", () => ({
  benchAdminGuard: async () => ({ ok: true }),
  findBenchSession: async () => session && { ...session, label: null, mic_label: null, status: "ended", notes: null, room_slug: "s", room_name: "n" },
  listBenchChunks: async () => { dataReads.push("chunks"); return chunkRows; },
  listBenchEvents: async () => { dataReads.push("events"); return []; },
  splitChunksBySource: (rows: unknown[]) => ({ primary: rows, backup: [] }),
}));

const { GET: calibration } = await import("@/app/api/admin/speaker-calibration/route");
const { GET: manifest } = await import("@/app/api/bench/sessions/[id]/manifest/route");
const { NextRequest } = await import("next/server");

const callCal = () => calibration(new NextRequest("http://x/api/admin/speaker-calibration?session_id=bs_t"));
const callMan = () => manifest(new NextRequest("http://x/m"), { params: Promise.resolve({ id: "bs_t" }) });
const mk = (room_id: string, started_at: string, ended_at: string | null = null) => { session = { id: "bs_t", room_id, started_at, ended_at }; };

beforeEach(() => { dataReads.length = 0; windowQueries.length = 0; session = null; lookupFails = false; windowRows = []; chunkRows = []; });

describe("speaker-calibration", () => {
  it("blind session: 403 blind_room_day and no data query runs", async () => {
    mk(BR, `${BD}T05:00:00Z`);
    const res = await callCal();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "blind_room_day" });
    expect(dataReads).toEqual([]);
  });
  it("non-blind session: reads as before", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    const res = await callCal();
    expect(res.status).toBe(200);
    expect(dataReads.some((q) => /room_diarize_window/.test(q))).toBe(true);
  });
  it("IST edge: 18:29Z on the day before is not blind, 18:31Z is", async () => {
    mk(BR, `${dayBefore}T18:29:00Z`);
    expect((await callCal()).status).toBe(200);
    dataReads.length = 0;
    mk(BR, `${dayBefore}T18:31:00Z`);
    expect((await callCal()).status).toBe(403);
    expect(dataReads).toEqual([]);
  });
});

describe("speaker-calibration fails closed", () => {
  it("ended_at on a blind IST day (started the day before): 403, no window read", async () => {
    mk(BR, `${dayBefore}T05:00:00Z`, `${BD}T05:00:00Z`);
    expect((await callCal()).status).toBe(403);
    expect(dataReads).toEqual([]);
  });
  it("bench_session lookup DB error: 503 db and no window read", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    lookupFails = true;
    const res = await callCal();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db" });
    expect(dataReads).toEqual([]);
  });
  it("unknown session: 404, no window read", async () => {
    expect((await callCal()).status).toBe(404);
    expect(dataReads).toEqual([]);
  });
  it("window read excludes blind room-days in SQL (bound to BLIND_ROOM_DAYS), from the window's own room_day", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    await callCal();
    const q = windowQueries[0]!;
    expect(q.text).toMatch(/JOIN room_day rd ON rd\.id = w\.room_day_id/);
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM unnest\(\?::date\[\], \?::text\[\]\) AS b\(d, r\) WHERE b\.d = rd\.ist_date AND b\.r = rd\.room_id\)/);
    expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([d]) => d));
    expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([, r]) => r));
  });
  it("a window whose room_day is blind while the session dates are not: row excluded from the result", async () => {
    mk("room_other", "2026-10-08T05:00:00Z");
    windowRows = [
      { window_id: "w1", speakers_json: [], ist_date: BD, room_id: BR },
      { window_id: "w2", speakers_json: [], ist_date: "2026-10-08", room_id: BR },
    ];
    const body = await (await callCal()).json();
    expect(body.windows_with_results).toBe(1);
  });
});

describe("bench manifest", () => {
  it("ended_at on a blind IST day (started the day before): 403, no chunk read", async () => {
    mk(BR, `${dayBefore}T05:00:00Z`, `${BD}T05:00:00Z`);
    expect((await callMan()).status).toBe(403);
    expect(dataReads).toEqual([]);
  });
  it("a chunk runs past ended_at onto a blind IST day: 403 and nothing served", async () => {
    mk(BR, `${dayBefore}T05:00:00Z`, `${dayBefore}T08:00:00Z`);
    chunkRows = [{ started_at: `${dayBefore}T06:00:00Z` }, { started_at: `${BD}T05:00:00Z` }];
    const res = await callMan();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "blind_room_day" });
    expect(dataReads).not.toContain("events");
  });
  it("blind session: 403 blind_room_day and no chunk or event read", async () => {
    mk(BR, `${BD}T05:00:00Z`);
    const res = await callMan();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "blind_room_day" });
    expect(dataReads).toEqual([]);
  });
  it("non-blind session: manifest as before", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    const res = await callMan();
    expect(res.status).toBe(200);
    expect(dataReads).toEqual(["chunks", "events"]);
  });
  it("a blind date in a different room is not blind", async () => {
    mk("room_other", `${BD}T05:00:00Z`);
    expect((await callMan()).status).toBe(200);
  });
  it("IST edge: 18:29Z on the day before is not blind, 18:31Z is", async () => {
    mk(BR, `${dayBefore}T18:29:00Z`);
    expect((await callMan()).status).toBe(200);
    dataReads.length = 0;
    mk(BR, `${dayBefore}T18:31:00Z`);
    expect((await callMan()).status).toBe(403);
    expect(dataReads).toEqual([]);
  });
});
