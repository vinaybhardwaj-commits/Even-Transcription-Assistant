/**
 * Night drain — the outcome taxonomy and the producer stamp. What would break these: a diarize failure string that
 * maps to nothing (a status the caller would drop), the service's message reaching the row, or the producer becoming
 * a constant.
 */
import { describe, it, expect } from "vitest";
import { ABANDONED_CODES, DEFERRED_CODES, FAILED_CODES, FATAL_CODES, mapDiarizeFailure } from "@/lib/night-drain/outcome";
import { NIGHT_DRAIN_VERSION, producerStamp, stampTiming } from "@/lib/night-drain/producer";

describe("night drain: every runDiarize failure lands on a named outcome", () => {
  const cases: Array<[string, boolean, string]> = [
    ["diarize_base_url_missing", false, "fatal:diarize_base_url_missing"],
    ["diarize_busy_queue_wait_exceeded_120000ms", true, "deferred:diarize_busy"],
    ["diarize_busy_aborted_3ms", true, "deferred:diarize_busy"],
    ["timeout_300000ms", false, "recorded:failed:diarize_timeout"],
    ["network: fetch failed", false, "recorded:failed:diarize_network"],
    ["network: connect ECONNREFUSED 127.0.0.1:8001", false, "recorded:failed:diarize_network"],
    ["http_415: could not decode audio: Invalid data", false, "recorded:failed:diarize_http_4xx"],
    ["http_400: audio empty", false, "recorded:failed:diarize_http_4xx"],
    ["http_500: Internal Server Error", false, "recorded:failed:diarize_http_5xx"],
    ["http_503: ", false, "recorded:failed:diarize_http_5xx"],
    ["aborted", true, "abandoned:stopped"],
    ["something we have never seen", false, "recorded:failed:diarize_other"],
    ["", false, "recorded:failed:diarize_other"],
  ];
  it.each(cases)("%s (retryable=%s) → %s", (error, retryable, want) => {
    const o = mapDiarizeFailure({ error, retryable });
    const got = o.kind === "recorded" && o.state === "failed" ? `recorded:failed:${o.code}` : `${o.kind}:${(o as { code: string }).code}`;
    expect(got).toBe(want);
  });

  it("never lets the service's message reach the row: only a code survives", () => {
    const o = mapDiarizeFailure({ error: "http_500: Traceback ... /Users/someone/audio-of-a-patient.webm", retryable: false });
    expect(JSON.stringify(o)).not.toMatch(/Traceback|Users|patient|webm/);
  });

  it("keeps the code sets closed and disjoint by kind", () => {
    const all = [...FAILED_CODES, ...DEFERRED_CODES, ...ABANDONED_CODES, ...FATAL_CODES];
    expect(new Set(all).size).toBe(all.length);
    expect(FAILED_CODES).toContain("hard_cap");          // recorded, so a window that eats its whole cap cannot loop for ever
    expect(ABANDONED_CODES).not.toContain("hard_cap" as never);
  });
});

describe("night drain: the producer stamp is derived from the running host, never a constant", () => {
  it("takes host, arch and platform from what it is given", () => {
    const a = producerStamp("mps", { hostname: () => "host-a", arch: () => "arm64", platform: () => "darwin" });
    const b = producerStamp("cpu", { hostname: () => "host-b", arch: () => "x64", platform: () => "linux" });
    expect(a).toMatchObject({ host: "host-a", arch: "arm64", platform: "darwin", service_device: "mps", worker: "night-drain", worker_version: NIGHT_DRAIN_VERSION });
    expect(b).toMatchObject({ host: "host-b", arch: "x64", platform: "linux", service_device: "cpu" });
    expect(a.host).not.toBe(b.host);
  });

  it("defaults to the machine it is running on", async () => {
    const os = await import("node:os");
    const p = producerStamp(null);
    expect(p.host).toBe(os.hostname());
    expect(p.arch).toBe(os.arch());
    expect(p.platform).toBe(os.platform());
    expect(p.service_device).toBeNull();
  });

  it("stamps timing_json with the producer AND the diarize_only flag, keeping every key the client had", () => {
    const client = { queue_wait_ms: 3, wall_ms: 70_000, service_ms: 68_000, audio_bytes: 28_800_044, timed_out: false };
    const t = stampTiming(client, producerStamp("mps"), { mcp_ms: 900, download_ms: 4000, join_ms: 3000, diarize_ms: 70_000, total_ms: null }, { pieces: 4, bytes: 1_000_000, seconds: 900, source: "primary" });
    expect(t).toMatchObject({ ...client, diarize_only: true });
    expect(t.producer).toMatchObject({ worker: "night-drain" });
    expect(t.night_drain).toMatchObject({ audio_source: "scribe_mcp_chunks", phases: { mcp_ms: 900, join_ms: 3000 }, audio: { pieces: 4, seconds: 900 } });
  });

  it("stamps a failed row that never reached the service (no client timing)", () => {
    const t = stampTiming(null, producerStamp(null), { mcp_ms: null, download_ms: null, join_ms: null, diarize_ms: null, total_ms: null }, null);
    expect(t.diarize_only).toBe(true);
    expect(t.producer).toBeTruthy();
    expect(Object.keys(t).sort()).toEqual(["diarize_only", "night_drain", "producer"]);
  });
});
