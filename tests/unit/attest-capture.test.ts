/**
 * tests/unit/attest-capture.test.ts — record-time PIN attestation, server half.
 *
 * WHAT THIS IS FOR. `room_day.doctor_id` is NULL on all 102 room-days in production: nothing has
 * ever recorded which clinician was in a room. Every refusal below is a way the recorder can be
 * told "no" by name instead of being waved through into a binding nobody can check.
 *
 * NO PIN VALUE APPEARS IN ANY ASSERTION MESSAGE, and none is logged by the code under test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ATTEST_MAX_SITTING_MS,
  intervalsOverlap,
  resolveAttestationEnd,
} from "@/lib/attestation";

// ── the one fake database every test drives ────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ handler: null as null | ((text: string, vals: unknown[]) => Row[]) }));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) =>
    Promise.resolve(db.handler!(strings.join("?"), vals)),
}));
vi.mock("bcryptjs", () => ({
  default: { compare: (pin: string, hash: string) => Promise.resolve(hash === `hash:${pin}`) },
}));

const lockCalls: string[] = [];
vi.mock("@/lib/lockout", () => ({
  preAttemptCheck: async () => ({ kind: lockCalls.includes("locked") ? "locked" : "ok", reason: "locked", retry_after_seconds: 900 }),
  recordFailedAttempt: async () => { lockCalls.push("failed"); return { kind: "ok" as const }; },
  recordSuccessfulAttempt: async () => { lockCalls.push("reset"); return { kind: "ok" as const }; },
}));

const ROOM = { id: "room_x", disabled_at: null };
const CLINICIAN = { id: "doc_1", url_slug: "dr-x", pin_hash: "hash:1234", failed_pin_count: 0, locked_until: null, status: "active" };
const START = "2026-09-19T09:00:00.000Z";

/** A database that behaves; individual tests override one answer at a time. */
function makeDb(over: Partial<{
  room: Row[]; session: Row[]; clinician: Row[]; existing: Row[]; elsewhere: Row[]; sameRoom: Row[]; insert: Row[];
}> = {}) {
  const state = {
    room: over.room ?? [ROOM],
    session: over.session ?? [{ id: "bs_1" }],
    clinician: over.clinician ?? [CLINICIAN],
    existing: over.existing ?? [],
    elsewhere: over.elsewhere ?? [],
    sameRoom: over.sameRoom ?? [],
    insert: over.insert ?? [{ id: "att_1", started_at: START, expires_at: new Date(Date.parse(START) + ATTEST_MAX_SITTING_MS).toISOString() }],
  };
  db.handler = (text: string) => {
    if (text.includes("FROM room\n") || text.includes("FROM room ")) return state.room;
    if (text.includes("FROM bench_session")) return state.session;
    if (text.includes("FROM clinician")) return state.clinician;
    if (text.includes("INSERT INTO room_clinician_attestation")) return state.insert;
    if (text.includes("clinician_id =") && text.includes("room_id <>")) return state.elsewhere;
    if (text.includes("session_id =")) return state.existing;
    if (text.includes("FROM room_clinician_attestation")) return state.sameRoom;
    return [];
  };
  return state;
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/bench/attest/route");
  const req = {
    json: async () => body,
    headers: { get: (k: string) => (k === "user-agent" ? "recorder/0.1.24" : "") },
  } as unknown as Parameters<typeof POST>[0];
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

beforeEach(() => { lockCalls.length = 0; vi.resetModules(); });

describe("the happy path", () => {
  it("a verified PIN in a recording room writes one attested sitting", async () => {
    makeDb();
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "1234", session_id: "bs_1", started_at: START });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, attestation_id: "att_1", replayed: false, started_at: START });
    // The sitting carries its own end from the moment it is written.
    expect(new Date((r.body as unknown as { expires_at: string }).expires_at).getTime())
      .toBe(Date.parse(START) + ATTEST_MAX_SITTING_MS);
    expect(lockCalls).toContain("reset");
  });
});

describe("every refusal is named, and none of them writes a sitting", () => {
  it("wrong PIN -> PIN_INVALID, and the attempt is counted", async () => {
    makeDb();
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "9999", session_id: "bs_1" });
    expect(r.status).toBe(401);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("PIN_INVALID");
    expect(lockCalls).toContain("failed");
  });

  it("unknown room -> UNKNOWN_ROOM, and no PIN attempt is spent", async () => {
    makeDb({ room: [] });
    const r = await post({ room: "nope", clinician_slug: "dr-x", pin: "1234" });
    expect(r.status).toBe(404);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("UNKNOWN_ROOM");
    // An operator's typo must not burn a clinician's lockout budget.
    expect(lockCalls).toEqual([]);
  });

  it("room not recording -> ROOM_NOT_RECORDING", async () => {
    makeDb({ session: [] });
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "1234" });
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("ROOM_NOT_RECORDING");
    expect(lockCalls).toEqual([]);
  });

  it("the clinician is already attested in another room -> CLINICIAN_ELSEWHERE", async () => {
    makeDb({ elsewhere: [{ "?column?": 1 }] });
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "1234", session_id: "bs_1", started_at: START });
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("CLINICIAN_ELSEWHERE");
  });

  it("an overlapping sitting in the same room -> OVERLAPPING_SITTING", async () => {
    makeDb({ sameRoom: [{ "?column?": 1 }] });
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "1234", session_id: "bs_1", started_at: START });
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("OVERLAPPING_SITTING");
  });

  it("a session that is not the one recording -> ROOM_NOT_RECORDING", async () => {
    makeDb();
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "1234", session_id: "bs_OTHER" });
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("ROOM_NOT_RECORDING");
  });

  it("a malformed body -> VALIDATION_FAILED", async () => {
    makeDb();
    for (const body of [{ room: "room_x", clinician_slug: "dr-x" }, { room: "room_x", clinician_slug: "dr-x", pin: "12" }, { clinician_slug: "dr-x", pin: "1234" }]) {
      const r = await post(body);
      expect(r.status).toBe(400);
    }
  });
});

describe("a replayed request is not a second sitting", () => {
  it("returns the original row with replayed: true", async () => {
    makeDb({ existing: [{ id: "att_1", clinician_id: "doc_1", started_at: START, expires_at: "2026-09-19T13:00:00.000Z" }] });
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "1234", session_id: "bs_1", started_at: START });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, attestation_id: "att_1", replayed: true });
  });

  it("but a DIFFERENT clinician on the same open session is refused", async () => {
    makeDb({ existing: [{ id: "att_1", clinician_id: "doc_OTHER", started_at: START, expires_at: "2026-09-19T13:00:00.000Z" }] });
    const r = await post({ room: "room_x", clinician_slug: "dr-x", pin: "1234", session_id: "bs_1", started_at: START });
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("OVERLAPPING_SITTING");
  });
});

describe("a sitting always has an end, and the end only narrows", () => {
  it("the cap alone bounds it when nothing else has an opinion", () => {
    const end = resolveAttestationEnd({ expires_at: "2026-09-19T13:00:00.000Z" });
    expect(end).toBe("2026-09-19T13:00:00.000Z");
  });

  it("a session that closed early retires the sitting early", () => {
    const end = resolveAttestationEnd({
      expires_at: "2026-09-19T13:00:00.000Z",
      session_ended_at: "2026-09-19T10:30:00.000Z",
    });
    expect(end).toBe("2026-09-19T10:30:00.000Z");
  });

  it("a later session end can never widen past the cap", () => {
    const end = resolveAttestationEnd({
      expires_at: "2026-09-19T13:00:00.000Z",
      session_ended_at: "2026-09-19T20:00:00.000Z",
    });
    expect(end).toBe("2026-09-19T13:00:00.000Z");
  });

  it("an explicit end wins when it is the earliest", () => {
    const end = resolveAttestationEnd({
      expires_at: "2026-09-19T13:00:00.000Z",
      ended_at: "2026-09-19T09:45:00.000Z",
      session_ended_at: "2026-09-19T10:30:00.000Z",
    });
    expect(end).toBe("2026-09-19T09:45:00.000Z");
  });

  it("overlap is half-open, so one sitting may start exactly where another ended", () => {
    const A = ["2026-09-19T09:00:00Z", "2026-09-19T10:00:00Z"] as const;
    // touching: the second sitting starts exactly as the first ends
    expect(intervalsOverlap(A[0], A[1], "2026-09-19T10:00:00Z", "2026-09-19T11:00:00Z")).toBe(false);
    // one minute of genuine overlap
    expect(intervalsOverlap(A[0], A[1], "2026-09-19T09:59:00Z", "2026-09-19T11:00:00Z")).toBe(true);
    // fully contained, in both directions
    expect(intervalsOverlap(A[0], A[1], "2026-09-19T09:15:00Z", "2026-09-19T09:30:00Z")).toBe(true);
    expect(intervalsOverlap("2026-09-19T09:15:00Z", "2026-09-19T09:30:00Z", A[0], A[1])).toBe(true);
    // entirely before
    expect(intervalsOverlap(A[0], A[1], "2026-09-19T07:00:00Z", "2026-09-19T08:00:00Z")).toBe(false);
  });
});
