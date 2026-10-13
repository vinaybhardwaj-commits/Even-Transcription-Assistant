/**
 * gating/fr1-c3 — FR-1 server deltas, against a mocked database. Every id is fake; no patient text.
 *
 *   1  migration 0165 widens the kind CHECK (drop + add, idempotent) and the code knows the four new kinds
 *   2  no_machine in clinic hours is an alert-severity-error decision, and its page does not depend on the steward's shadow switches
 *   3  mic_denied also fires for a room whose newest install is retired and which has no live install
 *   4  ops alert bodies carry the room NAME beside the slug
 *   5  the Retire dialog names the signed-in admin
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Rec = { text: string; values: unknown[] };
const calls: Rec[] = [];
let responses: unknown[] = [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  return { sql, db: {} };
});

const A = await import("@/lib/alerts/ops-alert");
const S = await import("@/lib/alerts/ops-sweep");
const at = (iso: string) => new Date(iso).getTime();
const clinic = at("2026-10-13T10:00:00+05:30");
const night = at("2026-10-13T23:30:00+05:30");
const OPD4 = "room_ux92qpws";
const ALL = ["room_yh3etjpf", "room_87frpus9", OPD4, "room_4ggnkg5x", "room_pnyc9u49", "room_qyzghzaf", "room_ymch4bxu", "room_bh6jtq4t"];
const live = new Map(ALL.map((id) => [id, { mic_state: "authorized" as string | null }]));
const fresh = new Map(ALL.map((id) => [id, clinic - 60_000]));

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

describe("1 migration 0165 and the kinds", () => {
  const sql = readFileSync("db/migrations/0165_room_alert_outbox_fr1_kinds.sql", "utf8");
  const NEW = ["needs_enrol", "capture_stalled", "guardian_quiet", "heal_escalated"];
  it("drops and re-adds the CHECK in one transaction and lists every old and new kind", () => {
    expect(sql).toMatch(/BEGIN;[\s\S]*DROP CONSTRAINT IF EXISTS room_alert_outbox_kind_chk[\s\S]*ADD CONSTRAINT room_alert_outbox_kind_chk[\s\S]*COMMIT;/);
    for (const k of ["offline", "degraded", "recovered", "fleet_outage", "session_reaped", ...A.OPS_ALERT_KINDS, ...NEW]) expect(sql).toContain(`'${k}'`);
    expect(sql).toMatch(/VALUES \(165, '0165_room_alert_outbox_fr1_kinds'\)\s+ON CONFLICT \(version\) DO NOTHING/);
  });
  it("every kind in the ops module is allowed by the CHECK, and the four new ones are in the module", () => {
    const check = sql.slice(sql.indexOf("CHECK (kind IN"));
    for (const k of A.OPS_ALERT_KINDS) expect(check).toContain(`'${k}'`);
    for (const k of NEW) expect(A.OPS_ALERT_KINDS).toContain(k);
  });
  it("a new kind composes a relay-visible subject and body, and queues with its kind", async () => {
    const m = A.composeOpsAlert({ kind: "heal_escalated", room_id: OPD4, room_slug: "opd-4", room_name: "OPD 4", minutes: 12 });
    expect(m.subject).toBe("[ops] heal_escalated opd-4");
    expect(m.body).toBe(`room=opd-4 name="OPD 4" room_id=${OPD4} problem=heal_escalated minutes=12`);
    expect(m.dedupe_key).toBe("heal_escalated");
    responses = [[{ id: 1 }]];
    expect(await A.queueOpsAlert({ kind: "needs_enrol", room_id: OPD4, room_slug: "opd-4", minutes: null })).toBe(true);
    expect(calls[0]!.values).toContain("needs_enrol");
  });
});

describe("2 no_machine is out of shadow in clinic hours", async () => {
  const { DEFAULT_CONFIG } = await import("@/lib/steward/config");
  const { decideRoom } = await import("@/lib/steward/rules");
  const { healthy, ist } = await import("../support/steward-fixtures");
  it("the steward decision is an alert at error severity, not none/info, under the all-shadow default config", () => {
    expect(DEFAULT_CONFIG.shadow.global).toBe(true);
    expect(DEFAULT_CONFIG.kill_switch).toBe(true);
    const d = decideRoom(healthy(ist("10:00"), { machine: null }), DEFAULT_CONFIG, ist("10:00"))[0]!;
    expect(d).toMatchObject({ rule: "no_machine", action: "alert", severity: "error" });
  });
  it("no new live action: alert is not live-capable, so the steward cannot send it; the page goes through the ops sweep", async () => {
    const { actionMode, LIVE_CAPABLE_ACTIONS } = await import("@/lib/steward/config");
    expect(LIVE_CAPABLE_ACTIONS).not.toContain("alert");
    expect(actionMode({ ...DEFAULT_CONFIG, kill_switch: false, shadow: { global: false, actions: {} } }, "alert")).toBe("shadow");
    const installs = new Map(live);
    installs.delete(OPD4);
    const plan = S.planOpsAlerts({ now_ms: clinic, last_chunk_ms: fresh, live_installs: installs });
    expect(plan).toEqual([{ kind: "no_machine", room_id: OPD4, room_slug: OPD4, minutes: null }]);
  });
});

describe("3 mic_denied for a retired last install", () => {
  const installs = () => {
    const m = new Map(live);
    m.delete(OPD4);
    return m;
  };
  it("fires at any hour when there is no live install and the newest retired one reported denied", () => {
    const plan = S.planOpsAlerts({ now_ms: night, last_chunk_ms: new Map(), live_installs: installs(), retired_installs: new Map([[OPD4, { mic_state: "denied" }]]) });
    expect(plan).toEqual([{ kind: "mic_denied", room_id: OPD4, room_slug: OPD4, minutes: null }]);
  });
  it("does not fire when the retired install was fine, when a live install exists, or when the source was not read", () => {
    const base = { now_ms: night, last_chunk_ms: new Map<string, number>() };
    expect(S.planOpsAlerts({ ...base, live_installs: installs(), retired_installs: new Map([[OPD4, { mic_state: "authorized" }]]) })).toEqual([]);
    expect(S.planOpsAlerts({ ...base, live_installs: live, retired_installs: new Map([[OPD4, { mic_state: "denied" }]]) })).toEqual([]);
    expect(S.planOpsAlerts({ ...base, live_installs: installs(), retired_installs: null })).toEqual([]);
  });
  it("a live denied install and a retired denied one are one alert, not two", () => {
    const m = new Map(live);
    m.set(OPD4, { mic_state: "denied" });
    const plan = S.planOpsAlerts({ now_ms: night, last_chunk_ms: new Map(), live_installs: m, retired_installs: new Map([[OPD4, { mic_state: "denied" }]]) });
    expect(plan.filter((p) => p.kind === "mic_denied")).toHaveLength(1);
  });
  it("the sweep reads the newest retired install per room and queues the alert; an unreadable source is named degraded", async () => {
    responses = [[], [], [{ room_id: OPD4, mic_state: "denied" }], [{ id: OPD4, slug: "opd-4", name: "OPD 4" }], ...Array.from({ length: 24 }, () => [{ id: 1 }])];
    const out = await S.runOpsSweep(night);
    expect(calls[2]!.text).toMatch(/SELECT DISTINCT ON \(room_id\) room_id, mic_state FROM room_install WHERE room_id = ANY\(\?::text\[\]\) AND retired_at IS NOT NULL .* ORDER BY room_id, retired_at DESC/);
    expect(out.degraded).toEqual([]);
    const ins = calls.find((c) => c.text.startsWith("INSERT INTO room_alert_outbox") && c.values.includes("mic_denied"));
    expect(ins).toBeTruthy();
    responses = [[], [], new Error("boom")];
    expect((await S.runOpsSweep(night)).degraded).toEqual(["room_install_retired"]);
  });
});

describe("4 the room name is in the body", () => {
  it("the body carries slug and name; the outbox room_name column is the name", async () => {
    const m = A.composeOpsAlert({ kind: "mic_denied", room_id: OPD4, room_slug: "opd-4-k4hz", room_name: "OPD 4", minutes: null });
    expect(m.body).toBe(`room=opd-4-k4hz name="OPD 4" room_id=${OPD4} problem=mic_denied`);
    responses = [[{ id: 1 }]];
    await A.queueOpsAlert({ kind: "mic_denied", room_id: OPD4, room_slug: "opd-4-k4hz", room_name: "OPD 4", minutes: null });
    expect(calls[0]!.values).toContain("OPD 4");
  });
  it("a name is one clean line: control characters, quotes and newlines are removed", () => {
    const m = A.composeOpsAlert({ kind: "recorder_off", room_id: OPD4, room_slug: "s", room_name: 'OPD "4"\nproblem=x', minutes: 20 });
    expect(m.body).toContain('name="OPD 4problemx"');
    expect(m.body.includes("\n")).toBe(false);
  });
  it("no name keeps the old body exactly", () => {
    expect(A.composeOpsAlert({ kind: "recorder_off", room_id: "room_x", room_slug: "opd-4", minutes: 47.6 }).body).toBe("room=opd-4 room_id=room_x problem=recorder_off minutes=48");
  });
  it("the sweep puts the name in every alert it plans", () => {
    const m = new Map(live);
    m.delete(OPD4);
    const plan = S.planOpsAlerts({ now_ms: clinic, last_chunk_ms: fresh, live_installs: m, names: new Map([[OPD4, "OPD 4"]]) });
    expect(plan[0]).toMatchObject({ kind: "no_machine", room_name: "OPD 4" });
  });
});

describe("4b a disable alert carries the name without changing the toggle's own reads", async () => {
  const { recordRoomToggle } = await import("@/lib/room-enable");
  it("reads the name once, only when the alert will be queued, and puts it in the body", async () => {
    responses = [[], [{ name: "OPD 4" }], [{ id: 1 }]];
    await recordRoomToggle({ room_id: OPD4, room_slug: "opd-4", before: "enabled", after: "disabled", actor: "mcp:test", now_ms: clinic });
    expect(calls.map((c) => c.text.split(" ").slice(0, 2).join(" "))).toEqual(["INSERT INTO", "SELECT name", "INSERT INTO"]);
    expect(calls[2]!.values.some((v) => typeof v === "string" && v.includes('name="OPD 4"'))).toBe(true);
    calls.length = 0;
    responses = [[]];
    await recordRoomToggle({ room_id: OPD4, room_slug: "opd-4", before: "enabled", after: "disabled", actor: "mcp:test", now_ms: night });
    expect(calls).toHaveLength(1); // outside clinic hours: the audit row only
  });
});

describe("5 the Retire dialog names the actor", async () => {
  const { retireActorLine } = await import("@/components/admin/BenchInstallFleet");
  it("names the signed-in admin, or says it is the audit log when it cannot", () => {
    expect(retireActorLine(" admin@example.test ")).toBe("This retirement is recorded as done by admin@example.test.");
    expect(retireActorLine("")).toMatch(/audit log/);
  });
  it("the page passes the admin's email to the fleet card", () => {
    expect(readFileSync("app/admin/bench/page.tsx", "utf8")).toContain("<BenchInstallFleet actor={email} />");
  });
});
