/**
 * Build 3 §C / §D and the §5 amendment — the scorer trigger, the gold route, and Whisper's
 * reported model.
 *
 * §C exists because Build 2 shipped a refusal-emitting scorer that NOTHING CALLED: it was
 * reachable only from its own test, so the leaderboard stayed empty and an empty leaderboard is
 * indistinguishable from "no engine has been run". That ambiguity is exactly what the refusal
 * vocabulary was built to abolish, so the trigger is part of the vocabulary's contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { reportedWhisperModel } from "@/lib/whisper";

const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// §C — the scoring pass, against a mocked database
// ---------------------------------------------------------------------------

const calls: Array<{ text: string; values: unknown[] }> = [];
let responses: unknown[] = [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  },
}));
vi.mock("@/lib/r2", () => ({
  headObject: async () => ({ size: null, content_type: null }),
  getObjectBytes: async () => null,
}));
vi.mock("@/lib/whisper", async (orig) => ({
  ...(await orig<typeof import("@/lib/whisper")>()),
  transcribeWithWhisper: async () => ({ ok: false, error: "not_called", latency_ms: 0 }),
}));

const { runMeasureJob } = await import("@/lib/stt/measure-job");

const silent = () => {};
beforeEach(() => { calls.length = 0; responses = []; });

describe("§C — the nightly job now triggers the scorer", () => {
  it("a pass runs the scoring pass and reports its result", async () => {
    responses = [
      [],        // window scan: nothing to measure
      [],        // scorer: schema_migrations 72
      [],        // scorer: run/gold/family join
      [{ n: 0 }],// gold-without-run count
    ];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.scoring).toMatchObject({ pairs: 0, scored: 0, refused: 0 });
    // The decisive evidence: the scorer's own queries ran inside this pass.
    expect(calls.some((c) => c.text.includes("schema_migrations WHERE version = 72"))).toBe(true);
    expect(calls.some((c) => c.text.includes("LEFT JOIN stt_engine_family"))).toBe(true);
  });

  it("the scoring pass runs AFTER measurement, not before", async () => {
    responses = [[], [], [], [{ n: 0 }]];
    await runMeasureJob({ log: silent, skipFork: true });
    const measureScanAt = calls.findIndex((c) => c.text.includes("FROM bench_window w"));
    const scoreAt = calls.findIndex((c) => c.text.includes("schema_migrations WHERE version = 72"));
    expect(measureScanAt).toBeGreaterThan(-1);
    expect(scoreAt).toBeGreaterThan(measureScanAt);
  });

  it("it is idempotent across double runs — refusals ON CONFLICT DO NOTHING", async () => {
    const run = async () => {
      responses = [
        [],
        [{ applied_at: "2026-08-29T12:00:00.000Z" }],
        [{ id: "tr_1", engine: "sarvam", transcript_original: "x", receipt_complete: false,
           created_at: "2026-08-30T09:00:00.000Z", window_id: "bw_1", engine_family: "sarvam",
           reference_text: null, gold_status: null, seed_engine_family: null,
           covered_ms: null, window_ms: null, silence_spans_json: null }],
        [],          // the refusal insert
        [{ n: 0 }],
      ];
      calls.length = 0;
      return runMeasureJob({ log: silent, skipFork: true });
    };
    const first = await run();
    const second = await run();
    expect(first.scoring).toMatchObject({ refused: 1 });
    expect(second.scoring).toMatchObject({ refused: 1 });
    const insert = calls.find((c) => c.text.includes("INSERT INTO stt_score_refusal"))!;
    expect(insert.text).toContain("ON CONFLICT (window_id, engine_key, reason_code) DO NOTHING");
  });

  it("a scorer read failure produces NO score and NO refusal, and does not lose the measurements", async () => {
    responses = [
      [],
      [],
      new Error("relation stt_engine_family does not exist"),
      [{ n: 0 }],
    ];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(calls.some((c) => c.text.includes("INSERT INTO stt_score_refusal"))).toBe(false);
    expect(calls.some((c) => c.text.includes("INSERT INTO stt_window_score"))).toBe(false);
    expect(r.scoring).toMatchObject({ scored: 0, refused: 0 });
  });

  it("a gold row with no run is COUNTED, not silently dropped between the enumerations", async () => {
    responses = [[], [], [], [{ n: 3 }]];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.gold_without_run).toBe(3);
  });

  it("an unreadable orphan count is null, never 0", async () => {
    responses = [[], [], [], new Error("nope")];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.gold_without_run).toBeNull();
  });

  it("the caller can skip scoring without skipping measurement", async () => {
    responses = [[], [{ n: 0 }]];
    const r = await runMeasureJob({ log: silent, skipFork: true, skipScoring: true });
    expect(r.scoring).toEqual({ skipped: "skipped_by_caller" });
  });
});

// ---------------------------------------------------------------------------
// §5 amendment — Whisper's reported model
// ---------------------------------------------------------------------------

describe("the §5 amendment — engineVersion", () => {
  it("Whisper reports a model ONLY when the server sends one", () => {
    expect(reportedWhisperModel({ model: "ggml-large-v3-turbo" })).toBe("ggml-large-v3-turbo");
    expect(reportedWhisperModel({ model_name: "ggml-medium" })).toBe("ggml-medium");
    // The usual case: whisper.cpp sends text/language/duration/segments and no model at all.
    expect(reportedWhisperModel({ text: "hi", language: "english", duration: 3 })).toBeNull();
    expect(reportedWhisperModel({ model: "   " })).toBeNull();
    expect(reportedWhisperModel(null)).toBeNull();
  });

  it("the whisper client never falls back to the model named in its own header comment", () => {
    const src = codeOf("lib/whisper.ts");
    expect(src).not.toMatch(/reportedWhisperModel[\s\S]{0,200}ggml-large-v3-turbo/);
    expect(src).toContain("engineVersion: reportedWhisperModel(json)");
  });

  it("the field is OPTIONAL on the contract, so every existing adapter compiles unchanged", () => {
    const src = readFileSync("lib/stt/types.ts", "utf8");
    expect(src).toContain("engineVersion?: string | null;");
  });

  it("Whisper's model goes to metrics_json, NOT to engine_version_reported", () => {
    // engine_version_reported belongs to the engine the ROW NAMES — the paid one. Captioning a
    // Sarvam run with Whisper's version would be the typed-provider-label failure in a new hat.
    const drain = codeOf("lib/stt/room-drain.ts");
    expect(drain).toContain("whisper_model_reported: full.engineVersion ?? null");
    expect(drain).toContain("providerEngineVersion(asr)");
    expect(drain).not.toContain("engine_version_reported: full.engineVersion");
  });

  it("Sarvam still reports nothing — never typed", () => {
    const src = readFileSync("lib/stt/adapters/sarvam.ts", "utf8");
    expect(src).not.toContain("engineVersion");
  });
});

// ---------------------------------------------------------------------------
// §D — the gold read route
// ---------------------------------------------------------------------------

describe("§D — the gold window route", () => {
  const src = readFileSync("app/api/admin/stt-gold-window/route.ts", "utf8");
  // Comment-free, for the assertions about what the code DOES: the header explains why there is
  // no graduation control, and naming the thing it refuses to do must not fail that assertion.
  const code = codeOf("app/api/admin/stt-gold-window/route.ts");

  it("auth is exactly the Build 2 pattern: admin JWT or Bearer MIGRATION_SECRET", () => {
    const spend = readFileSync("app/api/admin/stt-spend/route.ts", "utf8");
    const fnOf = (s: string) => s.slice(s.indexOf("async function adminOrSecret"), s.indexOf("export const runtime") > 0 ? undefined : undefined);
    expect(src).toContain("MIGRATION_SECRET");
    expect(src).toContain("verifyAdminJwt");
    expect(src).toContain("readAdminCookie");
    // The same guard body as the sibling route, character for character.
    const guard = (s: string) => s.slice(s.indexOf("async function adminOrSecret"), s.indexOf("}\n\nexport"));
    expect(guard(src)).toBe(guard(spend));
    void fnOf;
  });

  it("no-auth is rejected before any read", () => {
    expect(src).toContain('return respondError("AUTH_REQUIRED"');
    const authAt = src.indexOf("AUTH_REQUIRED");
    const readAt = src.indexOf("FROM stt_gold_window");
    expect(authAt).toBeLessThan(readAt);
  });

  it("it is READ-ONLY — no write verb and no graduation control", () => {
    expect(code).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(code).not.toMatch(/UPDATE\s+stt_gold_window/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+stt_gold_window/i);
    // The only place 'graduated' may appear in executable code is as a READ of the status count.
    expect(code).not.toMatch(/status\s*=\s*'graduated'/);
  });

  it("reference_text is length-only by default and full only on ?full=1", () => {
    expect(src).toContain('searchParams.get("full") === "1"');
    expect(src).toContain("ref_chars");
    expect(src).toContain("...(full ? { reference_text: r.reference_text } : {})");
  });

  it("it returns every field the kickoff names", () => {
    for (const f of [
      "window_id", "status", "source", "seed_engine_family",
      "covered_ms", "window_ms", "ref_chars", "verified_by", "verified_at", "created_at",
    ]) {
      expect(src).toContain(f);
    }
  });

  it("the read fails safe to an empty list, never a 500", () => {
    expect(src).toContain("degraded to empty list");
    expect(src).toContain("catch (e)");
  });
});
