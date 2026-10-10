/**
 * nemotron-lab.test.ts — PURE checks for the Nemotron LAB lane (lib/diarize-nemotron/lab.ts, migration 0143): the override allow-list (refusals first),
 * the strict YAML subset, the three input forms, the closed lab-ingest body, the server-made R2 keys, the production ingest's optional probability pointer,
 * and the NLP1 probability file round trip in BOTH directions (a Python-written and a TypeScript-written fixture). All ids are fake.
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  LAB_PRESETS, LabArgsError, checkLabIngest, decodeNlp, encodeNlp, labEmbeddingsKey, labProbsKey, parseLabArgs, parseLabInputs, parseLabSpec,
  parsePostprocessingYaml, probsRawBytes, specHash, windowProbsKey, nemotronLabEnabled,
} from "@/lib/diarize-nemotron/lab";
import { checkIngest, configHash } from "@/lib/diarize-nemotron/validate";

const refuses = (f: () => unknown, re?: RegExp) => {
  let err: unknown;
  try { f(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(LabArgsError);
  if (re) expect((err as Error).message).toMatch(re);
};

describe("overrides: an allow-list, and an unknown key is a refusal", () => {
  it("defaults every field and accepts the offline preset", () => {
    expect(parseLabSpec(undefined)).toEqual({ preset: "offline_30.4s", postprocessing: {}, frontend: [], max_speakers: null, min_speech_ms: null, return_probs: false, return_embeddings: null });
  });
  it("refuses an unknown top-level key (not dropped)", () => {
    refuses(() => parseLabSpec({ preset: "offline_30.4s", model: "evil/model" }), /override not allowed/);
    refuses(() => parseLabSpec({ shell: "rm -rf /" }), /override not allowed/);
    refuses(() => parseLabSpec({ path: "/etc/passwd" }), /override not allowed/);
  });
  it("preset is an enum", () => {
    for (const p of LAB_PRESETS) expect(parseLabSpec({ preset: p }).preset).toBe(p);
    refuses(() => parseLabSpec({ preset: "../../etc" }), /preset must be/);
    refuses(() => parseLabSpec({ preset: 3 }), /preset must be/);
  });
  it("post-processing keys and ranges are bounded", () => {
    expect(parseLabSpec({ postprocessing: { offset: 0.6, onset: 0.5 } }).postprocessing).toEqual({ offset: 0.6, onset: 0.5 });
    refuses(() => parseLabSpec({ postprocessing: { onset: 1.5 } }), /postprocessing\.onset/);
    refuses(() => parseLabSpec({ postprocessing: { evil: 1 } }), /postprocessing key not allowed/);
    refuses(() => parseLabSpec({ postprocessing: { onset: "0.5" } }), /postprocessing\.onset/);
    refuses(() => parseLabSpec({ postprocessing: { onset: Number.NaN } }), /postprocessing\.onset/);
    refuses(() => parseLabSpec({ postprocessing: { min_duration_on: -1 } }), /min_duration_on/);
  });
  it("front-end chain: enum ops, numbers only, at most 6, no extra keys", () => {
    const ok = parseLabSpec({ frontend: [{ op: "highpass", hz: 80 }, { op: "lowpass", hz: 7000 }, { op: "gain", db: -3 }, { op: "loudnorm" }, { op: "afftdn", nr: 12 }] });
    expect(ok.frontend.map((s) => s.op)).toEqual(["highpass", "lowpass", "gain", "loudnorm", "afftdn"]);
    refuses(() => parseLabSpec({ frontend: [{ op: "exec", cmd: "id" }] }), /frontend op not allowed/);
    refuses(() => parseLabSpec({ frontend: [{ op: "highpass", hz: "80;id" }] }), /highpass\.hz/);
    refuses(() => parseLabSpec({ frontend: [{ op: "highpass", hz: 80, extra: 1 }] }), /unknown key/);
    refuses(() => parseLabSpec({ frontend: [{ op: "loudnorm", I: -16 }] }), /unknown key/);
    refuses(() => parseLabSpec({ frontend: Array.from({ length: 7 }, () => ({ op: "loudnorm" })) }), /at most 6/);
    refuses(() => parseLabSpec({ frontend: "highpass" }), /list of at most/);
    refuses(() => parseLabSpec({ frontend: [{ op: "highpass", hz: 5 }] }), /highpass\.hz/);
  });
  it("speaker limits and the file requests", () => {
    const s = parseLabSpec({ max_speakers: 3, min_speech_ms: 5000, return_probs: true, return_embeddings: "titanet" });
    expect([s.max_speakers, s.min_speech_ms, s.return_probs, s.return_embeddings]).toEqual([3, 5000, true, "titanet"]);
    refuses(() => parseLabSpec({ max_speakers: 9 }), /max_speakers/);
    refuses(() => parseLabSpec({ max_speakers: 0 }), /max_speakers/);
    refuses(() => parseLabSpec({ max_speakers: 2.5 }), /max_speakers/);
    refuses(() => parseLabSpec({ min_speech_ms: -1 }), /min_speech_ms/);
    refuses(() => parseLabSpec({ return_probs: "yes" }), /return_probs/);
    refuses(() => parseLabSpec({ return_embeddings: "whisper" }), /return_embeddings/);
    expect(parseLabSpec({ return_embeddings: null }).return_embeddings).toBeNull();
  });
  it("a normalised spec parses to itself (the stored args re-parse)", () => {
    const once = parseLabSpec({ preset: "latency_10s", postprocessing_yaml: "onset: 0.4\noffset: 0.7", frontend: [{ op: "gain", db: 2 }], max_speakers: 4, return_probs: true });
    expect(parseLabSpec(once)).toEqual(once);
  });
  it("specHash is stable and sensitive to every field", () => {
    const a = parseLabSpec({ postprocessing: { onset: 0.5 } });
    expect(specHash(a)).toBe(specHash(parseLabSpec({ postprocessing: { onset: 0.5 } })));
    expect(specHash(a)).not.toBe(specHash(parseLabSpec({ postprocessing: { onset: 0.51 } })));
    expect(specHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("post-processing YAML: a strict flat subset", () => {
  it("accepts key: number lines, comments, blank lines, one postprocessing: header", () => {
    expect(parsePostprocessingYaml("onset: 0.5\n# a note\n\noffset: 0.6  # trailing\n")).toEqual({ onset: 0.5, offset: 0.6 });
    expect(parsePostprocessingYaml("postprocessing:\n  onset: 0.4\n  min_duration_on: 0.2")).toEqual({ onset: 0.4, min_duration_on: 0.2 });
  });
  it.each([
    ["an anchor", "onset: &a 0.5"],
    ["an alias", "onset: *a"],
    ["a tag", "onset: !!float 0.5"],
    ["a flow map", "onset: {a: 1}"],
    ["a flow list", "onset: [1]"],
    ["a block scalar", "onset: |\n  1"],
    ["a string value", "onset: high"],
    ["a quoted number", 'onset: "0.5"'],
    ["a tab", "onset:\t0.5"],
    ["a duplicate key", "onset: 0.5\nonset: 0.6"],
    ["nesting below a non-header", "other:\n  onset: 0.5"],
    ["indentation without the header", "  onset: 0.5"],
    ["a header after keys", "onset: 0.5\npostprocessing:\n  offset: 0.5"],
    ["an exponent", "onset: 1e-1"],
    ["a document marker", "---\nonset: 0.5"],
    ["an uppercase key", "Onset: 0.5"],
  ])("refuses %s", (_n, text) => {
    refuses(() => parsePostprocessingYaml(text));
  });
  it("bounds length and line count", () => {
    refuses(() => parsePostprocessingYaml("onset: 0.5\n" + "#".repeat(2100)), /too long/);
    refuses(() => parsePostprocessingYaml(Array.from({ length: 13 }, (_, i) => `onset${"_x".repeat(i % 3)}: 1`).join("\n")), /too many lines|duplicate|header/);
  });
  it("a key outside the allow-list is refused after parsing (it is not silently dropped)", () => {
    refuses(() => parseLabSpec({ postprocessing_yaml: "evil: 1" }), /not allowed/);
    refuses(() => parseLabSpec({ postprocessing_yaml: "onset: 0.5", postprocessing: { onset: 0.5 } }), /not both/);
    refuses(() => parseLabSpec({ postprocessing_yaml: 5 }), /must be a string/);
  });
});

describe("inputs: window ids, two R2 prefixes, session spans", () => {
  it("parses all three forms in a fixed order and caps the count", () => {
    const a = parseLabInputs({ windows: ["bw_1"], r2_keys: ["bench/rm_a/2026-10-01/bs_x1/chunk_00001.webm", "clips/bs_x1/20261001T050000Z-20261001T052000Z-primary.webm"], spans: [{ session_id: "bs_x1", start: 1_000_000, end: 1_600_000 }] });
    expect(a.map((x) => x.kind)).toEqual(["window", "r2_key", "r2_key", "span"]);
    refuses(() => parseLabInputs({ windows: Array.from({ length: 11 }, (_, i) => `bw_${i}`) }), /at most 10/);
    refuses(() => parseLabInputs({}), /at least one/);
  });
  it.each([
    ["a path traversal", "bench/rm/../../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["an encounter key", "encounters/abc.webm"],
    ["a consult clip", "consult-clips/uid/clip.wav"],
    ["a voice sample", "voice-samples/dr/x.wav"],
    ["a lab key", "lab/nemotron/job/0/probs.nlp"],
    ["a scheme", "https://example.com/a.webm"],
    ["a space", "bench/rm a/2026/bs/chunk.webm"],
    ["a query", "clips/bs_x/a.webm?x=1"],
    ["a single segment", "clips/onlyone"],
  ])("refuses an r2 key that is %s", (_n, key) => {
    refuses(() => parseLabInputs({ r2_keys: [key] }));
  });
  it("window ids are plain ids; spans are bounded to 30 minutes and ordered", () => {
    refuses(() => parseLabInputs({ windows: ["bw 1; id"] }), /window id/);
    refuses(() => parseLabInputs({ windows: "bw_1" }), /list/);
    refuses(() => parseLabInputs({ spans: [{ session_id: "bs_x", start: 5, end: 5 }] }), /after start/);
    refuses(() => parseLabInputs({ spans: [{ session_id: "bs_x", start: 0, end: 31 * 60 * 1000 }] }), /30 minutes/);
    refuses(() => parseLabInputs({ spans: [{ session_id: "../x", start: 0, end: 10 }] }), /session_id/);
    refuses(() => parseLabInputs({ spans: [{ session_id: "bs_x", start: "soon", end: "later" }] }), /epoch ms or an ISO/);
    expect(parseLabInputs({ spans: [{ session_id: "bs_x", start: "2026-10-01T05:00:00Z", end: "2026-10-01T05:10:00Z", source: "backup" }] })[0]).toMatchObject({ kind: "span", source: "backup", end_ms: Date.parse("2026-10-01T05:10:00Z") });
  });
  it("args: a closed set of top-level keys", () => {
    refuses(() => parseLabArgs({ windows: ["bw_1"], url: "https://x" }), /argument not allowed/);
    refuses(() => parseLabArgs({ windows: ["bw_1"], script: "x" }), /argument not allowed/);
    refuses(() => parseLabArgs("windows"), /object/);
    expect(parseLabArgs({ windows: ["bw_1"], overrides: { max_speakers: 2 } }).spec.max_speakers).toBe(2);
  });
});

describe("the lab flag is strict", () => {
  it("unset/0 = off, 1 = on, a typo throws", () => {
    expect(nemotronLabEnabled({})).toBe(false);
    expect(nemotronLabEnabled({ NEMOTRON_LAB_ENABLED: "0" })).toBe(false);
    expect(nemotronLabEnabled({ NEMOTRON_LAB_ENABLED: "1" })).toBe(true);
    expect(() => nemotronLabEnabled({ NEMOTRON_LAB_ENABLED: "enabled?" })).toThrow();
  });
});

describe("R2 keys are made by the server", () => {
  it("are under the lab prefixes and carry ids only", () => {
    expect(labProbsKey("job_abc", 3)).toBe("lab/nemotron/job_abc/3/probs.nlp");
    expect(labEmbeddingsKey("job_abc", 3)).toBe("lab/nemotron/job_abc/3/emb.nlp");
    expect(windowProbsKey("bw_1")).toBe("lab/nemotron-probs/bw_1.nlp");
  });
});

const CFG = { chunk_len: 340, latency: "offline_30.4s" };
const labBody = (o: Record<string, unknown> = {}) => ({
  run_id: "job_abc", idx: 0, worker_id: "box-1", status: "ok", error_code: null, model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1", config: CFG,
  spec_hash: "a".repeat(64), audio_ms: 900000, clip_sha256: "b".repeat(64), turns: [[0, 4000, "spk0"], [3500, 9000, "spk1"]],
  probs_r2_key: null, embeddings_r2_key: null, embeddings_dims: null, infer_s: 12.5, ...o,
});

describe("lab ingest body: a closed shape", () => {
  it("accepts a good body and derives the counts", () => {
    const v = checkLabIngest(labBody());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.derived).toEqual({ speaker_count: 2, turn_count: 2, speech_ms: 9000, overlap_ms: 500 });
  });
  it.each([
    ["an unknown field", { transcript: "x" }, "unknown_field"],
    ["a bad run id", { run_id: "a/b" }, "bad_run_id"],
    ["an idx out of range", { idx: 10 }, "bad_idx"],
    ["a bad status", { status: "done" }, "bad_status"],
    ["ok without turns", { turns: [] }, "ok_without_turns"],
    ["an empty with turns", { status: "empty" }, "turns_with_empty"],
    ["a turn past the audio", { turns: [[0, 900001, "spk0"]] }, "turn_out_of_range"],
    ["unsorted turns", { turns: [[100, 200, "spk0"], [0, 50, "spk1"]] }, "turns_not_sorted"],
    ["a name as a label", { turns: [[0, 100, "Dr Rao"]] }, "bad_speaker_label"],
    ["a spec hash that is not a hash", { spec_hash: "x" }, "bad_spec_hash"],
    ["an ok result with no clip hash", { clip_sha256: null }, "missing_clip_sha256"],
    ["a probs key outside the lab prefix", { probs_r2_key: "bench/x/y.webm" }, "bad_probs_r2_key"],
    ["a probs key with ..", { probs_r2_key: "lab/nemotron/../x" }, "bad_probs_r2_key"],
    ["embeddings key without dims", { embeddings_r2_key: "lab/nemotron/j/0/emb.nlp" }, "embeddings_dims_mismatch"],
    ["a float config", { config: { onset: 0.5 } }, "bad_config"],
    ["a failure that names files", { status: "failed", error_code: "x", turns: [], probs_r2_key: "lab/nemotron/j/0/probs.nlp" }, "files_with_failure"],
    ["a failure without a code", { status: "failed", turns: [] }, "bad_error_code"],
    ["an error code on success", { error_code: "boom" }, "error_code_without_failure"],
  ])("refuses %s", (_n, over, code) => {
    expect(checkLabIngest(labBody(over))).toEqual({ ok: false, error: code });
  });
  it("accepts a failed row (no turns, no files) and an empty row", () => {
    expect(checkLabIngest(labBody({ status: "failed", error_code: "infer_failed", turns: [], clip_sha256: null, audio_ms: 0 })).ok).toBe(true);
    expect(checkLabIngest(labBody({ status: "empty", turns: [] })).ok).toBe(true);
  });
});

describe("production ingest: the optional probability pointer (0143)", () => {
  const cfg = { chunk: 340 };
  const prod = (o: Record<string, unknown> = {}) => ({
    window_id: "bw_a", room_day_id: "rd_1", engine: "nemotron", model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1", config: cfg, config_hash: configHash(cfg),
    worker_id: "box-1", machine: "box", audio_ms: 900000, clip_sha256: "c".repeat(64), status: "ok", error_code: null, turns: [[0, 4210, "spk0"]], ...o,
  });
  it("is optional: an old worker's body still validates", () => {
    const v = checkIngest(prod());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.body.probs_r2_key).toBeNull();
  });
  it("must equal the server's key for THAT window", () => {
    expect(checkIngest(prod({ probs_r2_key: windowProbsKey("bw_a") })).ok).toBe(true);
    expect(checkIngest(prod({ probs_r2_key: windowProbsKey("bw_other") }))).toEqual({ ok: false, error: "bad_probs_r2_key" });
    expect(checkIngest(prod({ probs_r2_key: "lab/nemotron-probs/../x.nlp" }))).toEqual({ ok: false, error: "bad_probs_r2_key" });
    expect(checkIngest(prod({ probs_r2_key: 5 }))).toEqual({ ok: false, error: "bad_probs_r2_key" });
    expect(checkIngest(prod({ status: "failed", error_code: "infer_failed", turns: [], clip_sha256: null, audio_ms: 0, probs_r2_key: windowProbsKey("bw_a") }))).toEqual({ ok: false, error: "files_with_failure" });
  });
  it("is NOT part of the payload hash: the same turns with and without the pointer are a duplicate, not a conflict", () => {
    const a = checkIngest(prod());
    const b = checkIngest(prod({ probs_r2_key: windowProbsKey("bw_a") }));
    expect(a.ok && b.ok && a.payload_sha256 === b.payload_sha256).toBe(true);
  });
  it("an unknown field is still refused", () => {
    expect(checkIngest(prod({ extra: 1 }))).toEqual({ ok: false, error: "unknown_field" });
  });
});

describe("NLP1: the probability / embedding file", () => {
  const P = [[0, 1, 0.5, 0.25], [0.2, 0.8, 0, 1], [0.1, 0.9, 0.3, 0.7]];
  const E = [[0.5, -0.25, 1.5, 0], [2, -1, 0.125, 0.75]];
  const near = (a: number[][], b: number[][], tol: number) => {
    expect(a.length).toBe(b.length);
    a.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(v - b[i]![j]!)).toBeLessThanOrEqual(tol)));
  };

  it("round-trips probabilities within the u8 quantisation error (1/510)", () => {
    const { header, rows } = decodeNlp(encodeNlp(P, "u8", { frame_ms: 80 }));
    expect(header).toMatchObject({ dtype: "u8", rows: 3, cols: 4, scale: 255, frame_ms: 80 });
    near(rows, P, 1 / 510 + 1e-9);
  });
  it("round-trips embeddings exactly for values a half float holds", () => {
    const { header, rows } = decodeNlp(encodeNlp(E, "f16", { embedder: "ecapa" }));
    expect(header).toMatchObject({ dtype: "f16", rows: 2, cols: 4, embedder: "ecapa" });
    expect(rows).toEqual(E);
  });
  it("reads the file the PYTHON worker wrote (tools/nemotron-worker/lab.py pack_nlp)", () => {
    const p = decodeNlp(readFileSync("tests/fixtures/nlp1/probs-py.nlp"));
    expect(p.header).toMatchObject({ dtype: "u8", rows: 3, cols: 4, frame_ms: 80 });
    near(p.rows, P, 1 / 510 + 1e-9);
    expect(decodeNlp(readFileSync("tests/fixtures/nlp1/emb-py.nlp")).rows).toEqual(E);
  });
  it("the TypeScript-written fixture is the one the Python test reads back", () => {
    const fixture = readFileSync("tests/fixtures/nlp1/probs-ts.nlp");
    near(decodeNlp(fixture).rows, P, 1 / 510 + 1e-9);
    expect(decodeNlp(readFileSync("tests/fixtures/nlp1/emb-ts.nlp")).rows).toEqual(E);
  });
  it("refuses a malformed or hostile file", () => {
    expect(() => decodeNlp(Buffer.from("not gzip"))).toThrow();
    expect(() => decodeNlp(gzipSync(Buffer.from("XXXX\0\0\0\0")))).toThrow(/not an NLP1/);
    const head = Buffer.from(JSON.stringify({ dtype: "u8", rows: 2, cols: 2 }));
    const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
    expect(() => decodeNlp(gzipSync(Buffer.concat([Buffer.from("NLP1"), len, head, Buffer.alloc(3)])))).toThrow(/size mismatch/);
    const bad = Buffer.from(JSON.stringify({ dtype: "f64", rows: 1, cols: 1 }));
    const l2 = Buffer.alloc(4); l2.writeUInt32LE(bad.length);
    expect(() => decodeNlp(gzipSync(Buffer.concat([Buffer.from("NLP1"), l2, bad, Buffer.alloc(8)])))).toThrow(/bad NLP1 header/);
  });
  it("clamps out-of-range probabilities and refuses a ragged matrix", () => {
    near(decodeNlp(encodeNlp([[-0.5, 1.5]], "u8")).rows, [[0, 1]], 1e-9);
    expect(() => encodeNlp([[0, 1], [0.5]], "u8")).toThrow(/ragged/);
  });
  it("sizes a 15-minute window: raw bytes by arithmetic, and the gzip of a realistic sparse matrix is smaller", () => {
    expect(probsRawBytes(900_000)).toBe(11_250 * 4);
    const frames = 11_250;
    let seed = 12345; // deterministic jitter, so the size is not the artefact of a perfectly regular matrix
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const rows = Array.from({ length: frames }, (_, i) => {
      const talker = Math.floor(i / 60) % 3; // turns of ~4.8 s
      return [0, 1, 2, 3].map((s) => Math.min(1, Math.max(0, (s === talker ? 0.9 : 0.04) + (rnd() - 0.5) * 0.2)));
    });
    const bytes = encodeNlp(rows, "u8").length;
    expect(bytes).toBeLessThan(probsRawBytes(900_000));
    console.log(`[nlp1-size] 15-min window, 4 speakers, ${frames} frames: raw u8 ${probsRawBytes(900_000)} B, gzip of a SYNTHETIC jittered matrix ${bytes} B`);
  });
});
