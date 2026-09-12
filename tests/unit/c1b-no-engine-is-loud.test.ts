/**
 * Amendment A — a null route must FAIL LOUDLY, and 0083 is deleted.
 *
 * The rejected fix was a (room,'default') routing row. It reads as a safety net and is the
 * opposite: room resolves to sarvam, so the catch-all would have been a PAID engine silently
 * absorbing a misconfiguration. These tests pin the behaviour that replaced it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const DB = vi.hoisted(() => ({ routing: null as string | null, failures: [] as string[], runs: 0 }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window w JOIN bench_session"))
      return [{ id: "bw_1", session_id: "s1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000,
                source_mic: "primary", clip_r2_key: "clips/j.webm", grid_aligned: true, state: "transcribing", room_id: "room_1" }];
    if (q.includes("FROM bench_chunk"))
      return [{ idx: 0, source: "primary", r2_key: "c.webm", content_type: "audio/webm",
                started_at: new Date(0).toISOString(), ended_at: new Date(900_000).toISOString(), upload_state: "uploaded" }];
    if (q.includes("FROM stt_routing")) return DB.routing ? [{ engine_id: DB.routing }] : [];
    if (q.includes("FROM stt_engine")) return [{ enabled: true, is_paid: true, cost_per_min_usd: null }];
    if (q.includes("UPDATE stt_subject_job")) { DB.failures.push(String(v[0])); return [{ attempts: 1 }]; }
    if (q.includes("INSERT INTO transcription_run")) { DB.runs += 1; return []; }
    return [];
  },
}));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => new Uint8Array([1]), signGetUrl: async () => "https://x" }));
vi.mock("@/lib/whisper", () => ({
  transcribeWithWhisper: async () => ({ ok: true, transcript: "words", language: "kn", latency_ms: 10, attempts: 1,
                                        segments: [{ start_s: 0, end_s: 5, text: "words" }], engineVersion: null }),
}));
vi.mock("@/lib/mcp/tools/bench", () => ({
  buildTurns: () => ({ turns: [{ t: 1 }] }),
  buildWindowCue: () => ({}),
  writeWindowCues: async () => ({ written: 2, deleted: 0, failed: 0, complete: true, window_recorded: true }),
}));

const ACTOR = { actor: "admin_1", via: "admin_route" as const };
beforeEach(() => { DB.routing = null; DB.failures = []; DB.runs = 0; });

describe("migration 0083 is gone, and stays gone", () => {
  it("the file does not exist and no migration adds a (room,'default') row", () => {
    expect(existsSync("db/migrations/0083_stt_routing_room_default.sql")).toBe(false);
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(`db/migrations/${f}`, "utf8");
      const insertsDefault = /INSERT INTO stt_routing[\s\S]{0,400}?'default'/.test(sql);
      expect(insertsDefault, `${f} seeds a routing default — a paid catch-all in disguise`).toBe(false);
    }
  });
});

describe("a null route is raised, named, and stops the window", () => {
  it("segment REFUSES with no_engine — it does not substitute, skip, or carry on", async () => {
    const { roomWindowSegment } = await import("@/lib/stt/room-drain");
    const out = await roomWindowSegment("bw_1", "https://x.test", ACTOR, { clip_r2_key: "clips/j.webm", audio_seconds: 900 });
    expect(out.ok, "a window with no engine is not a success").toBe(false);
    expect(out.step, "named, so an operator reads WHY").toBe("no_engine");
    expect(String(out.detail)).toContain("bucket=");
    // It is recorded against the job, so it is visible without reading a log line.
    expect(DB.failures.some((f) => f.startsWith("no_engine")), "recorded on the job row").toBe(true);
    // And nothing was written: no shadow run mislabelled with an empty engine.
    expect(DB.runs, "no run may be written for a window that has no engine").toBe(0);
  });

  it("with a route present the same call proceeds — the refusal is the null, not the path", async () => {
    DB.routing = "whisper";
    const { roomWindowSegment } = await import("@/lib/stt/room-drain");
    const out = await roomWindowSegment("bw_1", "https://x.test", ACTOR, { clip_r2_key: "clips/j.webm", audio_seconds: 900 });
    expect(out.ok).toBe(true);
    expect(out.next_progress!.engine_id).toBe("whisper");
  });
});
