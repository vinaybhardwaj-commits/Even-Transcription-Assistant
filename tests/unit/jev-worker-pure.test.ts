/**
 * Jev worker P1 — the PURE parts: the canonical hash, set validation, the flag gate, the error taxonomy, the breaker, drift maths, budget maths.
 * No database, no network, no Jev (the client is never reached).
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { canonicalJson, hashOf } from "@/lib/jev/worker/canonical";
import { JEV_MODEL_PIN, promptVersionOf, setSha, validateSetFile, QuestionSetError, type QuestionSetFile } from "@/lib/jev/worker/sets";
import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { anyLiveFlagOn, assertMockFallbackSane, modeGate, REAL_USES, USE_FLAG, USE_LIVE_FLAG } from "@/lib/jev/worker/flags";
import { classifyCallError, classifyDbError, policyOf, ERROR_CLASSES } from "@/lib/jev/worker/errors";
import { applyOutcome, freshBreaker, isDue, BREAKER_WAIT_MS, BREAKER_WAIT_CAP_MS } from "@/lib/jev/worker/breaker";
import { driftAlerts, psi } from "@/lib/jev/worker/drift";
import { costUsd, judgeBudget, reservationUsd } from "@/lib/jev/worker/budget";
import { JevBadResponseError, JevDisabledError, JevHttpError, JevMissingKeyError, JevStateTooLargeError } from "@/lib/jev/types";

const smoke = (): QuestionSetFile => JSON.parse(JSON.stringify(QUESTION_SET_FILES[0])) as QuestionSetFile;

// A small deterministic shuffle: the same permutation every run.
function shuffled<T>(a: T[], seed: number): T[] {
  const out = [...a]; let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}
const reorderKeys = (v: unknown, seed: number): unknown => {
  if (Array.isArray(v)) return v.map((x) => reorderKeys(x, seed + 1));
  if (v && typeof v === "object") return Object.fromEntries(shuffled(Object.entries(v as Record<string, unknown>), seed).map(([k, x]) => [k, reorderKeys(x, seed + 3)]));
  return v;
};

describe("P1.2 — the canonical hash", () => {
  it("is stable across key order and whitespace (30 permutations)", () => {
    const base = setSha(smoke());
    for (let seed = 1; seed <= 30; seed += 1) {
      const permuted = reorderKeys(smoke(), seed) as QuestionSetFile;
      // question criteria are ORDER-significant, so keep their order; everything else may permute
      const re = JSON.parse(JSON.stringify(permuted, null, seed % 3 === 0 ? 4 : 0)) as QuestionSetFile;
      re.questions.forEach((q, i) => { q.body = smoke().questions[i]!.body; });
      expect(setSha(re), `seed ${seed}`).toBe(base);
    }
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("changes with one character of wording, and with an option's position", () => {
    const base = setSha(smoke());
    const a = smoke(); (a.questions[0]!.body as { instructions: string }).instructions += "."; expect(setSha(a)).not.toBe(base);
    const b = smoke(); const crit = (b.questions[1]!.body as { criteria: Record<string, string> }).criteria;
    (b.questions[1]!.body as { criteria: Record<string, string> }).criteria = Object.fromEntries(Object.entries(crit).reverse());
    expect(setSha(b), "option ORDER is part of the hash").not.toBe(base);
    const c = smoke(); c.version = "v1"; expect(setSha(c)).not.toBe(base);
  });

  it("validation refuses what CAA's build-time checks refuse", () => {
    const bad = (mut: (f: QuestionSetFile) => void) => { const f = smoke(); mut(f); return () => validateSetFile(f); };
    expect(bad((f) => { f.model_pin = "jev-latest"; })).toThrow(QuestionSetError);
    expect(bad((f) => { f.questions[1]!.escape_options = []; })).toThrow(/escape_options/);
    expect(bad((f) => { f.questions[1]!.escape_options = ["nope"]; })).toThrow(/escape option/);
    expect(bad((f) => { f.questions[0]!.question_id = "Bad Id"; })).toThrow(/question_id/);
    expect(bad((f) => { f.questions[0]!.gate_question_id = "ghost"; })).toThrow(/gate_question_id/);
    expect(bad((f) => { f.questions[0]!.option_order = "both"; })).toThrow(/only a choice/);
    expect(bad((f) => { f.use = "legacy" as never; })).toThrow(/use/);
    expect(validateSetFile(smoke()).model_pin).toBe(JEV_MODEL_PIN);
  });

  it("every question-set file under jev/question-sets is listed in the index, and every listed file validates", () => {
    const onDisk = readdirSync("jev/question-sets", { recursive: true }).map(String).filter((f) => f.endsWith(".json")).sort();
    const listed = QUESTION_SET_FILES.map((f) => { const x = validateSetFile(f); return `${x.id}/${x.version}.json`; }).sort();
    expect(onDisk.map((f) => f.replace(/\\/g, "/"))).toEqual(listed);
  });

  it("the prompt_version stored carries the set, its version and the option order", () => {
    expect(promptVersionOf({ id: "smoke", version: "v0" }, "fwd")).toBe("smoke@v0+fwd");
    expect(promptVersionOf({ id: "smoke", version: "v0" }, "derived")).toBe("smoke@v0+derived");
  });
});

describe("P1.5 / §7 — the flag gate (every flag default OFF)", () => {
  afterEach(() => { for (const k of ["JEV_WORKER_ENABLED", "ETA_JEV_TEXT_LANE", "JEV_MOCK_FALLBACK", ...Object.values(USE_FLAG), ...Object.values(USE_LIVE_FLAG)]) delete process.env[k]; });

  it("with nothing set, no use can run in any mode", () => {
    for (const u of REAL_USES) for (const m of ["bench", "shadow", "live"] as const) expect(modeGate(u, m)).toEqual({ ok: false, reason: "worker_disabled" });
  });
  it("the master switch alone runs a NO-TEXT use in bench only; shadow needs the use's flag; live needs its live flag", () => {
    process.env.JEV_WORKER_ENABLED = "1";
    expect(modeGate("encounter_timeline", "bench")).toEqual({ ok: true });
    expect(modeGate("encounter_timeline", "shadow")).toEqual({ ok: false, reason: "use_flag_off" });
    process.env.JEV_USE_ENCOUNTER_TIMELINE = "1";
    expect(modeGate("encounter_timeline", "shadow")).toEqual({ ok: true });
    expect(modeGate("encounter_timeline", "live")).toEqual({ ok: false, reason: "live_flag_off" });
    process.env.JEV_ENCOUNTER_TIMELINE_LIVE = "1";
    expect(modeGate("encounter_timeline", "live")).toEqual({ ok: true });
  });
  it("a text use also needs the text-lane switch, in every mode", () => {
    process.env.JEV_WORKER_ENABLED = "1"; process.env.JEV_USE_STT_QUALITY = "1";
    for (const m of ["bench", "shadow"] as const) expect(modeGate("stt_quality", m)).toEqual({ ok: false, reason: "text_lane_off" });
    process.env.ETA_JEV_TEXT_LANE = "1";
    expect(modeGate("stt_quality", "shadow")).toEqual({ ok: true });
  });
  it("a typo in a flag THROWS rather than reading as off", () => {
    process.env.JEV_WORKER_ENABLED = "yess";
    expect(() => modeGate("stt_quality", "bench")).toThrow(/unrecognised/);
  });
  it("JEV_MOCK_FALLBACK is forbidden while any JEV_*_LIVE is on", () => {
    process.env.JEV_MOCK_FALLBACK = "1";
    expect(() => assertMockFallbackSane()).not.toThrow();
    process.env.JEV_STT_QUALITY_LIVE = "1";
    expect(anyLiveFlagOn()).toBe(true);
    expect(() => assertMockFallbackSane()).toThrow(/forbidden/);
  });
});

describe("§9.1 — the typed error taxonomy (fault injection, one per class)", () => {
  const httpErr = (s: number) => new JevHttpError(s, "{}");
  const cases: Array<[string, unknown, string, boolean]> = [   // [expected class, thrown, ..., aborted?]
    ["disabled", new JevDisabledError(), "disabled", false],
    ["config_missing_key", new JevMissingKeyError(), "config_missing_key", false],
    ["auth", httpErr(401), "auth", false], ["auth", httpErr(403), "auth", false],
    ["schema_rejected", httpErr(422), "schema_rejected", false],
    ["rate_limited", httpErr(429), "rate_limited", false],
    ["overloaded", httpErr(529), "overloaded", false], ["overloaded", httpErr(503), "overloaded", false],
    ["provider_error", httpErr(500), "provider_error", false],
    ["bad_response", new JevBadResponseError(), "bad_response", false],
    ["state_too_large", new JevStateTooLargeError(200_000), "state_too_large", false],
    ["timeout", Object.assign(new Error("x"), { name: "AbortError" }), "timeout", false],
    ["aborted", Object.assign(new Error("x"), { name: "AbortError" }), "aborted", true],
    ["db_error:42501", Object.assign(new Error("permission denied for table jev_decision"), { code: "42501" }), "db_error:42501", false],
    ["provider_error", new TypeError("fetch failed"), "provider_error", false],
  ];
  it.each(cases)("%s", (_n, thrown, expected, aborted) => {
    expect(classifyCallError(thrown, aborted).cls).toBe(expected);
  });
  it("retry and breaker policy match the table", () => {
    for (const c of ["auth", "schema_rejected", "disabled", "config_missing_key", "state_too_large", "off_menu", "no_answer", "budget_exceeded", "circuit_open", "set_not_allowed"] as const) expect(policyOf(c).retry, c).toBe(false);
    for (const c of ["rate_limited", "overloaded", "provider_error", "timeout", "aborted", "bad_response", "persist_failed", "db_error:42501"] as const) expect(policyOf(c).retry, c).toBe(true);
    for (const c of ["auth", "rate_limited", "overloaded", "provider_error", "timeout", "bad_response"] as const) expect(policyOf(c).breaker, c).toBe(true);
    for (const c of ["schema_rejected", "aborted", "off_menu", "state_too_large", "persist_failed", "db_error:23505", "config_missing_key"] as const) expect(policyOf(c).breaker, c).toBe(false);
    expect(policyOf("auth").immediate).toBe(true);
    expect(ERROR_CLASSES.length).toBe(17);
  });
  it("a database fault is never a Jev fault", () => {
    expect(classifyDbError(Object.assign(new Error("x"), { code: "23505" }))).toBe("db_error:23505");
    expect(classifyDbError(new Error("boom"))).toBe("persist_failed");
  });
});

describe("§9.2 — the circuit breaker (pure transitions)", () => {
  const t0 = new Date("2026-10-10T10:00:00Z");
  const fail = { ok: false as const, counts: true, cls: "timeout" };
  it("opens on the 5th consecutive counted failure, not the 4th", () => {
    let r = freshBreaker("stt_quality");
    for (let i = 0; i < 4; i += 1) r = applyOutcome(r, fail, t0);
    expect(r.state).toBe("closed");
    r = applyOutcome(r, fail, t0);
    expect(r.state).toBe("open");
    expect(r.reason_class).toBe("timeout");
  });
  it("a success resets the streak; a refusal that is not counted changes nothing", () => {
    let r = freshBreaker("u");
    for (let i = 0; i < 4; i += 1) r = applyOutcome(r, fail, t0);
    r = applyOutcome(r, { ok: true }, t0);
    expect(r.consecutive_failures).toBe(0);
    const same = applyOutcome(r, { ok: false, counts: false, cls: "schema_rejected" }, t0);
    expect(same).toBe(r);
  });
  it("auth opens it at once", () => {
    expect(applyOutcome(freshBreaker("u"), { ok: false, counts: true, immediate: true, cls: "auth" }, t0).state).toBe("open");
  });
  it("opens on an error rate >= 50% over the last 20 calls even without 5 in a row", () => {
    let r = freshBreaker("u");
    for (let i = 0; i < 20; i += 1) r = applyOutcome(r, i % 2 === 1 ? fail : { ok: true }, t0);   // alternating, ending on a failure: 10/20 = 50%
    expect(r.consecutive_failures).toBeLessThan(5);
    expect(r.state).toBe("open");
  });
  it("is due after the wait; the half-open probe closes it on success and re-opens it with the wait DOUBLED on failure, capped at 2 h", () => {
    let r = applyOutcome({ ...freshBreaker("u"), consecutive_failures: 4 }, fail, t0);
    expect(isDue(r, new Date(t0.getTime() + BREAKER_WAIT_MS - 1))).toBe(false);
    expect(isDue(r, new Date(t0.getTime() + BREAKER_WAIT_MS))).toBe(true);
    const probe = { ...r, state: "half_open" as const };
    expect(applyOutcome(probe, { ok: true }, t0)).toMatchObject({ state: "closed", wait_ms: BREAKER_WAIT_MS, opened_at: null });
    let w = applyOutcome(probe, fail, t0);
    expect(w).toMatchObject({ state: "open", wait_ms: BREAKER_WAIT_MS * 2 });
    for (let i = 0; i < 6; i += 1) w = applyOutcome({ ...w, state: "half_open" }, fail, t0);
    expect(w.wait_ms).toBe(BREAKER_WAIT_CAP_MS);
  });
});

describe("§6.4 — drift maths", () => {
  it("psi is 0 for identical distributions, large for a flip, and 0 when either side is empty", () => {
    expect(psi({ a: 50, b: 50 }, { a: 50, b: 50 })).toBe(0);
    expect(psi({ a: 90, b: 10 }, { a: 10, b: 90 })).toBeGreaterThan(0.2);
    expect(psi({}, { a: 5 })).toBe(0);
    expect(psi({ a: 5 }, { b: 5 })).toBeGreaterThan(0.2);
  });
  it("a model-string change raises an alert (fixture)", () => {
    expect(driftAlerts({ psi: 0.01, models_returned: ["jev-1.13.0"], model_pin: "jev-1.13.0" })).toEqual([]);
    expect(driftAlerts({ psi: 0.01, models_returned: ["jev-1.14.0"], model_pin: "jev-1.13.0" })).toEqual(["model_changed:jev-1.14.0"]);
    expect(driftAlerts({ psi: 0.5, models_returned: [], model_pin: "jev-1.13.0" })).toEqual(["psi_high"]);
  });
});

describe("§10 — budget maths", () => {
  it("prices input tokens at $0.042 per M, output free", () => {
    expect(costUsd(1_000_000)).toBe(0.042);
    expect(reservationUsd(4000, 0)).toBe(costUsd(1000));
  });
  it("judges spent + reservation against the cap, and warns past the soft line", () => {
    const over = judgeBudget(4.99, 0.02, 5, 2);
    expect(over.ok).toBe(false);
    expect(over.left).toBeCloseTo(0.01, 6);
    expect(judgeBudget(1.0, 0.5, 5, 2)).toMatchObject({ ok: true, soft_exceeded: false });
    expect(judgeBudget(1.9, 0.2, 5, 2)).toMatchObject({ ok: true, soft_exceeded: true });
  });
});

describe("§9.5 — never block capture or STT", () => {
  it("no capture, upload, chunk, STT or note route imports the WORKER (lib/jev/worker): its nudge is the only way in and it is fire-and-forget", () => {
    const files = [
      "app/api/bench/chunks/route.ts", "app/api/bench/sessions/route.ts", "app/[slug]/api/encounters/[id]/process/route.ts",
      "lib/stt/fanout.ts", "lib/stt/room-drain.ts", "lib/stt/join-only.ts", "lib/diarize.ts",
    ];
    for (const f of files) {
      let src = "";
      try { src = readFileSync(f, "utf8"); } catch { continue; }
      expect(src, f).not.toMatch(/from\s+["']@\/lib\/jev\/worker/);
    }
  });
});
