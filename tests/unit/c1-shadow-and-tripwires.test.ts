/**
 * Slice C1 steps 4 and 5 — the shadow sample, and the tripwires that read it.
 */
import { describe, it, expect } from "vitest";
import { shadowRate, shouldShadow, DEFAULT_SHADOW_RATE } from "@/lib/stt/shadow";

describe("C1 step 5 — the shadow sample is deterministic, not random", () => {
  it("the SAME window always makes the same decision — a re-drain cannot flip it", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `bw_${i}`);
    const first = ids.map((id) => shouldShadow(id, 0.1));
    const second = ids.map((id) => shouldShadow(id, 0.1));
    expect(second).toEqual(first);
  });

  it("raising the rate only ADDS windows — a widened sample is a superset", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `bw_${i}`);
    const at10 = new Set(ids.filter((id) => shouldShadow(id, 0.1)));
    const at30 = new Set(ids.filter((id) => shouldShadow(id, 0.3)));
    for (const id of at10) expect(at30.has(id), `${id} left the sample when the rate rose`).toBe(true);
  });

  it("lands near the requested fraction over a realistic number of windows", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `bw_${i}`);
    const hit = ids.filter((id) => shouldShadow(id, 0.1)).length / ids.length;
    expect(hit).toBeGreaterThan(0.07);
    expect(hit).toBeLessThan(0.13);
  });

  it("0 is never and 1 is always — both exact", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `bw_${i}`);
    expect(ids.some((id) => shouldShadow(id, 0))).toBe(false);
    expect(ids.every((id) => shouldShadow(id, 1))).toBe(true);
  });

  it("a typo in the env var falls back to the default — never to 0, never to 1", () => {
    expect(shadowRate("banana")).toBe(DEFAULT_SHADOW_RATE);
    expect(shadowRate("")).toBe(DEFAULT_SHADOW_RATE);
    expect(shadowRate(undefined)).toBe(DEFAULT_SHADOW_RATE);
    // Clamped two-sided: a fat-fingered 10 must not shadow every window in the clinic.
    expect(shadowRate("10")).toBe(1);
    expect(shadowRate("-3")).toBe(0);
    expect(shadowRate("0.25")).toBe(0.25);
  });
});

describe("C1 step 5 — the drain writes the control run, and what it costs", () => {
  const SRC = () => require("node:fs").readFileSync("lib/stt/room-drain.ts", "utf8") as string;

  it("the shadow INSERT names whisper as its own engine, so the leaderboard groups it correctly", () => {
    const src = SRC();
    expect(src).toMatch(/shouldShadow\(windowId\)/);
    // tr.engine must be whisper's own key, never the routed engine's — the existing GROUP BY
    // tr.engine aggregate is what makes one-run-per-(window x engine) work unchanged.
    expect(src).toMatch(/\$\{whisperAdapter\.key\}, \$\{whisperAdapter\.key\}, 'batch', 'asr'/);
  });

  it("a window whose routed engine IS whisper is skipped — it cannot be its own control", () => {
    expect(SRC()).toMatch(/engineKey !== whisperAdapter\.key && shouldShadow/);
  });

  it("the control run carries audio_seconds, or the yield comparison is one-sided", () => {
    const src = SRC();
    const shadow = src.slice(src.indexOf("THE SHADOW RUN"));
    expect(shadow.slice(0, shadow.indexOf("out.shadow_run_id"))).toMatch(/audio_seconds: audioSeconds/);
  });
});

describe("C1 step 4 — the tripwire tool", () => {
  it("is registered as a READ tool and says which columns are null for a non-route engine", async () => {
    const { STT_TOOLS } = await import("@/lib/mcp/tools/stt");
    const t = STT_TOOLS.find((x) => x.name === "scribe_route_tripwires");
    expect(t, "registered").toBeTruthy();
    expect(t!.scope, "it creates nothing").toBe("read");
    // A null mix must never be read as "zero spans" — the description is the only place a caller
    // learns that only `route` writes a timeline.
    expect(t!.description).toMatch(/null for every other engine/);
    expect(t!.description).toMatch(/no transcript text/);
  });

  it("names all four tripwires, so a reader knows what it is looking at", async () => {
    const { STT_TOOLS } = await import("@/lib/mcp/tools/stt");
    const d = STT_TOOLS.find((x) => x.name === "scribe_route_tripwires")!.description;
    for (const signal of ["engine mix", "language mix", "empty-transcript rate", "characters per audio-second"]) {
      expect(d.toLowerCase()).toContain(signal.toLowerCase());
    }
  });
});
