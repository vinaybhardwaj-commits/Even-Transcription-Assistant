/** Dispatch of the timeline run from scribe_encounter_shadow_run, and the `source` argument of scribe_encounter_hypotheses. v3 and the store are mocked. */
import { afterEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ v1: 0, v3: [] as unknown[], latest: [] as unknown[][] }));
vi.mock("@/lib/room-access/check", async (orig) => ({ ...((await orig()) as object), roomDayIsBlind: async () => false }));
vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no database in this test"); } }));
vi.mock("@/lib/encounter-clock/shadow-io", async (orig) => ({
  ...(await orig<typeof import("@/lib/encounter-clock/shadow-io")>()),
  runShadowForRoomDay: async () => { H.v1++; return { ok: true, run_id: "ehr_v1" }; },
}));
vi.mock("@/lib/encounter-clock/shadow-v3", () => ({
  runTimelineShadowForRoomDay: async (a: unknown) => { H.v3.push(a); return { ok: true, run_id: "ehr_tl" }; },
}));
vi.mock("@/lib/encounter-hypotheses", async (orig) => ({
  ...(await orig<typeof import("@/lib/encounter-hypotheses")>()),
  readLatestRun: async (...a: unknown[]) => { H.latest.push(a); return { run: null, runs_for_day: 0 }; },
}));
vi.mock("@/lib/mcp/tools/brain", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp/tools/brain")>()),
  resolveRoom: async () => ({ id: "room_x", slug: "x", name: "x", enabled: true }),
}));

import { VOICE_TOOLS } from "@/lib/mcp/tools/voice";
import { ENCOUNTER_TIMELINE_SHADOW, ENCOUNTER_GATE_DIAR } from "@/lib/encounter-clock/flag";

const run = VOICE_TOOLS.find((t) => t.name === "scribe_encounter_shadow_run")!;
const hyp = VOICE_TOOLS.find((t) => t.name === "scribe_encounter_hypotheses")!;
const ctx = { origin: "https://x", actor: "t", scopes: new Set(["invoke" as const, "read" as const]) };
const call = (t: typeof run, args: Record<string, unknown>) => t.handler({ room_day_id: "rd_mcp", room_id: "room_x", ...args }, ctx as never) as Promise<Record<string, unknown>>;

afterEach(() => { H.v1 = 0; H.v3 = []; H.latest = []; vi.unstubAllEnvs(); });

describe("scribe_encounter_shadow_run → timeline", () => {
  it("default: flag off, no replay → v3 never runs", async () => {
    vi.stubEnv(ENCOUNTER_TIMELINE_SHADOW, "");
    expect(await call(run, {})).toMatchObject({ runner: "v1" });
    expect(H.v3).toHaveLength(0);
  });
  it("timeline:true → v3 only (replay), gate v2 off unless ENCOUNTER_GATE_DIAR", async () => {
    vi.stubEnv(ENCOUNTER_GATE_DIAR, "");
    expect(await call(run, { timeline: true })).toMatchObject({ runner: "v3", replay: true, run_id: "ehr_tl" });
    expect(H.v1).toBe(0);
    expect(H.v3[0]).toMatchObject({ gate_diar: false });
    vi.stubEnv(ENCOUNTER_GATE_DIAR, "1");
    await call(run, { timeline: true });
    expect(H.v3[1]).toMatchObject({ gate_diar: true });
  });
  it("flag on → v3 runs beside v1 and the answer carries both", async () => {
    vi.stubEnv(ENCOUNTER_TIMELINE_SHADOW, "1");
    expect(await call(run, {})).toMatchObject({ runner: "v1", timeline: { run_id: "ehr_tl" } });
    expect(H.v3).toHaveLength(1);
  });
  it("a typo in the flag runs nothing", async () => {
    vi.stubEnv(ENCOUNTER_TIMELINE_SHADOW, "maybe");
    expect((await call(run, {})).ok).toBe(false);
    expect(H.v1).toBe(0);
    expect(H.v3).toHaveLength(0);
  });
});

describe("scribe_encounter_hypotheses → source", () => {
  it("source=timeline reads that source across smoother versions", async () => {
    await call(hyp, { source: "timeline" });
    expect(H.latest[0]).toEqual(["rd_mcp", undefined, "timeline"]);
  });
  it("without source the call is unchanged (current smoother version, no source)", async () => {
    await call(hyp, {});
    expect(H.latest[0]![0]).toBe("rd_mcp");
    expect(H.latest[0]![1]).toBe("encounter-clock-smooth-v1");
    expect(H.latest[0]![2]).toBeUndefined();
  });
  it("an unknown source is refused", async () => {
    expect(await call(hyp, { source: "guessed" })).toMatchObject({ error: "bad_source" });
    expect(H.latest).toHaveLength(0);
  });
});
