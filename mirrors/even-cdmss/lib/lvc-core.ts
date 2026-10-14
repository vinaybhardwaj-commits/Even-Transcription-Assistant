/**
 * lib/lvc-core.ts — Appropriateness / Low-Value-Care matcher CORE (CW.2).
 *
 * PURE, dependency-free logic so the conditional gate is unit-testable without DB/LLM.
 * The wired orchestrator (lib/lvc.ts) imports this + db/llm/retrieve/trace.
 * See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.1.md §6.
 *
 * Cardinal rules encoded here:
 *  - A flag fires ONLY when the applicability judge says APPLIES *and* clears the
 *    surface's confidence floor. INSUFFICIENT-INFO and DOES-NOT-APPLY never fire.
 *  - Two-tier floor: high (0.75) for the unsolicited auto-flag path, medium (0.5)
 *    for the opt-in dedicated surface (§12-Q5).
 */

export type Region = 'US' | 'CA' | 'IN';
export type ActionType =
  | 'imaging' | 'lab' | 'medication' | 'procedure'
  | 'screening' | 'monitoring' | 'referral' | 'other';
/** 'surface' = opt-in /appropriateness page; 'autoflag' = unsolicited DDx/Ask advisory. */
export type Surface = 'surface' | 'autoflag';
export type Verdict = 'applies' | 'does_not_apply' | 'insufficient_info';

export interface LvcRecommendation {
  id: string;
  region: Region;
  society: string;
  specialty: string | null;
  statement: string;
  precondition: string | null;
  action_type: ActionType | string | null;
  consider_instead: string | null;
  rationale: string | null;
  keywords: string[];
  citation_doi: string | null;
  citation_pmid: string | null;
  citation_url: string | null;
  source_release_year: number | null;
  status?: string;
}

export interface Candidate {
  name: string;
  action_type?: ActionType | string;
}

export interface JudgedRec {
  rec: LvcRecommendation;
  verdict: Verdict;
  confidence: number; // 0..1
  why: string;
  consider_instead: string | null;
}

export interface LvcFlag {
  id: string;
  statement: string;
  society: string;
  region: Region;
  specialty: string | null;
  rationale: string | null;
  consider_instead: string | null;
  why_it_applies: string;
  confidence: number;
  citation: { url: string | null; doi: string | null; pmid: string | null; year: number | null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence floor (two-tier) + the conditional gate
// ─────────────────────────────────────────────────────────────────────────────

export const AUTOFLAG_FLOOR = 0.75;
export const SURFACE_FLOOR = 0.5;

export function confidenceFloorFor(surface: Surface): number {
  return surface === 'autoflag' ? AUTOFLAG_FLOOR : SURFACE_FLOOR;
}

/** The gate: only APPLIES above the surface floor fires. INSUFFICIENT-INFO / DOES-NOT-APPLY never fire. */
export function passesFloor(j: { verdict: Verdict; confidence: number }, surface: Surface): boolean {
  if (j.verdict !== 'applies') return false;
  return j.confidence >= confidenceFloorFor(surface);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword recall (deterministic leg)
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeForMatch(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A rec matches if any of its keywords appears as a substring of the haystack
 * (scenario + candidate names), both normalized. Keywords are authored lowercase;
 * matching is substring on a normalized string so "lumbar mri" matches
 * "...ordered an MRI of the lumbar spine...". Short keywords (<3 chars) are ignored.
 */
export function keywordRecall(
  scenario: string,
  candidates: Candidate[],
  recs: LvcRecommendation[],
): LvcRecommendation[] {
  const hay = normalizeForMatch(`${scenario} ${candidates.map((c) => c.name).join(' ')}`);
  if (!hay) return [];
  const out: LvcRecommendation[] = [];
  for (const r of recs) {
    const hit = (r.keywords || []).some((k) => {
      const kk = normalizeForMatch(k);
      return kk.length >= 3 && hay.includes(kk);
    });
    if (hit) out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Union / ordering / assembly
// ─────────────────────────────────────────────────────────────────────────────

export function dedupeById<T extends { id: string }>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (item && !seen.has(item.id)) { seen.add(item.id); out.push(item); }
    }
  }
  return out;
}

const regionRank = (region: Region, prefer?: Region): number => {
  if (prefer && region === prefer) return 0;
  // Default tilt: India-local first, then Canada (live), then US (archived).
  return ({ IN: 1, CA: 2, US: 3 } as Record<Region, number>)[region] ?? 4;
};

/**
 * Apply the gate, then sort surviving flags by confidence (desc), tiebreak by
 * region preference then recency. Returns the renderable flag objects.
 */
export function assembleFlags(
  judged: JudgedRec[],
  surface: Surface,
  opts: { preferRegion?: Region } = {},
): LvcFlag[] {
  return judged
    .filter((j) => passesFloor(j, surface))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const rr = regionRank(a.rec.region, opts.preferRegion) - regionRank(b.rec.region, opts.preferRegion);
      if (rr !== 0) return rr;
      return (b.rec.source_release_year ?? 0) - (a.rec.source_release_year ?? 0);
    })
    .map((j) => ({
      id: j.rec.id,
      statement: j.rec.statement,
      society: j.rec.society,
      region: j.rec.region,
      specialty: j.rec.specialty,
      rationale: j.rec.rationale,
      consider_instead: j.consider_instead ?? j.rec.consider_instead,
      why_it_applies: j.why,
      confidence: j.confidence,
      citation: {
        url: j.rec.citation_url,
        doi: j.rec.citation_doi,
        pmid: j.rec.citation_pmid,
        year: j.rec.source_release_year,
      },
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate extraction (Flash) — prompt + parser
// ─────────────────────────────────────────────────────────────────────────────

export const CANDIDATE_SYSTEM = `You extract the diagnostic tests, imaging, lab orders, medications, procedures, screening and monitoring that a clinician is PROPOSING or IMPLYING for a patient. Return ONLY the orders/actions being considered — not the diagnosis, not findings already obtained.

Return ONLY a JSON array, no prose:
[{"name": "<short order/action>", "action_type": "imaging|lab|medication|procedure|screening|monitoring|referral|other"}]

Rules:
- Use the common clinical name (e.g. "MRI lumbar spine", "PSA test", "CT pulmonary angiogram", "broad-spectrum antibiotics").
- 0 items is valid (return []) if no order/action is proposed.
- Max 12 items.`;

export function buildCandidateUser(scenario: string): string {
  return `Clinical scenario / proposed plan:\n${scenario.trim()}`;
}

/** Tolerant parse of the candidate-extraction response into Candidate[]. */
export function parseCandidates(text: string): Candidate[] {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr)) return [];
  const out: Candidate[] = [];
  for (const x of arr) {
    if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
      const name = ((x as { name: string }).name || '').trim();
      if (!name) continue;
      const at = (x as { action_type?: unknown }).action_type;
      out.push({ name, action_type: typeof at === 'string' ? at : undefined });
    } else if (typeof x === 'string' && x.trim()) {
      out.push({ name: x.trim() });
    }
  }
  return out.slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// Applicability judge (Pro/Flash) — batched prompt + parser
// ─────────────────────────────────────────────────────────────────────────────

// Calibrated 16-Jul-2026 (JUDGE_SYSTEM calibration kickoff): added the ABSENCE-DEFINED
// PRECONDITIONS, CHRONICITY, and NAMED EXCLUSIONS rules, aimed at real check-gold/2.0 misses
// (RC-P-03 grounding suppression, RC-P-07 chronic-imaging, RC-C-01 CAC over-flag). NOTE: the
// NAMED EXCLUSIONS rule is DORMANT — buildJudgeUser does not yet surface proposedActions to the
// judge, so no ordered action reaches this prompt to match against a carve-out. It is kept
// (correct + benched-in) so the separate Fix-3 "ordered-action plumbing" PRD only adds the
// buildJudgeUser/lvc.ts wiring, with no further JUDGE_SYSTEM change. Governed prompt: any edit
// re-pins CHECK_MEASURED_HASH (lib/reasoning/outcome-core.ts) + regenerates the registry.
export const JUDGE_SYSTEM = `You are a careful clinical appropriateness reviewer. For each candidate recommendation, decide whether it APPLIES to THIS patient — i.e. whether the patient's situation satisfies the recommendation's stated precondition, such that the flagged test/treatment would be low-value or potentially harmful here.

For each recommendation return one of:
- "applies": the precondition is met for this patient and the flagged action would be low-value/harmful here.
- "does_not_apply": the precondition is NOT met (e.g. the patient has the red-flag/exception that makes the action appropriate).
- "insufficient_info": you cannot tell from the information given.

Be conservative: if the patient has any feature that is an exception to the recommendation (red flags, an evidence-based indication, a contraindication to the alternative), choose "does_not_apply". If key facts are missing, choose "insufficient_info" — do NOT guess "applies".

ABSENCE-DEFINED PRECONDITIONS: Many preconditions are satisfied by the ABSENCE of a feature — e.g. "no red flags", "no localising source", "uncomplicated", "asymptomatic", "no documented failed conservative care". A clinical note documents red flags and specific findings WHEN THEY ARE PRESENT, so a note that does not positively record such a feature SATISFIES an absence-type precondition — the feature's absence is meaningful, not merely "unknown". Do NOT downgrade a rec to "insufficient_info" solely because the excluded feature is "not mentioned" / "not documented" — that is exactly the situation the recommendation is written for. GUARDRAIL: this lets you treat an absent feature as absent; it NEVER lets you assert a POSITIVE finding the note does not state. If a precondition needs a positive feature that is genuinely not stated, "insufficient_info" still applies.

CHRONICITY IS NOT AN INDICATION: Long symptom duration or recurrence alone does not justify advanced imaging or testing. Chronic or recurrent low back pain with no red flags and no documented failed conservative care IS the low-value-imaging scenario a "don't image" recommendation targets — chronicity does not move it to "does_not_apply".

NAMED EXCLUSIONS: A precondition may carve out a specific test/action (e.g. "does not apply to X", "excluding Y", "not for Z"). Before returning "applies", identify the ACTUAL action ordered in this plan and match it against every carve-out by CLINICAL MEANING — synonyms and abbreviations count (e.g. a "CT coronary calcium score" IS "coronary artery calcium (CAC) scoring"). If the ordered action is a carved-out action, return "does_not_apply" and name the carve-out in "why", EVEN when the patient otherwise fits the precondition (asymptomatic, low-risk, etc.). Do NOT substitute the recommendation's generic target (e.g. "stress imaging") for the specific action the plan actually ordered.

Return ONLY a JSON array, one object per recommendation, no prose:
[{"id":"<rec id>","verdict":"applies|does_not_apply|insufficient_info","confidence":0.0-1.0,"why":"<one sentence specific to this patient>","consider_instead":"<short alternative or null>"}]`;

// Slice 2 (Right Care × ClinicalState): `clinicalStateText` is the pre-composed PATIENT
// PICTURE block (see lib/right-care-state.ts patientPictureBlock). OPTIONAL and additive —
// omitted/empty → the returned prompt is byte-identical to the ungrounded Slice-1 prompt
// (unit-asserted). The block sits between the scenario and the candidate list so the judge
// decides "does this APPLY to THIS patient" against the structured negatives/unknowns.
/**
 * Lab-package composition (Phase C, §7.2 / decision §1.12). A minimal, FACTUAL projection of
 * data/lab-packages.json: the package name and what it contains. Nothing evaluative.
 */
export interface LabPackageContext { package: string; aliases?: string[]; contains: string[] }

/**
 * Render the package block for the judge.
 *
 * ⚠️ THE SAFETY PROPERTY (§7.2, §8.9): an EMPTY or MALFORMED package set must produce a judge
 * context BYTE-IDENTICAL to today's. This function returns the empty string for anything unusable,
 * so `buildJudgeUser` concatenates nothing and the prompt is unchanged. It must NEVER be read as
 * "no packages exist, therefore everything is a duplicate" — the absence of the file widens nothing.
 *
 * This is CONTEXT, not rubric. It tells the judge what a package contains so that ordering a panel
 * and separately ordering one of its analytes is recognised as one order, not two. It does not
 * change the applicability test, any severity constant, or any weight.
 */
export function buildLabPackageBlock(packages?: LabPackageContext[] | null): string {
  const list = (Array.isArray(packages) ? packages : [])
    .filter((p) => p && typeof p.package === 'string' && p.package.trim() && Array.isArray(p.contains) && p.contains.length);
  if (!list.length) return '';
  const lines = list.map((p) => {
    const aka = (p.aliases ?? []).map((a) => String(a ?? '').trim()).filter(Boolean);
    const akaTxt = aka.length ? ` (also written: ${aka.join(', ')})` : '';
    return `- ${p.package.trim()}${akaTxt} contains: ${p.contains.map((c) => String(c ?? '').trim()).filter(Boolean).join(', ')}`;
  });
  return `\nLAB PACKAGE COMPOSITION (factual, from this hospital's own order data). A package below is a SINGLE order that includes the listed tests. If the plan orders a package, its constituent tests are already covered — do NOT treat the package and one of its own constituents as two separate or duplicated orders:\n${lines.join('\n')}\n`;
}

export function buildJudgeUser(
  ctx: { scenario: string; patient?: { age?: number; sex?: string } },
  recs: LvcRecommendation[],
  clinicalStateText?: string,
  orderedActions?: string[],
  labPackages?: LabPackageContext[] | null,
): string {
  const pt = ctx.patient
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const picture = clinicalStateText && clinicalStateText.trim() ? `\n${clinicalStateText.trim()}\n` : '';
  // ORDERED ACTION(S) UNDER REVIEW (gated on RIGHT_CARE_JUDGE_SEES_ACTION in lib/lvc.ts): the
  // specific test/treatment this plan ordered, surfaced so the judge matches it against each rec's
  // precondition carve-outs — this is what activates the dormant NAMED EXCLUSIONS rule in
  // JUDGE_SYSTEM. Absent/empty (flag off) → renders NOTHING → byte-identical to the ungrounded
  // Slice-1 prompt (unit-asserted). Defensive: whitespace-only entries drop; all-empty → no section.
  const acts = (orderedActions ?? []).map((a) => (a ?? '').trim()).filter(Boolean);
  const actions = acts.length
    ? `\nORDERED ACTION(S) UNDER REVIEW (the specific test/treatment this plan actually ordered — judge each recommendation against THIS action, and apply any precondition carve-out that names it):\n${acts.map((a) => `- ${a}`).join('\n')}\n`
    : '';
  // Phase C: factual package composition. Empty/absent → '' → the prompt is byte-identical to
  // today's (unit-asserted), so a missing or malformed lab-packages.json changes nothing.
  const packages = buildLabPackageBlock(labPackages);
  const list = recs
    .map((r, i) =>
      `${i + 1}. id=${r.id} [${r.region}/${r.society}]\n   STATEMENT: ${r.statement}\n   PRECONDITION: ${r.precondition || '(none stated)'}`)
    .join('\n');
  return `${pt}Clinical scenario / proposed plan:\n${ctx.scenario.trim()}\n${picture}${actions}${packages}\nCandidate recommendations to judge:\n${list}`;
}

const VERDICTS = new Set<Verdict>(['applies', 'does_not_apply', 'insufficient_info']);

/** Tolerant parse of the judge response. Any rec not returned → insufficient_info (never fires). */
export function parseJudgeResponse(text: string, recs: LvcRecommendation[]): JudgedRec[] {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const result = new Map<string, JudgedRec>();
  const arr = extractJsonArray(text);
  if (Array.isArray(arr)) {
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : '';
      const rec = byId.get(id);
      if (!rec) continue;
      let verdict = String(o.verdict ?? '').toLowerCase().trim() as Verdict;
      if (!VERDICTS.has(verdict)) verdict = 'insufficient_info';
      let confidence = Number(o.confidence);
      if (!Number.isFinite(confidence)) confidence = 0;
      confidence = Math.max(0, Math.min(1, confidence));
      // A non-"applies" verdict never fires, so its confidence is irrelevant; null it to 0 for clarity.
      if (verdict !== 'applies') confidence = 0;
      const why = typeof o.why === 'string' ? o.why.trim() : '';
      const ci = typeof o.consider_instead === 'string' && o.consider_instead.trim()
        ? o.consider_instead.trim()
        : null;
      result.set(id, { rec, verdict, confidence, why, consider_instead: ci });
    }
  }
  // Default any unjudged rec to insufficient_info.
  return recs.map((r) => result.get(r.id) ?? {
    rec: r, verdict: 'insufficient_info' as Verdict, confidence: 0, why: '', consider_instead: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// shared JSON extraction (tolerant of ```json fences and surrounding prose)
// ─────────────────────────────────────────────────────────────────────────────

export function extractJsonArray(text: string): unknown {
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
