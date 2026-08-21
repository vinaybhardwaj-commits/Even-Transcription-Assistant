/**
 * lib/brain/fuse/gemini-arms.ts — ARM B (hybrid) and ARM C (flash), and the lock they share.
 *
 * THE FAIL-CLOSED LOCK (X4, §6.6) is the thing in this file that matters most.
 *
 * routedChat falls back to local Ollama SILENTLY on any Gemini error — that is its designed
 * behaviour and this build does not change it. The consequence for a bake-off is fatal: a fuse
 * secretly served by qwen2.5:14b would be scored as Flash, and nothing anywhere would say so.
 * So every model call in this file goes through `gemini()` below, which inspects `provider` on
 * EVERY call and refuses anything that is not `gemini:`. On refusal the arm writes NOTHING —
 * not a partial run, not a degraded visit — and returns { ok:false, error:'provider_not_gemini',
 * provider }. Arm A never calls a model and is unaffected.
 *
 * Neither arm may invent identity. Arm B may only adjust what arm A already produced; arm C's
 * output is coerced field by field and anything it makes up is dropped rather than trusted.
 * There is no schema validator in this codebase (zod is a dependency nobody imports), so the
 * coercion below is hand-rolled and deliberately paranoid.
 */

import { routedChat } from "@/lib/llm/gemini";
import { runRulesArm } from "./rules";
import { VISIT_STATES, type ArmOutput, type DraftVisit, type FuseCue, type OpenedByKind, type VisitState } from "./types";

/** Well under any route budget, and well under the MCP door's patience. */
const FUSE_TIMEOUT_MS = 45_000;
const FUSE_MAX_TOKENS = 8192;

export type ArmFailure = { ok: false; error: string; provider: string; detail?: string };
export type ArmSuccess = {
  ok: true;
  provider: string;
  output: ArmOutput;
  /** arm B only: how many of arm A's ambiguous cases the advisor actually moved. The designer
   *  needs this to tell "the advisor agreed with the rules" from "the advisor was never asked". */
  advisory_applied?: number;
  advisory_considered?: number;
};
export type ArmResult = ArmSuccess | ArmFailure;

/** The §5 grammar, handed to the model as priors. Contains no identity and no clinical text. */
const GRAMMAR = [
  "You are reconciling evidence about outpatient consultations in ONE room on ONE day.",
  "Rules, which you must follow exactly:",
  "1. A 'pstart' cue is an official consult start. It opens a visit in state in_chair. A pstart with no kiosk mark STILL opens a visit.",
  "2. A 'pqm_called' cue with no matching pstart may open a visit in state called.",
  "3. A 'pulse_note' cue is a LATER LOCK. It never opens a visit.",
  "4. A 'dx_event' cue opens a HOLE: set state at_diagnostics on the person's EXISTING visit. It never creates a visit.",
  "5. A second pstart for the same individual_uid with a DIFFERENT calendar_uid IS a second, separate visit on the same day.",
  "6. payload.attribution 'inferred' is weak evidence. NEVER establish identity from an inferred dx_event alone.",
  "7. payload.in_tape_window is irrelevant. Never drop a visit because it is false.",
  "8. If the evidence cannot settle a case, say so: give the visit a LOW confidence and name the reason. Do not guess.",
  "9. Never invent an individual_uid. Use only uids present in the cues.",
  `10. state must be one of: ${VISIT_STATES.join(", ")}.`,
].join("\n");

/**
 * One model call, fail-closed on provider. EVERY call in this file goes through here — there
 * is no second path to routedChat, deliberately, so the check cannot be forgotten at a call site.
 */
async function gemini(surface: string, tier: "pro" | "flash", system: string, user: string): Promise<{ ok: true; content: string; provider: string } | ArmFailure> {
  let rc;
  try {
    rc = await routedChat({
      surface,
      tier,
      ollamaModel: process.env.NOTE_MODEL || "qwen2.5:14b",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      responseJson: true,
      timeoutMs: FUSE_TIMEOUT_MS,
      maxTokens: FUSE_MAX_TOKENS,
    });
  } catch (e) {
    return { ok: false, error: "provider_threw", provider: "unknown", detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  // X4. The check is on provider, not on ok: a SUCCESSFUL Ollama answer is exactly the failure
  // being guarded against, and it looks like success everywhere else.
  if (!rc.provider.startsWith("gemini:")) return { ok: false, error: "provider_not_gemini", provider: rc.provider };
  if (!rc.ok || !rc.content) return { ok: false, error: rc.error ?? "empty_response", provider: rc.provider };
  return { ok: true, content: rc.content, provider: rc.provider };
}

/** The cue list as the model sees it: no free text, no room ids, nothing it does not need. */
function cuesForPrompt(cues: FuseCue[]): string {
  return JSON.stringify(
    cues.map((c) => ({
      id: c.id,
      type: c.type,
      at: c.at,
      source_ref: c.source_ref,
      individual_uid: (c.payload?.individual_uid as string) ?? null,
      calendar_uid: (c.payload?.calendar_uid as string) ?? null,
      attribution: (c.payload?.attribution as string) ?? null,
      category: (c.payload?.category as string) ?? null,
    })),
  );
}

const asState = (v: unknown): VisitState | null => (typeof v === "string" && (VISIT_STATES as readonly string[]).includes(v) ? (v as VisitState) : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
const asStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(content) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ARM B — hybrid: arm A decides, Gemini advises, and only on the hard cases
// ---------------------------------------------------------------------------

/**
 * Arm A produces the visits. Gemini is consulted ONLY on the ones arm A flagged ambiguous, and
 * its answer is ADVISORY: it may move confidence and choose among states arm A already
 * enumerated. It may never mint a visit, never invent an individual_uid, and never touch a
 * visit arm A was confident about. Those three are enforced structurally below — the merge
 * only ever looks up an existing ambiguous draft by opened_by — rather than by asking the
 * model nicely in the prompt.
 */
export async function runHybridArm(cues: FuseCue[]): Promise<ArmResult> {
  const base = runRulesArm(cues);
  const ambiguous = base.visits.filter((v) => v.reasons.length > 0);
  if (ambiguous.length === 0) {
    // Nothing to ask about. No model call means no provider — and no silent fallback either.
    return { ok: true, provider: "none", output: base, advisory_applied: 0, advisory_considered: 0 };
  }

  const system = `${GRAMMAR}\n\nYou are ADVISING on cases a rules engine could not settle. You may only: adjust "confidence" (0..1), and choose a "state" from the list. You may NOT add visits, remove visits, or change any individual_uid. Reply with JSON: {"decisions":[{"opened_by":"...","state":"...","confidence":0.0,"why":"..."}]}`;
  const user = JSON.stringify({
    cues: JSON.parse(cuesForPrompt(cues)),
    ambiguous_visits: ambiguous.map((v) => ({
      opened_by: v.opened_by,
      opened_by_kind: v.opened_by_kind,
      individual_uid: v.individual_uid,
      state: v.state,
      confidence: v.confidence,
      reasons: v.reasons,
      options: VISIT_STATES,
    })),
  });

  const r = await gemini("cds", "pro", system, user);
  if (!r.ok) return r;

  const parsed = parseJsonObject(r.content);
  const decisions = Array.isArray(parsed?.decisions) ? (parsed!.decisions as unknown[]) : [];
  // Index by opened_by over the AMBIGUOUS drafts only. A decision naming anything else — a
  // confident visit, or a visit that does not exist — finds nothing and is dropped.
  const byOpenedBy = new Map(ambiguous.map((v) => [v.opened_by, v]));
  const visits = base.visits.map((v) => ({ ...v, reasons: [...v.reasons] }));
  const applied: string[] = [];

  for (const d of decisions) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    const key = asStr(o.opened_by);
    if (!key || !byOpenedBy.has(key)) continue; // never mints, never touches a confident visit
    const target = visits.find((v) => v.opened_by === key);
    if (!target) continue;
    const st = asState(o.state);
    const cf = asNum(o.confidence);
    if (st) target.state = st;
    if (cf !== null) target.confidence = cf;
    // individual_uid is NEVER read from the model's answer. Not coerced, not defaulted — the
    // field is simply not consulted, so it cannot be invented.
    applied.push(key);
  }

  // The unbound evidence is arm A's finding and the advisor cannot change it: it was never
  // offered those cues as decisions, so passing them through untouched is the honest result.
  return {
    ok: true,
    provider: r.provider,
    output: { visits, unbound: base.unbound },
    advisory_applied: applied.length,
    advisory_considered: ambiguous.length,
  };
}

// ---------------------------------------------------------------------------
// ARM C — flash: the model reads the cues and produces the visits
// ---------------------------------------------------------------------------

export async function runFlashArm(cues: FuseCue[]): Promise<ArmResult> {
  const system = `${GRAMMAR}\n\nProduce the visits. Reply with JSON: {"visits":[{"individual_uid":null|"...","state":"...","pstart_at":null|"ISO","confidence":0.0,"opened_by":"the source_ref or cue id that OPENED this visit","opened_by_kind":"pstart"|"pqm_called"|"mark","reasons":["..."]}]}. Every opened_by MUST be a source_ref or cue id present in the input. Emit nothing else.`;
  const r = await gemini("cds", "flash", system, cuesForPrompt(cues));
  if (!r.ok) return r;

  const parsed = parseJsonObject(r.content);
  const raw = Array.isArray(parsed?.visits) ? (parsed!.visits as unknown[]) : [];

  // Only ids that actually appear in the input can open a visit. This is what stops the model
  // from inventing evidence: a hallucinated opened_by has nowhere to land.
  const knownIds = new Set<string>();
  const uidByRef = new Map<string, string | null>();
  for (const c of cues) {
    knownIds.add(c.id);
    if (c.source_ref) knownIds.add(c.source_ref);
    const uid = (c.payload?.individual_uid as string) ?? null;
    if (c.source_ref) uidByRef.set(c.source_ref, uid);
    uidByRef.set(c.id, uid);
  }

  const seen = new Set<string>();
  const visits: DraftVisit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const opened_by = asStr(o.opened_by);
    if (!opened_by || !knownIds.has(opened_by) || seen.has(opened_by)) continue;
    const state = asState(o.state);
    if (!state) continue;
    seen.add(opened_by);
    const kindRaw = asStr(o.opened_by_kind);
    const kind: OpenedByKind = kindRaw === "pstart" || kindRaw === "pqm_called" || kindRaw === "mark" ? kindRaw : "mark";
    visits.push({
      // Identity comes from the CUE the model pointed at, never from the model's own answer.
      // It can choose which evidence opened a visit; it cannot choose who the person was.
      individual_uid: uidByRef.get(opened_by) ?? null,
      consult_uid: null,
      state,
      pstart_at: asStr(o.pstart_at),
      confidence: asNum(o.confidence) ?? 0.5,
      opened_by,
      opened_by_kind: kind,
      reasons: Array.isArray(o.reasons) ? (o.reasons as unknown[]).map(asStr).filter((x): x is string => x !== null).slice(0, 8) : [],
    });
  }

  return { ok: true, provider: r.provider, output: { visits, unbound: [] } };
}
