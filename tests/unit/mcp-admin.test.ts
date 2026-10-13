/**
 * ADMIN-1 (13 Oct 2026) — scribe_admin: scope, reason, audit shape, patient and live gates, idempotence, bind rules, the
 * token/command never reaching an audit row or a log line, and the two existing routes (Bench PATCH, /admin retire) now auditing.
 * `sql` is replaced by a small in-memory fake keyed on the statement text; no DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeFakeOperator } from "../support/fake-identity";

type Row = Record<string, unknown>;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const db = {
  rooms: [] as Row[],
  installs: [] as Row[],
  audits: [] as Array<{ q: string; values: unknown[] }>,
  recording: { known: true, rooms: [] as Array<{ room_id: string }> } as { known: boolean; rooms: Array<{ room_id: string }>; reason?: string },
  mintLog: [] as unknown[],
  noRelease: false,
  auditDown: false,
  writes: [] as string[],
};

const allAdminAudits = () => db.audits.filter((a) => /action, target_type/.test(a.q) && !/mcp\.tools\/call/.test(a.q)).map((a) => ({ actor_type: a.values[0], actor_id: a.values[1], action: a.values[2] as string, target_type: a.values[3], target_id: a.values[4], meta: JSON.parse(a.values[5] as string) as Row }));

/** the pre-write rows (admin.<action> and admin.<action>.refused) */
const adminAudits = () => allAdminAudits().filter((a) => !a.action.endsWith(".result"));
/** the post-write rows (admin.<action>.result) */
const resultAudits = () => allAdminAudits().filter((a) => a.action.endsWith(".result"));

function run(strings: TemplateStringsArray, values: unknown[]): Row[] {
  const q = strings.join("?").replace(/\s+/g, " ").trim();
  if (/^INSERT INTO audit_log/.test(q)) {
    if (db.auditDown && !/mcp\.tools\/call/.test(q)) throw new Error("audit_log down");
    db.audits.push({ q, values });
    return [];
  }
  if (/^UPDATE room/.test(q)) db.writes.push(q.slice(0, 40));
  if (/^SELECT id, slug, name, disabled_at FROM room WHERE/.test(q)) {
    const want = values.filter((v): v is string => typeof v === "string");
    return db.rooms.filter((r) => want.some((w) => w === r.id || w === r.slug || w.toLowerCase() === String(r.name).toLowerCase()));
  }
  if (/^SELECT disabled_at FROM room WHERE id/.test(q)) return db.rooms.filter((r) => r.id === values[0]).map((r) => ({ disabled_at: r.disabled_at }));
  if (/^UPDATE room SET failed_attempts/.test(q)) return [];
  if (/^UPDATE room SET disabled_at = NULL/.test(q)) { for (const r of db.rooms) if (r.id === values[0]) r.disabled_at = null; return []; }
  if (/^UPDATE room SET disabled_at = NOW\(\) WHERE id = \? AND disabled_at IS NULL/.test(q)) {
    const r = db.rooms.find((x) => x.id === values[0] && x.disabled_at === null);
    if (!r) return [];
    r.disabled_at = new Date(NOW).toISOString();
    return [{ disabled_at: r.disabled_at }];
  }
  if (/FROM room_install WHERE install_id = \?/.test(q)) return db.installs.filter((i) => i.install_id === values[0]);
  if (/FROM room_install WHERE room_id = \? AND enrolled_at IS NOT NULL AND retired_at IS NULL/.test(q)) return db.installs.filter((i) => i.room_id === values[0] && i.enrolled_at && !i.retired_at).slice(0, 1);
  if (/FROM room_install WHERE room_id = \? ORDER BY created_at DESC LIMIT/.test(q)) return db.installs.filter((i) => i.room_id === values[0]).slice(0, Number(values[1]));
  if (/^UPDATE room_install SET retired_at = now\(\)/.test(q)) {
    const i = db.installs.find((x) => x.install_id === values[0] && !x.retired_at);
    if (!i) return [];
    i.retired_at = new Date(NOW).toISOString();
    return [{ ...i, tape_poll_streak: 0 }];
  }
  if (/SET retired_at = NULL/.test(q)) {
    const [installId, roomId] = values as string[];
    const live = db.installs.some((o) => o.room_id === roomId && !o.retired_at && o.enrolled_at);
    const i = db.installs.find((x) => x.install_id === installId && x.room_id === roomId && x.retired_at && x.enrolled_at);
    if (!i || live) return [];
    i.retired_at = null;
    return [{ install_id: i.install_id }];
  }
  if (/^SELECT install_id, retired_at, hostname FROM room_install/.test(q)) return db.installs.filter((i) => i.room_id === values[0] && i.retired_at).slice(0, 3);
  if (/^SELECT action, actor_id, created_at, metadata_json->>'reason' AS reason FROM audit_log/.test(q)) {
    return adminAudits().filter((a) => a.meta.room_id === values[0]).slice(-5).reverse().map((a) => ({ action: a.action, actor_id: a.actor_id, created_at: new Date(NOW).toISOString(), reason: a.meta.reason }));
  }
  throw new Error(`fake sql: unhandled statement: ${q.slice(0, 120)}`);
}

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => { try { return Promise.resolve(run(strings, values)); } catch (e) { return Promise.reject(e); } };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/bench-join", () => ({ roomsRecordingNow: async () => db.recording }));
vi.mock("@/lib/bench", () => ({
  benchAdminGuard: async () => ({ ok: true, claims: { admin_id: "adm_1", email: makeFakeOperator(1).email } }),
  buildRoomSlug: () => ({ full: "x" }),
  newRoomId: () => "room_x",
}));
const SECRET_TOKEN = "bt_SECRETTOKENVALUE0123456789";
const SECRET_COMMAND = `curl -fsSL https://evenscribe.app/api/install/bootstrap/${SECRET_TOKEN} | bash`;
vi.mock("@/lib/room-install", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    mintBootstrapToken: async (input: { roomId: string; createdBy: string }) => {
      db.mintLog.push(input);
      if (db.noRelease) throw new (real.InstallError as new (c: string, m: string) => Error)("NO_RELEASE", "no release published yet");
      return { token: SECRET_TOKEN, install_id: "inst_new", command: SECRET_COMMAND, expires_at: "2026-10-13T10:00:00.000Z", room: { id: "room_a", slug: "opd-4-abcd", name: "OPD 4" }, release: { version: "0.1.99" } };
    },
  };
});

const { handleMcpRpc } = await import("@/lib/mcp/handler");
const { checkMcpBearer, parseTokenMap, ALL_SCOPES } = await import("@/lib/mcp/auth");
const { PATCH: benchPatch } = await import("@/app/api/bench/rooms/route");
const { POST: retireRoute } = await import("@/app/api/admin/installs/[installId]/retire/route");

type Scope = "read" | "invoke" | "write" | "admin";
const rpc = (name: string, args: Row) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
async function call(args: Row, scopes: Scope[] = ["read", "admin"], actor = "fable") {
  const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: rpc("scribe_admin", args) });
  const res = await handleMcpRpc(req, { token_id: actor, scopes: new Set(scopes) });
  const body = (await res.json()) as { result?: { structuredContent: Row }; error?: { code: number; message: string; data?: Row } };
  return { status: res.status, out: (body.result?.structuredContent ?? {}) as Row, error: body.error };
}

const ROOM_A = { id: "room_a", slug: "opd-4-abcd", name: "OPD 4", disabled_at: null as string | null };
const ROOM_B = { id: "room_b", slug: "opd-5-wxyz", name: "OPD 5", disabled_at: null as string | null };
const inst = (o: Row): Row => ({ install_id: "inst_1", room_id: "room_a", created_at: ago(86_400_000), enrolled_at: ago(80_000_000), retired_at: null, hostname: "mac-1", app_version: "0.1.50", last_seen_at: ago(3_600_000), update_channel: "stable", session_open: false, mic_state: "authorized", ...o });

let logs: string[];
beforeEach(() => {
  db.rooms = [{ ...ROOM_A }, { ...ROOM_B }];
  db.installs = [inst({})];
  db.audits = [];
  db.mintLog = [];
  db.noRelease = false;
  db.auditDown = false;
  db.writes = [];
  db.recording = { known: true, rooms: [] };
  logs = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

const WRITES = ["room_enable", "room_disable", "install_mint", "install_retire", "bind", "unbind"];
const writeArgs = (action: string): Row => ({ action, room: "room_a", reason: "test", install_id: "inst_1" });

describe("scope", () => {
  it("the single-token fallback (operator-v1) gets read/invoke/write and NOT admin; every admin write is scope_or_tool_unavailable", async () => {
    const prev = process.env.SCRIBE_MCP_TOKEN; const prevMap = process.env.SCRIBE_MCP_TOKENS;
    process.env.SCRIBE_MCP_TOKEN = "fallback-token"; delete process.env.SCRIBE_MCP_TOKENS;
    try {
      const r = checkMcpBearer(new Request("https://x/api/mcp", { headers: { authorization: "Bearer fallback-token" } }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.principal.token_id).toBe("operator-v1");
      expect([...r.principal.scopes].sort()).toEqual(["invoke", "read", "write"]);
      expect(ALL_SCOPES).not.toContain("admin");
      for (const action of WRITES) {
        const res = await call(writeArgs(action), [...r.principal.scopes] as Scope[], "operator-v1");
        expect(res.status, action).toBe(403);
        expect(res.error?.message, action).toBe("scope_or_tool_unavailable");
        expect(res.error?.data?.needed, action).toBe("admin");
      }
      expect(adminAudits()).toEqual([]);
      expect((await call({ action: "state", room: "room_a" }, ["read", "invoke", "write"], "operator-v1")).out.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SCRIBE_MCP_TOKEN; else process.env.SCRIBE_MCP_TOKEN = prev;
      if (prevMap !== undefined) process.env.SCRIBE_MCP_TOKENS = prevMap;
    }
  });

  it("a map entry that lists admin has it; an unknown scope is still dropped; the extra map can grant it too", () => {
    const h = (t: string) => createHash("sha256").update(t).digest("hex");
    const m = parseTokenMap(JSON.stringify({ [h("a")]: { actor: "fable", scopes: ["read", "admin", "bogus"] }, [h("b")]: { actor: "w", scopes: ["read"] } }));
    expect([...m[h("a")]!.scopes].sort()).toEqual(["admin", "read"]);
    expect([...m[h("b")]!.scopes]).toEqual(["read"]);
  });

  it("a read token can do state and install_list but none of the writes", async () => {
    expect((await call({ action: "state", room: "room_a" }, ["read"])).out.ok).toBe(true);
    const list = await call({ action: "install_list", room: "room_a" }, ["read"]);
    expect(list.out.ok).toBe(true);
    for (const action of WRITES) expect((await call(writeArgs(action), ["read"])).status, action).toBe(403);
    expect(adminAudits()).toEqual([]);
    expect(db.rooms[0]!.disabled_at).toBeNull();
  });

  it("a token with admin but not read cannot reach the tool at all", async () => {
    expect((await call({ action: "state", room: "room_a" }, ["admin"])).status).toBe(403);
  });
});

describe("reason", () => {
  it("every write without a reason, with a blank one, or over 500 chars is bad_args and changes and audits nothing", async () => {
    for (const action of WRITES) {
      for (const reason of [undefined, "", "   ", "x".repeat(501)]) {
        const args: Row = { action, room: "room_a", install_id: "inst_1" };
        if (reason !== undefined) args.reason = reason;
        const { out } = await call(args);
        expect(out.error, `${action} ${String(reason).length}`).toBe("bad_args");
      }
    }
    expect(adminAudits()).toEqual([]);
    expect(db.mintLog).toEqual([]);
  });
});

describe("room_enable / room_disable", () => {
  it("disable writes one audit row of the right shape, echoes {reason,before,after}, and a second disable is a no-op that is still audited", async () => {
    const a = await call({ action: "room_disable", room: "opd-4-abcd", reason: "closing for the day" });
    expect(a.out).toMatchObject({ ok: true, changed: true, reason: "closing for the day", before: { disabled_at: null } });
    expect((a.out.after as Row).disabled_at).toBeTruthy();
    const rows = adminAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "system", actor_id: "mcp:fable", action: "admin.room_disable", target_type: "room", target_id: "room_a" });
    expect(rows[0]!.meta).toMatchObject({ reason: "closing for the day", before: { disabled_at: null }, room_id: "room_a" });
    expect((rows[0]!.meta.after as Row).disabled_at).toBeTruthy();
    const b = await call({ action: "room_disable", room: "room_a", reason: "again" });
    expect(b.out).toMatchObject({ ok: true, changed: false });
    expect(adminAudits()).toHaveLength(2);
    expect(resultAudits()[1]!.meta.changed).toBe(false);
    expect(resultAudits()).toHaveLength(2);
  });

  it("enable clears disabled_at; enabling an enabled room is a no-op that is audited", async () => {
    db.rooms[0]!.disabled_at = ago(1000);
    const a = await call({ action: "room_enable", room: "room_a", reason: "back open" });
    expect(a.out).toMatchObject({ ok: true, changed: true, after: { disabled_at: null } });
    expect(db.rooms[0]!.disabled_at).toBeNull();
    const b = await call({ action: "room_enable", room: "room_a", reason: "again" });
    expect(b.out).toMatchObject({ ok: true, changed: false });
    expect(adminAudits().map((r) => r.action)).toEqual(["admin.room_enable", "admin.room_enable"]);
  });

  it("an unknown room is unknown_room and audits nothing", async () => {
    expect((await call({ action: "room_disable", room: "nope", reason: "x" })).out.error).toBe("unknown_room");
    expect(adminAudits()).toEqual([]);
  });
});

describe("patient gate", () => {
  const recordingNow = () => { db.recording = { known: true, rooms: [{ room_id: "room_a" }] }; };

  it("room_disable while recording is refused patient_gate (audited as .refused) and the room is unchanged", async () => {
    recordingNow();
    const { out } = await call({ action: "room_disable", room: "room_a", reason: "close" });
    expect(out).toMatchObject({ ok: false, error: "patient_gate" });
    expect(db.rooms[0]!.disabled_at).toBeNull();
    expect(adminAudits().map((r) => r.action)).toEqual(["admin.room_disable.refused"]);
  });

  it("override without 'V GO' in the reason is refused; the words without the flag are refused; both together are allowed", async () => {
    recordingNow();
    expect((await call({ action: "room_disable", room: "room_a", reason: "urgent", override_patient_gate: true })).out.error).toBe("patient_gate");
    expect((await call({ action: "room_disable", room: "room_a", reason: "V GO on this" })).out.error).toBe("patient_gate");
    expect(db.rooms[0]!.disabled_at).toBeNull();
    const ok = await call({ action: "room_disable", room: "room_a", reason: "approved, v go", override_patient_gate: true });
    expect(ok.out).toMatchObject({ ok: true, changed: true });
    expect(db.rooms[0]!.disabled_at).toBeTruthy();
  });

  it("an unreadable recording state also refuses (fails closed)", async () => {
    db.recording = { known: false, rooms: [], reason: "sessions_unavailable" };
    expect((await call({ action: "room_disable", room: "room_a", reason: "x" })).out).toMatchObject({ error: "patient_gate", why: "recording_state_unknown" });
  });

  it("a bound install with session_open true gates even when the recording rollup is empty", async () => {
    db.installs = [inst({ session_open: true })];
    expect((await call({ action: "unbind", room: "room_a", reason: "x" })).out).toMatchObject({ error: "patient_gate", why: "install_session_open" });
    expect(db.installs[0]!.retired_at).toBeNull();
  });

  it("install_retire and unbind are gated the same way and the refusal is audited", async () => {
    recordingNow();
    expect((await call({ action: "install_retire", room: "room_a", install_id: "inst_1", reason: "x" })).out.error).toBe("patient_gate");
    expect((await call({ action: "unbind", room: "room_a", reason: "x" })).out.error).toBe("patient_gate");
    expect(adminAudits().map((r) => r.action)).toEqual(["admin.install_retire.refused", "admin.unbind.refused"]);
    expect(db.installs[0]!.retired_at).toBeNull();
  });
});

describe("install_retire / unbind", () => {
  it("retires a quiet install: audit row admin.install_retire with before/after, response echoes them, a repeat is a no-op", async () => {
    const a = await call({ action: "install_retire", room: "room_a", install_id: "inst_1", reason: "wrong Mac" });
    expect(a.out).toMatchObject({ ok: true, changed: true, reason: "wrong Mac", before: { retired_at: null } });
    expect((a.out.after as Row).retired_at).toBeTruthy();
    const rows = adminAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: "mcp:fable", action: "admin.install_retire", target_type: "room_install", target_id: "inst_1" });
    expect(rows[0]!.meta).toMatchObject({ reason: "wrong Mac", room_id: "room_a", install_id: "inst_1", before: { retired_at: null } });
    const b = await call({ action: "install_retire", room: "room_a", install_id: "inst_1", reason: "again" });
    expect(b.out).toMatchObject({ ok: true, changed: false });
    expect(adminAudits()).toHaveLength(2);
  });

  it("live gate: an install seen in the last 10 minutes is refused install_live; confirm_live=true allows it; unbind too", async () => {
    db.installs = [inst({ last_seen_at: ago(2 * 60_000) })];
    const r = await call({ action: "install_retire", room: "room_a", install_id: "inst_1", reason: "x" });
    expect(r.out).toMatchObject({ ok: false, error: "install_live" });
    expect((await call({ action: "unbind", room: "room_a", reason: "x" })).out.error).toBe("install_live");
    expect(db.installs[0]!.retired_at).toBeNull();
    expect(adminAudits().map((a) => a.action)).toEqual(["admin.install_retire.refused", "admin.unbind.refused"]);
    const ok = await call({ action: "unbind", room: "room_a", reason: "x", confirm_live: true });
    expect(ok.out).toMatchObject({ ok: true, changed: true });
    expect(adminAudits().at(-1)!.action).toBe("admin.unbind");
  });

  it("an install of another room is install_not_in_room; an unknown install is no_install; unbind with no live install is no_install", async () => {
    db.installs = [inst({ install_id: "inst_b", room_id: "room_b" })];
    expect((await call({ action: "install_retire", room: "room_a", install_id: "inst_b", reason: "x" })).out.error).toBe("install_not_in_room");
    expect((await call({ action: "install_retire", room: "room_a", install_id: "inst_zz", reason: "x" })).out.error).toBe("no_install");
    expect((await call({ action: "unbind", room: "room_a", reason: "x" })).out.error).toBe("no_install");
    expect(db.installs[0]!.retired_at).toBeNull();
  });

  it("install_retire without install_id is bad_args", async () => {
    expect((await call({ action: "install_retire", room: "room_a", reason: "x" })).out.error).toBe("bad_args");
  });
});

describe("bind", () => {
  const retired = (o: Row = {}) => inst({ install_id: "inst_old", retired_at: ago(1000), last_seen_at: ago(86_400_000), ...o });

  it("restores a retired, enrolled install of the same room when no other is live, tells the caller to restart the recorder, and is audited", async () => {
    db.installs = [retired()];
    const a = await call({ action: "bind", room: "room_a", install_id: "inst_old", reason: "undo mistaken retire" });
    expect(a.out).toMatchObject({ ok: true, changed: true, after: { retired_at: null } });
    expect(String(a.out.note)).toMatch(/restart the recorder/);
    expect(db.installs[0]!.retired_at).toBeNull();
    expect(adminAudits()[0]).toMatchObject({ action: "admin.bind", target_id: "inst_old" });
    expect(adminAudits()[0]!.meta).toMatchObject({ reason: "undo mistaken retire", room_id: "room_a" });
    const b = await call({ action: "bind", room: "room_a", install_id: "inst_old", reason: "again" });
    expect(b.out).toMatchObject({ ok: true, changed: false });
    expect(adminAudits()).toHaveLength(2);
  });

  it("refuses live_install_exists, an install of another room, and a never-enrolled install", async () => {
    db.installs = [inst({}), retired(), retired({ install_id: "inst_b", room_id: "room_b" }), retired({ install_id: "inst_new", enrolled_at: null })];
    expect((await call({ action: "bind", room: "room_a", install_id: "inst_old", reason: "x" })).out.error).toBe("live_install_exists");
    expect((await call({ action: "bind", room: "room_a", install_id: "inst_b", reason: "x" })).out.error).toBe("install_not_in_room");
    expect((await call({ action: "bind", room: "room_a", install_id: "inst_new", reason: "x" })).out.error).toBe("never_enrolled");
    expect((await call({ action: "bind", room: "room_a", install_id: "inst_zz", reason: "x" })).out.error).toBe("no_install");
    expect(db.installs[1]!.retired_at).toBeTruthy();
    expect(db.writes).toEqual([]);
    expect(resultAudits().every((a) => a.meta.changed === false)).toBe(true);
  });
});

describe("install_mint: the command is shown once and appears nowhere else", () => {
  it("returns the command and install id, audits install id and expiry only, and no audit insert or console line carries the token or the command", async () => {
    const { out } = await call({ action: "install_mint", room: "room_a", reason: "replace dead Mac" });
    expect(out).toMatchObject({ ok: true, install_id: "inst_new", command: SECRET_COMMAND, expires_at: "2026-10-13T10:00:00.000Z", release: { version: "0.1.99" }, reason: "replace dead Mac", before: null });
    expect(db.mintLog).toEqual([{ roomId: "room_a", createdBy: "mcp:fable" }]);
    // pre-row first (before minting: no install id yet), then the result row with install id, expiry and release only
    expect(allAdminAudits().map((a) => a.action)).toEqual(["admin.install_mint", "admin.install_mint.result"]);
    expect(adminAudits()[0]!.meta).toMatchObject({ reason: "replace dead Mac", before: null, room_id: "room_a" });
    expect(resultAudits()[0]).toMatchObject({ target_id: "inst_new" });
    expect(resultAudits()[0]!.meta).toMatchObject({ changed: true, after: { install_id: "inst_new", expires_at: "2026-10-13T10:00:00.000Z" }, room_id: "room_a", release_version: "0.1.99" });
    const everything = JSON.stringify(db.audits) + logs.join("\n");
    expect(everything).not.toContain(SECRET_TOKEN);
    expect(everything).not.toContain("bootstrap/");
    expect(everything).not.toContain("curl");
    // the door's own audit row (mcp.tools/call) was written too and is part of `everything` above
    expect(db.audits.some((a) => /mcp\.tools\/call/.test(a.q))).toBe(true);
  });

  it("a mint that fails (no release) is an error code, no token, and leaves a pre-row and a changed:false result row", async () => {
    db.noRelease = true;
    const { out } = await call({ action: "install_mint", room: "room_a", reason: "x" });
    expect(out).toMatchObject({ ok: false, error: "no_release" });
    expect(JSON.stringify(out)).not.toContain(SECRET_TOKEN);
    expect(allAdminAudits().map((a) => a.action)).toEqual(["admin.install_mint", "admin.install_mint.result"]);
    expect(resultAudits()[0]!.meta).toMatchObject({ changed: false, error: "NO_RELEASE" });
  });
});

describe("install_list and state", () => {
  it("install_list returns at most 10 installs newest first with no token field", async () => {
    db.installs = Array.from({ length: 14 }, (_, n) => inst({ install_id: `inst_${n}`, created_at: ago(n * 1000) }));
    const { out } = await call({ action: "install_list", room: "room_a" }, ["read"]);
    const list = out.installs as Row[];
    expect(list).toHaveLength(10);
    expect(Object.keys(list[0]!).sort()).toEqual(["app_version", "created_at", "enrolled_at", "hostname", "install_id", "last_seen_at", "retired_at", "update_channel"]);
    expect(JSON.stringify(out)).not.toMatch(/token/i);
  });

  it("state: room, bound install, recording_now, retired installs and the last admin audit rows in one call", async () => {
    db.installs = [inst({}), inst({ install_id: "inst_old", retired_at: ago(5000) })];
    db.recording = { known: true, rooms: [{ room_id: "room_a" }] };
    await call({ action: "install_mint", room: "room_a", reason: "seed an audit row" });
    const { out } = await call({ action: "state", room: "room_a" }, ["read"]);
    expect(out.room).toMatchObject({ id: "room_a", slug: "opd-4-abcd", name: "OPD 4", enabled: true, disabled_at: null });
    expect(out.bound_install).toMatchObject({ install_id: "inst_1", hostname: "mac-1", app_version: "0.1.50", mic_state: "authorized", update_channel: "stable", session_open: false });
    expect(out.recording_now).toBe(true);
    expect((out.retired_installs as Row[])[0]).toMatchObject({ install_id: "inst_old" });
    expect((out.admin_audit as Row[]).find((x) => x.action === "admin.install_mint")).toMatchObject({ actor: "mcp:fable", reason: "seed an audit row" });
  });
});

describe("the existing routes now audit", () => {
  const patch = (body: Row) => benchPatch(new NextRequest("https://x/api/bench/rooms", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("Bench PATCH disable and enable write admin.room_disable / admin.room_enable with the admin session as actor", async () => {
    expect((await patch({ room_id: "room_a", action: "disable" })).status).toBe(200);
    expect(db.rooms[0]!.disabled_at).toBeTruthy();
    expect((await patch({ room_id: "room_a", action: "enable", reason: "reopen" })).status).toBe(200);
    expect(db.rooms[0]!.disabled_at).toBeNull();
    const rows = adminAudits();
    expect(rows.map((r) => [r.action, r.actor_type, r.actor_id])).toEqual([["admin.room_disable", "admin", "adm_1"], ["admin.room_enable", "admin", "adm_1"]]);
    expect(rows[0]!.meta.reason).toBe("bench admin page");
    expect(rows[1]!.meta.reason).toBe("reopen");
  });

  it("Bench PATCH on an unknown room is VALIDATION_FAILED unknown_room and audits nothing", async () => {
    const res = await patch({ room_id: "room_zzz", action: "disable" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(adminAudits()).toEqual([]);
  });

  it("the /admin retire route audits admin.install_retire with the guard's admin id, and a second call (already retired) is a 404 with no new row", async () => {
    process.env.MIGRATION_SECRET = "mig-secret-test";
    const req = () => new NextRequest("https://x/api/admin/installs/inst_1/retire", { method: "POST", headers: { authorization: "Bearer mig-secret-test", "content-type": "application/json" }, body: JSON.stringify({ reason: "decommission" }) });
    const ctx = { params: Promise.resolve({ installId: "inst_1" }) };
    const res = await retireRoute(req(), ctx);
    expect(res.status).toBe(200);
    const rows = adminAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "admin", actor_id: "migration_secret", action: "admin.install_retire", target_id: "inst_1" });
    expect(rows[0]!.meta).toMatchObject({ reason: "decommission", room_id: "room_a" });
    expect(JSON.stringify(rows)).not.toContain("mig-secret-test");
    expect((await retireRoute(req(), ctx)).status).toBe(404);
    expect(adminAudits()).toHaveLength(1);
    delete process.env.MIGRATION_SECRET;
  });
});

describe("ADMIN-1b A1: audit first, fail closed", () => {
  it("with the audit insert down, every write is audit_unavailable and nothing is updated, minted or retired", async () => {
    db.installs = [inst({ last_seen_at: ago(86_400_000) }), inst({ install_id: "inst_old", retired_at: ago(1000), last_seen_at: ago(86_400_000) })];
    db.installs[0]!.install_id = "inst_1";
    db.auditDown = true;
    for (const action of ["room_enable", "room_disable", "install_mint", "install_retire", "unbind"]) {
      const { out } = await call(writeArgs(action));
      expect(out, action).toMatchObject({ ok: false, error: "audit_unavailable" });
    }
    db.installs = [inst({ install_id: "inst_old", retired_at: ago(1000), last_seen_at: ago(86_400_000) })];
    expect((await call({ action: "bind", room: "room_a", install_id: "inst_old", reason: "x" })).out.error).toBe("audit_unavailable");
    expect(db.writes).toEqual([]);
    expect(db.mintLog).toEqual([]);
    expect(db.rooms[0]!.disabled_at).toBeNull();
    expect(db.installs[0]!.retired_at).toBeTruthy();
  });

  it("normal path: the pre-row is written before the write, the .result row after; every success path says audited:true (retire included)", async () => {
    const d = await call({ action: "room_disable", room: "room_a", reason: "r" });
    expect(d.out).toMatchObject({ ok: true, audited: true });
    const rt = await call({ action: "install_retire", room: "room_a", install_id: "inst_1", reason: "r", confirm_live: true });
    expect(rt.out).toMatchObject({ ok: true, changed: true, audited: true });
    expect(allAdminAudits().map((a) => a.action)).toEqual(["admin.room_disable", "admin.room_disable.result", "admin.install_retire", "admin.install_retire.result"]);
    // retireInstall wrote no duplicate pre-row
    expect(allAdminAudits().filter((a) => a.action === "admin.install_retire")).toHaveLength(1);
    const bd = await call({ action: "bind", room: "room_a", install_id: "inst_1", reason: "undo" });
    expect(bd.out).toMatchObject({ ok: true, changed: true, audited: true });
  });

  it("a failed result-row insert does not fail the write", async () => {
    // pre-row lands, then the audit goes down: not testable per row with this fake, so assert the strict/best-effort split directly
    const { writeAdminAudit } = await import("@/lib/admin-audit");
    db.auditDown = true;
    await expect(writeAdminAudit({ actor: { type: "system", id: "x" }, action: "a", targetType: "room", targetId: "r", meta: {} })).resolves.toBe(false);
    await expect(writeAdminAudit({ actor: { type: "system", id: "x" }, action: "a", targetType: "room", targetId: "r", meta: {}, strict: true })).rejects.toThrow();
  });
});

describe("ADMIN-1b A2 / A3 / A4", () => {
  it("A2: 'kiosk dev gone stale' does not satisfy V GO; a word-bounded 'v go' does", async () => {
    db.recording = { known: true, rooms: [{ room_id: "room_a" }] };
    expect((await call({ action: "room_disable", room: "room_a", reason: "kiosk dev gone stale", override_patient_gate: true })).out.error).toBe("patient_gate");
    expect((await call({ action: "room_disable", room: "room_a", reason: "ok (v go)", override_patient_gate: true })).out.ok).toBe(true);
  });

  it("A3: the state audit read is limited to 30 days", () => {
    const src = readFileSync("lib/mcp/tools/admin.ts", "utf8");
    expect(src).toContain("AND created_at > now() - interval '30 days'");
  });

  it("A4: the PIN-lockout disable writes room.pin_lockout_disable (system actor, room target, room_id + failed_attempts)", async () => {
    const { roomRecordFailedAttempt } = await import("@/lib/room-auth");
    const out = await roomRecordFailedAttempt({ id: "room_a", failed_attempts: 29, locked_until: null, disabled_at: null } as never);
    expect(out.kind).toBe("disabled");
    const row = allAdminAudits().find((a) => a.action === "room.pin_lockout_disable")!;
    expect(row).toMatchObject({ actor_type: "system", target_type: "room", target_id: "room_a" });
    expect(row.meta).toEqual({ room_id: "room_a", failed_attempts: 30 });
  });
});
