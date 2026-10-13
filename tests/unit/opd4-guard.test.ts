/**
 * gating/opd4-guard — the OPD 4 lost-day fixes, server side (S1-S6), against a mocked database. Every id is fake; no name, no transcript.
 *
 *   S1  retire is refused when the install polled in the last 10 min; minting never retires; the handover retires only after the NEW install's first accepted poll;
 *       every retirement writes an `install.retire` audit row and queues an alert
 *   S2  the Retire dialog's pure gate (live / minutes / typed room name) and the route's force + confirm_room check
 *   S3  the clinic-hours window, the dedupe, and what each standing alert reads
 *   S4  no_machine is severity error and action alert in clinic hours (never a room action), info and none outside; recorder_off as a second decision
 *   S5  a roster room with no live install is red (no_install) on the attention panel and listed by scribe_kiosks
 *   S6  the bootstrap script installs to /Applications, serves the fleet's release, and refuses to downgrade
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";

type Rec = { text: string; values: unknown[] };
const calls: Rec[] = [];
const txCalls: Rec[][] = [];
let responses: unknown[] = [];
let txResponses: unknown[][] = [];

function makeQuery(strings: TemplateStringsArray, values: unknown[]) {
  const rec: Rec = { text: strings.join("?").replace(/\s+/g, " ").trim(), values };
  const next = responses.shift();
  const p = (next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? [])) as Promise<unknown> & { __rec?: Rec };
  p.__rec = rec;
  return p;
}
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return makeQuery(strings, values);
  };
  sql.transaction = async (queries: Array<Promise<unknown> & { __rec?: Rec }>) => {
    txCalls.push(queries.map((q) => q.__rec ?? { text: "?", values: [] }));
    await Promise.allSettled(queries);
    return txResponses.shift() ?? queries.map(() => []);
  };
  return { sql, db: {} };
});
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({ admin_id: "adm_1" }) }));

const M = await import("@/lib/room-install");
const V = await import("@/lib/room-install-view");
const H = await import("@/lib/alerts/clinic-hours");
const A = await import("@/lib/alerts/ops-alert");
const S = await import("@/lib/alerts/ops-sweep");

beforeEach(() => {
  calls.length = 0;
  txCalls.length = 0;
  responses = [];
  txResponses = [];
  M.__resetRateLimits();
  process.env.JWT_SECRET_DOCTOR = "test-secret-for-opd4-guard-tests-only";
});

const installRow = (over: Record<string, unknown> = {}) => ({
  install_id: "install_old",
  room_id: "room_x",
  created_at: "2026-10-01T00:00:00Z",
  enrolled_at: "2026-10-01T00:01:00Z",
  retired_at: "2026-10-13T08:00:00Z",
  last_seen_at: "2026-10-13T07:59:00Z",
  tape_poll_streak: 0,
  ...over,
});
const sqlTexts = () => [...calls, ...txCalls.flat()].map((c) => c.text);

// ---------------------------------------------------------------------------
describe("S1 retire safety", () => {
  it("refuses to retire an install that polled in the last 10 minutes (no force): the guard is IN the UPDATE, and nothing is audited or alerted", async () => {
    responses = [[], [{ room_id: "room_x", retired_at: null, last_seen_age_s: 120 }]];
    const out = await M.retireInstall("install_old", { actor: "adm_1" });
    expect(out).toEqual({ ok: false, code: "LIVE", room_id: "room_x", last_seen_age_s: 120 });
    expect(calls[0]!.text).toMatch(/SET retired_at = now\(\)/);
    expect(calls[0]!.text).toMatch(/\(\?::boolean OR last_seen_at IS NULL OR last_seen_at < now\(\) - \(\?::int \* INTERVAL '1 second'\)/);
    expect(calls[0]!.values).toContain(false); // force
    expect(calls[0]!.values).toContain(600);
    expect(sqlTexts().some((t) => /audit_log|room_alert_outbox/.test(t))).toBe(false);
  });

  it("a stale install retires normally: reason manual, one audit row (actor, install, room, reason, last-seen age) and one install_retired alert", async () => {
    responses = [[installRow({ last_seen_age_s: 7200 })], [], [{ slug: "opd-x-1" }], [{ id: 1 }]];
    const out = await M.retireInstall("install_old", { actor: "adm_1" });
    expect(out).toMatchObject({ ok: true, reason: "manual", last_seen_age_s: 7200 });
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c.text))!;
    expect(audit.text).toContain("VALUES ('admin'");
    expect(audit.values).toEqual(expect.arrayContaining(["adm_1", "install.retire", "install_old"]));
    const meta = JSON.parse(String(audit.values.find((v) => typeof v === "string" && v.startsWith("{"))));
    expect(meta).toMatchObject({ install_id: "install_old", room_id: "room_x", reason: "manual", last_seen_age_s: 7200, actor: "adm_1" });
    const alert = calls.find((c) => /INSERT INTO room_alert_outbox/.test(c.text))!;
    expect(alert.values).toEqual(expect.arrayContaining(["install_retired", "room_x", "opd-x-1", "install_old"]));
  });

  it("force on a live install retires it with reason forced, and says so in the audit row", async () => {
    responses = [[installRow({ last_seen_age_s: 30 })], [], [{ slug: "opd-x-1" }], [{ id: 2 }]];
    const out = await M.retireInstall("install_old", { actor: "adm_1", force: true });
    expect(out).toMatchObject({ ok: true, reason: "forced", last_seen_age_s: 30 });
    expect(calls[0]!.values).toContain(true);
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c.text))!;
    expect(String(audit.values.find((v) => typeof v === "string" && v.startsWith("{")))).toContain('"reason":"forced"');
  });

  it("an unknown or already-retired install is NOT_FOUND", async () => {
    responses = [[], []];
    expect(await M.retireInstall("nope", { actor: "adm_1" })).toEqual({ ok: false, code: "NOT_FOUND" });
    responses = [[], [{ room_id: "room_x", retired_at: "2026-10-13T00:00:00Z", last_seen_age_s: 5 }]];
    expect(await M.retireInstall("install_old", { actor: "adm_1" })).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("a failing audit insert or alert never fails the retire", async () => {
    responses = [[installRow({ last_seen_age_s: 7200 })], new Error("audit down"), [{ slug: "s" }], new Error("outbox down")];
    expect(await M.retireInstall("install_old", { actor: "adm_1" })).toMatchObject({ ok: true });
  });

  it("minting a command creates a pending install and retires NOTHING", async () => {
    responses = [
      [{ id: "room_1", slug: "opd-5-ab12", name: "OPD 5" }],
      [{ id: "rel_1", version: "0.1.24", channel: "stable", published_at: new Date().toISOString(), withdrawn_at: null, size_bytes: 10 }],
      [], // fleet versions: none
      [],
      [{ expires_at: new Date(Date.now() + 1_800_000).toISOString() }],
    ];
    txResponses = [[[], [{ expires_at: new Date(Date.now() + 1_800_000).toISOString() }]]];
    await M.mintBootstrapToken({ roomId: "room_1", createdBy: "adm_1" });
    expect(sqlTexts().some((t) => /SET retired_at/.test(t))).toBe(false);
    expect(txCalls[0]!.map((c) => c.text.split(" ")[0])).toEqual(["INSERT", "INSERT"]);
  });

  it("the enrol exchange no longer retires anything; with another enrolled install on the room the new one is left PENDING (enrolled_at NULL), session issued", async () => {
    txResponses = [[[], [{ install_id: "install_new", room_id: "room_1", slug: "opd-5-ab12", name: "OPD 5", session_expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(), pending_handover: true }]]];
    const out = await M.enrolWithToken("a".repeat(32));
    expect(out.pending_handover).toBe(true);
    const [claim, exchange] = txCalls[0]!;
    expect(claim!.text).toMatch(/UPDATE room_bootstrap_token SET used_at = now\(\)/);
    expect(txCalls[0]!.some((c) => /SET retired_at/.test(c.text))).toBe(false);
    expect(exchange!.text).toMatch(/enrolled_at = CASE WHEN EXISTS \( SELECT 1 FROM room_install o/);
    expect(exchange!.text).toMatch(/ri\.session_expires_at IS NULL/); // the single-use guard
  });

  it("a replayed token (session already issued) matches nothing: TOKEN_INVALID", async () => {
    txResponses = [[[], []]];
    await expect(M.enrolWithToken("a".repeat(32))).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("HANDOVER: a pending install's first accepted poll retires the holder first, then enrols itself, in one transaction, and audits reason handover", async () => {
    responses = [[{ install_id: "install_new", assigned_channel: null, enrolled_at: null }]];
    txResponses = [[[{ install_id: "install_old", room_id: "room_x", last_seen_age_s: 4 }], [{ install_id: "install_new" }]]];
    // the probe-less happy path: the poll UPDATE returned a row, so applyInstallPoll hands over
    const out = await M.applyInstallPoll({ install_id: "install_new" } as never, {});
    expect(out).toMatchObject({ ok: true });
    expect(txCalls).toHaveLength(1);
    const [retire, enrol] = txCalls[0]!;
    expect(retire!.text).toMatch(/UPDATE room_install old SET retired_at = now\(\)/);
    expect(retire!.text).toMatch(/nw\.session_expires_at IS NOT NULL/);
    expect(enrol!.text).toMatch(/SET enrolled_at = now\(\)/);
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c.text) && c.values.includes("install_old"))!;
    expect(audit.text).toContain("VALUES ('system'");
    expect(audit.values).toEqual(expect.arrayContaining(["install:install_new", "install.retire"]));
    expect(String(audit.values.find((v) => typeof v === "string" && v.startsWith("{")))).toContain('"reason":"handover"');
    expect(calls.some((c) => /INSERT INTO room_alert_outbox/.test(c.text))).toBe(true);
  });

  it("the nightly cleanup never deletes a pending-handover install (token exchanged, session issued, not yet enrolled)", async () => {
    responses = [[{ token: "t", install_id: "install_new" }]];
    await M.cleanupExpiredInstalls();
    expect(calls[0]!.text).toMatch(/i\.enrolled_at IS NULL AND i\.session_expires_at IS NULL/);
    expect(txCalls[0]![1]!.text).toMatch(/enrolled_at IS NULL AND session_expires_at IS NULL/);
  });

  it("an ordinary poll (enrolled install) never triggers a handover, and a failed handover leaves the poll accepted", async () => {
    responses = [[{ install_id: "install_a", assigned_channel: null, enrolled_at: "2026-10-01T00:00:00Z" }]];
    await M.applyInstallPoll({ install_id: "install_a" } as never, {});
    expect(txCalls).toHaveLength(0);
    responses = [[{ install_id: "install_new", assigned_channel: null, enrolled_at: null }]];
    txResponses = [];
    const out = await M.applyInstallPoll({ install_id: "install_new" } as never, {});
    expect(out).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
describe("S2 retire dialog gate and route", () => {
  const now = Date.parse("2026-10-13T08:00:00Z");
  it("live within 10 min shows 'last seen N min ago'; older or never is not live", () => {
    expect(V.retireGate("2026-10-13T07:57:00Z", now)).toEqual({ live: true, minutes: 3, label: "last seen 3 min ago" });
    expect(V.retireGate("2026-10-13T07:50:00Z", now).live).toBe(false);
    expect(V.retireGate("2026-10-13T07:51:00Z", now).live).toBe(true);
    expect(V.retireGate(null, now)).toEqual({ live: false, minutes: null, label: "never seen" });
  });
  it("the typed text must be the room name (case and edge space ignored)", () => {
    expect(V.retireTypedMatches("  opd 4 ortho ", "OPD 4 Ortho")).toBe(true);
    expect(V.retireTypedMatches("OPD 4", "OPD 4 Ortho")).toBe(false);
    expect(V.retireTypedMatches("", "")).toBe(false);
  });

  const call = async (body: unknown) => {
    process.env.MIGRATION_SECRET = "s".repeat(24);
    const { POST } = await import("@/app/api/admin/installs/[installId]/retire/route");
    const res = await POST(
      new NextRequest("https://x.test/api/admin/installs/install_old/retire", {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(24)}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ installId: "install_old" }) },
    );
    return { status: res.status, json: (await res.json()) as { error?: { code: string; message: string } } };
  };

  it("a live install answers 409 INSTALL_LIVE naming minutes, and nothing is retired", async () => {
    responses = [[], [{ room_id: "room_x", retired_at: null, last_seen_age_s: 180 }]];
    const r = await call(undefined);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: "INSTALL_LIVE" });
    expect(r.json.error!.message).toContain("3 min ago");
  });
  it("force without the room's name is refused before any write", async () => {
    responses = [[{ room_id: "room_x", slug: "opd-4", name: "OPD 4 Ortho" }]];
    const r = await call({ force: true, confirm_room: "OPD 3" });
    expect(r.status).toBe(400);
    expect(sqlTexts().some((t) => /SET retired_at/.test(t))).toBe(false);
  });
  it("force with the room's name goes through", async () => {
    responses = [[{ room_id: "room_x", slug: "opd-4", name: "OPD 4 Ortho" }], [installRow({ last_seen_age_s: 20 })], [], [{ slug: "opd-4" }], [{ id: 3 }]];
    const r = await call({ force: true, confirm_room: "opd 4 ortho" });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("S3 clinic hours, dedupe, and the standing alerts", () => {
  const at = (iso: string) => Date.parse(iso);
  it("07:30-21:30 IST, Monday to Saturday, start inclusive and end exclusive", () => {
    expect(H.isClinicHours(at("2026-10-13T07:29:59+05:30"))).toBe(false); // Tue
    expect(H.isClinicHours(at("2026-10-13T07:30:00+05:30"))).toBe(true);
    expect(H.isClinicHours(at("2026-10-17T21:29:59+05:30"))).toBe(true); // Sat
    expect(H.isClinicHours(at("2026-10-17T21:30:00+05:30"))).toBe(false);
    expect(H.isClinicHours(at("2026-10-18T10:00:00+05:30"))).toBe(false); // Sun
    expect(H.isClinicHours(at("2026-10-12T10:00:00+05:30"))).toBe(true); // Mon
  });
  it("recorder_off needs 15 min of no audio, counted from the later of the last chunk and the window start", () => {
    const now = at("2026-10-13T10:00:00+05:30");
    expect(H.recorderOffMinutes(now, now - 14 * 60_000)).toBeNull();
    expect(H.recorderOffMinutes(now, now - 15 * 60_000)).toBe(15);
    expect(H.recorderOffMinutes(now, null)).toBe(150); // dark since 07:30
    expect(H.recorderOffMinutes(at("2026-10-13T07:40:00+05:30"), at("2026-10-12T20:00:00+05:30"))).toBeNull(); // 10 min into the window
    expect(H.recorderOffMinutes(at("2026-10-13T22:00:00+05:30"), null)).toBeNull(); // outside clinic hours
  });
  it("a message carries the room slug, the problem code and minutes, ids only", () => {
    const m = A.composeOpsAlert({ kind: "recorder_off", room_id: "room_x", room_slug: "opd-4", minutes: 47.6 });
    expect(m).toEqual({ subject: "[ops] recorder_off opd-4", body: "room=opd-4 room_id=room_x problem=recorder_off minutes=48", dedupe_key: "recorder_off" });
    const r = A.composeOpsAlert({ kind: "install_retired", room_id: "room_x", room_slug: "opd-4", minutes: 2, install_id: "install_9", reason: "forced" });
    expect(r.body).toBe("room=opd-4 room_id=room_x problem=install_retired install_id=install_9 reason=forced last_seen_min_ago=2");
    expect(r.dedupe_key).toBe("install_9");
    expect(A.composeOpsAlert({ kind: "mic_denied", room_id: "r", room_slug: "a b\nc", minutes: null }).subject).toBe("[ops] mic_denied abc");
  });
  it("dedupe is in the INSERT: one row per (kind, room, key) per hour; a deduped insert returns false", async () => {
    responses = [[]];
    expect(await A.queueOpsAlert({ kind: "mic_denied", room_id: "room_x", room_slug: "opd-4", minutes: null })).toBe(false);
    expect(calls[0]!.text).toMatch(/WHERE NOT EXISTS \( SELECT 1 FROM room_alert_outbox o WHERE o\.kind = \?::text AND o\.room_ids = ARRAY\[\?::text\] AND o\.status_to = \?::text AND o\.created_at > now\(\) - \(\?::int \* INTERVAL '1 minute'\)/);
    expect(calls[0]!.values).toContain(60);
    responses = [[{ id: 7 }]];
    expect(await A.queueOpsAlert({ kind: "mic_denied", room_id: "room_x", room_slug: "opd-4", minutes: null })).toBe(true);
  });
  it("a failed insert is swallowed (false), never thrown", async () => {
    responses = [new Error("check constraint")];
    expect(await A.queueOpsAlert({ kind: "no_machine", room_id: "room_x", room_slug: "opd-4", minutes: null })).toBe(false);
  });

  const clinic = at("2026-10-13T10:00:00+05:30");
  const live = (mic: string | null = "authorized") => ({ mic_state: mic });
  const all = (m: string | null = "authorized") => new Map(["room_yh3etjpf", "room_87frpus9", "room_ux92qpws", "room_4ggnkg5x", "room_pnyc9u49", "room_qyzghzaf", "room_ymch4bxu", "room_bh6jtq4t"].map((id) => [id, live(m)]));
  const fresh = new Map(Array.from(all().keys()).map((id) => [id, clinic - 60_000]));

  it("a healthy fleet raises nothing", () => {
    expect(S.planOpsAlerts({ now_ms: clinic, last_chunk_ms: fresh, live_installs: all() })).toEqual([]);
  });
  it("(b) recorder_off fires WITHOUT an install: the room's audio is what is read", () => {
    const installs = all();
    installs.delete("room_ux92qpws");
    const chunks = new Map(fresh);
    chunks.set("room_ux92qpws", clinic - 40 * 60_000);
    const plan = S.planOpsAlerts({ now_ms: clinic, last_chunk_ms: chunks, live_installs: installs, slugs: new Map([["room_ux92qpws", "opd-4"]]) });
    expect(plan).toEqual(expect.arrayContaining([
      { kind: "recorder_off", room_id: "room_ux92qpws", room_slug: "opd-4", minutes: 40 },
      { kind: "no_machine", room_id: "room_ux92qpws", room_slug: "opd-4", minutes: null },
    ]));
    expect(plan).toHaveLength(2);
  });
  it("(c) mic_denied fires at any hour; (d) no_machine and (b) recorder_off only in clinic hours", () => {
    const night = at("2026-10-13T23:30:00+05:30");
    const installs = all("denied");
    installs.delete("room_bh6jtq4t");
    const plan = S.planOpsAlerts({ now_ms: night, last_chunk_ms: new Map(), live_installs: installs });
    expect(plan.filter((p) => p.kind === "mic_denied")).toHaveLength(7);
    expect(plan.some((p) => p.kind === "no_machine" || p.kind === "recorder_off")).toBe(false);
  });
  it("a source that could not be read skips its rules instead of reading as healthy or dark", () => {
    expect(S.planOpsAlerts({ now_ms: clinic, last_chunk_ms: null, live_installs: null })).toEqual([]);
    expect(S.planOpsAlerts({ now_ms: clinic, last_chunk_ms: null, live_installs: new Map() }).every((p) => p.kind === "no_machine")).toBe(true);
  });
  it("the sweep queues what it plans, deduped by the database", async () => {
    const real = Date.now;
    Date.now = () => clinic;
    try {
      responses = [[], [], [], [], ...Array.from({ length: 24 }, () => [{ id: 1 }])];
      const out = await S.runOpsSweep(clinic);
      expect(out.degraded).toEqual([]);
      expect(out.planned).toBeGreaterThan(0);
      expect(out.queued).toBe(out.planned);
    } finally {
      Date.now = real;
    }
  });
  it("the cron door refuses without the bearer", async () => {
    process.env.CRON_SECRET = "c".repeat(20);
    const { GET } = await import("@/app/api/cron/ops-alerts/route");
    expect((await GET(new Request("https://x.test/api/cron/ops-alerts"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(new Request("https://x.test/api/cron/ops-alerts"))).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
describe("S4 steward", async () => {
  const { DEFAULT_CONFIG } = await import("@/lib/steward/config");
  const { decideRoom } = await import("@/lib/steward/rules");
  const { healthy, ist, ago } = await import("../support/steward-fixtures");

  it("no_machine in clinic hours is severity error, action alert (never a room action); outside it, info and none", () => {
    const d = decideRoom(healthy(ist("10:00"), { machine: null }), DEFAULT_CONFIG, ist("10:00"))[0]!;
    expect(d).toMatchObject({ rule: "no_machine", action: "alert", severity: "error" });
    const night = decideRoom(healthy(ist("23:00"), { machine: null }), DEFAULT_CONFIG, ist("23:00"))[0]!;
    expect(night).toMatchObject({ rule: "no_machine", action: "none", severity: "info" });
    const sunday = decideRoom(healthy(ist("10:00", "2026-10-11"), { machine: null }), DEFAULT_CONFIG, ist("10:00", "2026-10-11"))[0]!;
    expect(sunday).toMatchObject({ rule: "no_machine", action: "none" });
  });
  it("recorder_off is a second decision after 15 min with no audio, whatever the machine binding says", () => {
    const A = ist("10:00");
    const dark = healthy(A, { machine: null, recording: { last_chunk_at: ago(A, 40 * 60), last_chunk_24h_at: ago(A, 40 * 60) } });
    const ds = decideRoom(dark, DEFAULT_CONFIG, A);
    expect(ds.find((d) => d.rule === "recorder_off")).toMatchObject({ action: "alert", severity: "error", inputs: { recorder_off_min: 40 } });
    const fine = decideRoom(healthy(A, { machine: null, recording: { last_chunk_at: ago(A, 10 * 60) } }), DEFAULT_CONFIG, A);
    expect(fine.some((d) => d.rule === "recorder_off")).toBe(false);
    // a room whose primary decision already names a fault gets no second row (the sweep still pages it)
    const failing = decideRoom(healthy(A, { recording: { session_open: false, last_chunk_at: ago(A, 40 * 60) } }), DEFAULT_CONFIG, A);
    expect(failing.some((d) => d.rule === "recorder_off")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("S5 a roster room with no live install is red, not omitted", () => {
  it("the attention panel gets one red no_install item per roster room without a live install", async () => {
    const { noInstallItems } = await import("@/lib/fleet-attention");
    const roster = [{ room_id: "room_a", label: "OPD A" }, { room_id: "room_b", label: "OPD B" }];
    const items = noInstallItems(roster, new Set(["room_a"]), new Map([["room_b", "2026-10-12T07:55:54.000Z"]]), Date.parse("2026-10-13T05:00:00Z"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ room_id: "room_b", kind: "no_install", severity: "red", since: "2026-10-12T07:55:54.000Z", machine: null });
  });
});

// ---------------------------------------------------------------------------
describe("S6 bootstrap: /Applications, the fleet's release, no downgrade", () => {
  const input = { token: "t".repeat(32), origin: "https://x.test", blobUrl: "https://x.public.blob.vercel-storage.com/a.zip", sha256: "a".repeat(64), version: "0.1.34", roomName: "OPD 4" };

  it("installs into /Applications, never ~/Applications, and removes the stale user copy", () => {
    const script = M.renderBootstrapScript(input);
    expect(script).toContain('DEST="/Applications"');
    expect(script).not.toContain('DEST="$HOME/Applications"');
    expect(script).toContain('echo "Installing into /Applications..."');
    expect(script).toContain('rm -rf "$HOME/Applications/$APP"');
  });

  it("the downgrade guard runs in bash: refuses a Mac that is ahead, allows equal and older (version sort is numeric, 0.1.9 < 0.1.34)", () => {
    const guard = (have: string, next: string) =>
      execFileSync("bash", ["-c", `HAVE="${have}"; NEW_VERSION="${next}"; NEWEST="$(printf '%s\\n%s\\n' "$HAVE" "$NEW_VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"; if [ "$HAVE" != "$NEW_VERSION" ] && [ "$NEWEST" = "$HAVE" ]; then echo refuse; else echo ok; fi`]).toString().trim();
    expect(guard("0.1.34", "0.1.24")).toBe("refuse");
    expect(guard("0.1.34", "0.1.34")).toBe("ok");
    expect(guard("0.1.24", "0.1.34")).toBe("ok");
    expect(guard("0.1.9", "0.1.34")).toBe("ok");
    expect(guard("0.1.34", "0.1.9")).toBe("refuse");
    const script = M.renderBootstrapScript(input);
    expect(script).toContain('NEW_VERSION="0.1.34"');
    expect(script).toContain("printf '%s\\n%s\\n' \"$HAVE\" \"$NEW_VERSION\"");
    expect(script.indexOf("Install stopped. Nothing was changed.")).toBeLessThan(script.indexOf("Stopping any earlier copy"));
  });

  const rel = (version: string, channel: "stable" | "test") => ({ id: `rel_${version}`, version, channel, blob_url: `https://x/${version}`, sha256: "a".repeat(64), size_bytes: 1 }) as never;
  it("chooseBootstrapRelease: stable when the fleet is not ahead; the fleet's published version when it is; never a test build newer than the fleet", () => {
    const stable = rel("0.1.24", "stable");
    expect(M.chooseBootstrapRelease(stable, rel("0.1.34", "test"), null)).toBe(stable);
    expect(M.chooseBootstrapRelease(stable, rel("0.1.34", "test"), "0.1.20")).toBe(stable);
    expect(M.chooseBootstrapRelease(stable, rel("0.1.34", "test"), "0.1.34")).toMatchObject({ version: "0.1.34" });
    expect(M.chooseBootstrapRelease(stable, rel("0.1.40", "test"), "0.1.34")).toBe(stable); // nothing at 0.1.34 published: stable stands, the script refuses a downgrade
    expect(M.chooseBootstrapRelease(null, rel("0.1.34", "test"), "0.1.34")).toMatchObject({ version: "0.1.34" });
    expect(M.chooseBootstrapRelease(null, null, "0.1.34")).toBeNull();
    expect(M.compareVersions("0.1.9", "0.1.34")).toBeLessThan(0);
  });

  it("M1: only STABLE-channel installs set the fleet version; a test-channel Mac at a higher version changes nothing a new bootstrap gets", async () => {
    const stableRow = { id: "rel_24", version: "0.1.24", channel: "stable", published_at: "2026-09-01T00:00:00Z", withdrawn_at: null, size_bytes: 1 };
    // the SQL is what filters: assert it, and that with only the stable-channel rows the answer is stable
    responses = [[stableRow], [{ app_version: "0.1.24" }]];
    expect(await M.bootstrapRelease()).toMatchObject({ version: "0.1.24" });
    const q = calls.find((c) => /SELECT app_version FROM room_install/.test(c.text))!;
    expect(q.text).toContain("COALESCE(update_channel, 'stable') = 'stable'");
  });

  it("bootstrapRelease reads the fleet's version and serves the published release that matches it", async () => {
    const stableRow = { id: "rel_24", version: "0.1.24", channel: "stable", published_at: "2026-09-01T00:00:00Z", withdrawn_at: null, size_bytes: 1 };
    const testRow = { id: "rel_34", version: "0.1.34", channel: "test", published_at: "2026-10-10T00:00:00Z", withdrawn_at: null, size_bytes: 1 };
    responses = [[stableRow], [{ app_version: "0.1.34" }, { app_version: "0.1.28" }, { app_version: null }], [testRow]];
    expect(await M.bootstrapRelease()).toMatchObject({ version: "0.1.34" });
    responses = [[stableRow], [{ app_version: "0.1.24" }]];
    expect(await M.bootstrapRelease()).toMatchObject({ version: "0.1.24" });
    responses = [[stableRow], new Error("fleet read failed")];
    expect(await M.bootstrapRelease()).toMatchObject({ version: "0.1.24" });
  });
});

// ---------------------------------------------------------------------------
describe("S7 room enable / disable is audited and a clinic-hours disable alerts", () => {
  it("disable: one room.disable audit row (actor, room, reason, before -> after) and a room_disabled alert inside clinic hours", async () => {
    const R = await import("@/lib/room-enable");
    responses = [[{ slug: "opd-4", disabled_at: null }], [], [], [{ id: 1 }]];
    const out = await R.setRoomEnabled("room_x", false, { actor: "adm_1", reason: "cleaning" });
    expect(out).toEqual({ ok: true, room_id: "room_x", room_slug: "opd-4", before: "enabled", after: "disabled" });
    expect(calls[1]!.text).toMatch(/SET disabled_at = NOW\(\)/);
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c.text))!;
    expect(audit.values).toEqual(expect.arrayContaining(["admin", "adm_1", "room.disable", "room_x"]));
    expect(JSON.parse(String(audit.values.find((v) => typeof v === "string" && v.startsWith("{"))))).toEqual({ actor: "adm_1", room_id: "room_x", reason: "cleaning", before: "enabled", after: "disabled" });
    // the alert only fires inside clinic hours; the wall clock decides here, so assert it through the pure path below
  });
  it("recordRoomToggle: alert only for a disable inside clinic hours; enable and night-time disable write the audit row alone", async () => {
    const R = await import("@/lib/room-enable");
    const base = { room_id: "room_x", room_slug: "opd-4", actor: "adm_1" };
    responses = [[], [{ id: 1 }]];
    await R.recordRoomToggle({ ...base, before: "enabled", after: "disabled", now_ms: Date.parse("2026-10-13T10:00:00+05:30") });
    expect(calls.filter((c) => /room_alert_outbox/.test(c.text))).toHaveLength(1);
    expect(calls.find((c) => /room_alert_outbox/.test(c.text))!.values).toContain("room_disabled");
    calls.length = 0;
    await R.recordRoomToggle({ ...base, before: "enabled", after: "disabled", now_ms: Date.parse("2026-10-13T23:00:00+05:30") });
    await R.recordRoomToggle({ ...base, before: "disabled", after: "enabled", now_ms: Date.parse("2026-10-13T10:00:00+05:30") });
    expect(calls.filter((c) => /room_alert_outbox/.test(c.text))).toHaveLength(0);
    expect(calls.filter((c) => /room\.(enable|disable)/.test(JSON.stringify(c.values)))).toHaveLength(2);
  });
  it("the PIN-lockout auto-disable is audited as system:pin_lockout", async () => {
    const R = await import("@/lib/room-enable");
    responses = [[]];
    await R.recordRoomToggle({ room_id: "room_x", room_slug: "opd-4", before: "enabled", after: "disabled", actor: "system:pin_lockout", reason: "30 failed PIN attempts", now_ms: Date.parse("2026-10-13T23:00:00+05:30") });
    expect(calls[0]!.values).toEqual(expect.arrayContaining(["system", "system:pin_lockout", "room.disable"]));
  });
  it("an mcp:<actor> principal is actor_type system for a room toggle and for a retirement; actor_id keeps the name", async () => {
    const R = await import("@/lib/room-enable");
    responses = [[]];
    await R.recordRoomToggle({ room_id: "room_x", room_slug: "opd-4", before: "enabled", after: "disabled", actor: "mcp:scribe-admin", now_ms: Date.parse("2026-10-13T23:00:00+05:30") });
    expect(calls[0]!.values).toEqual(expect.arrayContaining(["system", "mcp:scribe-admin"]));
    calls.length = 0;
    responses = [[installRow({ last_seen_age_s: 7200 })], [], [{ slug: "s" }], [{ id: 1 }]];
    await M.retireInstall("install_old", { actor: "mcp:scribe-admin" });
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c.text))!;
    expect(audit.text).toContain("VALUES ('system'");
    expect(audit.values).toContain("mcp:scribe-admin");
  });
  it("an unknown room is NOT_FOUND and writes nothing", async () => {
    const R = await import("@/lib/room-enable");
    responses = [[]];
    expect(await R.setRoomEnabled("nope", true, { actor: "adm_1" })).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("M2: the script checks it can install BEFORE it stops the running recorder", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const input = { token: "t".repeat(32), origin: "https://x.test", blobUrl: "https://x.public.blob.vercel-storage.com/a.zip", sha256: "a".repeat(64), version: "0.1.34", roomName: "OPD 4" };

  /** Run the rendered Mac body under bash with fake curl / shasum / ditto / launchctl; DEST is swapped for `dest`. Returns the exit code, output and the launchctl log. */
  function run(dest: string, mutate?: (home: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "m2-"));
    const bin = join(root, "bin");
    const home = join(root, "home");
    mkdirSync(bin);
    mkdirSync(home);
    const log = join(root, "launchctl.log");
    const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    fake("curl", 'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then echo zip > "$2"; fi; shift; done');
    fake("shasum", `echo "${"a".repeat(64)}  -"`);
    fake("launchctl", `echo "$@" >> "${log}"`);
    // ditto -x -k zip dir  -> a fake bundle with a runnable room-recorder; ditto src dst -> copy
    fake("ditto", 'if [ "$1" = "-x" ]; then mkdir -p "$4/EvenScribe Room Recorder.app/Contents/MacOS"; printf "#!/bin/bash\\nexit 0\\n" > "$4/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder"; chmod +x "$4/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder"; else cp -R "$1" "$2"; fi');
    mutate?.(home);
    const script = M.renderBootstrapScript(input).split("\n").map((l) => (l === 'DEST="/Applications"' ? `DEST="${dest}"` : l)).join("\n");
    const r = spawnSync("bash", ["-c", script.slice(script.indexOf('APP="EvenScribe'))], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home } as unknown as NodeJS.ProcessEnv, encoding: "utf8" as const });
    return { code: r.status, out: String(r.stdout) + String(r.stderr), log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  }

  it("a destination that is not a directory aborts with a clear message and never calls launchctl bootout", () => {
    const root = mkdtempSync(join(tmpdir(), "m2f-"));
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    const r = run(file);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("cannot write");
    expect(r.out).toContain("The running recorder was not touched");
    expect(r.log).not.toContain("bootout");
  });

  it.skipIf(process.getuid?.() === 0)("an unwritable directory aborts before bootout", () => {
    const dir = mkdtempSync(join(tmpdir(), "m2u-"));
    chmodSync(dir, 0o555);
    const r = run(dir);
    chmodSync(dir, 0o755);
    expect(r.code).not.toBe(0);
    expect(r.log).not.toContain("bootout");
  });

  it("a writable destination: the new bundle is copied BESIDE the old one first, then bootout, then the swap", () => {
    const dir = mkdtempSync(join(tmpdir(), "m2ok-"));
    mkdirSync(join(dir, "EvenScribe Room Recorder.app"));
    writeFileSync(join(dir, "EvenScribe Room Recorder.app", "old"), "old");
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.log).toContain("bootout");
    expect(existsSync(join(dir, "EvenScribe Room Recorder.app", "Contents", "MacOS", "room-recorder"))).toBe(true);
    expect(existsSync(join(dir, "EvenScribe Room Recorder.app", "old"))).toBe(false);
    expect(existsSync(join(dir, "EvenScribe Room Recorder.app.new"))).toBe(false);
  });

  it("in the rendered text every abort comes before the bootout line", () => {
    const script = M.renderBootstrapScript(input);
    const boot = script.indexOf('launchctl bootout "gui/$(id -u)/com.evenscribe.room-recorder"', script.indexOf("APP="));
    expect(script.indexOf("The running recorder was not touched")).toBeLessThan(boot);
    expect(script.lastIndexOf("Install stopped.", boot)).toBeGreaterThan(0);
  });
});
