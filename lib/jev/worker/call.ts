/**
 * lib/jev/worker/call.ts — ONE subject, all its questions, every option order (PRD §3.5 steps 3-5).
 *
 *   breaker -> budget -> slot -> systemOne (one call per option order) -> ledger row -> breaker outcome -> decision rows.
 *
 * Every Choice that asks for both orders is sent forward AND reversed; the stored `derived` row is the order-AVERAGED distribution
 * (the row consumers read), with the flip noted in `evidence`. Every row stores prompt_version = `<set>@<version>+<order>`.
 * The client enforces ETA_JEV_ENABLED before any fetch; the mock's answers are marked mock=true and model 'jev-mock'.
 * A bench call writes its ledger row but NO decision rows (PRD §3.6). Text of the state or of an answer never leaves this
 * function except to the Jev client: rows hold closed codes, numbers, ids and an HMAC.
 */
import { parseFlag } from "@/lib/flags";
import { confidenceBand } from "../confidence";
import { getJevClient } from "../client";
import { noulConfidence } from "../confidence";
import type { JevAnswer, JevQuestion, JevResult } from "../types";
import { hashOf } from "./canonical";
import { breakerAdmit, recordOutcome } from "./breaker";
import { budgetCheck, costUsd, reservationUsd } from "./budget";
import { classifyCallError, policyOf, type ErrorClass } from "./errors";
import type { JevMode } from "./flags";
import { insertCall, newCallId, stateHmac, upsertDecisions, type CallRecord, type WorkerDecision } from "./persist";
import type { QuestionDef } from "./sets";
import { acquireSlot, releaseSlot } from "./slots";
import type { StateBuild } from "./uses";

export type SetRef = { id: string; version: string; sha: string; modelPin: string; use: string; subjectType: string; bands?: { act: number; caution: number } | null };
export type BenchRow = { subject_id: string; question_id: string; variant: string; kind: string; value: string | number; confidence: number | null };

export type AskOutcome =
  | { kind: "done"; decisions: number; calls: number; errorClass: null; bench: BenchRow[]; inputTokens: number }
  | { kind: "deferred"; why: "circuit_open" | "no_slot" | "budget_exceeded"; calls: number }
  | { kind: "failed"; errorClass: ErrorClass; retry: boolean; calls: number };

const ESCAPE_BAND = "abstain" as const;
const mockOn = (): boolean => parseFlag("ETA_JEV_MOCK");

const reverseOptions = (q: JevQuestion): JevQuestion =>
  q.type === "choice" ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).reverse()) } : q;
const optionOrderSha = (q: JevQuestion): string | null => (q.type === "choice" ? hashOf(Object.keys(q.criteria)) : null);
const questionChars = (qs: Record<string, JevQuestion>): number => JSON.stringify(qs).length;

function valueOf(a: JevAnswer): { value: string | number; confidence: number; probabilities: Record<string, number> | null } {
  if (a.type === "noul") return { value: a.noul, confidence: noulConfidence(a.noul), probabilities: null };
  if (a.type === "choice") return { value: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  return { value: a.score, confidence: a.confidence, probabilities: a.probabilities };
}

function validChoice(def: QuestionDef, a: JevAnswer): boolean {
  return a.type !== "choice" || Object.prototype.hasOwnProperty.call((def.body as { criteria: Record<string, unknown> }).criteria, a.choice);
}

/** Uncalibrated answers band `review`, or `abstain` on an escape option; only a question WITH a calibration may reach `act`/`caution` (PRD §6.3). */
function bandFor(def: QuestionDef, set: SetRef, a: JevAnswer, confidence: number, mock: boolean): WorkerDecision["band"] {
  if (a.type === "choice" && def.escape_options?.includes(a.choice)) return ESCAPE_BAND;
  if (mock || !def.calibration || def.calibration.method === "none") return "review";
  return confidenceBand(confidence, def.bands ?? set.bands ?? undefined);
}

export async function askSubject(input: {
  jobId: string | null; set: SetRef; defs: QuestionDef[]; mode: JevMode; subjectId: string; build: StateBuild | null; signal?: AbortSignal;
}): Promise<AskOutcome> {
  const { jobId, set, defs, mode, subjectId, build } = input;
  const mock = mockOn();
  const lane = build && "lane" in build ? build.lane : "text";
  const base = (): Omit<WorkerDecision, "questionId" | "orderVariant" | "answer" | "probabilities" | "confidence" | "band" | "outcome" | "optionOrderSha" | "promptVersion"> => ({
    subjectType: set.subjectType, subjectId, model: mock ? "jev-mock" : set.modelPin, setId: set.id, setVersion: set.version, setSha: set.sha, lane,
    callId: null, jobId, mode, latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null, evidence: {}, stateSha: null, mock,
  });
  const pv = (v: string) => `${set.id}@${set.version}+${v}`;

  // No builder output: the subject is no longer buildable. Recorded as no opinion, never a fabricated state.
  if (!build) return { kind: "done", decisions: 0, calls: 0, errorClass: null, bench: [], inputTokens: 0 };

  if ("tooLarge" in build) {
    const rows: WorkerDecision[] = defs.map((d) => ({ ...base(), questionId: d.question_id, orderVariant: "derived", promptVersion: pv("derived"), optionOrderSha: null, answer: { type: "none" }, probabilities: null, confidence: null, band: ESCAPE_BAND, outcome: "state_too_large", evidence: { state_bytes: build.bytes } }));
    if (mode !== "bench") await upsertDecisions(rows);
    return { kind: "done", decisions: mode === "bench" ? 0 : rows.length, calls: 0, errorClass: null, bench: [], inputTokens: 0 };
  }

  const stateBytes = JSON.stringify(build.state ?? null).length;
  const admit = await breakerAdmit(set.use);
  if (!admit.admit) return { kind: "deferred", why: "circuit_open", calls: 0 };

  // The question maps to send: forward always for forward/both, reversed for reversed/both. One call per order.
  const maps: Array<{ variant: "fwd" | "rev"; questions: Record<string, JevQuestion> }> = [];
  const fwd: Record<string, JevQuestion> = {};
  const rev: Record<string, JevQuestion> = {};
  for (const d of defs) {
    const order = d.option_order ?? "forward";
    if (order === "forward" || order === "both") fwd[d.question_id] = d.body;
    if (order === "reversed" || order === "both") rev[d.question_id] = reverseOptions(d.body);
  }
  if (Object.keys(fwd).length) maps.push({ variant: "fwd", questions: fwd });
  if (Object.keys(rev).length) maps.push({ variant: "rev", questions: rev });

  const reserve = maps.reduce((s, m) => s + reservationUsd(stateBytes, questionChars(m.questions)), 0);
  const budget = await budgetCheck(reserve);
  if (!budget.ok) return { kind: "deferred", why: "budget_exceeded", calls: 0 };

  const slot = await acquireSlot(jobId);
  if (!slot) return { kind: "deferred", why: "no_slot", calls: 0 };

  const stateSha = stateHmac(build.state);
  const results = new Map<"fwd" | "rev", { res: JevResult; callId: string }>();
  let calls = 0;
  let inputTokens = 0;
  try {
    for (const m of maps) {
      const callId = newCallId();
      const t0 = Date.now();
      const rec: CallRecord = {
        id: callId, jobId, use: set.use, mode, setSha: set.sha, subjectCount: 1, questionCount: Object.keys(m.questions).length, modelRequested: set.modelPin,
        modelReturned: null, httpStatus: null, errorClass: null, latencyMs: null, inputTokens: 0, outputTokens: 0, costUsd: 0, stateBytes, mock, breakerState: admit.state,
      };
      try {
        const res = await getJevClient().systemOne({ state: build.state, questions: m.questions, model: set.modelPin }, { signal: input.signal });
        calls += 1;
        rec.modelReturned = res.model; rec.latencyMs = res.latency_ms; rec.inputTokens = res.usage.input_tokens; rec.outputTokens = res.usage.output_tokens;
        rec.costUsd = mock ? 0 : costUsd(res.usage.input_tokens); inputTokens += res.usage.input_tokens;
        await insertCall(rec);
        await recordOutcome(set.use, { ok: true });
        results.set(m.variant, { res, callId });
      } catch (e) {
        calls += 1;
        const { cls, status } = classifyCallError(e, input.signal?.aborted === true);
        rec.errorClass = cls; rec.httpStatus = status ?? null; rec.latencyMs = Date.now() - t0;
        await insertCall(rec).catch(() => undefined);
        const pol = policyOf(cls);
        await recordOutcome(set.use, { ok: false, counts: pol.breaker, immediate: pol.immediate, cls }).catch(() => undefined);
        return { kind: "failed", errorClass: cls, retry: pol.retry, calls };
      }
    }
  } finally {
    await releaseSlot(slot).catch(() => undefined);
  }

  // ── decisions ────────────────────────────────────────────────────────────────────────────────────────────────
  const rows: WorkerDecision[] = [];
  const bench: BenchRow[] = [];
  const answered = new Map<string, Partial<Record<"fwd" | "rev", { a: JevAnswer; callId: string; model: string; tokens: number; latency: number }>>>();
  for (const d of defs) {
    for (const v of ["fwd", "rev"] as const) {
      const r = results.get(v);
      const sent = v === "fwd" ? fwd[d.question_id] : rev[d.question_id];
      if (!r || !sent) continue;
      const a = r.res.answers[d.question_id];
      const common = { ...base(), questionId: d.question_id, orderVariant: v, promptVersion: pv(v), optionOrderSha: optionOrderSha(sent), callId: r.callId, model: mock ? "jev-mock" : r.res.model, latencyMs: r.res.latency_ms, inputTokens: Math.round(r.res.usage.input_tokens / Object.keys(v === "fwd" ? fwd : rev).length), outputTokens: r.res.usage.output_tokens, costUsd: null, stateSha, evidence: { ...build.evidence } };
      if (!a) { rows.push({ ...common, answer: { type: "none" }, probabilities: null, confidence: null, band: ESCAPE_BAND, outcome: "no_answer" }); continue; }
      if (!validChoice(d, a)) { rows.push({ ...common, answer: { type: "rejected" }, probabilities: null, confidence: null, band: ESCAPE_BAND, outcome: "off_menu_rejected" }); continue; }
      const val = valueOf(a);
      rows.push({ ...common, answer: a, probabilities: val.probabilities, confidence: val.confidence, band: bandFor(d, set, a, val.confidence, mock), outcome: "answered" });
      const slotMap = answered.get(d.question_id) ?? {};
      slotMap[v] = { a, callId: r.callId, model: r.res.model, tokens: r.res.usage.input_tokens, latency: r.res.latency_ms };
      answered.set(d.question_id, slotMap);
      bench.push({ subject_id: subjectId, question_id: d.question_id, variant: v, kind: a.type, value: val.value, confidence: val.confidence });
    }
  }

  // derived: the order-averaged row consumers read (a single-order question's derived row is its one answer).
  const derivedAnswer = new Map<string, JevAnswer>();
  for (const d of defs) {
    const got = answered.get(d.question_id);
    if (!got || (!got.fwd && !got.rev)) {
      rows.push({ ...base(), questionId: d.question_id, orderVariant: "derived", promptVersion: pv("derived"), optionOrderSha: null, answer: { type: "none" }, probabilities: null, confidence: null, band: ESCAPE_BAND, outcome: "no_answer", stateSha, evidence: { ...build.evidence } });
      continue;
    }
    const pair = [got.fwd, got.rev].filter((x): x is NonNullable<typeof x> => Boolean(x));
    let derived: JevAnswer = pair[0]!.a;
    let flip = false;
    if (pair.length === 2 && pair[0]!.a.type === "choice" && pair[1]!.a.type === "choice") {
      const [p, q] = [pair[0]!.a as Extract<JevAnswer, { type: "choice" }>, pair[1]!.a as Extract<JevAnswer, { type: "choice" }>];
      const keys = Object.keys((d.body as { criteria: Record<string, unknown> }).criteria);
      const avg: Record<string, number> = {};
      for (const k of keys) avg[k] = ((p.probabilities[k] ?? 0) + (q.probabilities[k] ?? 0)) / 2;
      const top = keys.reduce((b, k) => (avg[k]! > avg[b]! ? k : b), keys[0]!);
      flip = p.choice !== q.choice;
      derived = { type: "choice", choice: top, probabilities: avg, confidence: avg[top]! };
    } else if (pair.length === 2 && pair[0]!.a.type === "score" && pair[1]!.a.type === "score") {
      const [p, q] = [pair[0]!.a as Extract<JevAnswer, { type: "score" }>, pair[1]!.a as Extract<JevAnswer, { type: "score" }>];
      derived = { ...p, confidence: (p.confidence + q.confidence) / 2 };
      flip = p.score !== q.score;
    }
    derivedAnswer.set(d.question_id, derived);
    const val = valueOf(derived);
    const first = pair[0]!;
    rows.push({ ...base(), questionId: d.question_id, orderVariant: "derived", promptVersion: pv("derived"), optionOrderSha: null, model: mock ? "jev-mock" : first.model, callId: first.callId, latencyMs: first.latency,
      answer: derived, probabilities: val.probabilities, confidence: val.confidence, band: bandFor(d, set, derived, val.confidence, mock), outcome: "answered", stateSha, evidence: { ...build.evidence, order_flip: flip } });
    bench.push({ subject_id: subjectId, question_id: d.question_id, variant: "derived", kind: derived.type, value: val.value, confidence: val.confidence });
  }

  // gates: a dependent question's derived answer is OVERWRITTEN in code when its gate says no; the raw answer is kept on the row.
  for (const d of defs) {
    if (!d.gate_question_id) continue;
    const g = derivedAnswer.get(d.gate_question_id);
    const gateDef = defs.find((x) => x.question_id === d.gate_question_id);
    const closed = g?.type === "noul" ? g.noul < 0.5 : g?.type === "choice" ? Boolean(gateDef?.escape_options?.includes(g.choice)) : false;
    if (!closed) continue;
    const row = rows.find((r) => r.questionId === d.question_id && r.orderVariant === "derived");
    if (row && row.outcome === "answered") { row.outcome = "gated_overwritten"; row.band = ESCAPE_BAND; row.evidence = { ...row.evidence, gate: d.gate_question_id }; }
  }

  let written = 0;
  if (mode !== "bench") written = await upsertDecisions(rows);
  return { kind: "done", decisions: written, calls, errorClass: null, bench, inputTokens };
}
