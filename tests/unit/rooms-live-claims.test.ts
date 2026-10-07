/** "I'm on it" (SPEC-v1 AMENDMENT 2): the claims route over GATING's helper, the race, the already_claimed answer, the auto-clear. In-memory stand-in for rooms_live_claim. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({ occ: vi.fn(async () => [] as unknown[]), cookie: vi.fn(), verify: vi.fn(), staff: { value: null as string | null }, db: { fn: null as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> } }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => M.db.fn(s, ...v) }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: M.cookie }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: M.verify, ADMIN_COOKIE: "admin" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "eta_staff_session" && M.staff.value ? { value: M.staff.value } : undefined) }) }));
vi.mock("@/lib/steward/occupancy-read", () => ({ scopedOccupancy: (...a: unknown[]) => (M.occ as unknown as (...x: unknown[]) => Promise<unknown[]>)(...a) }));

import { GET, POST } from "@/app/api/rooms-live/claims/route";
import { signStaffJwt } from "@/lib/rooms-live/staff-auth";
import { buildSnapshot, getSnapshot, resetMemoForTests } from "@/lib/rooms-live/snapshot";
import { groupOf } from "@/lib/rooms-live/present";
import { AUTO_CLEAR_GAP_MS, resetAutoClearForTests, claimResolved } from "@/lib/rooms-live/claims";
import { ROOM_IDS } from "@/lib/rooms-live/rooms";

type Row = { id: number; room_id: string; claimed_by: string; claimed_at: string; cleared_at: string | null; cleared_by: string | null; state_at_claim: string | null; note: string | null };
/** answers exactly the four statements of lib/rooms-live-claims.ts, and nothing else (empty for the snapshot's own reads) */
function claimsDb() {
  const rows: Row[] = [];
  let id = 1;
  const fn = async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const t = strings.join("?");
    if (t.includes("INSERT INTO rooms_live_claim")) {
      const [room, by, state, note] = v as [string, string, string | null, string | null];
      if (rows.some((r) => r.room_id === room && r.cleared_at === null)) return [];
      const r: Row = { id: id++, room_id: room, claimed_by: by, claimed_at: new Date().toISOString(), cleared_at: null, cleared_by: null, state_at_claim: state, note };
      rows.push(r);
      return [r];
    }
    if (t.includes("UPDATE rooms_live_claim")) {
      const [by, room] = v as [string, string];
      const r = rows.find((x) => x.room_id === room && x.cleared_at === null);
      if (!r) return [];
      r.cleared_at = new Date().toISOString();
      r.cleared_by = by;
      return [r];
    }
    if (t.includes("FROM rooms_live_claim") && t.includes("room_id = ?")) return rows.filter((r) => r.room_id === v[0] && r.cleared_at === null).slice(0, 1);
    if (t.includes("FROM rooms_live_claim")) return rows.filter((r) => r.cleared_at === null);
    return [];
  };
  return { rows, fn };
}
const post = (b: unknown) => POST(new Request("http://x/api/rooms-live/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
const ROOM = ROOM_IDS[0]!;

beforeEach(async () => {
  resetMemoForTests();
  resetAutoClearForTests();
  process.env.JWT_SECRET_STAFF = "fixture-staff-secret-not-real";
  M.cookie.mockReset();
  M.verify.mockReset();
  M.cookie.mockResolvedValue(null);
  M.staff.value = await signStaffJwt("Asha");
  M.db.fn = claimsDb().fn;
});

describe("claims route", () => {
  it("401 without any cookie; 400 for a room outside the eight or a bad action", async () => {
    M.staff.value = null;
    expect((await post({ room_id: ROOM, action: "claim" })).status).toBe(401);
    expect((await GET(new Request("http://x"))).status).toBe(401);
    M.staff.value = await signStaffJwt("Asha");
    for (const b of [{ room_id: "room_jwyrr4dc", action: "claim" }, { room_id: "room_d74hhmc4", action: "claim" }, { room_id: ROOM, action: "steal" }, { room_id: "", action: "claim" }, {}]) expect((await post(b)).status).toBe(400);
  });
  it("happy path: claim as the staff name, GET lists it, clear removes it", async () => {
    const db = claimsDb();
    M.db.fn = db.fn;
    const r = await post({ room_id: ROOM, action: "claim" });
    expect(r.status).toBe(200);
    expect((await r.json()).claim.claimed_by).toBe("Asha");
    expect(db.rows[0]).toMatchObject({ room_id: ROOM, claimed_by: "Asha", cleared_at: null });
    expect(db.rows[0]!.state_at_claim).toBe("unknown"); // the fake database answers the screen's reads with nothing: the computed state is recorded as it is
    const g = await (await GET(new Request("http://x"))).json();
    expect(g.claims).toHaveLength(1);
    expect(g.claims[0]).toMatchObject({ room_id: ROOM, claimed_by: "Asha" });
    const c = await post({ room_id: ROOM, action: "clear" });
    expect(c.status).toBe(200);
    expect(db.rows[0]).toMatchObject({ cleared_by: "Asha" });
    expect((await post({ room_id: ROOM, action: "clear" })).status).toBe(404);
  });
  it("an admin claims under the e-mail local part", async () => {
    M.staff.value = null;
    M.cookie.mockResolvedValue("jwt");
    M.verify.mockResolvedValue({ admin_id: "a", email: "ops.lead@example.test" });
    const db = claimsDb();
    M.db.fn = db.fn;
    expect((await post({ room_id: ROOM, action: "claim" })).status).toBe(200);
    expect(db.rows[0]!.claimed_by).toBe("ops.lead");
  });
  it("RACE: two people press at once: exactly one wins, the other gets 409 already_claimed naming the winner", async () => {
    const db = claimsDb();
    M.db.fn = db.fn;
    const [a, b] = await Promise.all([post({ room_id: ROOM, action: "claim" }), post({ room_id: ROOM, action: "claim" })]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const j = await loser.json();
    expect(j).toMatchObject({ ok: false, reason: "already_claimed", existing: { claimed_by: "Asha" } });
    expect(db.rows.filter((r) => r.cleared_at === null)).toHaveLength(1);
  });
  it("the database failing is a 503 with a plain message, never a stack", async () => {
    M.db.fn = async () => {
      throw new Error("boom postgres://u:p@h/db");
    };
    const r = await post({ room_id: ROOM, action: "claim" });
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toMatch(/postgres:|boom/);
  });
});

describe("auto-clear (the only write of GET /now)", () => {
  const NOW = Date.parse("2026-10-07T10:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const claimRow = (room: string) => ({ id: 1, room_id: room, claimed_by: "Asha", claimed_at: iso(NOW - 120_000), cleared_at: null, cleared_by: null, state_at_claim: "muted", note: null });
  /** a database whose eight rooms are healthy (listening) */
  const healthyDb = (() => {
    const hosts: Record<string, string> = Object.fromEntries(ROOM_IDS.map((id, i) => [id, `HOST-${i}`]));
    return (async (strings: TemplateStringsArray) => {
      const t = strings.join("?");
      if (t.includes("FROM bench_listener")) return ROOM_IDS.map((id) => ({ room_id: id, last_poll_at: iso(NOW - 1000), levels_at: iso(NOW - 800), mic_peak: 0.035, mic_zero_ratio: 0.001, recording_session_id: "s", paused: false }));
      if (t.includes("FROM room_install")) return ROOM_IDS.map((id) => ({ room_id: id, hostname: hosts[id], state_flags: { flags: [] }, state_changed_at: null, input_device_name: "M", input_devices: [{ name: "M" }] }));
      if (t.includes("FROM bench_session")) return ROOM_IDS.map((id) => ({ room_id: id, id: "s" + id, status: "recording", started_at: iso(NOW - 3_600_000), last_chunk_at: iso(NOW - 60_000) }));
      if (t.includes("FROM bench_level_sample")) return ROOM_IDS.flatMap((id) => Array.from({ length: 120 }, (_, i) => ({ room_id: id, sampled_at: iso(NOW - 800 - i * 2300), peak: i < 4 ? 0.035 + i * 0.002 : 0.009 + (i % 5) * 0.0004, zero_ratio: 0.001 })));
      if (t.includes("FROM kiosk_health_events")) return Object.values(hosts).map((m) => ({ machine: m, received_at: iso(NOW - 20_000) }));
      return [];
    }) as unknown as import("@/lib/rooms-live/read").Db;
  })();
  it("a claim on a room that is back in listening is cleared with by auto; the row shows no claim", async () => {
    const clear = vi.fn(async () => {});
    const deps = { db: healthyDb, now: () => NOW, claims: { open: async () => [claimRow(ROOM)], clear } };
    await buildSnapshot(deps);
    expect(clear).not.toHaveBeenCalled(); // F27: one resolved poll is not enough
    const s = await buildSnapshot(deps);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(ROOM);
    expect(s.rooms.find((r) => r.room_id === ROOM)!.claim).toBeNull();
  });
  it("fires ONCE per room per minute: the next snapshots inside 60 s do not clear again; after 60 s it may", async () => {
    const clear = vi.fn(async () => {});
    const deps = (t: number) => ({ db: healthyDb, now: () => t, claims: { open: async () => [claimRow(ROOM)], clear } });
    await buildSnapshot(deps(NOW));               // poll 1: streak 1
    await buildSnapshot(deps(NOW + 10_000));      // poll 2: streak 2 -> clears
    await buildSnapshot(deps(NOW + 20_000));
    await buildSnapshot(deps(NOW + 10_000 + AUTO_CLEAR_GAP_MS - 1));
    expect(clear).toHaveBeenCalledTimes(1);
    await buildSnapshot(deps(NOW + 10_000 + AUTO_CLEAR_GAP_MS + 1));
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it("a claim on a room still in trouble WITH a doctor present is kept and shown (who, since); with no doctor the same claim is cleared", async () => {
    const clear = vi.fn(async () => {});
    const noSession = (async (strings: TemplateStringsArray, ...v: unknown[]) => (strings.join("?").includes("FROM bench_session") ? [] : (healthyDb as unknown as (s: TemplateStringsArray, ...x: unknown[]) => Promise<unknown>)(strings, ...v))) as unknown as import("@/lib/rooms-live/read").Db;
    M.occ.mockResolvedValue([{ machine: "HOST-0", occupied: true, ambiguous: false, stale_occupant: null, pending: null, page_name: "Clinician T" }]);
    const kept = await buildSnapshot({ db: noSession, now: () => NOW, claims: { open: async () => [claimRow(ROOM)], clear } });
    const row = kept.rooms.find((r) => r.room_id === ROOM)!;
    expect(row.state).toBe("notrec");
    expect(row.doctor).not.toBeNull();
    expect(row.claim).toEqual({ by: "Asha", since: iso(NOW - 120_000) });
    expect(clear).not.toHaveBeenCalled();
    resetAutoClearForTests();
    M.occ.mockResolvedValue([]);
    const goneDeps = { db: noSession, now: () => NOW, claims: { open: async () => [claimRow(ROOM)], clear } };
    await buildSnapshot(goneDeps);
    const gone = await buildSnapshot(goneDeps);
    expect(gone.rooms.find((r) => r.room_id === ROOM)!.claim).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("claimResolved: a problem with a doctor is not resolved; listening/quiet or no doctor is; unknown never clears", () => {
    expect(claimResolved("muted", true)).toBe(false);
    expect(claimResolved("unplugged", false)).toBe(true);
    expect(claimResolved("listening", true)).toBe(true);
    expect(claimResolved("quiet", true)).toBe(true);
    expect(claimResolved("unknown", false)).toBe(false);
    expect(claimResolved("off", true)).toBe(false);
  });
  it("a failed claims read is a degraded note, not an error; rows still render", async () => {
    const s = await buildSnapshot({ db: healthyDb, now: () => NOW, claims: { open: async () => { throw new Error("x"); }, clear: async () => {} } });
    expect(s.degraded).toEqual(["rooms_live_claim"]);
    expect(s.rooms).toHaveLength(8);
  });
});

describe("FIX-1 F1: a failed occupancy read is 'doctor unknown', never 'no doctor'", () => {
  const NOW = Date.parse("2026-10-07T10:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const MUTED = ROOM_IDS[1]!; // OPD 3 in the refuter's probe
  const hosts: Record<string, string> = Object.fromEntries(ROOM_IDS.map((id, i) => [id, `HOST-${i}`]));
  const db = (async (strings: TemplateStringsArray) => {
    const t = strings.join("?");
    if (t.includes("FROM bench_listener")) return ROOM_IDS.map((id) => ({ room_id: id, last_poll_at: iso(NOW - 1000), levels_at: iso(NOW - 800), mic_peak: id === MUTED ? 0 : 0.035, mic_zero_ratio: id === MUTED ? 1 : 0.001, recording_session_id: "s", paused: false }));
    if (t.includes("FROM room_install")) return ROOM_IDS.map((id) => ({ room_id: id, hostname: hosts[id], state_flags: { flags: [] }, state_changed_at: null, input_device_name: "M", input_devices: [{ name: "M" }] }));
    if (t.includes("FROM bench_session")) return ROOM_IDS.map((id) => ({ room_id: id, id: "s" + id, status: "recording", started_at: iso(NOW - 3_600_000), last_chunk_at: iso(NOW - 60_000) }));
    if (t.includes("FROM bench_level_sample")) return ROOM_IDS.flatMap((id) => Array.from({ length: 150 }, (_, i) => id === MUTED ? { room_id: id, sampled_at: iso(NOW - 800 - i * 2300), peak: 0, zero_ratio: 1 } : { room_id: id, sampled_at: iso(NOW - 800 - i * 2300), peak: i < 4 ? 0.035 + i * 0.002 : 0.009 + (i % 5) * 0.0004, zero_ratio: 0.001 }));
    if (t.includes("FROM kiosk_health_events")) return Object.values(hosts).map((m) => ({ machine: m, received_at: iso(NOW - 20_000) }));
    return [];
  }) as unknown as import("@/lib/rooms-live/read").Db;
  const claimOn = (room: string) => ({ id: 1, room_id: room, claimed_by: "Asha", claimed_at: iso(NOW - 180_000), cleared_at: null, cleared_by: null, state_at_claim: "muted", note: null });

  it("the refuter's probe: occupancy throws, OPD 3 is Mic silent, a claim is open -> the claim survives, nothing is auto-cleared, the room stays in Needs attention", async () => {
    M.occ.mockReset();
    M.occ.mockRejectedValue(new Error("boom"));
    const clear = vi.fn(async () => {});
    const s = await buildSnapshot({ db, now: () => NOW, claims: { open: async () => [claimOn(MUTED)], clear } });
    const row = s.rooms.find((r) => r.room_id === MUTED)!;
    expect(s.degraded).toEqual(["occupancy"]);
    expect(row.state).toBe("muted");
    expect(row.doctor).toBeNull();
    expect(row.doctor_known).toBe(false);
    expect(row.claim).toMatchObject({ by: "Asha" });
    expect(clear).not.toHaveBeenCalled();
    expect(groupOf(row)).toBe("attention");
  });
  it("control: occupancy fine and no doctor on the muted room -> the same claim IS cleared by the no-doctor rule (known absence)", async () => {
    M.occ.mockReset();
    M.occ.mockResolvedValue([]);
    const clear = vi.fn(async () => {});
    const deps = { db, now: () => NOW, claims: { open: async () => [claimOn(MUTED)], clear } };
    await buildSnapshot(deps);
    await buildSnapshot(deps);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("while occupancy is degraded, auto-clear on listening/quiet still works", async () => {
    M.occ.mockReset();
    M.occ.mockRejectedValue(new Error("boom"));
    const clear = vi.fn(async () => {});
    const deps = { db, now: () => NOW, claims: { open: async () => [claimOn(ROOM_IDS[0]!)], clear } };
    await buildSnapshot(deps);
    const s = await buildSnapshot(deps);
    expect(s.rooms.find((r) => r.room_id === ROOM_IDS[0])!.state).toBe("listening");
    expect(clear).toHaveBeenCalledWith(ROOM_IDS[0]);
  });
});

describe("FIX-1 F4: the claims POST never leaves a claims-less snapshot in the shared memo, and always drops the memo", () => {
  const counted = () => {
    const c = { n: 0 };
    const base = claimsDb();
    M.db.fn = async (s: TemplateStringsArray, ...v: unknown[]) => {
      if (!s.join("?").includes("rooms_live_claim")) c.n++;
      return base.fn(s, ...v);
    };
    return c;
  };
  it("a POST claim does not fill the memo: the next shared read still runs its claims port", async () => {
    const reads = counted();
    const open = vi.fn(async () => []);
    const deps = { db: M.db as unknown as import("@/lib/rooms-live/read").Db, now: () => Date.parse("2026-10-07T10:00:00Z"), claims: { open, clear: async () => {} } };
    expect((await post({ room_id: ROOM, action: "claim" })).status).toBe(200);
    expect(reads.n).toBeGreaterThan(0); // the POST read the screen state itself
    const after = reads.n;
    await getSnapshot({ ...deps, db: ((s: TemplateStringsArray, ...v: unknown[]) => M.db.fn(s, ...v)) as never });
    expect(open).toHaveBeenCalledTimes(1);     // not served from a memo the POST wrote
    expect(reads.n).toBeGreaterThan(after);
  });
  it("a POST invalidates a memo that was already there (the new claim shows at once)", async () => {
    counted();
    const open = vi.fn(async () => []);
    const t = Date.parse("2026-10-07T10:00:00Z");
    const deps = { db: ((s: TemplateStringsArray, ...v: unknown[]) => M.db.fn(s, ...v)) as never, now: () => t, claims: { open, clear: async () => {} } };
    await getSnapshot(deps);
    await getSnapshot(deps);
    expect(open).toHaveBeenCalledTimes(1); // memoised
    await post({ room_id: ROOM, action: "claim" });
    await getSnapshot(deps);
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("a claim() that THROWS still drops the memo (finally)", async () => {
    const open = vi.fn(async () => []);
    const t = Date.parse("2026-10-07T10:00:00Z");
    const base = claimsDb();
    M.db.fn = async (s: TemplateStringsArray, ...v: unknown[]) => {
      if (s.join("?").includes("INSERT INTO rooms_live_claim")) throw new Error("boom");
      return base.fn(s, ...v);
    };
    const deps = { db: ((s: TemplateStringsArray, ...v: unknown[]) => M.db.fn(s, ...v)) as never, now: () => t, claims: { open, clear: async () => {} } };
    await getSnapshot(deps);
    expect(open).toHaveBeenCalledTimes(1);
    expect((await post({ room_id: ROOM, action: "claim" })).status).toBe(503);
    await getSnapshot(deps);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("v1.1 F27: two consecutive resolved polls clear a claim", () => {
  const NOW = Date.parse("2026-10-07T10:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const claimRow = (room: string) => ({ id: 1, room_id: room, claimed_by: "Asha", claimed_at: iso(NOW - 120_000), cleared_at: null, cleared_by: null, state_at_claim: "muted", note: null });
  const hosts: Record<string, string> = Object.fromEntries(ROOM_IDS.map((id, i) => [id, `HOST-${i}`]));
  /** the first room's mic is dead (peak 0) while `dead.v` is true, otherwise it is speaking */
  const dead = { v: false };
  const db = (async (strings: TemplateStringsArray) => {
    const t = strings.join("?");
    if (t.includes("FROM bench_listener")) return ROOM_IDS.map((id) => ({ room_id: id, last_poll_at: iso(NOW - 1000), levels_at: iso(NOW - 800), mic_peak: 0.035, mic_zero_ratio: 0.001, recording_session_id: "s", paused: false }));
    if (t.includes("FROM room_install")) return ROOM_IDS.map((id) => ({ room_id: id, hostname: hosts[id], state_flags: { flags: [] }, state_changed_at: null, input_device_name: "M", input_devices: [{ name: "M" }] }));
    if (t.includes("FROM bench_session")) return ROOM_IDS.map((id) => ({ room_id: id, id: "s" + id, status: "recording", started_at: iso(NOW - 3_600_000), last_chunk_at: iso(NOW - 60_000) }));
    if (t.includes("FROM bench_level_sample")) return ROOM_IDS.flatMap((id) => Array.from({ length: 120 }, (_, i) => ({ room_id: id, sampled_at: iso(NOW - 800 - i * 2300), peak: id === ROOM && dead.v ? 0 : i < 4 ? 0.035 + i * 0.002 : 0.009 + (i % 5) * 0.0004, zero_ratio: id === ROOM && dead.v ? 1 : 0.001 })));
    if (t.includes("FROM kiosk_health_events")) return Object.values(hosts).map((m) => ({ machine: m, received_at: iso(NOW - 20_000) }));
    return [];
  }) as unknown as import("@/lib/rooms-live/read").Db;
  it("good, bad (doctor present, Mic silent), good, good -> cleared only on the second consecutive good poll", async () => {
    resetAutoClearForTests();
    M.occ.mockReset();
    M.occ.mockResolvedValue([{ machine: "HOST-0", occupied: true, ambiguous: false, stale_occupant: null, pending: null, page_name: "Clinician T" }]);
    const clear = vi.fn(async () => {});
    const deps = { db, now: () => NOW, claims: { open: async () => [claimRow(ROOM)], clear } };
    dead.v = false;
    await buildSnapshot(deps);
    dead.v = true;
    const bad = await buildSnapshot(deps);
    expect(bad.rooms.find((r) => r.room_id === ROOM)!.state).toBe("muted");
    dead.v = false;
    await buildSnapshot(deps);
    expect(clear).not.toHaveBeenCalled(); // the bad poll reset the run
    await buildSnapshot(deps);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
