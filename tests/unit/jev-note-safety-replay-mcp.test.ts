/**
 * lib/mcp/tools/jev.ts's scribe_note_safety_replay — order NOTE-SAFETY-SHADOW.md §3. Mocks
 * lib/jev/note-safety-shadow.ts's runNoteSafetyShadowAsync as a black box (its own behaviour is
 * tests/unit/jev-note-safety-shadow.test.ts's job).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/brain/db", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: vi.fn() }));

const runMock = vi.fn(async (_encounterId: string) => ({ ran: true, u4Sentences: 3, u8Questions: 4 }));
vi.mock("@/lib/jev/note-safety-shadow", () => ({ runNoteSafetyShadowAsync: (encounterId: string) => runMock(encounterId) }));

import { JEV_TOOLS } from "@/lib/mcp/tools/jev";
import type { ToolContext } from "@/lib/mcp/registry";

const tool = () => {
  const t = JEV_TOOLS.find((x) => x.name === "scribe_note_safety_replay");
  if (!t) throw new Error("scribe_note_safety_replay not registered");
  return t;
};
const ctx: ToolContext = { origin: "https://preview.example", actor: "test-actor", scopes: new Set(["invoke"]) };

beforeEach(() => {
  runMock.mockClear();
});

describe("scribe_note_safety_replay", () => {
  it("requires an enc_-prefixed encounter_id", async () => {
    const bad = (await tool().handler({ encounter_id: "not-an-id" }, ctx)) as Record<string, unknown>;
    expect(bad).toMatchObject({ ran: false, error: "bad_encounter_id" });
    expect(runMock).not.toHaveBeenCalled();

    const missing = (await tool().handler({}, ctx)) as Record<string, unknown>;
    expect(missing).toMatchObject({ ran: false, error: "bad_encounter_id" });
  });

  it("delegates to runNoteSafetyShadowAsync and returns its counts, never text", async () => {
    const out = (await tool().handler({ encounter_id: "enc_abc123" }, ctx)) as Record<string, unknown>;
    expect(runMock).toHaveBeenCalledWith("enc_abc123");
    expect(out).toEqual({ ok: true, ran: true, u4Sentences: 3, u8Questions: 4 });
  });

  it("the flag-off case (runNoteSafetyShadowAsync itself returns ran:false) is passed through, not treated as a tool error", async () => {
    runMock.mockResolvedValueOnce({ ran: false, u4Sentences: 0, u8Questions: 0 });
    const out = (await tool().handler({ encounter_id: "enc_off" }, ctx)) as Record<string, unknown>;
    expect(out).toEqual({ ok: true, ran: false, u4Sentences: 0, u8Questions: 0 });
  });

  it("fails safe: an error from runNoteSafetyShadowAsync degrades rather than throwing", async () => {
    runMock.mockRejectedValueOnce(new Error("db down"));
    const out = (await tool().handler({ encounter_id: "enc_err" }, ctx)) as Record<string, unknown>;
    expect(out.degraded).toBe(true);
    expect(out.ran).toBe(false);
  });

  it("W27.7(a) F2: an error that quotes text never reaches the MCP caller; only the class name does", async () => {
    runMock.mockRejectedValueOnce(new Error("upstream said: Tab Zylorex 40mg twice daily"));
    const out = (await tool().handler({ encounter_id: "enc_leak" }, ctx)) as Record<string, unknown>;
    expect(out.degraded).toBe(true);
    expect(out.error).toBe("jev_error: Error");
    expect(JSON.stringify(out)).not.toContain("Zylorex");
  });

  it("is scoped invoke, not read — it can trigger real Jev calls when the flag is on", () => {
    expect(tool().scope).toBe("invoke");
  });
});
