/**
 * Fix 1, F1 — the WIRE, not the database layer.
 *
 * ─── THE GAP THIS FILE EXISTS TO CLOSE ───────────────────────────────────────────────────────
 * Build R3 shipped with `tests/unit/room-install-update.test.ts` proving `applyInstallPoll` writes
 * the new columns, and with `RoomSelfUpdateTests` proving the app puts them on the query string.
 * Nothing tested the route in between, and the route read none of them: `GET /api/bench/commands`
 * built its `install` object from a hard-coded list of eleven keys and dropped all seven R3 fields
 * on the floor. Both ends were right and the middle was empty.
 *
 * WHAT THAT WOULD HAVE DONE IN A CLINIC ROOM. `session_open` would have stayed NULL for ever, so
 * `deriveRow`'s `sessionOpen === true` would never be true, so "Tape not advancing" would never
 * fire in ANY room again. R3-3 was meant to make that warning correct; instead it would have
 * deleted it, and a room with a patient in it and a dead microphone cable would have read healthy.
 *
 * So every assertion here is about the object handed to `pollCommands` — the one place that proves
 * a value crossed from the query string into the write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type PollInput = { install?: Record<string, unknown> | null };
let lastPoll: PollInput | null = null;

vi.mock("@/lib/bench-commands", () => ({
  pollCommands: async (input: PollInput) => {
    lastPoll = input;
    return { now: "2026-09-09T10:00:00.000Z", superseded: false, commands: [] };
  },
  cleanLevels: () => null,
  classifyBusError: (e: unknown) => ({ code: "bus_down", cause_message: String(e) }),
}));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));

const { GET } = await import("@/app/api/bench/commands/route");

const poll = async (query: Record<string, string>) => {
  const url = new URL("https://www.evenscribe.app/api/bench/commands");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = { nextUrl: url } as unknown as Parameters<typeof GET>[0];
  const res = await GET(req);
  return { status: res.status, install: lastPoll?.install ?? null };
};

/** Exactly what the 0.1.8 app sends on a poll that carries a receipt. */
const FULL = {
  tab_id: "app_install_gd9tnfgqazvh",
  install_id: "install_gd9tnfgqazvh",
  app_version: "0.1.7",
  build_sha: "abc1234",
  mic_state: "authorized",
  tape_advancing: "true",
  never_sleep: "true",
  launched_by: "launchd",
  hostname: "Vinays-Mac-mini-3",
  hardware_model: "Mac16,11",
  os_version: "macOS 27.0",
  input_device_name: "TONOR TM20 Audio Device",
  session_open: "false",
  update_channel: "test",
  last_update_result: "checksum_mismatch",
  last_update_version: "0.1.8",
  last_update_error: "the downloaded file did not match its checksum",
  last_update_at: "2026-09-09T09:14:00.000Z",
  disk_free_bytes: "412300000000",
};

beforeEach(() => {
  lastPoll = null;
});

describe("the install poll's wire (F1)", () => {
  it("carries ALL SEVEN Build R3 fields into pollCommands", async () => {
    const { status, install } = await poll(FULL);
    expect(status).toBe(200);
    expect(install).toMatchObject({
      install_id: "install_gd9tnfgqazvh",
      session_open: false,
      update_channel: "test",
      last_update_result: "checksum_mismatch",
      last_update_version: "0.1.8",
      last_update_error: "the downloaded file did not match its checksum",
      last_update_at: "2026-09-09T09:14:00.000Z",
      disk_free_bytes: "412300000000",
    });
  });

  it("still carries everything §4.3 already carried", async () => {
    const { install } = await poll(FULL);
    expect(install).toMatchObject({
      app_version: "0.1.7",
      build_sha: "abc1234",
      mic_state: "authorized",
      tape_advancing: true,
      never_sleep: true,
      launched_by: "launchd",
      hostname: "Vinays-Mac-mini-3",
      hardware_model: "Mac16,11",
      os_version: "macOS 27.0",
      input_device_name: "TONOR TM20 Audio Device",
    });
  });

  it("session_open is a TRI-STATE and false survives it", async () => {
    // The whole of R3-3 rests on this being able to arrive as false. A truthiness read here would
    // turn every idle room into "not reported" and put the false tape warning back.
    expect((await poll({ ...FULL, session_open: "false" })).install?.session_open).toBe(false);
    expect((await poll({ ...FULL, session_open: "true" })).install?.session_open).toBe(true);
    const { session_open: _omitted, ...withoutIt } = FULL;
    expect((await poll(withoutIt)).install?.session_open).toBeNull();
    // Anything that is not exactly "true" or "false" is NOT REPORTED, never coerced.
    expect((await poll({ ...FULL, session_open: "1" })).install?.session_open).toBeNull();
    expect((await poll({ ...FULL, session_open: "yes" })).install?.session_open).toBeNull();
  });

  it("NEVER lets a disk reading of 0 or a non-number through (§5.5)", async () => {
    for (const bad of ["0", "-1", "", " ", "1.5", "9e9", "abc", "12,345"]) {
      const { install } = await poll({ ...FULL, disk_free_bytes: bad });
      expect(install?.disk_free_bytes, `disk_free_bytes=${JSON.stringify(bad)}`).toBeNull();
    }
    expect((await poll({ ...FULL, disk_free_bytes: "1" })).install?.disk_free_bytes).toBe("1");
  });

  it("omits an unparseable update time rather than guessing one", async () => {
    expect((await poll({ ...FULL, last_update_at: "yesterday" })).install?.last_update_at).toBeNull();
    expect((await poll({ ...FULL, last_update_at: "" })).install?.last_update_at).toBeNull();
    // A valid instant in any shape is normalised to ISO-8601, which is what the column takes.
    expect((await poll({ ...FULL, last_update_at: "2026-09-09T09:14:00Z" })).install?.last_update_at)
      .toBe("2026-09-09T09:14:00.000Z");
  });

  it("a poll WITHOUT install_id sends no install object at all", async () => {
    // The browser kiosk. Its poll must behave exactly as it did before R1 shipped — this is what
    // keeps the kiosk untouched by the whole install module.
    const { install } = await poll({ tab_id: "tab_browser", session_open: "true" });
    expect(install).toBeNull();
  });

  it("a 0.1.7 app — no R3 fields at all — still polls, with them all absent", async () => {
    // Every room below 0.1.8 sends exactly this until it updates itself, for ever.
    const { status, install } = await poll({
      tab_id: "app_install_x",
      install_id: "install_x",
      app_version: "0.1.7",
      tape_advancing: "false",
    });
    expect(status).toBe(200);
    expect(install).toMatchObject({ install_id: "install_x", tape_advancing: false });
    for (const key of [
      "session_open",
      "update_channel",
      "last_update_result",
      "last_update_version",
      "last_update_error",
      "last_update_at",
      "disk_free_bytes",
    ]) {
      expect(install?.[key], key).toBeNull();
    }
  });

  it("spare_device is not required, and its absence is not an error (§5.7)", async () => {
    // The 0.1.8 app stopped sending it. If the server rejected a poll that omits it, §5.7 said to
    // stop and report — this is that check, standing.
    const { status } = await poll(FULL);
    expect(status).toBe(200);
  });
});
