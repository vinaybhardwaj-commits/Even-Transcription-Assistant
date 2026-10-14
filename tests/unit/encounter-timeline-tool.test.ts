/** scribe_encounter_timeline: read-only board. SQL is not opened; ids are fake. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readEncounterTimeline, type TimelineLoad, type TimelineReadDeps } from "@/lib/mcp/tools/encounter-timeline";
import { timelineBoard } from "@/lib/encounter-clock/timeline-view";
import { CALLABLE_TOOLS, LAB_TOOLS, PUBLISHED_TOOLS } from "@/lib/mcp/surface";
import { listedTool, toolsForProfile } from "@/lib/mcp/profile";

const load = (over: Partial<TimelineLoad> = {}): TimelineLoad => ({
  run: { id: "ets_fake", model: "jev-1.13.0", calibration_sha: "ab".repeat(32) },
  consults: [{
    consult_key: "c1", start_ms: 0, end_ms: 100_000, confidence: 0.8, reason_codes: ["patient_left", "note_submitted"],
    closed_by: "patient_left", encounter_end_ms: 120_000, jev_used: false,
  }],
  pulse: [
    { start_ms: 0, end_ms: 100_000, close_kind: "clicked_end", end_clicked: true },
    { start_ms: 200_000, end_ms: 250_000, close_kind: "url_clear", end_clicked: false },
  ],
  cuts: [{ start_ms: 5_000, end_ms: 90_000 }],
  truncated: false,
  ...over,
});

function deps(over: Partial<TimelineReadDeps> & { loads?: number } = {}): TimelineReadDeps {
  return {
    resolveRoom: async () => ({ id: "room_fake1", slug: "opd-fake", name: "x", enabled: true }),
    pickIstDate: () => ({ date: "2026-10-09" }),
    findRoomDay: async () => ({ id: "rd_fake1" }) as never,
    isBlindRoomDay: () => false,
    roomDayIsBlind: async () => false,
    load: async () => { over.loads = (over.loads ?? 0) + 1; return load(); },
    ...over,
  };
}

const keysDeep = (o: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, out));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.add(k); keysDeep(v, out); }
  return out;
};

describe("registration", () => {
  it("is appended once, read scope, listed for every profile", () => {
    expect(PUBLISHED_TOOLS.filter((t) => t.name === "scribe_encounter_timeline")).toHaveLength(1);
    expect(PUBLISHED_TOOLS[PUBLISHED_TOOLS.length - 4]!.name).toBe("scribe_encounter_timeline");
    expect(PUBLISHED_TOOLS[PUBLISHED_TOOLS.length - 3]!.name).toBe("scribe_freescript");
    expect(PUBLISHED_TOOLS[PUBLISHED_TOOLS.length - 2]!.name).toBe("scribe_admin");
    expect(PUBLISHED_TOOLS[PUBLISHED_TOOLS.length - 1]!.name).toBe("scribe_catalog"); // CATALOG-1
    expect(CALLABLE_TOOLS.get("scribe_encounter_timeline")!.scope).toBe("read");
    expect(LAB_TOOLS.some((t) => t.name === "scribe_encounter_timeline")).toBe(true);
    for (const p of ["operator", "lab"] as const) expect(toolsForProfile(p).map((t) => t.name)).toContain("scribe_encounter_timeline");
    const listed = listedTool("scribe_encounter_timeline")!;
    expect(listed.description.length).toBeLessThanOrEqual(200);
    expect(listed.description).toMatch(/Read-only/);
    expect(listed.description).toMatch(/Times UTC/);
    expect(listed.help ?? "").toMatch(/No transcript/);
  });
});

describe("readEncounterTimeline", () => {
  it("refuses a held-out day before any read", async () => {
    let reads = 0;
    const counting = async () => { reads++; return load(); };
    expect(await readEncounterTimeline({ room_id: "room_fake1" }, deps({ isBlindRoomDay: () => true, load: counting }))).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await readEncounterTimeline({ room_id: "room_fake1", room_day_id: "rd_fake1" }, deps({ roomDayIsBlind: async () => true, load: counting }))).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(reads).toBe(0);
  });

  it("unknown room and a missing day do not invent a consult", async () => {
    expect(await readEncounterTimeline({}, deps({ resolveRoom: async () => null }))).toMatchObject({ ok: false, error: "unknown_room" });
    expect(await readEncounterTimeline({ room_id: "room_fake1" }, deps({ findRoomDay: async () => null }))).toMatchObject({ ok: false, error: "no_room_day" });
  });

  it("returns timings, reason codes, and agreement, and no text fields", async () => {
    const out = await readEncounterTimeline({ room_id: "room_fake1", room_day_id: "rd_fake1" }, deps());
    expect(out).toMatchObject({
      ok: true, run_id: "ets_fake", model: "jev-1.13.0", n_consults: 1,
      agreement: { pulse: { truth: 2, hypotheses: 1, missed: 1, extra: 0 }, cuts: { missed: 0, extra: 0 } },
      pulse_close: { end_clicked: 1, not_clicked: 1, by_close_kind: { clicked_end: 1, url_clear: 1 } },
    });
    const consult = (out.consults as Array<Record<string, unknown>>)[0]!;
    expect(consult.encounter_end_ms).toBe(120_000);
    expect(consult.reason_codes).toEqual(["patient_left", "note_submitted"]);
    const keys = keysDeep(out);
    for (const banned of ["transcript", "text", "full_name", "doctor_name", "note", "audio_url", "features"]) expect(keys.has(banned)).toBe(false);
  });

  it("a database error is a code, and the loader selects no name columns", async () => {
    expect(await readEncounterTimeline({ room_id: "room_fake1" }, deps({
      load: async () => ({ error: "db_error:42P01" }),
    }))).toEqual({ ok: false, error: "db_error:42P01" });
    const tool = readFileSync("lib/mcp/tools/encounter-timeline.ts", "utf8");
    const src = readFileSync("lib/room-access/encounter-timeline-read.ts", "utf8");
    expect(tool).not.toMatch(/eta_encounter_windows|consult_index|encounter_timeline_shadow/);
    expect(src).toMatch(/from "@\/lib\/db"/);
    const selects = src.slice(src.indexOf("SELECT id, model"));
    expect(selects).not.toMatch(/warehouse_doctor_name|consulting_doctor_name|transcript|full_name/);
    expect(src).toMatch(/FROM encounter_timeline_shadow/);
    expect(src).toMatch(/FROM eta_encounter_windows/);
    expect(src).toMatch(/FROM consult_index/);
  });
});

describe("timelineBoard", () => {
  it("scores the intervals it is given and copies no extra fields", () => {
    const board = timelineBoard({
      room_id: "room_fake1",
      consults: [{ consult_key: "c1", start_ms: 0, end_ms: 10_000, confidence: null, reason_codes: [], closed_by: "cap", encounter_end_ms: null, jev_used: false }],
      pulse: [],
      cuts: [],
    });
    expect(board.agreement.pulse).toMatchObject({ truth: 0, hypotheses: 1, extra: 1, missed: 0 });
    expect(Object.keys(board.consults[0]!).sort()).toEqual(["closed_by", "confidence", "consult_key", "encounter_end_ms", "end_ms", "jev_used", "reason_codes", "start_ms"]);
  });
});
