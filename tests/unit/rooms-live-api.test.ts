/** Snapshot + routes: row shape, PHI-free JSON, degraded path, the 2 s memo, the admin guard. In-memory stand-in for the database. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({ occ: vi.fn(), cookie: vi.fn(), verify: vi.fn(), staff: { value: null as string | null } }));
vi.mock("@/lib/steward/occupancy-read", () => ({ scopedOccupancy: M.occ }));
vi.mock("@/lib/db", () => ({ sql: (() => Promise.resolve([])) as unknown }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: M.cookie }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: M.verify, ADMIN_COOKIE: "admin" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "eta_staff_session" && M.staff.value ? { value: M.staff.value } : undefined) }) }));

import { buildSnapshot, getSnapshot, resetMemoForTests, flagsOf, deviceNamesOf } from "@/lib/rooms-live/snapshot";
import { ROOMS, ROOM_IDS } from "@/lib/rooms-live/rooms";
import { roomsLiveGuard, roomsLivePageGuard } from "@/lib/rooms-live/guard";
import { signStaffJwt } from "@/lib/rooms-live/staff-auth";

const NOW = Date.parse("2026-10-07T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOST: Record<string, string> = {
  room_yh3etjpf: "EHRC-CONSUL2’s Mac mini (2)", room_87frpus9: "EHRC-CONSUL4’s Mac mini", room_ux92qpws: "EHRC-CONSUL4’s Mac mini (2)",
  room_4ggnkg5x: "EHRC-CONSUL5’s Mac mini", room_pnyc9u49: "EHRC-CONSUL6’s Mac mini", room_qyzghzaf: "EHRC-CONSUL7’s Mac mini",
  room_ymch4bxu: "EHRC-DISCUSSION’s Mac mini", room_bh6jtq4t: "EHRC-ECHO’s Mac mini",
};
const MACH: Record<string, string> = {
  room_yh3etjpf: "EHRC-CONSUL2s-Mac-mini-2", room_87frpus9: "EHRC-CONSUL4s-Mac-mini", room_ux92qpws: "EHRC-CONSUL4s-Mac-mini-2", room_4ggnkg5x: "EHRC-CONSUL5s-Mac-mini",
  room_pnyc9u49: "EHRC-CONSUL6s-Mac-mini", room_qyzghzaf: "EHRC-CONSUL7s-Mac-mini", room_ymch4bxu: "EHRC-DISCUSSIONs-Mac-mini", room_bh6jtq4t: "EHRC-ECHOs-Mac-mini",
};

type Opt = { fail?: string[]; calls?: string[]; unplugged?: string; muted?: string };
function fakeDb(o: Opt = {}) {
  const calls: string[] = o.calls ?? [];
  const db = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM steward_config")) return [];
    if (text.includes("FROM room WHERE")) return ROOM_IDS.map((id) => ({ room_id: id, name: id }));
    const name = ["bench_listener", "room_install", "bench_session", "bench_level_sample", "steward_decisions", "kiosk_health_events", "pulse_presence_events"].find((n) => text.includes(`FROM ${n}`));
    calls.push(name ?? "?");
    if (!name) throw new Error("unexpected statement " + text.slice(0, 60));
    if (o.fail?.includes(name)) throw new Error("boom with a secret postgres://user:pw@host/db");
    if (name === "bench_listener") return ROOM_IDS.map((id) => ({ room_id: id, last_poll_at: iso(NOW - 1000), levels_at: iso(NOW - 800), mic_peak: id === o.muted ? 0 : 0.035, mic_zero_ratio: id === o.muted ? 1 : 0.001, recording_session_id: "bs_1", paused: false }));
    if (name === "room_install") return ROOM_IDS.map((id) => ({ room_id: id, hostname: HOST[id], state_flags: { flags: id === o.unplugged ? ["DEVICE_MISSING"] : [], drift_since: null }, state_changed_at: iso(NOW - 600_000), input_device_name: "C270 HD WEBCAM", input_devices: id === o.unplugged ? [] : [{ name: "C270 HD WEBCAM" }] }));
    if (name === "bench_session") return ROOM_IDS.map((id) => ({ room_id: id, id: "bs_" + id, status: "recording", started_at: iso(NOW - 3_600_000), last_chunk_at: iso(NOW - 70_000) }));
    if (name === "bench_level_sample") return ROOM_IDS.flatMap((id) => Array.from({ length: 150 }, (_, i) => ({ room_id: id, sampled_at: iso(NOW - 800 - i * 2300), peak: id === o.muted ? 0 : i < 4 ? 0.035 + i * 0.002 : 0.009 + (i % 5) * 0.0004, zero_ratio: id === o.muted ? 1 : 0.001 })));
    if (name === "steward_decisions") return [];
    if (name === "kiosk_health_events") return Object.values(MACH).map((m) => ({ machine: m, received_at: iso(NOW - 20_000) }));
    return Object.values(MACH).map((m) => ({ machine: m, ts: iso(NOW - 10_000), dn: "Test Clinician", enc: null }));
  }) as unknown as import("@/lib/rooms-live/read").Db;
  return { db, calls };
}

beforeEach(() => {
  resetMemoForTests();
  M.occ.mockReset();
  M.occ.mockImplementation(async (_db: unknown, _asOf: unknown, keys: string[]) => Object.values(MACH).filter((m) => keys.includes(m)).map((m) => ({ machine: m, occupied: true, ambiguous: false, stale_occupant: null, pending: null, page_name: "Clinician T" })));
  M.cookie.mockReset();
  M.verify.mockReset();
  M.staff.value = null;
  process.env.JWT_SECRET_STAFF = "fixture-staff-secret-not-real";
});

describe("row shape", () => {
  it("eight rows in allow-list order, with the spec's fields", async () => {
    const s = await buildSnapshot({ db: fakeDb().db, now: () => NOW });
    expect(s.rooms.map((r) => r.room_id)).toEqual(ROOMS.map((r) => r.room_id));
    expect(s.rooms.map((r) => r.label)).toEqual(ROOMS.map((r) => r.label));
    const r = s.rooms[0]!;
    expect(Object.keys(r).sort()).toEqual(["ages_s", "baseline_rms", "claim", "detail_code", "device", "doctor", "doctor_known", "label", "level", "room_id", "session", "state", "state_since", "steward"].sort());
    expect(Object.keys(r.level).sort()).toEqual(["at", "rms", "stale", "zero"]);
    expect(Object.keys(r.ages_s).sort()).toEqual(["heartbeat", "listener", "ext"].sort());
    expect(r.doctor).toEqual({ display: "Clinician T", activity: "Signed in" }); // F28: the occupant's name (page_name), not the ext event's display_name
    expect(r.session.open).toBe(true);
    expect(r.session.chunk_age_s).toBe(70);
    expect(s.degraded).toEqual([]);
    expect(typeof s.generated_at).toBe("string");
  });
  it("a healthy day: speech in the last seconds -> listening; unplugged and muted rooms show their state", async () => {
    const s = await buildSnapshot({ db: fakeDb({ unplugged: "room_ux92qpws", muted: "room_87frpus9" }).db, now: () => NOW });
    const by = Object.fromEntries(s.rooms.map((r) => [r.room_id, r]));
    expect(by.room_ux92qpws!.state).toBe("unplugged");
    expect(by.room_ux92qpws!.device.missing).toBe(true);
    expect(by.room_87frpus9!.state).toBe("muted");
    expect(by.room_yh3etjpf!.state).toBe("listening");
  });
  it("PHI: no email, uid, cookie or patient key anywhere in the JSON, and no value that looks like an address", async () => {
    const s = await buildSnapshot({ db: fakeDb().db, now: () => NOW });
    const text = JSON.stringify(s);
    const keys = new Set<string>();
    JSON.parse(text, function (k) { keys.add(k); return this[k]; });
    for (const k of keys) expect(/email|uid|cookie|patient|uhid|phone_number|token/i.test(k), k).toBe(false);
    expect(/@/.test(text)).toBe(false);
  });
  it("a doctor is shown only when the resolver has one non-ambiguous occupant", async () => {
    M.occ.mockImplementation(async (_d: unknown, _a: unknown, keys: string[]) => [
      { machine: "EHRC-CONSUL2s-Mac-mini-2", occupied: true, ambiguous: true, stale_occupant: null, pending: null, page_name: "Clinician X" },
      { machine: "EHRC-CONSUL4s-Mac-mini", occupied: false, ambiguous: false, stale_occupant: null, pending: null, page_name: null },
    ].filter((o) => keys.includes(o.machine)));
    const s = await buildSnapshot({ db: fakeDb().db, now: () => NOW });
    expect(s.rooms.every((r) => r.doctor === null)).toBe(true);
  });
  it("helpers: flagsOf / deviceNamesOf tolerate strings, nulls and junk", () => {
    expect(flagsOf('{"flags":["DEVICE_MISSING"]}')).toEqual(["DEVICE_MISSING"]);
    expect(flagsOf(null)).toEqual([]);
    expect(flagsOf("not json")).toEqual([]);
    expect(deviceNamesOf([{ name: "A" }, "B", 5])).toEqual(["A", "B"]);
    expect(deviceNamesOf(null)).toBeNull();
  });
});

describe("degraded path", () => {
  it("a failed critical read: the affected rooms are 'unknown', the failure is named, no throw and no secret in the answer", async () => {
    const s = await buildSnapshot({ db: fakeDb({ fail: ["bench_session"] }).db, now: () => NOW });
    expect(s.degraded).toContain("bench_session");
    expect(s.rooms.every((r) => r.state === "unknown")).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/postgres:|boom|pw@/);
  });
  it("a failed heartbeat read does not turn a healthy room into 'off'", async () => {
    const s = await buildSnapshot({ db: fakeDb({ fail: ["kiosk_health_events"] }).db, now: () => NOW });
    expect(s.degraded).toEqual(["kiosk_health_heartbeat"]);
    expect(s.rooms.every((r) => r.state !== "off" && r.state !== "unknown")).toBe(true);
  });
  it("a failed occupancy read: rooms still render, no doctor, named", async () => {
    M.occ.mockRejectedValue(new Error("x"));
    const s = await buildSnapshot({ db: fakeDb().db, now: () => NOW });
    expect(s.degraded).toEqual(["occupancy"]);
    expect(s.rooms.every((r) => r.doctor === null && r.doctor_known === false && r.state === "listening")).toBe(true); // FIX-1 F1: unknown, not absent
  });
  it("a failed steward read is only a note", async () => {
    const s = await buildSnapshot({ db: fakeDb({ fail: ["steward_decisions"] }).db, now: () => NOW });
    expect(s.degraded).toEqual(["steward_decisions"]);
    expect(s.rooms.every((r) => r.state === "listening")).toBe(true);
  });
  it("a read that never answers is cut at the timeout", async () => {
    const hang = (async () => new Promise(() => {})) as unknown as import("@/lib/rooms-live/read").Db;
    const s = await buildSnapshot({ db: hang, now: () => NOW, timeoutMs: 20 });
    expect(s.degraded.length).toBeGreaterThan(0);
    expect(s.rooms).toHaveLength(8);
  });
});

describe("memo", () => {
  it("two calls within 2 s = ONE database fan-out; after 2 s a new one", async () => {
    const f = fakeDb();
    let t = NOW;
    const deps = { db: f.db, now: () => t };
    await getSnapshot(deps);
    const first = f.calls.length;
    expect(first).toBeGreaterThan(0);
    t = NOW + 1900;
    await getSnapshot(deps);
    expect(f.calls.length).toBe(first);
    t = NOW + 2100;
    await getSnapshot(deps);
    expect(f.calls.length).toBe(first * 2);
  });
  it("concurrent callers share the in-flight call", async () => {
    const f = fakeDb();
    await Promise.all([getSnapshot({ db: f.db, now: () => NOW }), getSnapshot({ db: f.db, now: () => NOW }), getSnapshot({ db: f.db, now: () => NOW + 50 })]);
    expect(f.calls.filter((c) => c === "bench_listener")).toHaveLength(1);
    expect(f.calls.filter((c) => c === "room_install")).toHaveLength(1);
  });
});

describe("routes", () => {
  it("now: 401 without an admin cookie; with one, 200, no-store, eight rooms", async () => {
    const { GET } = await import("@/app/api/rooms-live/now/route");
    M.cookie.mockResolvedValue(null);
    const denied = await GET(new Request("http://x/api/rooms-live/now"));
    expect(denied.status).toBe(401);
    M.cookie.mockResolvedValue("jwt");
    M.verify.mockResolvedValue({ admin_id: "a", email: "a@b" });
    const ok = await GET(new Request("http://x/api/rooms-live/now"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = await ok.json();
    expect(body.rooms).toHaveLength(8); // the mocked database answers nothing: every room is unknown, the page still renders
    expect(body.rooms.every((r: { state: string }) => r.state === "unknown")).toBe(true);
    expect(Array.isArray(body.degraded)).toBe(true);
  });
  it("day: 401 without a cookie; 400 for a room outside the allow-list (Audiometry, ORB2, ORB3, Home Office, junk)", async () => {
    const { GET } = await import("@/app/api/rooms-live/day/route");
    M.cookie.mockResolvedValue(null);
    expect((await GET(new Request("http://x/api/rooms-live/day?room_id=room_yh3etjpf"))).status).toBe(401);
    M.cookie.mockResolvedValue("jwt");
    M.verify.mockResolvedValue({ admin_id: "a", email: "a@b" });
    for (const id of ["room_jwyrr4dc", "room_2qe955hy", "room_d74hhmc4", "room_mah3aspr", "", "x' OR 1=1"]) expect((await GET(new Request(`http://x/api/rooms-live/day?room_id=${encodeURIComponent(id)}`))).status).toBe(400);
  });
});

describe("guard (admin OR staff)", () => {
  it("no cookie at all: AUTH_REQUIRED", async () => {
    M.cookie.mockResolvedValue(null);
    const g = await roomsLiveGuard();
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("AUTH_REQUIRED");
  });
  it("a valid admin cookie passes as kind admin, named by the e-mail local part", async () => {
    M.cookie.mockResolvedValue("jwt");
    M.verify.mockResolvedValue({ admin_id: "a", email: "ops.person@example.test" });
    expect(await roomsLiveGuard()).toEqual({ ok: true, kind: "admin", name: "ops.person" });
  });
  it("a valid staff cookie passes as kind staff with the typed name", async () => {
    M.cookie.mockResolvedValue(null);
    M.staff.value = await signStaffJwt("Front Desk 2");
    expect(await roomsLiveGuard()).toEqual({ ok: true, kind: "staff", name: "Front Desk 2" });
  });
  it("a garbage or expired staff cookie is AUTH_EXPIRED; an invalid admin cookie with no staff cookie is AUTH_EXPIRED too", async () => {
    M.cookie.mockResolvedValue(null);
    M.staff.value = "not.a.jwt";
    const g = await roomsLiveGuard();
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("AUTH_EXPIRED");
    M.staff.value = null;
    M.cookie.mockResolvedValue("jwt");
    M.verify.mockRejectedValue(new Error("bad"));
    const h = await roomsLiveGuard();
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.code).toBe("AUTH_EXPIRED");
  });
  it("the page guard gives null for nobody, a Who for either cookie", async () => {
    M.cookie.mockResolvedValue(null);
    expect(await roomsLivePageGuard()).toBeNull();
    M.staff.value = await signStaffJwt("Reception");
    expect(await roomsLivePageGuard()).toEqual({ kind: "staff", name: "Reception" });
  });
});
