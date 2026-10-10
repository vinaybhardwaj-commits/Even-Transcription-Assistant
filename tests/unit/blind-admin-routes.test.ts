/**
 * The (now no-op, rule lifted by V 10 Oct 2026) held-out room-day guard on the two admin routes that read a bench session's data:
 * /api/admin/speaker-calibration and /api/bench/sessions/{id}/manifest. Each guard is pinned on its own
 * (remove only that route's guard and only that route's blind test fails). Mocked, no database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FORMER_BLIND_PAIRS as BLIND_ROOM_DAYS } from "../support/former-blind-pairs";

const [BD, BR] = BLIND_ROOM_DAYS.find(([d]) => d === "2026-09-13")!;
const dayBefore = "2026-09-12";

const dataReads: string[] = [];
let session: { id: string; room_id: string; started_at: string; ended_at: string | null } | null = null;

let lookupFails = false;
let chunksFail = false;
let windowRows: unknown[] = [];
let chunkRows: Array<{ started_at: string; ended_at?: string }> = [];
const windowQueries: Array<{ text: string; values: unknown[] }> = [];
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (/FROM bench_session/.test(text)) { if (lookupFails) throw new Error("db down"); return session ? [session] : []; }
    if (/FROM bench_chunk/.test(text)) { dataReads.push("chunks"); if (chunksFail) throw new Error("db down"); return chunkRows; }
    dataReads.push(text); windowQueries.push({ text, values }); return windowRows;
  },
}));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => "c" }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({}) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.invalid/x" }));
vi.mock("@/lib/bench", () => ({
  benchAdminGuard: async () => ({ ok: true }),
  findBenchSession: async () => session && { ...session, label: null, mic_label: null, status: "ended", notes: null, room_slug: "s", room_name: "n" },
    listBenchEvents: async () => { dataReads.push("events"); return []; },
  splitChunksBySource: (rows: unknown[]) => ({ primary: rows, backup: [] }),
}));

const { GET: calibration } = await import("@/app/api/admin/speaker-calibration/route");
const { GET: manifest } = await import("@/app/api/bench/sessions/[id]/manifest/route");
const { NextRequest } = await import("next/server");

const callCal = () => calibration(new NextRequest("http://x/api/admin/speaker-calibration?session_id=bs_t"));
const callMan = () => manifest(new NextRequest("http://x/m"), { params: Promise.resolve({ id: "bs_t" }) });
const mk = (room_id: string, started_at: string, ended_at: string | null = null) => { session = { id: "bs_t", room_id, started_at, ended_at }; };

beforeEach(() => { dataReads.length = 0; windowQueries.length = 0; session = null; lookupFails = false; chunksFail = false; windowRows = []; chunkRows = []; });

describe("speaker-calibration", () => {
  it("formerly blind session: 200, data is read", async () => {
    mk(BR, `${BD}T05:00:00Z`);
    const res = await callCal();
    expect(res.status).toBe(200);
    expect(dataReads.some((q) => /room_diarize_window/.test(q))).toBe(true);
  });
  it("non-blind session: reads as before", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    const res = await callCal();
    expect(res.status).toBe(200);
    expect(dataReads.some((q) => /room_diarize_window/.test(q))).toBe(true);
  });
  it("IST edge: both 18:29Z and 18:31Z on the day before a formerly blind day are served", async () => {
    mk(BR, `${dayBefore}T18:29:00Z`);
    expect((await callCal()).status).toBe(200);
    dataReads.length = 0;
    mk(BR, `${dayBefore}T18:31:00Z`);
    expect((await callCal()).status).toBe(200);
    expect(dataReads.some((q) => /room_diarize_window/.test(q))).toBe(true);
  });
});

describe("speaker-calibration fails closed", () => {
  it("ended_at on a formerly blind IST day (started the day before): 200, window read", async () => {
    mk(BR, `${dayBefore}T05:00:00Z`, `${BD}T05:00:00Z`);
    expect((await callCal()).status).toBe(200);
    expect(dataReads.some((q) => /room_diarize_window/.test(q))).toBe(true);
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
  it("window read keeps the SQL exclusion shape, bound to the EMPTY live list (not the former pairs), from the window's own room_day", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    await callCal();
    const q = windowQueries[0]!;
    expect(q.text).toMatch(/JOIN room_day rd ON rd\.id = w\.room_day_id/);
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM unnest\(\?::date\[\], \?::text\[\]\) AS b\(d, r\) WHERE b\.d = rd\.ist_date AND b\.r = rd\.room_id\)/);
    expect(q.values).not.toContainEqual(BLIND_ROOM_DAYS.map(([d]) => d));
    expect(q.values.filter((x) => Array.isArray(x) && x.length === 0).length).toBeGreaterThanOrEqual(2);
  });
  it("a window whose room_day is a formerly blind pair while the session dates are not: row kept in the result", async () => {
    mk("room_other", "2026-10-08T05:00:00Z");
    windowRows = [
      { window_id: "w1", speakers_json: [], ist_date: BD, room_id: BR },
      { window_id: "w2", speakers_json: [], ist_date: "2026-10-08", room_id: BR },
    ];
    const body = await (await callCal()).json();
    expect(body.windows_with_results).toBe(2);
  });
});

describe("speaker-calibration NULL room_day", () => {
  it("a window with no room_day is excluded: inner join in SQL and dropped by the code filter", async () => {
    mk("room_other", "2026-10-08T05:00:00Z");
    windowRows = [
      { window_id: "w1", speakers_json: [], ist_date: null, room_id: null },
      { window_id: "w2", speakers_json: [], ist_date: "2026-10-08", room_id: BR },
    ];
    const body = await (await callCal()).json();
    expect(body.windows_with_results).toBe(1);
    expect(windowQueries[0]!.text).not.toMatch(/LEFT JOIN room_day/);
  });
});

describe("bench manifest", () => {
  it("chunk read throws: 503 db, events never read, nothing served", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    chunksFail = true;
    const res = await callMan();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db" });
    expect(dataReads).toEqual(["chunks"]);
  });
  it("ended_at on a formerly blind IST day (started the day before): 200, chunks and events read", async () => {
    mk(BR, `${dayBefore}T05:00:00Z`, `${BD}T05:00:00Z`);
    expect((await callMan()).status).toBe(200);
    expect(dataReads).toEqual(["chunks", "events"]);
  });
  it("a chunk runs past ended_at onto a formerly blind IST day: served 200", async () => {
    mk(BR, `${dayBefore}T05:00:00Z`, `${dayBefore}T08:00:00Z`);
    chunkRows = [{ started_at: `${dayBefore}T06:00:00Z`, ended_at: `${dayBefore}T06:10:00Z` }, { started_at: `${BD}T05:00:00Z`, ended_at: `${BD}T05:10:00Z` }];
    const res = await callMan();
    expect(res.status).toBe(200);
    expect(dataReads).toContain("events");
  });
  it("formerly blind session: 200, chunks and events read", async () => {
    mk(BR, `${BD}T05:00:00Z`);
    const res = await callMan();
    expect(res.status).toBe(200);
    expect(dataReads).toEqual(["chunks", "events"]);
  });
  it("non-blind session: manifest as before", async () => {
    mk(BR, "2026-10-08T05:00:00Z");
    const res = await callMan();
    expect(res.status).toBe(200);
    expect(dataReads).toEqual(["chunks", "events"]);
  });
  it("a formerly blind date in a different room is served", async () => {
    mk("room_other", `${BD}T05:00:00Z`);
    expect((await callMan()).status).toBe(200);
  });
  it("IST edge: both 18:29Z and 18:31Z on the day before a formerly blind day are served", async () => {
    mk(BR, `${dayBefore}T18:29:00Z`);
    expect((await callMan()).status).toBe(200);
    dataReads.length = 0;
    mk(BR, `${dayBefore}T18:31:00Z`);
    expect((await callMan()).status).toBe(200);
    expect(dataReads).toEqual(["chunks", "events"]);
  });
});
