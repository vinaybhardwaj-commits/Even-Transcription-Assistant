/**
 * Release B2, server half — the pure functions, the SQL they drive, migration 0079, and the card
 * rendered from a fixture of the fleet's shape on 11 September 2026.
 *
 * D3 one row per room · D4 the receipt's sentence · D5 assigned channel · D6 disk headroom ·
 * D7 peak and zero ratio · D10 the input-device list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const calls: Array<{ text: string; values: unknown[] }> = [];
let responses: unknown[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const M = await import("@/lib/room-install");
const V = await import("@/lib/room-install-view");
const { FleetTable } = await import("@/components/admin/BenchInstallFleet");

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

const NOW = new Date("2026-09-11T12:00:00.000Z");
const nowMs = NOW.getTime();
const TTL = 30 * 60_000;
const ago = (ms: number) => new Date(nowMs - ms).toISOString();
const DAY = 86_400_000;

let seq = 0;
const inst = (over: Partial<V.InstallView> = {}): V.InstallView => ({
  install_id: `install_${String(++seq).padStart(12, "0")}`,
  room_id: "room_1",
  created_at: ago(2 * DAY),
  enrolled_at: ago(2 * DAY),
  session_expires_at: new Date(nowMs + 300 * DAY).toISOString(),
  launched_by: "launchd",
  hostname: "MINI",
  hardware_model: "Mac mini",
  os_version: "macOS 15.7",
  input_device_name: "TONOR TM20 Audio Device",
  app_version: "0.1.19",
  build_sha: "da58a4c",
  first_seen_at: ago(2 * DAY),
  last_seen_at: ago(5_000),
  mic_state: "authorized",
  launch_agent_loaded: true,
  tape_advancing: true,
  tape_poll_streak: 4,
  tape_advancing_since: ago(60_000),
  never_sleep: true,
  retired_at: null,
  session_open: false,
  update_channel: "stable",
  last_update_result: "ok",
  last_update_version: "0.1.19",
  last_update_error: null,
  last_update_at: ago(3_600_000),
  disk_free_bytes: 180_000_000_000,
  ...over,
});
const room = (id: string, name = id) => ({ id, slug: `${id}-slug`, name, disabled_at: null });
const group = (rooms: V.FleetRoom[], installs: V.InstallView[]) =>
  V.groupFleet({ rooms, installs, nowMs, tokenTtlMs: TTL });

// ---------------------------------------------------------------------------
// D3 — grouping
// ---------------------------------------------------------------------------

describe("B2-D3 — one row per room", () => {
  it("1 bound + 3 retired installs in one room is ONE row with earlier_installs: 3", () => {
    const bound = inst();
    const retired = [1, 2, 3].map((n) =>
      inst({ created_at: ago((10 + n) * DAY), retired_at: ago((5 + n) * DAY) }),
    );
    const { rows, unassigned } = group([room("room_1")], [bound, ...retired]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.install?.install_id).toBe(bound.install_id);
    expect(rows[0]!.earlier_installs).toBe(3);
    expect(rows[0]!.earlier!.map((e) => e.install_id)).toEqual(retired.map((r) => r.install_id));
    expect(rows[0]!.earlier!.every((e) => e.retired_at)).toBe(true);
    expect(unassigned).toHaveLength(0);
    // deriveRow is unchanged by grouping: the row reads exactly as a bound, healthy row did.
    expect(V.deriveRow({ row: rows[0]!, latestRelease: null, nowMs }).state).toBe("healthy");
  });

  it("an install whose room is not on the card goes to Unassigned, once", () => {
    const orphan = inst({ room_id: "room_gone", hostname: "EHRC-CONSUL2's Mac mini (2)", retired_at: ago(DAY) });
    const { rows, unassigned } = group([room("room_1")], [inst(), orphan]);
    expect(rows).toHaveLength(1);
    expect(unassigned).toEqual([
      {
        install_id: orphan.install_id,
        room_id: "room_gone",
        hostname: "EHRC-CONSUL2's Mac mini (2)",
        created_at: orphan.created_at,
        retired_at: orphan.retired_at,
        why: "room_not_on_card",
      },
    ]);
  });

  it("a room with only retired installs is still a `retired` row — state unchanged", () => {
    const a = inst({ retired_at: ago(DAY) });
    const b = inst({ created_at: ago(9 * DAY), retired_at: ago(8 * DAY) });
    const { rows } = group([room("room_1")], [a, b]);
    expect(rows[0]!.install).toBeNull();
    expect(rows[0]!.last_retired?.install_id).toBe(a.install_id);
    expect(rows[0]!.earlier_installs).toBe(2);
    expect(V.deriveRow({ row: rows[0]!, latestRelease: null, nowMs }).state).toBe("retired");
  });

  it("an abandoned mint — every machine column null — is listed under Unassigned, not lost", () => {
    const allNull = inst({
      created_at: ago(3 * 3_600_000),
      enrolled_at: null,
      hostname: null,
      app_version: null,
      last_seen_at: null,
    });
    const { rows, unassigned } = group([room("room_1")], [inst(), allNull]);
    expect(rows[0]!.pending).toBeNull();
    expect(unassigned.map((u) => [u.install_id, u.why])).toEqual([[allNull.install_id, "never_enrolled"]]);
  });

  it("an in-TTL mint is the row's `pending`, not Unassigned — the checklist still finds it", () => {
    const mint = inst({ created_at: ago(60_000), enrolled_at: null, last_seen_at: null });
    const { rows, unassigned } = group([room("room_1")], [mint]);
    expect(rows[0]!.pending?.install_id).toBe(mint.install_id);
    expect(unassigned).toHaveLength(0);
  });

  it("NEVER hides a bound install: a second live one in the same room is shown as second_bound", () => {
    // The partial unique index forbids this. If it ever happened, the card must show both.
    const first = inst();
    const second = inst({ created_at: ago(3 * DAY) });
    const { rows, unassigned } = group([room("room_1")], [first, second]);
    expect(rows[0]!.install?.install_id).toBe(first.install_id);
    expect(unassigned.map((u) => [u.install_id, u.why])).toEqual([[second.install_id, "second_bound"]]);
  });

  it("readFleet lists nothing as Unassigned when the room read itself failed", async () => {
    responses = [new Error("rooms down"), [inst({ room_id: "room_1" })], [], []];
    const payload = await M.readFleet(NOW);
    expect(payload.degraded[0]).toMatch(/^rooms_unavailable/);
    expect(payload.unassigned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D4 — the receipt's sentence
// ---------------------------------------------------------------------------

describe("B2-D4 — receiptSentence", () => {
  it("capitalises and closes the sentence, and says nothing for nothing", () => {
    expect(V.receiptSentence("the new version did not poll within 180 s; restored 0.1.18")).toBe(
      "The new version did not poll within 180 s; restored 0.1.18.",
    );
    expect(V.receiptSentence("Already a sentence.")).toBe("Already a sentence.");
    for (const none of [null, undefined, "", "   "]) expect(V.receiptSentence(none)).toBeNull();
  });

  it("the swap_failed row names the receipt's reason, not the stock sentence", () => {
    const i = inst({
      app_version: "0.1.18",
      last_update_result: "swap_failed",
      last_update_version: "0.1.19",
      last_update_error: "the new version did not poll within 180 s; restored 0.1.18",
      last_update_at: "2026-09-11T11:33:23.000Z",
    });
    const view = V.deriveRow({
      row: { room_id: "room_1", room_slug: "r", room_name: "R", disabled: false, install: i, pending: null, last_retired: null },
      latestRelease: null,
      nowMs,
    });
    expect(view.update_note).toContain("The new version did not poll within 180 s; restored 0.1.18.");
    expect(view.update_note).not.toContain("did not verify once it was in place");
  });
});

// ---------------------------------------------------------------------------
// D6 — disk headroom
// ---------------------------------------------------------------------------

describe("B2-D6 — disk level and text", () => {
  it("is red under 5 GB, amber under 20 GB, ok above", () => {
    expect(V.diskLevel(4_999_999_999)).toBe("red");
    expect(V.diskLevel(5_000_000_000)).toBe("amber");
    expect(V.diskLevel(19_999_999_999)).toBe("amber");
    expect(V.diskLevel(20_000_000_000)).toBe("ok");
    expect(V.diskLevel(412_300_000_000)).toBe("ok");
  });

  it("is NEVER ok on a missing number — null, 0 and negative are unknown and say 'not reported'", () => {
    for (const none of [null, undefined, 0, -1, Number.NaN]) {
      expect(V.diskLevel(none)).toBe("unknown");
      expect(V.diskText(none)).toBe("disk not reported");
    }
  });

  it("writes GB with one decimal at every size", () => {
    expect(V.diskText(18_440_000_000)).toBe("18.4 GB free");
    expect(V.diskText(1_500_000_000_000)).toBe("1500.0 GB free");
    expect(V.diskText(800_000_000)).toBe("0.8 GB free");
  });

  it("deriveRow carries the level and text; a row with no Mac is unknown", () => {
    const row = (i: V.InstallView | null) => ({
      room_id: "room_1", room_slug: "r", room_name: "R", disabled: false, install: i, pending: null, last_retired: null,
    });
    expect(V.deriveRow({ row: row(inst({ disk_free_bytes: 3_000_000_000 })), latestRelease: null, nowMs }).disk_level).toBe("red");
    expect(V.deriveRow({ row: row(inst({ disk_free_bytes: null })), latestRelease: null, nowMs }).disk_level).toBe("unknown");
    expect(V.deriveRow({ row: row(null), latestRelease: null, nowMs }).disk_level).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// D5 — the card's side of the assigned channel
// ---------------------------------------------------------------------------

describe("B2-D5 — Move to stable, as deriveRow decides it", () => {
  const view = (over: Partial<V.InstallView>) =>
    V.deriveRow({
      row: { room_id: "room_1", room_slug: "r", room_name: "R", disabled: false, install: inst(over), pending: null, last_retired: null },
      latestRelease: null,
      nowMs,
    });

  it("is offered on a Mac reporting test, and only there", () => {
    expect(view({ update_channel: "test" }).can_move_to_stable).toBe(true);
    expect(view({ update_channel: "stable" }).can_move_to_stable).toBe(false);
    expect(view({ update_channel: null }).can_move_to_stable).toBe(false);
  });

  it("shows the assignment until the Mac itself reports stable, then says nothing", () => {
    const waiting = view({ update_channel: "test", assigned_channel: "stable" });
    expect(waiting.assigned_pending).toBe(true);
    expect(waiting.can_move_to_stable).toBe(false);
    const moved = view({ update_channel: "stable", assigned_channel: "stable" });
    expect(moved.assigned_pending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D7 / D10 — intake bounds and the SQL
// ---------------------------------------------------------------------------

describe("B2-D7 — unitRatio", () => {
  it("keeps 0..1, including Swift's exponent form", () => {
    for (const [raw, n] of [["0", 0], ["1", 1], ["0.4576", 0.4576], ["1e-05", 0.00001], [".5", 0.5], [0.25, 0.25]] as const) {
      expect(M.unitRatio(raw)).toBeCloseTo(n);
    }
  });

  it("drops out of range and non-numbers, never clamps", () => {
    for (const bad of ["1.0001", "-0.1", "NaN", "Infinity", "0x1", "", " ", "abc", null, undefined, 2, -1]) {
      expect(M.unitRatio(bad)).toBeNull();
    }
  });
});

describe("B2-D10 — cleanInputDevices", () => {
  const dev = (over: Record<string, unknown> = {}) => ({ name: "TONOR TM20 Audio Device", uid: "tonor-1", is_default: true, ...over });

  it("keeps a bounded list, trimmed, as JSON for the jsonb cast", () => {
    const out = M.cleanInputDevices(JSON.stringify([dev({ name: "  TONOR TM20 Audio Device " }), dev({ name: "C270", uid: "c270", is_default: false })]));
    expect(JSON.parse(out!)).toEqual([dev(), { name: "C270", uid: "c270", is_default: false }]);
  });

  it("keeps an EMPTY list — nothing plugged in is a measurement", () => {
    expect(M.cleanInputDevices("[]")).toBe("[]");
  });

  it("drops the WHOLE list on any bad entry, so a shorter list never looks complete", () => {
    const bad = [
      "not json",
      JSON.stringify({ name: "x" }),
      JSON.stringify([dev(), { name: "C270", uid: "c270" }]),
      JSON.stringify([dev({ name: "" })]),
      JSON.stringify([dev({ name: "x".repeat(129) })]),
      JSON.stringify([dev({ uid: "u".repeat(257) })]),
      JSON.stringify([dev({ is_default: "true" })]),
      JSON.stringify([dev(), dev({ uid: "second" })]), // two defaults
      JSON.stringify(Array.from({ length: 17 }, (_, n) => dev({ uid: `u${n}`, is_default: false }))),
    ];
    for (const b of bad) expect(M.cleanInputDevices(b)).toBeNull();
    expect(M.cleanInputDevices(undefined)).toBeNull();
    expect(M.cleanInputDevices(null)).toBeNull();
  });

  it("admits exactly 16 entries, 128-character names and 256-character ids (ruling 4)", () => {
    const sixteen = Array.from({ length: 16 }, (_, n) =>
      dev({ name: `n${n}`.padEnd(128, "x"), uid: `u${n}`.padEnd(256, "x"), is_default: n === 0 }),
    );
    expect(M.cleanInputDevices(JSON.stringify(sixteen))).not.toBeNull();
  });

  it("keeps the TONOR's real 81-character CoreAudio id — the one 0077 quotes", () => {
    const uid = "AppleUSBAudioEngine:FuZhou Kingwayinfo CO.,LTD:TONOR TM20 Audio Device:20200918:1";
    expect(uid).toHaveLength(81);
    const out = M.cleanInputDevices(JSON.stringify([dev({ uid }), dev({ name: "C270 HD WEBCAM", uid: "c270", is_default: false })]));
    expect(JSON.parse(out!)[0].uid).toBe(uid);
  });
});

describe("B2 — the poll's UPDATE and the fleet read", () => {
  it("COALESCEs peak, zero_ratio and input_devices, so an older app's poll cannot blank them", async () => {
    responses = [[{ install_id: "install_a" }]];
    await M.applyInstallPoll({ install_id: "install_a" });
    const up = calls[0]!.text;
    expect(up).toMatch(/peak\s*=\s*COALESCE\(\?::real, peak\)/);
    expect(up).toMatch(/zero_ratio\s*=\s*COALESCE\(\?::real, zero_ratio\)/);
    expect(up).toMatch(/input_devices\s*=\s*COALESCE\(\?::jsonb, input_devices\)/);
    // A poll may CLEAR the assignment (ruling 3) and can never SET one: the only assignment of the
    // column in this statement yields NULL or leaves it as it was. Setting stays the admin route's.
    const sets = up.match(/assigned_channel\s*=\s*[^,]*?END/g) ?? [];
    expect(sets).toEqual(["assigned_channel = CASE WHEN ?::text = 'stable' THEN NULL ELSE assigned_channel END"]);
  });

  it("the fleet read and retire both select the four 0079 columns", () => {
    const src = readFileSync("lib/room-install.ts", "utf8");
    const projections = src.match(/last_update_error, last_update_at, disk_free_bytes,\s*\n\s*assigned_channel, peak, zero_ratio, input_devices/g) ?? [];
    expect(projections).toHaveLength(2);
  });

  it("clears assigned_channel in the SAME UPDATE when the Mac reports stable (ruling 3)", async () => {
    responses = [[{ install_id: "install_a", assigned_channel: null }]];
    await M.applyInstallPoll({ install_id: "install_a", update_channel: "stable" });
    const up = calls[0]!;
    expect(up.text).toMatch(
      /assigned_channel = CASE WHEN \?::text = 'stable' THEN NULL ELSE assigned_channel END/,
    );
    expect(up.text).toMatch(/RETURNING install_id, assigned_channel$/);
    expect(calls).toHaveLength(1); // one statement: no separate read of the assignment (ruling 5)
  });

  it("returns the post-UPDATE assignment, and only ever `stable` or null", async () => {
    responses = [[{ install_id: "install_a", assigned_channel: "stable" }]];
    expect(await M.applyInstallPoll({ install_id: "install_a" })).toEqual({ ok: true, assigned_channel: "stable" });
    responses = [[{ install_id: "install_a", assigned_channel: null }]];
    expect(await M.applyInstallPoll({ install_id: "install_a" })).toEqual({ ok: true, assigned_channel: null });
    responses = [[{ install_id: "install_a", assigned_channel: "test" }]];
    expect(await M.applyInstallPoll({ install_id: "install_a" })).toEqual({ ok: true, assigned_channel: null });
  });
});

// ---------------------------------------------------------------------------
// Migration 0079
// ---------------------------------------------------------------------------

describe("migration 0079", () => {
  const sqlText = readFileSync("db/migrations/0079_install_assigned_channel.sql", "utf8");
  const ddl = sqlText.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

  it("records itself as version 79", () => {
    expect(sqlText).toMatch(/VALUES \(79, '0079_install_assigned_channel'\)/);
  });

  it("is additive and idempotent — four ADD COLUMN IF NOT EXISTS, nothing dropped, no DEFAULT", () => {
    expect(ddl.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(4);
    // The statements, not the COMMENT prose (which says "default" about a microphone).
    const alter = /ALTER TABLE room_install[\s\S]*?;/.exec(ddl)![0];
    expect(alter).not.toMatch(/\bDROP\b|\bDEFAULT\b|ALTER COLUMN/i);
    expect(ddl).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
  });

  it("admits stable and only stable in assigned_channel", () => {
    expect(ddl).toMatch(/assigned_channel text NULL CHECK \(assigned_channel IN \('stable'\)\)/);
    expect(ddl).not.toMatch(/'test'/);
  });

  it("types the three measurements as the kickoff names them", () => {
    expect(ddl).toMatch(/peak\s+real/);
    expect(ddl).toMatch(/zero_ratio\s+real/);
    expect(ddl).toMatch(/input_devices\s+jsonb/);
  });

  it("comments every column (house style of 0077/0078)", () => {
    for (const c of ["assigned_channel", "peak", "zero_ratio", "input_devices"]) {
      expect(sqlText).toContain(`COMMENT ON COLUMN room_install.${c}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The card, rendered from the fleet's shape on 11 September 2026
// ---------------------------------------------------------------------------

describe("the card renders today's fleet as one row per room", () => {
  it("nine rooms (seven on 0.1.19, two on 0.1.8), twelve retired, one null install → 9 rows, 12 in disclosures, 1 Unassigned", () => {
    const names = ["Cardiology OPD", "Home Office", "OPD 1", "OPD 3", "OPD 4", "OPD 5", "OPD 6", "OPD 7", "Room 4.1"];
    const rooms = names.map((n, k) => room(`room_${k}`, n));
    const bound = rooms.map((r) =>
      inst({
        room_id: r.id,
        app_version: r.name === "OPD 1" || r.name === "OPD 4" ? "0.1.8" : "0.1.19",
        update_channel: r.name === "Home Office" || r.name === "Room 4.1" ? "test" : "stable",
        disk_free_bytes: r.name === "OPD 3" ? 12_000_000_000 : 180_000_000_000,
      }),
    );
    // Twelve retired installs spread over six rooms, the re-enrolment pastes of 10–11 Sep.
    const retired = Array.from({ length: 12 }, (_, n) =>
      inst({ room_id: rooms[[1, 3, 5, 6, 7, 8][n % 6]!]!.id, created_at: ago((20 + n) * DAY), retired_at: ago((3 + n) * DAY) }),
    );
    const nullRow = inst({
      room_id: rooms[2]!.id, created_at: ago(5 * 3_600_000), enrolled_at: null, hostname: null,
      app_version: null, last_seen_at: null, disk_free_bytes: null,
    });
    const { rows, unassigned } = group(rooms, [...bound, ...retired, nullRow]);
    const fleet: V.FleetPayload = {
      now: NOW.toISOString(), rows, latest_release: null, releases: { stable: null, test: null }, degraded: [], unassigned,
    };
    const html = renderToStaticMarkup(
      React.createElement(FleetTable, {
        fleet, nowMs, busy: null, onCopy: () => {}, onRetire: () => {}, onAssignStable: () => {},
      }),
    );
    const count = (re: RegExp) => (html.match(re) ?? []).length;
    expect(count(/<tr data-fleet-row/g)).toBe(9);
    expect(count(/<details data-earlier/g)).toBe(6);
    expect(count(/earlier installs?<\/summary>/g)).toBe(6);
    expect(rows.reduce((s, r) => s + (r.earlier_installs ?? 0), 0)).toBe(12);
    expect(count(/<li data-unassigned/g)).toBe(1);
    expect(count(/Move to stable/g)).toBe(2); // Home Office and Room 4.1, the two on test
    expect(count(/data-disk="amber"/g)).toBe(1); // OPD 3 at 12.0 GB
    expect(html).toContain("12.0 GB free");
    // Evidence line for the build report.
    console.log(`[fixture] rows=${count(/<tr data-fleet-row/g)} disclosures=${count(/<details data-earlier/g)} earlier_total=12 unassigned=${count(/<li data-unassigned/g)} move_to_stable=${count(/Move to stable/g)}`);
  });
});
