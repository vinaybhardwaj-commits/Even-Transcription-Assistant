/**
 * R4-S — the fifth command kind, `set_audio_input` (Install and Fleet PRD, Release R4 addendum,
 * R4-D1 and R4-D7), on the bus, in migration 0080, and in the browser kiosk. Mocked `sql`; no live DB.
 *
 * ─── THE PROPERTIES ────────────────────────────────────────────────────────────────────────────
 *   · the kind goes through the same insert → poll → ack lifecycle as the four before it
 *   · bad args never reach the table: `insertCommand` throws BAD_ARGS before any SQL runs
 *   · the four existing kinds are validated exactly as before, which is to say not at all
 *   · 0080 swaps the CHECK inside one statement and looks the old name up rather than guessing it
 *   · the browser kiosk ignores the kind without acking it, and still runs the four it knows
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };

const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] | Promise<Row[]> = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  };
  return { sql };
});

const B = await import("@/lib/bench-commands");

const NOW = new Date("2026-09-11T15:00:00.000Z");
const findCall = (re: RegExp) => calls.find((c) => re.test(c.text));

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe("R4-D1 — COMMAND_KINDS", () => {
  it("is the four existing kinds plus set_audio_input, in that order — then Tier 1's three verbs", () => {
    expect([...B.COMMAND_KINDS]).toEqual([
      "start_day", "pause_day", "resume_day", "end_day", "set_audio_input",
      "check_update_now", "report_diag", "restart_engine",
    ]);
  });
});

describe("R4-D1 — set_audio_input through the bus lifecycle", () => {
  it("inserts → is delivered by the room's poll → is failed by the app with a named reason", async () => {
    const id = await B.insertCommand({ roomId: "room_1", kind: "set_audio_input", args: { device_uid: "c270-1" }, source: "admin" });
    expect(id).toMatch(/^cmd_[a-z2-9]{8}$/);
    const ins = findCall(/INSERT INTO bench_command/)!;
    expect(ins.values).toEqual([id, "room_1", "set_audio_input", JSON.stringify({ device_uid: "c270-1" }), "admin"]);

    // The room's next poll hands it over exactly like any other pending command.
    calls.length = 0;
    responder = (text) =>
      /SELECT id, kind, args, created_at FROM bench_command/.test(text)
        ? [{ id, kind: "set_audio_input", args: { device_uid: "c270-1" }, created_at: NOW.toISOString() }]
        : [];
    const polled = await B.pollCommands({ roomId: "room_1", tabId: "app_install_1", prevPollAt: null, recordingSessionId: null, paused: false });
    expect(polled).toMatchObject({ superseded: false });
    if (!("commands" in polled)) throw new Error("expected commands");
    expect(polled.commands).toEqual([{ id, kind: "set_audio_input", args: { device_uid: "c270-1" }, created_at: NOW.toISOString() }]);

    // The app fails it with R4-D3's reason; ackCommand stores it as it stores any other.
    calls.length = 0;
    responder = (text) => (/UPDATE bench_command SET status = \?/.test(text) ? [{ id }] : []);
    expect(await B.ackCommand({ roomId: "room_1", commandId: id, ok: false, error: "device_not_present" })).toBe("failed");
    const upd = findCall(/UPDATE bench_command SET status = \?/)!;
    expect(upd.values[0]).toBe("failed");
    expect(upd.values[2]).toBe("device_not_present");

    // …and waitForAck hands the failed row back to the caller that is waiting on it.
    responder = () => [{ id, room_id: "room_1", kind: "set_audio_input", args: { device_uid: "c270-1" }, status: "failed", source: "admin", result: { ok: false, error: "device_not_present" }, error: "device_not_present", created_at: NOW.toISOString(), acked_at: NOW.toISOString() }];
    const row = await B.waitForAck(id, { timeoutMs: 0, intervalMs: 1, sleep: async () => undefined });
    expect(row).toMatchObject({ status: "failed", error: "device_not_present" });
  });

  it("stores a volume-only and a both-fields command, uid trimmed", async () => {
    await B.insertCommand({ roomId: "room_1", kind: "set_audio_input", args: { input_volume: 0.5 } });
    await B.insertCommand({ roomId: "room_1", kind: "set_audio_input", args: { device_uid: "  c270-1 ", input_volume: 0 } });
    const inserts = calls.filter((c) => /INSERT INTO bench_command/.test(c.text));
    expect(inserts.map((c) => c.values[3])).toEqual([
      JSON.stringify({ input_volume: 0.5 }),
      JSON.stringify({ device_uid: "c270-1", input_volume: 0 }),
    ]);
  });
});

describe("R4-S item 2 — BAD_ARGS, thrown before any SQL", () => {
  const rejects = async (args: unknown) => {
    calls.length = 0;
    await expect(B.insertCommand({ roomId: "room_1", kind: "set_audio_input", args })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(calls).toHaveLength(0);
  };

  it("refuses a command that names neither field", async () => {
    for (const args of [undefined, null, {}, { device_uid: undefined }]) await rejects(args);
  });

  it("refuses a volume outside 0..1 or not a number", async () => {
    for (const v of [1.0001, -0.1, 2, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, true]) await rejects({ input_volume: v });
  });

  it("refuses a device id that is empty, too long, or not a string", async () => {
    for (const u of ["", "   ", "u".repeat(257), 7, null, ["c270-1"]]) await rejects({ device_uid: u });
  });

  it("refuses anything else: an unknown key, an array, a string", async () => {
    for (const args of [{ device_uid: "c270-1", gain: 1 }, [{ device_uid: "c270-1" }], "c270-1", 0.5]) await rejects(args);
  });

  it("the throw is a CommandArgsError with a reason, and the validator is the one insertCommand uses", () => {
    expect(() => B.parseSetAudioInputArgs({ input_volume: 3 })).toThrow(B.CommandArgsError);
    try {
      B.parseSetAudioInputArgs({});
    } catch (e) {
      expect((e as InstanceType<typeof B.CommandArgsError>).code).toBe("BAD_ARGS");
      expect((e as InstanceType<typeof B.CommandArgsError>).reason).toMatch(/device_uid or input_volume/);
    }
    // 256 is the fleet's own bound on a CoreAudio uid (B2 ruling 4), and it is admitted.
    expect(B.parseSetAudioInputArgs({ device_uid: "u".repeat(256) })).toEqual({ device_uid: "u".repeat(256) });
    expect(B.parseSetAudioInputArgs({ input_volume: 1 })).toEqual({ input_volume: 1 });
  });

  it("leaves the four existing kinds exactly as they were — no validation added to them", async () => {
    await B.insertCommand({ roomId: "room_1", kind: "start_day", args: { override_pause: true } });
    await B.insertCommand({ roomId: "room_1", kind: "end_day", source: "admin" });
    const inserts = calls.filter((c) => /INSERT INTO bench_command/.test(c.text));
    expect(inserts.map((c) => [c.values[2], c.values[3], c.values[4]])).toEqual([
      ["start_day", JSON.stringify({ override_pause: true }), "mcp"],
      ["end_day", null, "admin"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// R4-D11 — the version floor
// ---------------------------------------------------------------------------

describe("R4-D11 — appVersionAtLeast / audioInputRefusal", () => {
  it("compares dotted versions numerically, not as strings", () => {
    expect(B.SET_AUDIO_INPUT_MIN_APP_VERSION).toBe("0.1.21");
    const at = (v: string) => B.appVersionAtLeast(v, "0.1.21");
    for (const ok of ["0.1.21", "0.1.22", "0.1.100", "0.2", "0.2.0", "1.0.0", " 0.1.21 "]) expect(at(ok), ok).toBe(true);
    // "0.1.3" > "0.1.21" and "0.1.100" < "0.1.21" as STRINGS — both wrong, both caught here.
    for (const no of ["0.1.20", "0.1.3", "0.1", "0.0.99", "0.1.8"]) expect(at(no), no).toBe(false);
  });

  it("treats a missing or unparseable version as too old — refuse, never guess", () => {
    for (const bad of [null, undefined, "", "  ", "v0.1.21", "0.1.21-rc1", "0.1.x", "latest", "0..21"]) {
      expect(B.appVersionAtLeast(bad, "0.1.21"), String(bad)).toBe(false);
    }
  });

  it("the refusal carries the code, a message naming the floor, and the version as reported", () => {
    expect(B.audioInputRefusal("0.1.21")).toBeNull();
    expect(B.audioInputRefusal("0.1.20")).toEqual({ code: "APP_TOO_OLD", message: expect.stringContaining("0.1.21"), app_version: "0.1.20" });
    expect(B.audioInputRefusal("  ")).toMatchObject({ code: "APP_TOO_OLD", app_version: null });
    expect(B.audioInputRefusal(null)).toMatchObject({ code: "APP_TOO_OLD", app_version: null });
  });
});

// ---------------------------------------------------------------------------
// R4-D12 — cleanAckApplied
// ---------------------------------------------------------------------------

describe("R4-D12 — cleanAckApplied", () => {
  it("keeps the three fields when each is well formed", () => {
    expect(B.cleanAckApplied({ ok: true, applied_device_uid: " c270-1 ", applied_input_volume: 0.5, input_volume_settable: true })).toEqual({
      applied_device_uid: "c270-1", applied_input_volume: 0.5, input_volume_settable: true,
    });
    expect(B.cleanAckApplied({ input_volume_settable: false })).toEqual({ input_volume_settable: false });
  });

  it("drops each malformed field on its own, and every unknown key", () => {
    expect(B.cleanAckApplied({ applied_device_uid: "u".repeat(257), applied_input_volume: 1.5, input_volume_settable: "true", gain: 3 })).toEqual({});
    expect(B.cleanAckApplied({ applied_device_uid: "", applied_input_volume: "0.5", input_volume_settable: 1 })).toEqual({});
    expect(B.cleanAckApplied({ applied_device_uid: "u".repeat(256), applied_input_volume: -0.1 })).toEqual({ applied_device_uid: "u".repeat(256) });
    for (const none of [null, undefined, "x", [1], {}]) expect(B.cleanAckApplied(none)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Migration 0080
// ---------------------------------------------------------------------------

describe("migration 0080", () => {
  const sqlText = readFileSync("db/migrations/0080_bench_command_set_audio_input.sql", "utf8");
  const ddl = sqlText.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

  it("records itself as version 80", () => {
    expect(sqlText).toMatch(/VALUES \(80, '0080_bench_command_set_audio_input'\)/);
  });

  it("looks the old CHECK's name up in pg_constraint by its column, and never types it", () => {
    expect(ddl).toMatch(/FROM pg_constraint/);
    expect(ddl).toMatch(/conrelid = 'bench_command'::regclass/);
    expect(ddl).toMatch(/contype = 'c'/);
    expect(ddl).toMatch(/attname = 'kind'/);
    expect(ddl).toMatch(/EXECUTE format\('ALTER TABLE bench_command DROP CONSTRAINT %I'/);
    // No literal DROP CONSTRAINT <name> anywhere: the name comes from the catalogue.
    expect(ddl).not.toMatch(/DROP CONSTRAINT\s+(?!%I)\w/);
  });

  it("refuses to guess when the catalogue shows more than one CHECK on kind", () => {
    expect(ddl).toMatch(/RAISE EXCEPTION/);
  });

  it("drops and re-adds inside ONE DO block, so the table is never without the CHECK", () => {
    const blocks = ddl.match(/DO \$\$[\s\S]*?\$\$;/g) ?? [];
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    const drop = block.indexOf("DROP CONSTRAINT");
    const add = block.indexOf("ADD CONSTRAINT bench_command_kind_check");
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    expect(block).toContain("CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input'))");
  });

  it("adds the two poll columns, nullable, idempotent, no DEFAULT, and comments them", () => {
    expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS input_volume\s+real NULL/);
    expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS input_volume_settable\s+boolean NULL/);
    const alter = /ALTER TABLE room_install[\s\S]*?;/.exec(ddl)![0];
    expect(alter).not.toMatch(/\bDEFAULT\b|\bDROP\b|ALTER COLUMN/i);
    for (const c of ["input_volume", "input_volume_settable"]) expect(sqlText).toContain(`COMMENT ON COLUMN room_install.${c}`);
  });

  it("rewrites no rows", () => {
    expect(ddl).not.toMatch(/^\s*(UPDATE|DELETE|TRUNCATE)\b/im);
  });
});

// ---------------------------------------------------------------------------
// R4-D7 — the browser kiosk
// ---------------------------------------------------------------------------

describe("R4-D7 — the browser kiosk ignores set_audio_input without acking it", () => {
  const src = readFileSync("lib/use-command-poll.ts", "utf8");

  it("knows the kind in its union", () => {
    expect(src).toMatch(/export type CommandKind = [^;]*"set_audio_input"/);
  });

  it("still runs the four kinds it owns, each by an explicit case", () => {
    for (const k of ["start_day", "pause_day", "resume_day", "end_day"]) expect(src).toContain(`case "${k}": {`);
    expect(src).not.toContain('case "set_audio_input"');
  });

  it("its default returns before the ack — no result, no ack, no refusal label", () => {
    const d = /default:\s*\{?([\s\S]*?)\n\s*\}\s*\n\s*\} catch/.exec(src);
    expect(d).not.toBeNull();
    const body = d![1]!;
    expect(body).toMatch(/return;/);
    expect(body).not.toMatch(/result\s*=/);
    expect(body).not.toMatch(/ack\(/);
  });
});
