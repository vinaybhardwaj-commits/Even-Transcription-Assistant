/**
 * diarize-nemotron-validate.test.ts — the pure checks for what the Nemotron worker posts (epic #23 b).
 * Every expected number is worked out by hand in a comment; hashes are of literal strings typed here, never of
 * the function under test's own output. All ids are fake.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  checkHeartbeat,
  checkIngest,
  configHash,
  pendingLimit,
  speechAndOverlap,
  type Turn,
} from "@/lib/diarize-nemotron/validate";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
// The lab's offline config, and its canonical form typed BY HAND (keys sorted, no spaces) — what
// Python's json.dumps(sort_keys=True, separators=(",", ":")) prints for it.
const CONFIG = { spkcache: 264, fifo: 40, chunk: 340, right_context: 40, update: 300 };
const CONFIG_CANON = '{"chunk":340,"fifo":40,"right_context":40,"spkcache":264,"update":300}';
const CONFIG_HASH = sha(CONFIG_CANON);
const CLIP = "a".repeat(64);

const body = (o: Record<string, unknown> = {}) => ({
  window_id: "bw_fake0001",
  room_day_id: "rd_fake0001",
  engine: "nemotron",
  model: "nvidia/Nemotron-3-Diarization",
  model_rev: "rev0fake",
  config: CONFIG,
  config_hash: CONFIG_HASH,
  worker_id: "box-t4-1",
  machine: "box",
  audio_ms: 900000,
  clip_sha256: CLIP,
  status: "ok",
  error_code: null,
  turns: [[0, 4210, "spk0"], [3900, 9100, "spk1"], [9300, 15800, "spk0"]],
  ...o,
});
const err = (o: Record<string, unknown>) => {
  const r = checkIngest(body(o));
  return r.ok ? "ACCEPTED" : r.error;
};

describe("canonical JSON and the config hash", () => {
  it("sorts keys at every depth and has no whitespace", () => {
    expect(canonicalJson(CONFIG)).toBe(CONFIG_CANON);
    expect(canonicalJson({ b: [2, { z: 1, a: "x" }], a: null })).toBe('{"a":null,"b":[2,{"a":"x","z":1}]}');
  });
  it("configHash is sha256 of that canonical form, whatever the key order", () => {
    expect(configHash(CONFIG)).toBe(CONFIG_HASH);
    expect(configHash({ update: 300, right_context: 40, chunk: 340, fifo: 40, spkcache: 264 })).toBe(CONFIG_HASH);
  });
  it("refuses a non-finite number", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe("speech and overlap", () => {
  it("unions speech and measures 2+ voices, pinned by hand", () => {
    // [0,4210] ∪ [3900,9100] = [0,9100] → 9100; plus [9300,15800] → 6500; total 15600.
    // Overlap: [3900,4210] → 310.
    const t: Turn[] = [[0, 4210, "spk0"], [3900, 9100, "spk1"], [9300, 15800, "spk0"]];
    expect(speechAndOverlap(t)).toEqual({ speech_ms: 15600, overlap_ms: 310 });
  });
  it("turns that only touch do not overlap", () => {
    expect(speechAndOverlap([[0, 1000, "spk0"], [1000, 2000, "spk1"]])).toEqual({ speech_ms: 2000, overlap_ms: 0 });
  });
  it("three voices at once count once as overlap", () => {
    // [0,3000] ∪ … = 3000 speech; overlap where depth ≥ 2: [1000,3000] → 2000.
    expect(speechAndOverlap([[0, 3000, "spk0"], [1000, 3000, "spk1"], [1500, 2500, "spk2"]])).toEqual({ speech_ms: 3000, overlap_ms: 2000 });
  });
  it("nothing in, nothing out", () => {
    expect(speechAndOverlap([])).toEqual({ speech_ms: 0, overlap_ms: 0 });
  });
});

describe("checkIngest — accepts the PRD §7.1 shape", () => {
  it("an ok body: derived counts and a payload hash that ignores key order", () => {
    const r = checkIngest(body());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.derived).toEqual({ speaker_count: 2, turn_count: 3, speech_ms: 15600, overlap_ms: 310 });
    const reordered = Object.fromEntries(Object.entries(body()).reverse());
    const r2 = checkIngest(reordered);
    expect(r2.ok && r2.payload_sha256).toBe(r.payload_sha256);
    // A one-ms change to one turn is a different payload.
    const r3 = checkIngest(body({ turns: [[0, 4211, "spk0"], [3900, 9100, "spk1"], [9300, 15800, "spk0"]] }));
    expect(r3.ok && r3.payload_sha256).not.toBe(r.payload_sha256);
    // Who ran it is not part of the result: another worker on another machine gives the same hash.
    const r4 = checkIngest(body({ worker_id: "hf-9", machine: "hf" }));
    expect(r4.ok && r4.payload_sha256).toBe(r.payload_sha256);
  });
  it("empty: no turns; failed: an error code, no turns, and the clip hash may be absent", () => {
    expect(err({ status: "empty", turns: [] })).toBe("ACCEPTED");
    expect(err({ status: "failed", error_code: "decode_failed", turns: [], clip_sha256: null, audio_ms: 0 })).toBe("ACCEPTED");
  });
});

describe("checkIngest — refuses, with a code and never the value", () => {
  it("the body shape", () => {
    expect(checkIngest(null)).toMatchObject({ ok: false, error: "bad_body" });
    expect(checkIngest([])).toMatchObject({ ok: false, error: "bad_body" });
    expect(err({ transcript: "anything" })).toBe("unknown_field");
    const { turns: _t, ...noTurns } = body();
    expect(checkIngest(noTurns)).toMatchObject({ ok: false, error: "missing_turns" });
  });
  it("ids, engine, model, machine, status", () => {
    expect(err({ window_id: "bw 1" })).toBe("bad_window_id");
    expect(err({ room_day_id: "" })).toBe("bad_room_day_id");
    expect(err({ engine: "pyannoteai" })).toBe("bad_engine");
    expect(err({ model: "a b" })).toBe("bad_model");
    expect(err({ model_rev: "" })).toBe("bad_model_rev");
    expect(err({ worker_id: "x".repeat(65) })).toBe("bad_worker_id");
    expect(err({ machine: "laptop" })).toBe("bad_machine");
    expect(err({ status: "done" })).toBe("bad_status");
  });
  it("config: only flat ints, booleans, short ASCII strings; the hash must be the config's own", () => {
    expect(err({ config: { a: 1.5 }, config_hash: sha('{"a":1.5}') })).toBe("bad_config");
    expect(err({ config: { a: { b: 1 } } })).toBe("bad_config");
    expect(err({ config: {} })).toBe("bad_config");
    expect(err({ config: { a: "é" } })).toBe("bad_config");
    expect(err({ config_hash: "ABC" })).toBe("bad_config_hash");
    expect(err({ config_hash: sha('{"chunk":340}') })).toBe("config_hash_mismatch");
  });
  it("audio_ms and the clip hash", () => {
    expect(err({ audio_ms: 0 })).toBe("bad_audio_ms");
    expect(err({ audio_ms: 900000.5 })).toBe("bad_audio_ms");
    expect(err({ audio_ms: 4 * 3600 * 1000 + 1 })).toBe("bad_audio_ms");
    expect(err({ clip_sha256: "nothex" })).toBe("bad_clip_sha256");
    expect(err({ clip_sha256: null })).toBe("missing_clip_sha256");
  });
  it("error_code goes with failed, and only with failed", () => {
    expect(err({ error_code: "decode_failed" })).toBe("error_code_without_failure");
    expect(err({ status: "failed", error_code: null, turns: [] })).toBe("bad_error_code");
    expect(err({ status: "failed", error_code: "Bad Code", turns: [] })).toBe("bad_error_code");
  });
  it("turns: shape, labels, range, order, counts", () => {
    expect(err({ turns: "x" })).toBe("bad_turns");
    expect(err({ turns: [[0, 10]] })).toBe("bad_turn");
    expect(err({ turns: [[0.5, 10, "spk0"]] })).toBe("bad_turn");
    expect(err({ turns: [[0, 10, "DOC"]] })).toBe("bad_speaker_label");
    expect(err({ turns: [[0, 10, "spk100"]] })).toBe("bad_speaker_label");
    expect(err({ turns: [[10, 10, "spk0"]] })).toBe("turn_out_of_range");
    expect(err({ turns: [[-1, 10, "spk0"]] })).toBe("turn_out_of_range");
    expect(err({ turns: [[0, 900001, "spk0"]] })).toBe("turn_out_of_range");
    expect(err({ turns: [[5, 10, "spk0"], [0, 10, "spk1"]] })).toBe("turns_not_sorted");
    expect(err({ turns: [[0, 10, "spk0"], [0, 5, "spk1"]] })).toBe("turns_not_sorted");
    const nine = Array.from({ length: 9 }, (_, i) => [i * 10, i * 10 + 5, `spk${i}`]);
    expect(err({ turns: nine })).toBe("too_many_speakers");
    const many = Array.from({ length: 5001 }, (_, i) => [i * 100, i * 100 + 50, "spk0"]);
    expect(err({ turns: many, audio_ms: 600000 })).toBe("too_many_turns");
    expect(err({ turns: [] })).toBe("ok_without_turns");
    expect(err({ status: "empty" })).toBe("turns_with_empty");
  });
  it("8 speakers and 5,000 turns are the edges, not past them", () => {
    const eight = Array.from({ length: 8 }, (_, i) => [i * 10, i * 10 + 5, `spk${i}`]);
    expect(err({ turns: eight })).toBe("ACCEPTED");
    const most = Array.from({ length: 5000 }, (_, i) => [i * 100, i * 100 + 50, "spk0"]);
    expect(err({ turns: most, audio_ms: 600000 })).toBe("ACCEPTED");
  });
});

describe("checkHeartbeat", () => {
  it("keeps allow-listed fields, drops the rest", () => {
    const r = checkHeartbeat({
      worker_id: "box-t4-1", host: "eta-lab-t4", gpu: "Tesla T4", model_rev: "rev0fake", config_hash: CONFIG_HASH,
      queue_depth: 12, oldest_wait_s: 340, last_ok_at: "2026-10-09T03:00:00Z", windows_24h: 900, hf_jobs_24h: 2,
      hf_usd_24h: 1.234, last_error_code: null, note: "free text is dropped",
    });
    expect(r).toEqual({
      ok: true,
      worker_id: "box-t4-1",
      payload: {
        host: "eta-lab-t4", gpu: "Tesla T4", model_rev: "rev0fake", config_hash: CONFIG_HASH, queue_depth: 12, oldest_wait_s: 340,
        last_ok_at: "2026-10-09T03:00:00.000Z", windows_24h: 900, hf_jobs_24h: 2, hf_usd_24h: 1.23,
      },
    });
  });
  it("refuses a bad worker id or a bad value", () => {
    expect(checkHeartbeat({})).toMatchObject({ ok: false, error: "bad_worker_id" });
    expect(checkHeartbeat({ worker_id: "w", queue_depth: -1 })).toMatchObject({ ok: false, error: "bad_queue_depth" });
    expect(checkHeartbeat({ worker_id: "w", host: "a\"b" })).toMatchObject({ ok: false, error: "bad_host" });
    expect(checkHeartbeat({ worker_id: "w", hf_usd_24h: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, error: "bad_hf_usd_24h" });
    expect(checkHeartbeat({ worker_id: "w", last_ok_at: "yesterday" })).toMatchObject({ ok: false, error: "bad_last_ok_at" });
  });
});

describe("pendingLimit", () => {
  it("1..8, default 4", () => {
    expect(pendingLimit(null)).toBe(4);
    expect(pendingLimit("")).toBe(4);
    expect(pendingLimit("abc")).toBe(4);
    expect(pendingLimit("0")).toBe(1);
    expect(pendingLimit("3.9")).toBe(3);
    expect(pendingLimit("99")).toBe(8);
  });
});
