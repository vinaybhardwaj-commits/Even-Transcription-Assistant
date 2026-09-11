/**
 * R4-D12 — POST /api/bench/commands/{id}/ack carries what a 0.1.21 app applied into
 * `bench_command.result`: `applied_device_uid` (string ≤256), `applied_input_volume` (0..1),
 * `input_volume_settable` (bool). Each is validated on its own and dropped if malformed; any other
 * key is dropped. An ack without them — every ack of the four day verbs, every browser kiosk — writes
 * exactly the `result` it wrote before R4.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ text: string; values: unknown[] }> = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(/^UPDATE bench_command SET status/.test(text) ? [{ id: values[values.length - 3] }] : []);
  };
  return { sql };
});
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));
// The start_day day-open hook is off the ack path and not under test here.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), after: () => {} }));
vi.mock("@/lib/brain/open-day", () => ({ ensureRoomDayOpen: async () => ({ created: false }) }));
vi.mock("@/lib/brain/state", () => ({ istDate: () => "2026-09-11" }));

const { POST } = await import("@/app/api/bench/commands/[id]/ack/route");

const ack = async (body: unknown, id = "cmd_abcdefgh") => {
  const req = new Request(`https://www.evenscribe.app/api/bench/commands/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req as never, { params: Promise.resolve({ id }) });
  const upd = calls.find((c) => /^UPDATE bench_command SET status/.test(c.text));
  return { status: res.status, result: upd ? String(upd.values[1]) : null, error: upd ? upd.values[2] : undefined };
};

beforeEach(() => {
  calls.length = 0;
});

describe("R4-D12 — the ack's applied fields reach bench_command.result", () => {
  it("lands all three on a set_audio_input ack", async () => {
    const { status, result } = await ack({ ok: true, applied_device_uid: "c270-1", applied_input_volume: 0.5, input_volume_settable: true });
    expect(status).toBe(200);
    expect(JSON.parse(result!)).toEqual({ ok: true, applied_device_uid: "c270-1", applied_input_volume: 0.5, input_volume_settable: true });
  });

  it("carries settable=false on a failed ack beside the app's reason", async () => {
    const { result, error } = await ack({ ok: false, error: "volume_not_settable", input_volume_settable: false });
    expect(JSON.parse(result!)).toEqual({ ok: false, error: "volume_not_settable", input_volume_settable: false });
    expect(error).toBe("volume_not_settable");
  });

  it("drops malformed fields and unknown keys, and still acks", async () => {
    const { status, result } = await ack({
      ok: true, applied_device_uid: "u".repeat(257), applied_input_volume: 1.5, input_volume_settable: "yes", gain: 0.9, note: "x",
    });
    expect(status).toBe(200);
    expect(result).toBe(JSON.stringify({ ok: true }));
  });

  it("an ack without them is byte-for-byte what it was before R4 (start_day, and a plain failure)", async () => {
    expect((await ack({ ok: true, session_id: "bs_new00001" })).result).toBe(JSON.stringify({ ok: true, session_id: "bs_new00001" }));
    calls.length = 0;
    expect((await ack({ ok: false, error: "room_paused" })).result).toBe(JSON.stringify({ ok: false, error: "room_paused" }));
    calls.length = 0;
    expect((await ack({ ok: true })).result).toBe(JSON.stringify({ ok: true }));
  });
});
