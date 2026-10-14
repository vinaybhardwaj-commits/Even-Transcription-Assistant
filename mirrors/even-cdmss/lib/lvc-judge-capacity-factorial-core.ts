/**
 * lib/lvc-judge-capacity-factorial-core.ts — the PURE core of the LVC judge capacity factorial.
 * CDMSS-LVC-JUDGE-CAPACITY-FACTORIAL-PRD-v3.0-11-AUG-2026, §3 and §4.1.
 *
 * MEASUREMENT ONLY. Nothing here is imported by a production module, nothing here decides a
 * verdict, and nothing here changes a request path. It exists so that the one thing this
 * experiment can get catastrophically wrong — sending a wire format the endpoint silently
 * ignores — is decided by unit-tested pure functions rather than by the runner's good intentions.
 *
 * ── WHY THE WIRE FORMAT IS THE WHOLE POINT (PRD §1) ─────────────────────────────────────────────
 * PRD v2.0 specified `reasoning: { max_tokens }` for the capped arms. That is the OpenRouter
 * dialect. Direct Vertex ignores it (lib/trace.ts:152-165 records the SL0 dose-response that
 * established this), so arms B and D would have been byte-equivalent to A and C and the thinking
 * factor would have returned a clean null that meant nothing. The ONLY honoured form on this
 * endpoint is a TOP-LEVEL `google.thinking_config.thinking_budget` — lib/trace.ts:528 and the
 * production precedent at lib/opd-note-audit.ts:1092. `realizedArmFromSerializedBody` therefore
 * reads the arm back off the bytes that actually left the process, never off the intent object.
 *
 * ── NO INPUT, NO OUTPUT ─────────────────────────────────────────────────────────────────────────
 * No fs, no net, no process.env, no Date.now, no randomness. `node:crypto`'s createHash is
 * computation, not I/O, and is the only host import. Every value that could vary by environment
 * is a preregistered literal below (PRD §3.1, D-37): a budget read from the environment is not a
 * preregistered arm, it is an unrecorded one.
 *
 * ── NO CLINICAL TEXT, NO IDENTIFIERS, NO SECRETS LEAVE THIS MODULE ──────────────────────────────
 * Every diagnostic this module returns is a COUNT or a CODE. `evaluateCompleteness` never returns
 * a recommendation id, a `why` string or a fragment of a response body, because its results are
 * printed, asserted in tests and summarised into reports. The frozen ids live in the private
 * frozen-input artifact and are passed IN; they are never passed back out.
 *
 * ⚠️ DELIBERATELY NO `*_VERSION` EXPORT. lib/architecture/manifests.ts is a tracked production
 * file and this build may not edit it (PRD §4.1). A top-level lib/*.ts becomes a coverage-rule
 * subsystem the moment it exports an UPPER_SNAKE `*_VERSION*` const (scripts/lib/import-scan.mjs
 * `VERSION_EXPORT_RE`), which would then require a manifest or an UNREGISTERED entry. The
 * protocol's identity is `PROTOCOL_ID` instead. Do not rename it to carry `_VERSION`.
 */

import { createHash } from 'node:crypto';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. PREREGISTERED CONSTANTS (PRD §3.1, §3.3, D-33, D-37, D-38)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Protocol identity, stamped into the manifest. Not a version constant — see the header note. */
export const PROTOCOL_ID = 'lvc-judge-capacity-factorial/v1';

/** D-38. The reference the worktree is checked out at. The dirty main tree is NOT the reference. */
export const REFERENCE_SHA = '81b7c93a8e5e0323a47a3f893fd4b0e96aaa421a';

/** The deployed judge's CALLER-side `max_tokens` at REFERENCE_SHA (lib/lvc.ts:489, literal 900). */
export const REFERENCE_CALLER_MAX_TOKENS = 900;

/** What lib/trace.ts's Vertex branch adds to the caller's value before dispatch (`baseMax + 8192`). */
export const VERTEX_THINKING_HEADROOM = 8192;

/**
 * D-33. The runner is a raw SDK call: it BYPASSES lib/trace.ts, so it must send the final wire
 * value itself. These are the two capacity levels, asserted at runtime before every dispatch.
 */
export const WIRE_MAX_TOKENS_CONTROL = REFERENCE_CALLER_MAX_TOKENS + VERTEX_THINKING_HEADROOM; // 9_092
export const WIRE_MAX_TOKENS_HIGH = 16_384;

/**
 * D-37. The thinking cap is a preregistered LITERAL. Never `AUDIT_EVAL_THINKING_BUDGET` (which
 * reads the environment at module load and defaults to 4,096), never `LLM_THINKING_BUDGET`.
 * NB gemini-2.5-pro rejects a budget of 0 with HTTP 400 and treats -1 as "dynamic" (uncapped);
 * 2,048 is a real cap on the SL0 dose-response curve (2048 → ~1,509 actual reasoning tokens).
 */
export const THINKING_BUDGET = 2_048;

/** PRD §3.1 — held constant across every call. The normalized name is applied by the runner. */
export const JUDGE_MODEL = 'gemini-2.5-pro';

/** PRD §3.1 — "one timeout for all arms of at least 240 seconds". One value, every arm. */
export const MIN_TIMEOUT_MS = 240_000;
export const TIMEOUT_MS = 300_000;

/** PRD §4.2 — the only root any artifact may be written under, relative to the repo root. */
export const PRIVATE_ROOT = '.corpus-eval/lvc-judge-capacity-factorial/v1';

/**
 * PRD §3.3 — "One item V must confirm before execution: that `LLM_THINKING_BUDGET` is absent or
 * empty in the Vercel production environment. If it was set, the deployed judge was capped and arm
 * A does not reproduce it. This cannot be read from the repository."
 *
 * V CONFIRMED on 11 August 2026 that it has NEVER been set in production, at any point. Arm A
 * therefore reproduces an UNCAPPED deployed judge, which is what makes the thinking factor a real
 * contrast rather than a comparison of two capped configurations.
 *
 * Recorded as a preregistered literal, not a value typed at the command line: a fact that decides
 * whether the control arm is the control must not depend on what someone remembered to pass, and a
 * later re-freeze must not be able to silently regress it to "unconfirmed". The date travels with
 * the claim so a reader can tell when it was made and against which environment.
 */
export const REFERENCE_ENV_GLOBAL_THINKING_BUDGET = 'confirmed_absent';
export const REFERENCE_ENV_CONFIRMED_ON = '2026-08-11';

/** PRD §3.2 — two cycles of four blocks of four. */
export const CYCLES = 2;
export const CALLS_PER_CYCLE = 16;
export const TOTAL_SCHEDULED_CALLS = CYCLES * CALLS_PER_CYCLE;

export type ArmId = 'A' | 'B' | 'C' | 'D';

export const ARM_IDS: readonly ArmId[] = ['A', 'B', 'C', 'D'] as const;

/**
 * PRD §3.2. Each arm appears once per block and once in each position, so a drift in provider
 * behaviour over the run cannot land preferentially on one arm.
 */
export const SCHEDULE_BLOCKS: readonly (readonly ArmId[])[] = [
  ['A', 'B', 'D', 'C'],
  ['B', 'C', 'A', 'D'],
  ['C', 'D', 'B', 'A'],
  ['D', 'A', 'C', 'B'],
] as const;

/**
 * PRD §3.5 — `provider_usable` needs the set production actually accepts, so the result can never
 * imply production would have served a body it would in fact refuse.
 *
 * FROZEN COPY of `USABLE_FINISH_REASONS` in lib/provider-error-core.ts:79, plus that module's
 * documented null rule: `classifyProviderResponse` deliberately does NOT treat an ABSENT
 * finish_reason as a defect when content is present ("content is the real signal, and some
 * providers omit the field"). `raw_complete` already implies content, so absent ⇒ accepted here
 * too. Copied rather than imported so a later production change cannot silently redefine a
 * preregistered endpoint mid-experiment.
 */
export const PRODUCTION_ACCEPTED_FINISH_REASONS: readonly string[] = ['stop', 'tool_calls', 'function_call'] as const;

/**
 * PRD §4.2 — "only an allowlist of non-secret response headers is kept". Everything else is
 * dropped, counted, and never written. Deliberately excludes every `set-cookie`, `authorization`,
 * `x-goog-*` quota/identity and trace-correlation header.
 */
export const RESPONSE_HEADER_ALLOWLIST: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'date',
  'server',
  'vary',
] as const;

/** PRD §4.5 — exactly one of these closes a run. Anything else in terminal position is invalid. */
export const JOURNAL_TERMINAL_EVENTS: readonly string[] = [
  'completed', 'http_error', 'timeout', 'network_error', 'parse_error', 'outcome_unknown',
] as const;

/** Keys whose VALUES are replaced wholesale by `redactValue`. Matched case-insensitively. */
const SECRET_KEY_RE =
  /(authorization|auth[-_]?token|api[-_]?key|apikey|access[-_]?token|id[-_]?token|refresh[-_]?token|bearer|secret|credential|password|passwd|private[-_]?key|sa[-_]?key|session[-_]?id|cookie|signature)/i;

export const REDACTED = '[REDACTED]';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. CANONICAL HASHING (PRD §3.4)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Recursively sort object keys; preserve array order. The unit test pins that key INSERTION order
 * cannot change a hash — otherwise "the input did not change between arms" is unprovable, since
 * two structurally identical manifests written by different code paths would hash differently.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

/** Canonical JSON: sorted keys, array order preserved, UTF-8, NO trailing newline. */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJsonString(value));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE FROZEN INPUT (PRD §3.4)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface FrozenMessage { role: 'system' | 'user'; content: string }

/**
 * Everything frozen before the first study call. The runner replays `messages` byte-for-byte on
 * every arm — it never re-runs candidate extraction, recall, recommendation loading, prompt
 * rendering or retrieval between arms, because any of those would make the arms different
 * questions rather than the same question asked four ways.
 */
export interface FrozenInput {
  protocol: string;
  reference_sha: string;
  /** Opaque local case reference. Never printed; lives only in the private artifact. */
  case_ref: string;
  model: string;
  messages: FrozenMessage[];
  /** Ordered expected recommendation identifiers — the completeness contract's key set. */
  expected_ids: string[];
  expected_count: number;
  hashes: FrozenInputHashes;
}

export interface FrozenInputHashes {
  system_message: string;
  user_message: string;
  message_array: string;
  recommendation_snapshot: string;
}

/** The four hashes of PRD §3.4, computed from the frozen bytes alone. */
export function frozenInputHashes(
  messages: FrozenMessage[],
  recommendationSnapshot: unknown,
): FrozenInputHashes {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  return {
    system_message: sha256Hex(system),
    user_message: sha256Hex(user),
    message_array: hashCanonicalJson(messages),
    recommendation_snapshot: hashCanonicalJson(recommendationSnapshot),
  };
}

/** Structural validation only — never echoes content. Returns violation CODES. */
export function validateFrozenInput(fi: FrozenInput): string[] {
  const v: string[] = [];
  if (fi.protocol !== PROTOCOL_ID) v.push('frozen_protocol_mismatch');
  if (fi.reference_sha !== REFERENCE_SHA) v.push('frozen_reference_sha_mismatch');
  if (fi.model !== JUDGE_MODEL) v.push('frozen_model_mismatch');
  if (!Array.isArray(fi.messages) || fi.messages.length !== 2) v.push('frozen_message_count');
  else {
    if (fi.messages[0]?.role !== 'system' || !fi.messages[0]?.content) v.push('frozen_system_message');
    if (fi.messages[1]?.role !== 'user' || !fi.messages[1]?.content) v.push('frozen_user_message');
  }
  if (!Array.isArray(fi.expected_ids) || fi.expected_ids.length === 0) v.push('frozen_expected_ids_empty');
  else {
    if (new Set(fi.expected_ids).size !== fi.expected_ids.length) v.push('frozen_expected_ids_duplicated');
    if (fi.expected_ids.some((id) => typeof id !== 'string' || !id)) v.push('frozen_expected_ids_malformed');
  }
  if (fi.expected_count !== (fi.expected_ids?.length ?? -1)) v.push('frozen_expected_count_mismatch');
  const h = frozenInputHashes(fi.messages ?? [], null);
  if (fi.hashes?.system_message !== h.system_message) v.push('frozen_system_hash_mismatch');
  if (fi.hashes?.user_message !== h.user_message) v.push('frozen_user_hash_mismatch');
  if (fi.hashes?.message_array !== h.message_array) v.push('frozen_message_array_hash_mismatch');
  if (!fi.hashes?.recommendation_snapshot) v.push('frozen_recommendation_hash_absent');
  return v;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. ARM CONSTRUCTION (PRD §3.1, §5 "Arm construction")
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface ArmSpec {
  arm: ArmId;
  /** The FINAL wire value. lib/trace.ts's `+ 8192` is bypassed, so nothing adds to this. */
  maxTokens: number;
  /** null ⇒ the `google` field is omitted ENTIRELY (not present-and-empty). */
  thinkingBudget: number | null;
}

const ARM_SPECS: Readonly<Record<ArmId, ArmSpec>> = {
  A: { arm: 'A', maxTokens: WIRE_MAX_TOKENS_CONTROL, thinkingBudget: null },
  B: { arm: 'B', maxTokens: WIRE_MAX_TOKENS_CONTROL, thinkingBudget: THINKING_BUDGET },
  C: { arm: 'C', maxTokens: WIRE_MAX_TOKENS_HIGH, thinkingBudget: null },
  D: { arm: 'D', maxTokens: WIRE_MAX_TOKENS_HIGH, thinkingBudget: THINKING_BUDGET },
};

export function armSpec(arm: ArmId): ArmSpec {
  const s = ARM_SPECS[arm];
  if (!s) throw new Error(`unknown arm: ${String(arm)}`);
  return { ...s };
}

export interface ArmRequestInput {
  /** Already publisher-prefixed by the runner via lib/llm.ts `vertexModelName`. */
  wireModel: string;
  messages: FrozenMessage[];
  seed: number;
}

/**
 * The request body, and nothing else. Arms A and C omit BOTH `google` and `reasoning`; arms B and
 * D carry exactly one top-level `google.thinking_config.thinking_budget` and no `reasoning`.
 *
 * `reasoning` is never constructed on ANY path in this file — the OpenRouter dialect has no
 * legitimate use here, and the surest way not to send it is not to have code that can.
 *
 * ── WHY EXACTLY THESE SIX KEYS, IN THIS ORDER ───────────────────────────────────────────────────
 * Arm A must reproduce the deployed judge at REFERENCE_SHA *on the wire*. That judge's params
 * (lib/lvc.ts:493-507 at the reference) carry `options` and `keep_alive`, which lib/trace.ts's
 * Vertex branch STRIPS before dispatch, and `model`/`max_tokens`, which it overwrites in place.
 * What actually leaves the process is { model, messages, temperature, seed, top_p, max_tokens }
 * in that key order, with `google` appended last when a budget is set. There is no `stream` key:
 * non-streaming is the ABSENCE of the field, not `stream: false`, and adding it would make arm A
 * a fifth configuration rather than the control.
 */
export function buildArmRequest(arm: ArmId, input: ArmRequestInput): Record<string, unknown> {
  const spec = armSpec(arm);
  const body: Record<string, unknown> = {
    model: input.wireModel,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: 0,
    seed: input.seed,
    top_p: 1,
    max_tokens: spec.maxTokens,
  };
  if (spec.thinkingBudget !== null) {
    body.google = { thinking_config: { thinking_budget: spec.thinkingBudget } };
  }
  return body;
}

/** The keys every arm carries. Anything outside this ∪ {google} invalidates the body. */
const ALLOWED_BODY_KEYS: readonly string[] = ['model', 'messages', 'temperature', 'seed', 'top_p', 'max_tokens'];

/**
 * Keys that must NEVER appear: the OpenRouter dialect (`reasoning`, `reasoning_effort`), the two
 * forms SL0 measured as SILENT no-ops on this endpoint (`generationConfig`, `extra_body`), a
 * `thinking_config` hoisted to the top level instead of nested under `google`, and `stream` —
 * every arm is non-streaming by omission, and a streamed body carries no usage without
 * `stream_options`, which would silently destroy the token accounting in §3.6.
 */
const FORBIDDEN_BODY_KEYS: readonly string[] = ['reasoning', 'reasoning_effort', 'generationConfig', 'generation_config', 'extra_body', 'thinkingConfig', 'thinking_config', 'stream', 'stream_options'];

/**
 * Fail-closed structural check of a request body against its intended arm. Returns violation
 * CODES only — a body carries clinical text and must never reach an exception message.
 */
export function assertArmRequest(arm: ArmId, body: Record<string, unknown>): string[] {
  const v: string[] = [];
  const spec = armSpec(arm);
  const keys = Object.keys(body);

  for (const k of FORBIDDEN_BODY_KEYS) if (k in body) v.push(`forbidden_key:${k}`);
  for (const k of keys) {
    if (k === 'google') continue;
    if (!ALLOWED_BODY_KEYS.includes(k)) v.push(`unexpected_key:${k}`);
  }
  for (const k of ALLOWED_BODY_KEYS) if (!(k in body)) v.push(`missing_key:${k}`);

  if (body.max_tokens !== spec.maxTokens) v.push('max_tokens_mismatch');
  if (body.max_tokens !== WIRE_MAX_TOKENS_CONTROL && body.max_tokens !== WIRE_MAX_TOKENS_HIGH) {
    v.push('max_tokens_not_a_preregistered_level');
  }
  if (body.temperature !== 0) v.push('temperature_not_zero');
  if (body.top_p !== 1) v.push('top_p_not_one');
  if (!Number.isInteger(body.seed)) v.push('seed_not_integer');

  if (spec.thinkingBudget === null) {
    if ('google' in body) v.push('google_present_on_uncapped_arm');
  } else {
    v.push(...googleFieldViolations(body.google, spec.thinkingBudget));
  }
  return v;
}

/** Exactly `{ thinking_config: { thinking_budget: <literal> } }`, no more, no less. */
function googleFieldViolations(google: unknown, expected: number): string[] {
  const v: string[] = [];
  if (!google || typeof google !== 'object' || Array.isArray(google)) return ['google_absent_or_malformed'];
  const g = google as Record<string, unknown>;
  const gk = Object.keys(g);
  if (gk.length !== 1 || gk[0] !== 'thinking_config') v.push('google_extra_keys');
  const tc = g.thinking_config;
  if (!tc || typeof tc !== 'object' || Array.isArray(tc)) return [...v, 'thinking_config_malformed'];
  const t = tc as Record<string, unknown>;
  const tk = Object.keys(t);
  if (tk.length !== 1 || tk[0] !== 'thinking_budget') v.push('thinking_config_extra_keys');
  const b = t.thinking_budget;
  if (typeof b !== 'number' || !Number.isInteger(b)) v.push('thinking_budget_not_an_integer');
  else if (b <= 0) v.push('thinking_budget_not_positive');
  else if (b !== expected) v.push('thinking_budget_not_the_preregistered_literal');
  return v;
}

export interface RealizedArm {
  arm: ArmId | null;
  maxTokens: number | null;
  thinkingBudget: number | null;
  violations: string[];
}

/**
 * ⚠️ THE ARM IS READ OFF THE BYTES THAT LEFT THE PROCESS, NEVER OFF THE INTENT OBJECT (PRD §3.1).
 *
 * The failure this defends against is exactly the one PRD §1 caught in v2.0: a body that LOOKS
 * capped in the config and is not capped on the wire. An SDK that dropped, renamed or relocated
 * the `google` field would produce a silent duplicate arm, and every downstream number would be
 * a comparison of A against A. So the serialized outbound body — the string handed to fetch — is
 * the only thing consulted here.
 */
export function realizedArmFromSerializedBody(serialized: string): RealizedArm {
  const out: RealizedArm = { arm: null, maxTokens: null, thinkingBudget: null, violations: [] };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      out.violations.push('serialized_body_not_an_object');
      return out;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    out.violations.push('serialized_body_unparseable');
    return out;
  }

  for (const k of FORBIDDEN_BODY_KEYS) if (k in body) out.violations.push(`forbidden_key:${k}`);
  for (const k of Object.keys(body)) {
    if (k === 'google') continue;
    if (!ALLOWED_BODY_KEYS.includes(k)) out.violations.push(`unexpected_key:${k}`);
  }

  const mt = body.max_tokens;
  if (mt === WIRE_MAX_TOKENS_CONTROL || mt === WIRE_MAX_TOKENS_HIGH) out.maxTokens = mt as number;
  else out.violations.push('max_tokens_not_a_preregistered_level');

  const hasGoogle = 'google' in body;
  if (hasGoogle) {
    const gv = googleFieldViolations(body.google, THINKING_BUDGET);
    out.violations.push(...gv);
    const b = (((body.google as Record<string, unknown>)?.thinking_config) as Record<string, unknown>)?.thinking_budget;
    if (typeof b === 'number') out.thinkingBudget = b;
  }

  if (out.maxTokens === WIRE_MAX_TOKENS_CONTROL) out.arm = hasGoogle ? 'B' : 'A';
  else if (out.maxTokens === WIRE_MAX_TOKENS_HIGH) out.arm = hasGoogle ? 'D' : 'C';
  if (out.violations.length) out.arm = null;
  return out;
}

/** PRD §3.1 — asserted at runtime, before dispatch. Throws with a code, never with a body. */
export function assertWireMaxTokens(n: unknown): void {
  if (n !== WIRE_MAX_TOKENS_CONTROL && n !== WIRE_MAX_TOKENS_HIGH) {
    throw new Error(`wire max_tokens must be ${WIRE_MAX_TOKENS_CONTROL} or ${WIRE_MAX_TOKENS_HIGH}`);
  }
}

/**
 * PRD §5 — "the only properties that vary between arms are `max_tokens` and the presence of
 * `google`". Compares two arms' bodies built from identical input and returns the differing
 * top-level keys.
 */
export function armBodyDifferences(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff: string[] = [];
  for (const k of [...keys].sort()) {
    if (canonicalJsonString(a[k]) !== canonicalJsonString(b[k])) diff.push(k);
  }
  return diff;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. SCHEDULE (PRD §3.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface ScheduledCall {
  runId: string;
  cycle: number;
  block: number;
  position: number;
  arm: ArmId;
  /** 1-based index over the whole 32-call schedule. */
  ordinal: number;
}

/**
 * The full schedule. `cycles` exists so cycle 1 can be run alone (D-34: cycle 1 is blinded rig
 * validation), but the run ids are identical either way — cycle 2 extends the same experiment
 * rather than starting a new one.
 */
export function buildSchedule(experimentId: string, cycles: number = CYCLES): ScheduledCall[] {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > CYCLES) {
    throw new Error(`cycles must be an integer in 1..${CYCLES}`);
  }
  const calls: ScheduledCall[] = [];
  let ordinal = 0;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (let b = 0; b < SCHEDULE_BLOCKS.length; b++) {
      const block = SCHEDULE_BLOCKS[b];
      for (let p = 0; p < block.length; p++) {
        ordinal += 1;
        const arm = block[p];
        calls.push({
          runId: `${experimentId}-c${cycle}-b${b + 1}-p${p + 1}-${arm}`,
          cycle, block: b + 1, position: p + 1, arm, ordinal,
        });
      }
    }
  }
  return calls;
}

/** Balance check: every arm once per block and once in every position, per cycle. */
export function validateSchedule(calls: ScheduledCall[]): string[] {
  const v: string[] = [];
  if (new Set(calls.map((c) => c.runId)).size !== calls.length) v.push('duplicate_run_id');
  const cycles = [...new Set(calls.map((c) => c.cycle))].sort();
  for (const cycle of cycles) {
    const inCycle = calls.filter((c) => c.cycle === cycle);
    if (inCycle.length !== CALLS_PER_CYCLE) v.push(`cycle_${cycle}_wrong_length`);
    for (const b of [1, 2, 3, 4]) {
      const inBlock = inCycle.filter((c) => c.block === b).map((c) => c.arm).sort();
      if (canonicalJsonString(inBlock) !== canonicalJsonString([...ARM_IDS])) v.push(`cycle_${cycle}_block_${b}_unbalanced`);
    }
    for (const p of [1, 2, 3, 4]) {
      const inPos = inCycle.filter((c) => c.position === p).map((c) => c.arm).sort();
      if (canonicalJsonString(inPos) !== canonicalJsonString([...ARM_IDS])) v.push(`cycle_${cycle}_position_${p}_unbalanced`);
    }
  }
  return v;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. COMPLETENESS — THE TWO ENDPOINTS (PRD §3.5)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * FROZEN COPY of `extractJsonArray` from lib/lvc-core.ts:346, byte-for-byte in behaviour.
 *
 * Copied, not imported, on purpose (PRD kickoff "Read first"): the production rule may change,
 * and a preregistered endpoint that silently follows it would stop being preregistered. If the
 * two ever diverge, this experiment's numbers still mean what the protocol said they meant.
 */
export function extractJsonArrayFrozen(text: string): unknown {
  let t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('[');
  const b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** D-32 — this system's vocabulary. Not a synonym set: the contract is exact-match. */
export const VERDICT_VALUES: readonly string[] = ['applies', 'does_not_apply', 'insufficient_info'] as const;

export interface CompletenessResult {
  /** The WHOLE trimmed body is a JSON array. Reported separately from the tolerant rule. */
  strict_json_array: boolean;
  /** The frozen production extraction rule yielded an array (fences and prose tolerated). */
  production_extractable_array: boolean;
  array_length: number | null;
  expected_count: number;
  non_object_entry_count: number;
  missing_id_count: number;
  duplicate_id_count: number;
  unknown_id_count: number;
  invalid_verdict_count: number;
  invalid_confidence_count: number;
  empty_why_count: number;
  missing_consider_instead_count: number;
  /** The strict structural contract of PRD §3.5, measured on raw text before any backfill. */
  raw_complete: boolean;
  /** Codes only. Never an id, never a fragment of the body. */
  violation_codes: string[];
}

/**
 * The primary endpoint. DELIBERATELY STRICTER THAN THE PRODUCTION PARSER — that is the point.
 * `parseJudgeResponse` normalizes invalid verdicts to `insufficient_info`, clamps confidence,
 * ignores unknown ids, takes last-write-wins on duplicates and backfills every missing rec. Which
 * is exactly why the 9 August results "looked complete": we would be measuring what the parser can
 * rescue, not what the model returned.
 *
 * Takes the expected ids IN and returns only counts OUT — no identifier escapes.
 */
export function evaluateCompleteness(rawText: string, expectedIds: string[]): CompletenessResult {
  const expected = new Set(expectedIds);
  const r: CompletenessResult = {
    strict_json_array: false,
    production_extractable_array: false,
    array_length: null,
    expected_count: expectedIds.length,
    non_object_entry_count: 0,
    missing_id_count: expectedIds.length,
    duplicate_id_count: 0,
    unknown_id_count: 0,
    invalid_verdict_count: 0,
    invalid_confidence_count: 0,
    empty_why_count: 0,
    missing_consider_instead_count: 0,
    raw_complete: false,
    violation_codes: [],
  };

  const trimmed = (rawText || '').trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try { r.strict_json_array = Array.isArray(JSON.parse(trimmed)); } catch { r.strict_json_array = false; }
  }

  const extracted = extractJsonArrayFrozen(rawText);
  if (!Array.isArray(extracted)) {
    r.violation_codes.push('not_an_extractable_array');
    return r;
  }
  r.production_extractable_array = true;
  r.array_length = extracted.length;

  const seen = new Map<string, number>();
  for (const entry of extracted) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { r.non_object_entry_count += 1; continue; }
    const o = entry as Record<string, unknown>;

    const id = typeof o.id === 'string' ? o.id : '';
    if (!id || !expected.has(id)) r.unknown_id_count += 1;
    else seen.set(id, (seen.get(id) ?? 0) + 1);

    if (typeof o.verdict !== 'string' || !VERDICT_VALUES.includes(o.verdict)) r.invalid_verdict_count += 1;

    const c = o.confidence;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) r.invalid_confidence_count += 1;

    if (typeof o.why !== 'string' || o.why.trim().length === 0) r.empty_why_count += 1;

    if (!('consider_instead' in o)) r.missing_consider_instead_count += 1;
    else {
      const ci = o.consider_instead;
      if (ci !== null && typeof ci !== 'string') r.missing_consider_instead_count += 1;
    }
  }

  r.missing_id_count = expectedIds.filter((id) => !seen.has(id)).length;
  r.duplicate_id_count = [...seen.values()].reduce((n, k) => n + (k > 1 ? k - 1 : 0), 0);

  if (r.array_length !== r.expected_count) r.violation_codes.push('array_length_mismatch');
  if (r.non_object_entry_count) r.violation_codes.push('non_object_entry');
  if (r.missing_id_count) r.violation_codes.push('missing_id');
  if (r.duplicate_id_count) r.violation_codes.push('duplicate_id');
  if (r.unknown_id_count) r.violation_codes.push('unknown_id');
  if (r.invalid_verdict_count) r.violation_codes.push('invalid_verdict');
  if (r.invalid_confidence_count) r.violation_codes.push('invalid_confidence');
  if (r.empty_why_count) r.violation_codes.push('empty_why');
  if (r.missing_consider_instead_count) r.violation_codes.push('bad_consider_instead');

  r.raw_complete = r.violation_codes.length === 0;
  return r;
}

/**
 * The second endpoint. A body can be structurally complete while the provider reports `length`,
 * and production rejects `length` BEFORE parsing — so reporting only `raw_complete` would imply
 * production would have served a response it would in fact refuse.
 */
export function isProviderUsable(c: CompletenessResult, finishReason: string | null | undefined): boolean {
  if (!c.raw_complete) return false;
  return isProductionAcceptedFinishReason(finishReason);
}

export function isProductionAcceptedFinishReason(finishReason: string | null | undefined): boolean {
  if (finishReason == null || finishReason === '') return true; // the documented null rule; content is present
  return PRODUCTION_ACCEPTED_FINISH_REASONS.includes(String(finishReason).toLowerCase());
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7. TOKEN ACCOUNTING, NAMED HONESTLY (PRD §3.6)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  reasoning_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
}

export interface TokenAccounting {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  /** A flat provider field or a completion-detail field. Otherwise null — NEVER zero. */
  reasoning_tokens_reported: number | null;
  /** total − prompt − completion, when all three exist. NOT reasoning tokens. */
  unaccounted_output_tokens: number | null;
  /** Populated ONLY if the probe established that semantic for this exact endpoint. */
  reasoning_tokens_inferred: number | null;
  reasoning_token_source: 'reported' | 'inferred' | 'unavailable';
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * ⚠️ NEVER COALESCE AN ABSENT VALUE TO ZERO, and never rename unaccounted tokens as reasoning
 * tokens. A zero would read as "the model did no thinking", which is a finding; absent means we
 * do not know, which is not.
 *
 * ⚠️ FLAGGED PRD INTERNAL INCONSISTENCY, resolved in favour of §5 and recorded in the build
 * report. §3.6 defines `unaccounted_output_tokens` as `max(0, total − prompt − completion)`,
 * which maps a NEGATIVE subtraction to 0. §5 ("Telemetry") requires "a negative subtraction
 * becomes null, never zero or negative". A negative result means the provider's own accounting is
 * internally inconsistent — reporting 0 would assert "nothing unaccounted", which is a claim the
 * data does not support. So: negative ⇒ null; a legitimate exact 0 ⇒ 0. For every non-negative
 * case the two clauses agree.
 */
export function deriveTokenAccounting(
  usage: RawUsage | null | undefined,
  opts: { inferredSemanticEstablished: boolean },
): TokenAccounting {
  const u = usage ?? {};
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens);

  const reported = num(u.reasoning_tokens) ?? num(u.completion_tokens_details?.reasoning_tokens);

  let unaccounted: number | null = null;
  if (prompt !== null && completion !== null && total !== null) {
    const d = total - prompt - completion;
    unaccounted = d < 0 ? null : d;
  }

  const inferred = opts.inferredSemanticEstablished ? unaccounted : null;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    reasoning_tokens_reported: reported,
    unaccounted_output_tokens: unaccounted,
    reasoning_tokens_inferred: inferred,
    reasoning_token_source: reported !== null ? 'reported' : (inferred !== null ? 'inferred' : 'unavailable'),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8. REDACTION (PRD §4.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Recursively replace credential-like VALUES. Structure and non-secret values are preserved. */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactValue(src[k]);
    return out;
  }
  if (typeof value === 'string' && /^Bearer\s+\S/i.test(value)) return REDACTED;
  return value;
}

/**
 * The outbound body, safe to hash, compare and store: credentials redacted AND every message
 * content replaced by its own hash and length. The arm comparison needs the SHAPE of the body, not
 * the clinical text in it, so the text never leaves the process in any form but a digest.
 */
export function redactSerializedBody(serialized: string): { redacted: Record<string, unknown> | null; error: string | null } {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return { redacted: null, error: 'serialized_body_unparseable' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { redacted: null, error: 'serialized_body_not_an_object' };
  }
  const body = redactValue(parsed) as Record<string, unknown>;
  if (Array.isArray(body.messages)) {
    body.messages = (body.messages as unknown[]).map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      const content = typeof o.content === 'string' ? o.content : '';
      return { role: o.role ?? null, content_sha256: sha256Hex(content), content_length: content.length };
    });
  }
  return { redacted: body, error: null };
}

/** PRD §4.2 — keep only non-secret headers; report how many were dropped, never which. */
export function filterResponseHeaders(headers: Record<string, string>): { kept: Record<string, string>; dropped_count: number } {
  const kept: Record<string, string> = {};
  let dropped = 0;
  for (const [k, val] of Object.entries(headers ?? {})) {
    const lk = k.toLowerCase();
    if (RESPONSE_HEADER_ALLOWLIST.includes(lk)) kept[lk] = val;
    else dropped += 1;
  }
  return { kept, dropped_count: dropped };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 9. PATH GUARD (PRD §4.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Pure POSIX-style normalization. Both arguments must already be absolute. */
function normalizeAbs(p: string): string | null {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

/**
 * The runner refuses any output path outside the private root. Traversal (`..`), sibling-prefix
 * collisions (`/x/rootEVIL` against root `/x/root`) and non-absolute paths all fail.
 */
export function isInsidePrivateRoot(rootAbs: string, candidateAbs: string): boolean {
  const root = normalizeAbs(rootAbs);
  const cand = normalizeAbs(candidateAbs);
  if (!root || !cand) return false;
  if (cand === root) return true;
  return cand.startsWith(`${root}/`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 10. JOURNAL VALIDATION (PRD §4.5)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface JournalEvent {
  run_id: string;
  event: string;
  /** Present on `completed`; the fetch-boundary counter's value for this run. */
  dispatch_count?: number;
  [k: string]: unknown;
}

export interface JournalRunState {
  runId: string;
  scheduled: boolean;
  dispatched: boolean;
  terminal: string | null;
  /** `dispatching` written but no terminal event — the outcome is genuinely unknown. */
  uncertain: boolean;
  problems: string[];
}

export interface JournalValidation {
  valid: boolean;
  problems: string[];
  runs: JournalRunState[];
}

/**
 * Append-only means an earlier event is never edited, so validity is a property of the SEQUENCE.
 * Two `dispatching` events for one run id is the single most damaging defect this can catch: it
 * means the call was made twice and the response we scored may not be the response we paid for.
 */
export function validateJournal(events: JournalEvent[]): JournalValidation {
  const runs = new Map<string, JournalRunState>();
  const problems: string[] = [];
  const get = (id: string): JournalRunState => {
    let s = runs.get(id);
    if (!s) { s = { runId: id, scheduled: false, dispatched: false, terminal: null, uncertain: false, problems: [] }; runs.set(id, s); }
    return s;
  };

  for (const e of events ?? []) {
    const id = typeof e?.run_id === 'string' ? e.run_id : '';
    if (!id) { problems.push('event_without_run_id'); continue; }
    const s = get(id);
    const kind = String(e?.event ?? '');
    if (kind === 'scheduled') {
      if (s.scheduled) s.problems.push('duplicate_scheduled');
      s.scheduled = true;
    } else if (kind === 'dispatching') {
      if (s.dispatched) s.problems.push('duplicate_dispatch');
      if (s.terminal) s.problems.push('dispatch_after_terminal');
      s.dispatched = true;
    } else if (JOURNAL_TERMINAL_EVENTS.includes(kind)) {
      if (s.terminal) s.problems.push('duplicate_terminal');
      s.terminal = kind;
      if (kind === 'completed' && e.dispatch_count !== 1) s.problems.push('dispatch_count_not_one');
    } else {
      s.problems.push(`unknown_event:${kind}`);
    }
  }

  for (const s of runs.values()) {
    s.uncertain = s.dispatched && !s.terminal;
    problems.push(...s.problems.map((p) => `${s.runId}:${p}`));
  }
  return { valid: problems.length === 0, problems, runs: [...runs.values()] };
}

/**
 * Resume rule (PRD §4.5). A run that reached `dispatching` without a terminal event is NEVER
 * replayed — a second dispatch would either double-charge for an answer we may already have, or
 * quietly turn one scheduled call into two. It becomes `outcome_unknown` and STAYS IN THE
 * DENOMINATOR (D-35): an infrastructure failure that removed itself from the denominator would
 * flatter whichever arm it hit.
 */
export function nextJournalAction(events: JournalEvent[], runId: string): 'dispatch' | 'mark_unknown' | 'skip_done' {
  const state = validateJournal(events).runs.find((r) => r.runId === runId);
  if (!state) return 'dispatch';
  if (state.terminal) return 'skip_done';
  if (state.dispatched) return 'mark_unknown';
  return 'dispatch';
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 11. AGGREGATION (PRD §6) — counts, Wilson intervals, medians. No inference, no p-values.
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface CallRecord {
  arm: ArmId;
  /** false for a timeout, HTTP error, network error or unknown outcome — all stay counted. */
  responded: boolean;
  raw_complete: boolean;
  provider_usable: boolean;
  finish_reason: string | null;
  strict_json_array: boolean;
  production_extractable_array: boolean;
  missing_id_count: number | null;
  completion_tokens: number | null;
  reasoning_tokens_reported: number | null;
  unaccounted_output_tokens: number | null;
  total_ms: number | null;
  ttfb_ms: number | null;
}

export interface Interval { lo: number; hi: number }

/** Wilson score interval, 95%. Returns {0,0} for an empty denominator rather than NaN. */
export function wilson(k: number, n: number, z = 1.959964): Interval {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d) };
}

export interface ContinuousSummary { n: number; median: number | null; min: number | null; max: number | null }

/** Median and range over the PRESENT values only; `n` says how many were present. */
export function summarizeContinuous(values: Array<number | null | undefined>): ContinuousSummary {
  const xs = (values ?? []).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, median: null, min: null, max: null };
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return { n: xs.length, median, min: xs[0], max: xs[xs.length - 1] };
}

export interface ArmAggregate {
  arm: ArmId;
  /** D-35 — EVERY scheduled call for this arm, including those that never got a response. */
  scheduled: number;
  responded: number;
  raw_complete: number;
  raw_complete_wilson: Interval;
  provider_usable: number;
  provider_usable_wilson: Interval;
  finish_length: number;
  strict_json_array: number;
  production_extractable_array: number;
  missing_ids: ContinuousSummary;
  completion_tokens: ContinuousSummary;
  reasoning_tokens_reported: ContinuousSummary;
  unaccounted_output_tokens: ContinuousSummary;
  total_ms: ContinuousSummary;
  ttfb_ms: ContinuousSummary;
}

/**
 * `scheduled` is the denominator for every binary rate. A call that timed out is a call that did
 * not produce a complete response, and dropping it would answer a different question than the one
 * asked ("how often does this configuration work" ≠ "how often does it work when it works").
 */
export function aggregateByArm(records: CallRecord[], scheduledByArm: Record<ArmId, number>): ArmAggregate[] {
  return ARM_IDS.map((arm) => {
    const rs = (records ?? []).filter((r) => r.arm === arm);
    const scheduled = scheduledByArm?.[arm] ?? rs.length;
    const rawComplete = rs.filter((r) => r.raw_complete).length;
    const usable = rs.filter((r) => r.provider_usable).length;
    return {
      arm,
      scheduled,
      responded: rs.filter((r) => r.responded).length,
      raw_complete: rawComplete,
      raw_complete_wilson: wilson(rawComplete, scheduled),
      provider_usable: usable,
      provider_usable_wilson: wilson(usable, scheduled),
      finish_length: rs.filter((r) => String(r.finish_reason ?? '').toLowerCase() === 'length').length,
      strict_json_array: rs.filter((r) => r.strict_json_array).length,
      production_extractable_array: rs.filter((r) => r.production_extractable_array).length,
      missing_ids: summarizeContinuous(rs.map((r) => r.missing_id_count)),
      completion_tokens: summarizeContinuous(rs.map((r) => r.completion_tokens)),
      reasoning_tokens_reported: summarizeContinuous(rs.map((r) => r.reasoning_tokens_reported)),
      unaccounted_output_tokens: summarizeContinuous(rs.map((r) => r.unaccounted_output_tokens)),
      total_ms: summarizeContinuous(rs.map((r) => r.total_ms)),
      ttfb_ms: summarizeContinuous(rs.map((r) => r.ttfb_ms)),
    };
  });
}

/**
 * PRD §3.7, second consequence, decided in advance. If arms A and C show reasoning BELOW the cap,
 * the cap never bound, B and D are duplicates of A and C on that factor, and the thinking factor
 * is reported UNTESTED — not as a null result. Returns null when there is no reasoning telemetry
 * to judge it by, which is itself "untested".
 */
export function thinkingFactorBound(aggregates: ArmAggregate[]): { bound: boolean | null; reason: string } {
  const uncapped = aggregates.filter((a) => a.arm === 'A' || a.arm === 'C');
  const observed = uncapped.map((a) => a.reasoning_tokens_reported).filter((s) => s.n > 0);
  if (!observed.length) return { bound: null, reason: 'no_reasoning_telemetry_on_uncapped_arms' };
  const maxSeen = Math.max(...observed.map((s) => s.max ?? 0));
  return maxSeen > THINKING_BUDGET
    ? { bound: true, reason: 'uncapped_arms_exceeded_the_cap' }
    : { bound: false, reason: 'uncapped_arms_never_reached_the_cap' };
}
