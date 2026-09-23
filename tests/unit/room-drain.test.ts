/**
 * K4b Part C — the pure half of the room STT drain: the report-only vocabulary (C8), the
 * language-probe slice (C3) and the Sarvam locale map.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The source with every comment removed.
 *
 * These assertions are about what the drain DOES, and a prose promise that it does not diarize
 * is not the same evidence as the absence of a diarization call. Reading the raw file makes the
 * header's own "No diarization (K5 owns it)" fail the test that checks for diarization, which is
 * the opposite of useful.
 */
const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
import {
  describeWindowActivity,
  probeSlice,
  sarvamLanguageCode,
  bucketFor,
  cueWriteFailed,
  PROBE_SECONDS,
  DRAIN_MAX_ATTEMPTS,
  joinBusyBackoffMs,
  JOIN_BUSY_BACKOFF_MIN_MS,
  JOIN_BUSY_BACKOFF_MAX_MS,
  JOIN_BUSY_MAX_WAIT_MS,
  JOIN_BUSY_MAX_ATTEMPTS,
  JOIN_BUSY_STEP_BUDGET_MS,
} from "@/lib/stt/room-drain";

const FIFTEEN = 15 * 60_000;
const piece = (idx: number, duration_s: number) => ({
  chunk: { idx, source: "primary" as const, r2_key: `k${idx}`, content_type: "audio/webm", started_at: "2026-08-22T16:00:00Z", ended_at: "2026-08-22T16:05:00Z", upload_state: "verified" },
  offset_in_chunk_s: 0,
  duration_s,
  chunk_bounds: { started_at: "2026-08-22T16:00:00Z", ended_at: "2026-08-22T16:05:00Z" },
});

describe("C8 — silence is REPORTED, never inferred", () => {
  it("zero segments is silence", () => {
    expect(describeWindowActivity(0, FIFTEEN, [])).toBe("silent");
  });

  it("1..3 segments on a window of ten minutes or more is thin", () => {
    expect(describeWindowActivity(1, FIFTEEN, ["a"])).toBe("thin");
    expect(describeWindowActivity(3, 10 * 60_000, ["a", "b", "c"])).toBe("thin");
  });

  it("the same 1..3 segments on a SHORT window is not thin — the rule names ten minutes", () => {
    expect(describeWindowActivity(2, 5 * 60_000, ["a", "b"])).toBe("speech");
  });

  it("four segments is not thin", () => {
    expect(describeWindowActivity(4, FIFTEEN, ["a", "b", "c", "d"])).toBe("speech");
  });

  it("repeated identical text is a loop, whatever the count", () => {
    expect(describeWindowActivity(6, FIFTEEN, Array(6).fill("thank you."))).toBe("loop");
    expect(describeWindowActivity(6, FIFTEEN, Array(6).fill("  thank you.  "))).toBe("loop");
  });

  it("a loop beats thin, because a repeated phrase is the more specific fault", () => {
    expect(describeWindowActivity(2, FIFTEEN, ["hmm", "hmm"])).toBe("loop");
  });

  it("one segment is not a loop — a single phrase repeats nothing", () => {
    expect(describeWindowActivity(1, FIFTEEN, ["hello"])).toBe("thin");
  });

  it("the vocabulary is CLOSED — no branch invents a fifth verdict", () => {
    const verdicts = new Set([
      describeWindowActivity(0, FIFTEEN, []),
      describeWindowActivity(1, FIFTEEN, ["a"]),
      describeWindowActivity(9, FIFTEEN, Array(9).fill("x")),
      describeWindowActivity(9, FIFTEEN, ["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
    ]);
    expect([...verdicts].sort()).toEqual(["loop", "silent", "speech", "thin"]);
  });

  it("no threshold, no second stack — the drain RECORDS VAD evidence (E18 R1.2) and still DECIDES nothing with it", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    // E18 changed what this invariant can say. The drain must now record the parameters a silence verdict was
    // made under, so the word appears; what it must never do is JUDGE with them. The mentions are therefore
    // enumerated: recording only, no comparison, no threshold, no second detector.
    // Exactly two mentions, both of them recording: the read, and the field it is stored under. A third —
    // a threshold, a comparison, a `vadDecides` — fails this test, which is the point of enumerating them.
    expect(new Set(src.match(/[A-Za-z_]*vad[A-Za-z_]*/gi) ?? []), "the only VAD mentions are the evidence read and the field it lands in")
      .toEqual(new Set(["readVadParams", "vad"]));
    expect(src).not.toMatch(/no_speech_prob\s*[<>]/);
    expect(src).not.toMatch(/silence_threshold|min_confidence/i);
    // Nothing in the drain compares a level or a probability against anything: that is E13's detector, and it
    // is not built here.
    expect(src).not.toMatch(/(peak_level|avg_level|no_speech_prob|silero)[^\n]*[<>]=?/);
  });
});

describe("C3 — the probe slice", () => {
  it("takes the first 30 seconds from a single long piece", () => {
    const s = probeSlice([piece(0, 300)], PROBE_SECONDS);
    expect(s.pieces).toHaveLength(1);
    expect(s.seconds).toBe(30);
    expect(s.pieces[0]!.duration_s).toBe(30);
  });

  it("spans pieces when the first is shorter than the probe", () => {
    const s = probeSlice([piece(0, 12), piece(1, 300)], PROBE_SECONDS);
    expect(s.pieces).toHaveLength(2);
    expect(s.seconds).toBe(30);
    expect(s.pieces[1]!.duration_s).toBe(18);
  });

  it("a window shorter than the probe yields what exists and SAYS so", () => {
    const s = probeSlice([piece(0, 7)], PROBE_SECONDS);
    expect(s.seconds).toBe(7);
    expect(s.pieces).toHaveLength(1);
  });

  it("never reaches for a piece it does not need", () => {
    const s = probeSlice([piece(0, 300), piece(1, 300), piece(2, 300)], PROBE_SECONDS);
    expect(s.pieces).toHaveLength(1);
  });

  it("no covering pieces is not a crash", () => {
    expect(probeSlice([], PROBE_SECONDS)).toEqual({ pieces: [], seconds: 0 });
  });
});

describe("C3 — Whisper's language becomes Sarvam's", () => {
  it("maps the codes Whisper actually returns", () => {
    expect(sarvamLanguageCode("en")).toBe("en-IN");
    expect(sarvamLanguageCode("hi")).toBe("hi-IN");
    expect(sarvamLanguageCode("kn")).toBe("kn-IN");
    expect(sarvamLanguageCode("ta")).toBe("ta-IN");
  });

  it("an English variant is still English", () => {
    expect(sarvamLanguageCode("en-US")).toBe("en-IN");
    expect(sarvamLanguageCode("eng")).toBe("en-IN");
  });

  it("UNKNOWN means do not force — never a plausible guess", () => {
    for (const v of [null, undefined, "", "auto", "und", "unknown", "zz", "xhosa"]) {
      expect(sarvamLanguageCode(v)).toBeNull();
    }
  });

  it("the bucket follows the same English rule the rest of the app uses", () => {
    expect(bucketFor("en")).toBe("english");
    expect(bucketFor("en-IN")).toBe("english");
    expect(bucketFor("hi")).toBe("indic");
    expect(bucketFor(null)).toBe("indic");
  });
});

describe("C7 — three attempts, then park", () => {
  it("the ceiling is three", () => {
    expect(DRAIN_MAX_ATTEMPTS).toBe(3);
  });

  it("the failure path parks the window and stops re-queueing", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    expect(src).toContain("attempts + 1 >= ${DRAIN_MAX_ATTEMPTS} THEN 'failed'");
    expect(src).toContain("state = 'failed'");
    // and the queue runner refuses to pick up an exhausted job at all
    expect(src).toContain("j.attempts < ${DRAIN_MAX_ATTEMPTS}");
  });
});

describe("the DO NOTs, held by the source itself", () => {
  const src = codeOf("lib/stt/room-drain.ts");

  it("does not diarize — K5 owns that", () => {
    expect(src).not.toMatch(/with_diarization|withDiarization|num_speakers|numSpeakers|diariz/i);
  });

  it("generates no note", () => {
    expect(src).not.toContain("generateNote");
  });

  it("calls ONE routed engine, never a fan-out", () => {
    expect(src).not.toContain("runFanoutForEncounter");
    expect(src).not.toContain("enqueueFanout");
    // ONE routed engine call, still — it is just made through the paid chokepoint now, which is
    // the only place in the repo that invokes an adapter on this path.
    expect(src.match(/adapter\.transcribe\(/g) ?? [], "the drain must not call an adapter directly").toHaveLength(0);
    expect(src.match(/await guardedTranscribe\(\{/g) ?? []).toHaveLength(1);
  });

  it("never types an engine name into a payload or a run", () => {
    expect(src).not.toMatch(/engine:\s*"/);
    expect(src).toContain("adapter.key");
  });

  it("resolves the ROOM stage, never 'live'", () => {
    expect(src).toContain('DRAIN_STAGE = "room"');
    expect(src).not.toMatch(/resolveRouting\(\s*"live"/);
  });

  it("bounds the session from chunks — session.ended_at is never read", () => {
    expect(src).not.toContain("ended_at FROM bench_session");
    expect(src).not.toMatch(/session\.ended_at/);
  });
});

/**
 * A refused cue post must FAIL the window.
 *
 * The first live run of this drain transcribed a 15-minute window, wrote a 506-segment run, and
 * posted ZERO cues — because /api/brain/cues answered not_a_scratch_day — and still returned
 * ok:true with the window marked 'transcribed'. These tests are about the exact shape that made
 * that possible.
 */
describe("a refused cue post fails the window", () => {
  it("the whole batch landing is the ONLY success", () => {
    expect(cueWriteFailed({ complete: true })).toBe(false);
  });

  it("THE TRAP — a marker-only admission has written:1 and must still FAIL", () => {
    // writeWindowCues' fallback records the ask with one stt_window cue while every turn was
    // rolled back. Testing `written === 0` would call this a success, which is the bug.
    const markerOnly = { complete: false, written: 1, failed: 506, deleted: 0,
                         failed_reason: "permission", turn_write_error: "not_a_scratch_day" };
    expect(markerOnly.written).toBeGreaterThan(0);
    expect(cueWriteFailed(markerOnly)).toBe(true);
  });

  it("nothing committed at all also fails", () => {
    expect(cueWriteFailed({ complete: false })).toBe(true);
  });

  it("a missing `complete` is a failure, not a pass — never assume success", () => {
    expect(cueWriteFailed({})).toBe(true);
    expect(cueWriteFailed({ complete: undefined })).toBe(true);
  });

  it("the drain tests `complete`, never `written`, at the cue gate", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    expect(src).toContain("if (cueWriteFailed(counts)) {");
    // the old, wrong test must not come back
    expect(src).not.toContain("counts.written === 0");
  });

  it("the failure is NAMED cues_refused and does not blame the engine", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    expect(src).toContain('recordFailure(windowId, "cues_refused", why)');
    expect(src).toContain('step: "cues_refused"');
  });

  it("the reason carries the brain's OWN error, not a generic string", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    expect(src).toContain("counts.turn_write_error ?? counts.failed_reason");
  });

  it("the gate runs BEFORE the window is marked transcribed", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    const gate = src.indexOf("cueWriteFailed(counts)");
    const mark = src.indexOf("state = 'transcribed'");
    expect(gate).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(mark);
  });
});

/**
 * The leaderboard must not blend subject kinds.
 *
 * `sarvam runs=55` on the first drained day was 46 consultations and 9 windows of a podcast
 * averaged into one composite — the exact failure lib/stt/subject.ts describes as "wrong in a
 * way that looks like data".
 */
describe("the leaderboard filters by subject kind", () => {
  const src = codeOf("lib/stt/leaderboard.ts");

  it("the query filters on subject_type", () => {
    expect(src).toContain("${subjectKind} = 'all' OR tr.subject_type = ${subjectKind}");
  });

  it("the DEFAULT is encounter — never 'all', never whatever was passed", () => {
    expect(src).toContain('filters.subjectKind === "bench_window" || filters.subjectKind === "all" ? filters.subjectKind : "encounter"');
  });

  it("an unknown or absent value falls to encounter, not to a widened population", () => {
    // The guard must be a whitelist, not a coalesce: `filters.subjectKind ?? "encounter"` would
    // pass ANY string straight into the SQL, including "all", which is the blend we are removing.
    const line = src.split("\n").find((l) => l.includes("const subjectKind"));
    expect(line).toBeDefined();
    expect(line).not.toContain("??");
    expect(line).toContain('? filters.subjectKind : "encounter"');
  });

  it("the answer SAYS which population it describes", () => {
    expect(src).toContain("subject_kind: subjectKind");
  });

  it("the route defaults the same way the library does", () => {
    const route = codeOf("app/api/admin/stt-lab/leaderboard/route.ts");
    expect(route).toContain('subjectParam === "bench_window" || subjectParam === "all" ? subjectParam : "encounter"');
  });

  it("the UI warns when a mixed board is selected", () => {
    const ui = codeOf("components/admin/SttLabClient.tsx");
    expect(ui).toContain('subject === "all" &&');
    expect(ui).toContain("not comparable");
  });

  it("the mixed-board warning uses a colour the palette actually defines", () => {
    // bg-danger-50 and friends were silently dropped for weeks because the shades did not exist.
    const cfg = readFileSync("tailwind.config.ts", "utf8");
    expect(cfg).toMatch(/warning:\s*\{[^}]*700:/);
  });
});

describe("Drain throughput fix (23 Sep) — join-busy backoff, PURE", () => {
  it("is always within [MIN, MAX)", () => {
    for (const r of [0, 0.1, 0.5, 0.999, 0.9999999]) {
      const ms = joinBusyBackoffMs(() => r);
      expect(ms).toBeGreaterThanOrEqual(JOIN_BUSY_BACKOFF_MIN_MS);
      expect(ms).toBeLessThan(JOIN_BUSY_BACKOFF_MAX_MS);
    }
  });

  it("is deterministic for a given rand() — same input, same backoff", () => {
    const rand = () => 0.37;
    expect(joinBusyBackoffMs(rand)).toBe(joinBusyBackoffMs(rand));
  });

  it("the bounds are the ones the order asked for: 30-60s backoff, a step budget under MAX_STEP_MS, a 15 min / 30 attempt cap", () => {
    expect(JOIN_BUSY_BACKOFF_MIN_MS).toBe(30_000);
    expect(JOIN_BUSY_BACKOFF_MAX_MS).toBe(60_000);
    expect(JOIN_BUSY_MAX_WAIT_MS).toBe(15 * 60_000);
    expect(JOIN_BUSY_MAX_ATTEMPTS).toBeGreaterThan(0);
    // A per-claim budget that could not fit even one backoff would never actually retry.
    expect(JOIN_BUSY_STEP_BUDGET_MS).toBeGreaterThan(JOIN_BUSY_BACKOFF_MAX_MS);
  });
});
