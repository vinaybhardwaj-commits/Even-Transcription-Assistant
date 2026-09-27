/**
 * Recorder 0.1.25 sends an ADDITIVE poll field `device_state` ("ok" | "lost"). The server release
 * that reads it (a DEVICE_LOST flag) ships after D4, so until then it must be ignored WITHOUT
 * harm: not an error, not in the cleaned fields, not in the ring entry, not in any SQL value.
 * Mocked `sql`; no live database.
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

const RI = await import("@/lib/room-install");

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe("device_state (0.1.25) is ignored by a server that does not read it yet", () => {
  it("cleanPollFields drops it: same result with and without, for ok, lost and junk", () => {
    const base = RI.cleanPollFields({ install_id: "i", tape_advancing: true } as never);
    for (const device_state of ["ok", "lost", "weird", 5, null]) {
      const withField = RI.cleanPollFields({ install_id: "i", tape_advancing: true, device_state } as never);
      expect(withField).toEqual(base);
      expect("device_state" in withField).toBe(false);
    }
  });

  it("applyInstallPoll neither throws nor writes it anywhere", async () => {
    responder = () => [{ install_id: "install_1", assigned_channel: null }];
    await RI.applyInstallPoll(
      { install_id: "install_1", tape_advancing: true, device_state: "lost" } as never,
      { recording: true },
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.text).not.toMatch(/device_state/);
      for (const v of c.values) expect(String(v)).not.toMatch(/device_state|"lost"/);
    }
  });

  it("DEVICE_MISSING still follows input_devices alone (the flag that exists today)", () => {
    const flags = RI.cleanPollFields({ install_id: "i", input_devices: "[]", device_state: "lost" } as never);
    expect(flags.input_devices).toBe("[]");
  });
});
