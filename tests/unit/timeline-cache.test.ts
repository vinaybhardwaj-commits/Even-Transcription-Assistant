/** The timeline wire is pinned and has no temperature field. The same state is not asked twice. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  answerCacheKey, clientBodyOmitsTemperature, memoryCache, timelineQuestionSetSha, timelineWireBody, TIMELINE_MODEL_PIN,
} from "@/lib/encounter-clock/timeline-cache";

describe("timeline cache", () => {
  it("pins jev-1.13.0 and a stable question-set hash", () => {
    expect(TIMELINE_MODEL_PIN).toBe("jev-1.13.0");
    expect(timelineQuestionSetSha()).toBe(timelineQuestionSetSha());
    expect(timelineQuestionSetSha()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the cache key ignores key order, and a second read does not miss", () => {
    const a = answerCacheKey(TIMELINE_MODEL_PIN, "sha", { rows: [{ t: "t+00:00" }], setting: "s" });
    const b = answerCacheKey(TIMELINE_MODEL_PIN, "sha", { setting: "s", rows: [{ t: "t+00:00" }] });
    expect(a).toBe(b);
    const cache = memoryCache();
    const reading = { end_row: "t+00:00", end_signal: null, end_conf: 0.4, late_start_p: null, kind: null, kind_conf: null };
    expect(cache.get(a)).toBeNull();
    cache.set(a, reading);
    expect(cache.get(a)).toEqual(reading);
  });

  it("the client body the leave lane is allowed to send has no temperature key", () => {
    const body = timelineWireBody(TIMELINE_MODEL_PIN, { rows: [] }, { q: {} });
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(JSON.stringify(body)).not.toContain("temperature");
    expect(clientBodyOmitsTemperature(readFileSync("lib/jev/client.ts", "utf8"))).toBe(true);
  });
});
