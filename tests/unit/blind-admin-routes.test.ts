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

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => { dataReads.push(strings.join("?")); return []; },
}));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => "c" }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({}) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.invalid/x" }));
vi.mock("@/lib/bench", () => ({
  benchAdminGuard: async () => ({ ok: true }),
  findBenchSession: async () => session && { ...session, label: null, mic_label: null, status: "ended", notes: null, room_slug: "s", room_name: "n" },
  listBenchChunks: async () => { dataReads.push("chunks"); return []; },
  listBenchEvents: async () => { dataReads.push("events"); return []; },
  splitChunksBySource: (rows: unknown[]) => ({ primary: rows, backup: [] }),
}));

const { GET: calibration } = await import("@/app/api/admin/speaker-calibration/route");
const { GET: manifest } = await import("@/app/api/bench/sessions/[id]/manifest/route");
const { NextRequest } = await import("next/server");

const callCal = () => calibration(new NextRequest("http://x/api/admin/speaker-calibration?session_id=bs_t"));
const callMan = () => manifest(new NextRequest("http://x/m"), { params: Promise.resolve({ id: "bs_t" }) });
const mk = (room_id: string, started_at: string) => { session = { id: "bs_t", room_id, started_at, ended_at: null }; };

beforeEach(() => { dataReads.length = 0; session = null; });

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

describe("bench manifest", () => {
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
