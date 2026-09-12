/**
 * Tier 1 §3 — the three verbs on the server: the zod args schemas, the 0.1.22 floor, the ack result
 * shapes (and the secret check on report_diag's payload), the admin route, the 0.1.22 heartbeat on
 * the poll wire and in the install write, and the per-kind ack wait. Mocked `sql`; no live database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const calls: Array<{ text: string; values: unknown[] }> = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    try {
      return Promise.resolve(responder(text, values));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/bench", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, benchAdminGuard: async () => ({ ok: true, claims: { admin_id: "adm_1" } }) };
});
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));

const B = await import("@/lib/bench-commands");
const RI = await import("@/lib/room-install");
const adminCommand = await import("@/app/api/admin/bench/command/route");
const pollRoute = await import("@/app/api/bench/commands/route");

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

const inserts = () => calls.filter((c) => /INSERT INTO bench_command/.test(c.text));

// ---------------------------------------------------------------------------
// Args schemas
// ---------------------------------------------------------------------------

describe("the three verbs' args (zod, strict)", () => {
  it("check_update_now takes nothing: absent and null are accepted, anything else is refused", () => {
    expect(B.parseVerbArgs("check_update_now", undefined)).toBeNull();
    expect(B.parseVerbArgs("check_update_now", null)).toBeNull();
    for (const bad of [{}, { force: true }, "now", 1]) {
      expect(() => B.parseVerbArgs("check_update_now", bad)).toThrow(B.CommandArgsError);
    }
  });

  it("report_diag takes {log_lines?: integer 0..500}", () => {
    expect(B.parseVerbArgs("report_diag", undefined)).toBeNull();
    expect(B.parseVerbArgs("report_diag", {})).toBeNull();
    expect(B.parseVerbArgs("report_diag", { log_lines: 0 })).toEqual({ log_lines: 0 });
    expect(B.parseVerbArgs("report_diag", { log_lines: 500 })).toEqual({ log_lines: 500 });
    for (const bad of [{ log_lines: 501 }, { log_lines: -1 }, { log_lines: 2.5 }, { log_lines: "100" }, { lines: 100 }, []]) {
      expect(() => B.parseVerbArgs("report_diag", bad), JSON.stringify(bad)).toThrow(B.CommandArgsError);
    }
  });

  it("restart_engine takes {force?: boolean}", () => {
    expect(B.parseVerbArgs("restart_engine", null)).toBeNull();
    expect(B.parseVerbArgs("restart_engine", { force: true })).toEqual({ force: true });
    expect(B.parseVerbArgs("restart_engine", { force: false })).toEqual({ force: false });
    for (const bad of [{ force: "true" }, { force: 1 }, { hard: true }]) {
      expect(() => B.parseVerbArgs("restart_engine", bad)).toThrow(B.CommandArgsError);
    }
  });

  it("insertCommand validates them too, and a bad one writes nothing", async () => {
    await expect(B.insertCommand({ roomId: "room_1", kind: "report_diag", args: { log_lines: 9999 } })).rejects.toBeInstanceOf(B.CommandArgsError);
    expect(calls).toHaveLength(0);
    await B.insertCommand({ roomId: "room_1", kind: "report_diag", args: { log_lines: 100 }, source: "admin" });
    expect(JSON.parse(String(inserts()[0]!.values[3]))).toEqual({ log_lines: 100 });
  });
});

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

describe("the 0.1.22 floor (D11's rule for the verbs)", () => {
  it("0.1.22 and later pass; 0.1.21, 0.1.9, null and garbage are APP_TOO_OLD naming the kind", () => {
    expect(B.VERBS_MIN_APP_VERSION).toBe("0.1.22");
    for (const ok of ["0.1.22", "0.1.100", "0.2.0", "1.0"]) expect(B.verbRefusal("report_diag", ok)).toBeNull();
    for (const old of ["0.1.21", "0.1.9", null, "", "v0.1.22", "0.1.22-rc1"]) {
      const r = B.verbRefusal("restart_engine", old);
      expect(r?.code, String(old)).toBe("APP_TOO_OLD");
      expect(r?.message).toContain("restart_engine needs 0.1.22");
    }
  });
});

// ---------------------------------------------------------------------------
// Ack shapes
// ---------------------------------------------------------------------------

describe("the verbs' ack results reach bench_command.result", () => {
  it("check_update_now: checked_at, offered_version, deferred, held — each kept only when well-formed", () => {
    expect(
      B.cleanAckApplied({ ok: true, checked_at: "2026-09-11T16:00:00Z", offered_version: "0.1.23", deferred: false, held: false }),
    ).toEqual({ checked_at: "2026-09-11T16:00:00.000Z", offered_version: "0.1.23", deferred: false, held: false });
    expect(B.cleanAckApplied({ checked_at: "yesterday", offered_version: "<b>0.1.23</b>", deferred: "no" })).toEqual({});
  });

  it("restart_engine: restarting", () => {
    expect(B.cleanAckApplied({ ok: true, restarting: true })).toEqual({ restarting: true });
  });

  it("report_diag: the payload is kept whole under the size bound", () => {
    const diag = { app_version: "0.1.22", log_lines: ["a", "b"], input_devices: [{ name: "C270 HD WEBCAM" }] };
    expect(B.cleanAckApplied({ ok: true, diag })).toEqual({ diag });
    const huge = { log_lines: ["x".repeat(B.DIAG_MAX_CHARS)] };
    expect(B.cleanAckApplied({ ok: true, diag: huge })).toEqual({});
  });

  it("report_diag: a payload naming ANY word on the forbidden list is withheld, not stored", () => {
    // Driven off DIAG_FORBIDDEN itself, so a word added to the list is guarded by this test the
    // moment it is added, and a word removed from it fails here rather than silently.
    expect(B.DIAG_FORBIDDEN.length).toBeGreaterThan(0);
    for (const w of B.DIAG_FORBIDDEN) {
      const out = B.cleanAckApplied({ ok: true, diag: { log_lines: [`line with ${w}=abc`] } });
      expect(JSON.stringify(out), w).not.toContain(w);
      expect(out.diag, w).toEqual({ diag_withheld: "the payload named a secret and was not stored" });
    }
  });

  it("the forbidden list names MIGRATION_SECRET (12 Sep ruling on the Refuter's naming gap)", () => {
    // Nothing in apps/room-recorder reads it today — it is a server-only env var — so this guards
    // nothing yet. The list is the name of every secret that must not come back from a Mac, and the
    // day a diagnostic starts quoting the server's environment must not depend on someone adding it.
    expect(B.DIAG_FORBIDDEN).toContain("MIGRATION_SECRET");
    // The kickoff's original four are all still there.
    for (const w of ["eta_room_session", "etaRoomSession", "commandVerifyKey", "SCRIBE_MCP_TOKEN"]) {
      expect(B.DIAG_FORBIDDEN, w).toContain(w);
    }
  });

  it("ackCommand writes them into result beside ok", async () => {
    responder = (t) => (/UPDATE bench_command/.test(t) ? [{ id: "cmd_a", kind: "check_update_now" }] : []);
    await B.ackCommand({ roomId: "room_1", commandId: "cmd_a", ok: true, applied: B.cleanAckApplied({ checked_at: "2026-09-11T16:00:00Z", deferred: true, offered_version: "0.1.23" }) });
    expect(JSON.parse(String(calls[0]!.values[1]))).toEqual({ ok: true, checked_at: "2026-09-11T16:00:00.000Z", offered_version: "0.1.23", deferred: true });
  });
});

// ---------------------------------------------------------------------------
// The admin route
// ---------------------------------------------------------------------------

describe("POST /api/admin/bench/command accepts the three verbs", () => {
  const post = async (body: unknown) => {
    const res = await adminCommand.POST(new Request("https://x/api/admin/bench/command", { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, json: (await res.json()) as Row };
  };
  const boundAt = (v: string | null) => (t: string) =>
    /FROM room_install WHERE room_id = \?/.test(t) ? (v === null ? [] : [{ install_id: "install_1", app_version: v }]) : [];

  it("queues a valid verb for a 0.1.22 Mac, audited, and says how long an ack takes", async () => {
    responder = boundAt("0.1.22");
    const { status, json } = await post({ room_id: "room_1", kind: "report_diag", args: { log_lines: 100 } });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, kind: "report_diag", room_id: "room_1", queued: true, ack_wait_ms: 20_000 });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.values.slice(1, 5)).toEqual(["room_1", "report_diag", JSON.stringify({ log_lines: 100 }), "admin"]);
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c.text))!;
    expect(JSON.parse(String(audit.values.at(-1)))).toMatchObject({ kind: "report_diag", queued: true, args: { log_lines: 100 } });
  });

  it("400 bad_args before anything is read or written", async () => {
    responder = boundAt("0.1.22");
    const { status, json } = await post({ room_id: "room_1", kind: "restart_engine", args: { force: "yes" } });
    expect(status).toBe(400);
    expect(json.error).toBe("bad_args");
    expect(calls).toHaveLength(0);
  });

  it("409 APP_TOO_OLD for a 0.1.21 Mac or a room with no bound Mac, nothing inserted", async () => {
    for (const v of ["0.1.21", null]) {
      calls.length = 0;
      responder = boundAt(v);
      const { status, json } = await post({ room_id: "room_1", kind: "check_update_now" });
      expect(status).toBe(409);
      expect(json.error).toBe("APP_TOO_OLD");
      expect(inserts()).toHaveLength(0);
    }
  });

  it("an unknown kind is still 400, and lists the eight", async () => {
    const { status, json } = await post({ room_id: "room_1", kind: "reboot" });
    expect(status).toBe(400);
    expect(json.allowed).toEqual([...B.COMMAND_KINDS, "close_orphan"]);
  });
});

// ---------------------------------------------------------------------------
// The 0.1.22 heartbeat: wire → clean → write → rules
// ---------------------------------------------------------------------------

describe("the heartbeat: clip_count, silence_ms, channel_locked", () => {
  it("the poll route carries all three into the install write", async () => {
    responder = (t) => (/^UPDATE room_install SET last_seen_at/.test(t) ? [{ install_id: "install_1", assigned_channel: null }] : []);
    const url = new URL("https://www.evenscribe.app/api/bench/commands");
    for (const [k, v] of Object.entries({ tab_id: "app_install_1", install_id: "install_1", clip_count: "12", silence_ms: "4500", channel_locked: "true" })) {
      url.searchParams.set(k, v);
    }
    const res = await pollRoute.GET({ nextUrl: url } as never);
    expect(res.status).toBe(200);
    const up = calls.find((c) => /^UPDATE room_install SET last_seen_at/.test(c.text))!;
    expect(up.text).toMatch(/clip_count = COALESCE\(\?::integer, clip_count\)/);
    expect(up.text).toMatch(/silence_ms = COALESCE\(\?::bigint, silence_ms\)/);
    expect(up.text).toMatch(/channel_locked = COALESCE\(\?::boolean, channel_locked\)/);
    expect(up.values).toContain(12);
    expect(up.values).toContain(4500);
    const entry = JSON.parse(up.values.find((v) => typeof v === "string" && v.includes('"rec"')) as string);
    expect(entry).toMatchObject({ clip_count: 12, silence_ms: 4500 });
  });

  it("cleanPollFields keeps a whole number or nothing, and a boolean lock or nothing", () => {
    const f = (o: Row) => RI.cleanPollFields({ install_id: "i", ...o } as never);
    expect(f({ clip_count: "0", silence_ms: "0" })).toMatchObject({ clip_count: 0, silence_ms: 0 });
    expect(f({ clip_count: 7, silence_ms: 120000 })).toMatchObject({ clip_count: 7, silence_ms: 120000 });
    for (const bad of ["-1", "1.5", "abc", "", "1e3", String(RI.CLIP_COUNT_MAX + 1)]) {
      expect(f({ clip_count: bad }).clip_count, bad).toBeNull();
    }
    expect(f({ channel_locked: true }).channel_locked).toBe(true);
    expect(f({ channel_locked: "true" }).channel_locked).toBeNull();
    // A 0.1.21 poll carries none of them, and its ring entry has neither key.
    expect(f({})).toMatchObject({ clip_count: null, silence_ms: null, channel_locked: null });
  });

  it("an entry from a 0.1.21 poll carries no heartbeat keys, so the rules fall back for it", async () => {
    responder = () => [{ install_id: "install_1", assigned_channel: null }];
    await RI.applyInstallPoll({ install_id: "install_1", zero_ratio: "1", tape_advancing: true }, { recording: true });
    const entry = JSON.parse(calls[0]!.values.find((v) => typeof v === "string" && v.includes('"rec"')) as string);
    expect("clip_count" in entry).toBe(false);
    expect("silence_ms" in entry).toBe(false);
  });

  it("this poll's silence_ms decides SILENT_WHILE_RECORDING when the app sends it", async () => {
    const returned = (silentPolls: number) => [{
      install_id: "install_1", assigned_channel: null, state_flags: { flags: [], drift_since: null },
      poll_ring: [{ at: "x", peak: 0, zero_ratio: 1, tape_advancing: true, rec: true, silent_polls: silentPolls }],
    }];
    // 0.1.22 says 2 minutes of silence though the ring count is short: flagged.
    responder = (t) => (/^UPDATE room_install SET last_seen_at/.test(t) ? returned(3) : []);
    await RI.applyInstallPoll({ install_id: "install_1", tape_advancing: true, silence_ms: "120000" }, { recording: true });
    expect(JSON.parse(String(calls[1]!.values[0])).flags).toEqual(["SILENT_WHILE_RECORDING"]);
    // 0.1.22 says sound a moment ago though the ring count is long: not flagged, nothing written.
    calls.length = 0;
    responder = (t) => (/^UPDATE room_install SET last_seen_at/.test(t) ? returned(500) : []);
    await RI.applyInstallPoll({ install_id: "install_1", tape_advancing: true, silence_ms: "200" }, { recording: true });
    expect(calls).toHaveLength(1);
  });
});
