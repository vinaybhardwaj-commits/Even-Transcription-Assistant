/**
 * encounter-fusion-mcp.test.ts — which runner scribe_encounter_shadow_run calls. v1 by default; v2 when the
 * call asks for a replay (`fusion: true`, flag off — E-7 scoring of past days) or ENCOUNTER_FUSION_SHADOW is
 * on; an unrecognised flag value is an error, never read as off. Both runners are mocked: this is dispatch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ v1: 0, v2: 0 }));
vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no database in this test"); } }));
vi.mock("@/lib/encounter-clock/shadow-io", async (orig) => ({
  ...(await orig<typeof import("@/lib/encounter-clock/shadow-io")>()),
  runShadowForRoomDay: async () => { H.v1++; return { ok: true, run_id: "ehr_v1" }; },
}));
vi.mock("@/lib/encounter-clock/shadow-v2", () => ({
  runFusionShadowForRoomDay: async () => { H.v2++; return { ok: true, acoustic_run_id: "ehr_a", fused_run_id: "ehr_f" }; },
}));
// resolveRoom needs a room; stub the one lookup it makes.
vi.mock("@/lib/mcp/tools/brain", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp/tools/brain")>()),
  resolveRoom: async () => ({ id: "room_x", slug: "x", name: "x", enabled: true }),
}));

import { VOICE_TOOLS } from "@/lib/mcp/tools/voice";
import { ENCOUNTER_FUSION_SHADOW } from "@/lib/encounter-clock/flag";

const tool = VOICE_TOOLS.find((t) => t.name === "scribe_encounter_shadow_run")!;
const ctx = { origin: "https://x", actor: "t", scopes: new Set(["invoke" as const]) };
const call = (args: Record<string, unknown>) => tool.handler({ room_day_id: "rd_mcp", room_id: "room_x", ...args }, ctx as never) as Promise<Record<string, unknown>>;

afterEach(() => { H.v1 = 0; H.v2 = 0; vi.unstubAllEnvs(); });

describe("scribe_encounter_shadow_run dispatch", () => {
  it("declares the replay argument", () => {
    expect((tool.inputSchema as { properties: Record<string, { type: string }> }).properties.fusion).toMatchObject({ type: "boolean" });
  });

  it("flag off, no replay → v1 only", async () => {
    vi.stubEnv(ENCOUNTER_FUSION_SHADOW, "");
    expect(await call({})).toMatchObject({ runner: "v1", run_id: "ehr_v1" });
    expect(H).toEqual({ v1: 1, v2: 0 });
  });

  it("flag off, fusion:true → v2 (replay), and says it was a replay", async () => {
    vi.stubEnv(ENCOUNTER_FUSION_SHADOW, "0");
    expect(await call({ fusion: true })).toMatchObject({ runner: "v2", replay: true, fused_run_id: "ehr_f" });
    expect(H).toEqual({ v1: 0, v2: 1 });
  });

  it("flag on → v2 without being asked", async () => {
    vi.stubEnv(ENCOUNTER_FUSION_SHADOW, "1");
    expect(await call({})).toMatchObject({ runner: "v2", replay: false });
    expect(H).toEqual({ v1: 0, v2: 1 });
  });

  it("an unrecognised flag value runs NEITHER runner", async () => {
    vi.stubEnv(ENCOUNTER_FUSION_SHADOW, "sometimes");
    const r = await call({});
    expect(r.ok).toBe(false);
    expect(H).toEqual({ v1: 0, v2: 0 });
  });
});
