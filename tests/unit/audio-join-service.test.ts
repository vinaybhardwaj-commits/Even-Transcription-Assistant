/**
 * U2 service side — services/audio-join.
 *
 * The joining service is deployed separately (Cloudflare Containers, D14), but its decisions are
 * pure and live in `container/join-core.mjs`, so they are proved here with the app's own runner
 * rather than in a second harness nobody runs. What matters:
 *
 *   - the ORDER of the pieces survives every hop — validation, the wire frame, the ffmpeg argv;
 *   - an over-long input is refused by name.
 *
 * The ffmpeg process itself is exercised for real, on a real recording, by
 * `scripts/join-real-file.mjs` — see the U2 report.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM shipped inside the container image; no types, by design.
import { buildFfmpegArgs, buildFilterGraph, CLIPS_PREFIX, frameHeader, frameJob, framePiecePrefix, frameWireLength, MAX_JOIN_MS, MAX_PIECES, unframeJob, validateJoinRequest } from "../../services/audio-join/container/join-core.mjs";

const KEY = (i: number) => `bench/opd-7/2026-08-19/bs_xvntaugh/chunk_${String(i).padStart(5, "0")}.webm`;

const job = (over: Record<string, unknown> = {}) => ({
  pieces: [{ key: KEY(11), idx: 11 }, { key: KEY(12), idx: 12 }, { key: KEY(13), idx: 13 }],
  trim: { start_ms: 120_000, end_ms: 840_000 },
  out_key: "clips/bs_xvntaugh/20260819T050200Z-20260819T051400Z-primary.webm",
  meta: { session_id: "bs_xvntaugh", source: "primary" },
  ...over,
});

describe("ordering is preserved", () => {
  it("validation copies the pieces as given and never sorts them", () => {
    // Deliberately out of index order: the CALLER's order is the tape's order, not `idx`.
    const v = validateJoinRequest(job({ pieces: [{ key: KEY(13), idx: 13 }, { key: KEY(11), idx: 11 }, { key: KEY(12), idx: 12 }] }));
    expect(v.ok).toBe(true);
    expect(v.job.pieces.map((p: { idx: number }) => p.idx)).toEqual([13, 11, 12]);
    expect(v.job.pieces.map((p: { key: string }) => p.key)).toEqual([KEY(13), KEY(11), KEY(12)]);
  });

  it("the wire frame round-trips the piece bodies in order and byte for byte", () => {
    const bodies = [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2]), new Uint8Array([3, 3, 3, 3])];
    const header = { trim: { start_ms: 0, end_ms: 1_000 }, pieces: [{ key: KEY(0), idx: 0 }] };
    const { header: back, pieces } = unframeJob(frameJob(header, bodies));
    expect(back).toEqual(header);
    expect(pieces).toHaveLength(3);
    expect([...pieces[0]]).toEqual([1, 1, 1]);
    expect([...pieces[1]]).toEqual([2, 2]);
    expect([...pieces[2]]).toEqual([3, 3, 3, 3]);
  });

  it("an empty piece in the middle does not shift the ones after it", () => {
    const bodies = [new Uint8Array([9]), new Uint8Array([]), new Uint8Array([7, 7])];
    const { pieces } = unframeJob(frameJob({ trim: { start_ms: 0, end_ms: 1 }, pieces: [] }, bodies));
    expect(pieces.map((p: Uint8Array) => [...p])).toEqual([[9], [], [7, 7]]);
  });

  it("the ffmpeg argv gives every file its own -i in the order handed over, and the filter graph concatenates by input index", () => {
    const files = ["/tmp/p0000.webm", "/tmp/p0001.webm", "/tmp/p0002.webm"];
    const args = buildFfmpegArgs(files, 120_000, 840_000, "/tmp/out.webm");
    // -i in order, nothing between them but the paths
    const inputs = args.reduce<string[]>((acc, a, i) => (a === "-i" ? [...acc, args[i + 1]!] : acc), []);
    expect(inputs).toEqual(files);
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toBe(buildFilterGraph(3, 120_000, 840_000));
    expect(graph).toContain("[a0][a1][a2]concat=n=3:v=0:a=1[joined]");
    // The trim happens INSIDE the join (D9), on the joined stream.
    expect(graph).toContain("atrim=start=120.000:end=840.000");
    expect(args[args.indexOf("-map") + 1]).toBe("[out]");
  });

  it("every input is pinned to its FIRST AUDIO stream and normalised before concat — these recordings are audio inside a video container", () => {
    const graph = buildFilterGraph(2, 0, 60_000);
    expect(graph).toContain("[0:a:0]aformat=");
    expect(graph).toContain("[1:a:0]aformat=");
    expect(graph).toContain("sample_rates=48000:channel_layouts=mono");
    expect(buildFfmpegArgs(["a", "b"], 0, 60_000, "o")).toContain("-vn");
  });
});

describe("guard rails", () => {
  it("more than 30 minutes of input is refused, naming the limit", () => {
    const v = validateJoinRequest(job({ trim: { start_ms: 0, end_ms: 30 * 60_000 + 1 } }));
    expect(v.ok).toBe(false);
    expect(v.error).toBe("input_too_long");
    expect(v.limit_ms).toBe(MAX_JOIN_MS);
    expect(v.limit_minutes).toBe(30);
    // Exactly 30 minutes is allowed.
    expect(validateJoinRequest(job({ trim: { start_ms: 0, end_ms: 30 * 60_000 } })).ok).toBe(true);
  });

  it("a key outside the clips prefix is refused, and so is a traversal", () => {
    expect(validateJoinRequest(job({ out_key: "bench/opd-7/2026-08-19/bs_x/chunk_00001.webm" }))).toMatchObject({ ok: false, error: "bad_out_key", required_prefix: CLIPS_PREFIX });
    expect(validateJoinRequest(job({ out_key: "clips/../bench/x.webm" }))).toMatchObject({ ok: false, error: "bad_out_key" });
    expect(validateJoinRequest(job({ out_key: 42 }))).toMatchObject({ ok: false, error: "bad_out_key" });
  });

  it("every other malformed job has a name, and none of them throws", () => {
    expect(validateJoinRequest(null)).toMatchObject({ ok: false, error: "bad_request_body" });
    expect(validateJoinRequest(job({ pieces: [] }))).toMatchObject({ ok: false, error: "no_pieces" });
    expect(validateJoinRequest(job({ pieces: Array.from({ length: MAX_PIECES + 1 }, (_, i) => ({ key: KEY(i), idx: i })) }))).toMatchObject({ ok: false, error: "too_many_pieces", limit: MAX_PIECES });
    expect(validateJoinRequest(job({ pieces: [{ idx: 0 }] }))).toMatchObject({ ok: false, error: "bad_piece" });
    expect(validateJoinRequest(job({ trim: { start_ms: 5, end_ms: 5 } }))).toMatchObject({ ok: false, error: "trim_end_before_start" });
    expect(validateJoinRequest(job({ trim: { start_ms: -1, end_ms: 100 } }))).toMatchObject({ ok: false, error: "bad_trim" });
    expect(validateJoinRequest(job({ trim: "later" }))).toMatchObject({ ok: false, error: "bad_trim" });
  });

  it("the provenance is carried through as a flat string map — what R2 custom metadata accepts", () => {
    const v = validateJoinRequest(job({ meta: { session_id: "bs_a", nested: { a: 1 }, dropped: null, n: 7 } }));
    expect(v.ok).toBe(true);
    expect(v.job.meta).toEqual({ session_id: "bs_a", nested: '{"a":1}', n: "7" });
  });
});

/**
 * The Worker's body is a FixedLengthStream, because the container hop refuses one of unknown
 * length ("Provided readable stream must have a known length …"). That means the Worker declares
 * the byte count from R2's head() sizes BEFORE it reads any audio, and workerd holds it to that
 * number exactly: one byte over is "Attempt to write too many bytes through a FixedLengthStream",
 * one byte under is "FixedLengthStream did not see all expected bytes before close()". Both
 * measured in workerd, neither recoverable — so the arithmetic is pinned here to the frame the
 * container actually parses, rather than trusted.
 */
describe("the declared wire length", () => {
  const hdr = (n: number) => ({ trim: { start_ms: 164_497, end_ms: 884_496 }, pieces: Array.from({ length: n }, (_, i) => ({ key: KEY(i), idx: 29 + i })) });
  const body = (size: number, tag: number) => { const u = new Uint8Array(size); u.fill(tag); return u; };

  it("equals the bytes the frame actually occupies, for every shape the door can produce", () => {
    // one piece; the real bs_xvntaugh 12-minute window (4 pieces); the 30-minute worst case (7);
    // an empty piece; and the MAX_PIECES ceiling.
    for (const sizes of [[4_900_000], [4_900_000, 4_900_000, 4_900_000, 2_100_000], Array(7).fill(4_900_000), [0, 12, 0], Array(MAX_PIECES).fill(1_024)]) {
      const header = hdr(sizes.length);
      const framed = frameJob(header, sizes.map((s, i) => body(s, i + 1)));
      expect(frameWireLength(header, sizes)).toBe(framed.length);
    }
  });

  it("counts the header block and the 8-byte prefixes, not just the audio", () => {
    const header = hdr(3);
    const sizes = [100, 200, 300];
    // 3 prefixes × 8 B + the header block, above the 600 B of payload.
    expect(frameWireLength(header, sizes)).toBe(600 + 3 * 8 + (4 + JSON.stringify(header).length));
  });

  it("a piece that is not the size head() reported would break the frame — which is why the Worker counts bytes and names it", () => {
    const header = hdr(2);
    const declared = frameWireLength(header, [10, 10]);
    // What the pump would actually put on the wire if an object shrank between head() and get():
    // the PREFIX still says 10 — it was written from head() — but only 9 bytes follow it.
    const parts = [frameHeader(header), framePiecePrefix(10), body(10, 1), framePiecePrefix(10), body(9, 2)];
    const onWire = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0;
    for (const p of parts) { onWire.set(p, off); off += p.length; }

    expect(onWire.length).toBe(declared - 1); // one byte short of what was promised
    expect(() => unframeJob(onWire)).toThrow(/frame_truncated/);
  });
});
