/**
 * diarize-nemotron-engine.test.ts — `nemotron` as a KNOWN engine that the push job must REFUSE, the shadow flag, and the
 * `engine=nemotron` read path of lib/diarize-segments.ts (epic #23 b). All values synthetic.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db: { calls: Array<{ q: string; vals: unknown[] }>; rows: unknown[] } = { calls: [], rows: [] };
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => {
    db.calls.push({ q: strings.join("?"), vals });
    return Promise.resolve(db.rows);
  },
}));
vi.mock("@/lib/mcp/auth", () => ({ checkMcpBearer: () => ({ ok: true, principal: { scopes: new Set(["read"]) } }) }));

import {
  DIARIZE_ENGINES,
  DiarizeEngineError,
  PUSH_ENGINES,
  diarizeEngine,
  nemotronShadowEnabled,
  pushEngine,
} from "@/lib/diarize-engine";
import { FlagValueError } from "@/lib/flags";
import { lookupSegments, nemotronWindowPayload, pickQuery, type NemotronWindowRow } from "@/lib/diarize-segments";

describe("the engine switch", () => {
  it("knows nemotron, and the default is still local", () => {
    expect([...DIARIZE_ENGINES].sort()).toEqual(["local", "nemotron", "pyannoteai"]);
    expect(diarizeEngine({})).toBe("local");
    expect(diarizeEngine({ DIARIZE_ENGINE: " Nemotron " })).toBe("nemotron");
    expect(() => diarizeEngine({ DIARIZE_ENGINE: "nemotron-3" })).toThrow(DiarizeEngineError);
  });

  it("the push job runs local and pyannoteai, and THROWS on nemotron rather than falling through", () => {
    expect([...PUSH_ENGINES].sort()).toEqual(["local", "pyannoteai"]);
    expect(pushEngine({})).toBe("local");
    expect(pushEngine({ DIARIZE_ENGINE: "pyannoteai" })).toBe("pyannoteai");
    expect(() => pushEngine({ DIARIZE_ENGINE: "nemotron" })).toThrow(DiarizeEngineError);
    expect(() => pushEngine({ DIARIZE_ENGINE: "nemotron" })).toThrow(/pull-based/);
    expect(() => pushEngine({ DIARIZE_ENGINE: "typo" })).toThrow(DiarizeEngineError);
  });

  it("the diarize_window job asks pushEngine, not diarizeEngine", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/jobs/kinds/diarize-window.ts", "utf8");
    expect(src).toMatch(/const engine: DiarizeEngine = pushEngine\(\);/);
    expect(src).not.toMatch(/=\s*diarizeEngine\(\)/);
  });

  it("scribe_diarize_segments passes engine raw, so an overlong value is refused rather than read as absent", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/mcp/tools/voice.ts", "utf8");
    expect(src).toMatch(/engine: args\.engine == null \? null : String\(args\.engine\)/);
    expect(src).not.toMatch(/argStr\(args, "engine"/);
  });

  it("DIARIZE_NEMOTRON_SHADOW: off unless set; strict", () => {
    expect(nemotronShadowEnabled({})).toBe(false);
    expect(nemotronShadowEnabled({ DIARIZE_NEMOTRON_SHADOW: "1" })).toBe(true);
    expect(nemotronShadowEnabled({ DIARIZE_NEMOTRON_SHADOW: "off" })).toBe(false);
    expect(() => nemotronShadowEnabled({ DIARIZE_NEMOTRON_SHADOW: "enabled" })).toThrow(FlagValueError);
  });
});

describe("segments read path: engine=nemotron", () => {
  beforeEach(() => {
    db.calls = [];
    db.rows = [];
  });

  it("pickQuery: absent engine is unchanged; nemotron needs window_id; anything else is refused", () => {
    expect(pickQuery({ window_id: "bw_1" })).toMatchObject({ ok: true, engine: null });
    expect(pickQuery({ window_id: "bw_1", engine: "" })).toMatchObject({ ok: true, engine: null });
    expect(pickQuery({ window_id: "bw_1", engine: "NEMOTRON" })).toMatchObject({ ok: true, engine: "nemotron" });
    // An overlong value is refused, not read as absent (the MCP tool passes it through raw).
    expect(pickQuery({ window_id: "bw_1", engine: "nemotron-but-much-too-long" })).toMatchObject({ ok: false, error: "bad_engine" });
    expect(pickQuery({ session_id: "bs_1", engine: "nemotron" })).toMatchObject({ ok: false, error: "engine_needs_window_id" });
    expect(pickQuery({ encounter_id: "enc_1", engine: "nemotron" })).toMatchObject({ ok: false, error: "engine_needs_window_id" });
    expect(pickQuery({ window_id: "bw_1", engine: "pyannoteai" })).toMatchObject({ ok: false, error: "bad_engine" });
  });

  it("the payload: spkN → S<N>, per-speaker speech, overlap where another speaker intersects; bad turns dropped", () => {
    const row: NemotronWindowRow = {
      window_id: "bw_1", session_id: "bs_1", room_day_id: "rd_1", source_mic: "mic_a", status: "ok",
      received_at: "2026-10-09T03:00:00Z", start_ms: 1_000_000, end_ms: 1_900_000, model_rev: "rev1", machine: "box",
      turns_json: [[0, 4210, "spk0"], [3900, 9100, "spk1"], [9300, 15800, "spk0"], [5, 2, "spk0"], [0, 10, "DOC name"], "junk"],
    };
    const p = nemotronWindowPayload(row);
    expect(p).toMatchObject({ kind: "window", window_id: "bw_1", source: "nemotron/box", clock: "clip_relative", origin_ms: 1_000_000, segments_run_id: "rev1", segments_stale: false, diarize_state: "ok" });
    // spk0: 4210 + 6500 = 10710; spk1: 5200.
    expect(p.speakers).toEqual([
      { speaker_idx: 0, speaker_label: "S0", total_speech_ms: 10710 },
      { speaker_idx: 1, speaker_label: "S1", total_speech_ms: 5200 },
    ]);
    expect(p.segments.map((s) => [s.start_ms, s.end_ms, s.speaker_label, s.overlap])).toEqual([
      [0, 4210, "S0", true],
      [3900, 9100, "S1", true],
      [9300, 15800, "S0", false],
    ]);
    expect(JSON.stringify(p)).not.toContain("DOC");
    expect(JSON.stringify(p)).not.toContain("matched_clinician_id");
  });

  it("an unexpected machine value is never echoed into source", () => {
    const p = nemotronWindowPayload({ window_id: "bw_1", session_id: null, room_day_id: null, source_mic: null, status: "empty",
      received_at: null, start_ms: null, end_ms: null, model_rev: null, machine: "box; DROP", turns_json: [] });
    expect(p.source).toBe("nemotron");
    expect(p.segments).toEqual([]);
  });

  it("lookupSegments reads the shadow table only for engine=nemotron, newest ok/empty row", async () => {
    db.rows = [];
    expect(await lookupSegments({ window_id: "bw_1", engine: "nemotron" })).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.q).toContain("FROM diarize_nemotron_window n");
    expect(db.calls[0]!.q).toContain("n.status IN ('ok', 'empty')");
    expect(db.calls[0]!.q).toMatch(/ORDER BY n\.received_at DESC/);
    expect(db.calls[0]!.q).not.toContain("room_diarize_window");
    db.calls = [];
    await lookupSegments({ window_id: "bw_1" });
    expect(db.calls[0]!.q).toContain("FROM room_diarize_window d");
    expect(db.calls[0]!.q).not.toContain("diarize_nemotron_window");
  });

  it("GET /api/diarize-segments passes engine through", async () => {
    const { GET } = await import("@/app/api/diarize-segments/route");
    db.rows = [];
    const r = await GET(new NextRequest("https://x.test/api/diarize-segments?window_id=bw_1&engine=nemotron"));
    expect(r.status).toBe(404);
    expect(db.calls.at(-1)!.q).toContain("diarize_nemotron_window");
    const bad = await GET(new NextRequest("https://x.test/api/diarize-segments?window_id=bw_1&engine=sortformer"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "bad_engine" });
  });
});
