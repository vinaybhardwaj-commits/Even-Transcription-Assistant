/**
 * Pure core for Right Care LVC rule identity (RIGHT-CARE-INDICATOR-PRD §5). NO db / Next imports.
 *   - engine stamp helper (stampLvcMetadata): called by the orchestrator after finding identity to
 *     add rule_ref (null — the OPD engine has no wired lvc_recommendations matcher) + lvc_category to
 *     every low-value, non-informational finding. signal_type:'low_value_care' is set in the pure
 *     stampFindingIdentity (it feeds finding_ref); category/rule_ref are additive, so they live here.
 *   - read-time fallback classifier: older-engine rows classify their low-value findings by verdict
 *     tier (authoritative) + subject text-match to the 29 lvc_recommendations rules (rule_ref null-safe).
 *   - precision gate: exclude findings whose rule_ref has a CURRENT 'suppress' ledger decision
 *     (cluster_key convention lvc:<rule_ref>). v1 default: nothing suppressed → all 29 count.
 */

// 0.81.8 Part B — the taxonomy now sub-tags the residual `other` bucket. The 3 base categories keep their
// authoritative early-returns; the 8 overuse sub-tags (priority order) split what used to be `other`; an
// omission-type finding stays `other` (Decision 7 drops safety_netting_gap / dx_complaint_mismatch). All
// metadata — never touches verdict/domain/score. `other` stays last so it remains the catch-all.
export const LVC_BASE_CATEGORIES = ['antibiotic', 'imaging', 'supplement_polypharmacy'] as const;
export const LVC_OVERUSE_TAGS = [
  'therapeutic_duplication', 'systemic_steroid', 'gi_ppi_prokinetic', 'antihistamine_allergy',
  'nsaid_analgesic', 'cough_cold_fdc', 'cough_expectorant', 'unindicated_investigation',
] as const;
export const LVC_CATEGORIES = [...LVC_BASE_CATEGORIES, ...LVC_OVERUSE_TAGS, 'other'] as const;
export type LvcCategory = (typeof LVC_CATEGORIES)[number];

/** Shared human labels for every category (Decision 10) — every UI surface + MCP enum reads THIS so no
 *  surface renders a raw slug. Kept here (the pure core) so it has no runtime dependency. */
export const LVC_CATEGORY_LABELS: Record<string, string> = {
  antibiotic: 'Antibiotic',
  imaging: 'Imaging',
  supplement_polypharmacy: 'Supplement / polypharmacy',
  therapeutic_duplication: 'Therapeutic duplication',
  systemic_steroid: 'Systemic steroid',
  gi_ppi_prokinetic: 'GI acid-suppressant / prokinetic',
  antihistamine_allergy: 'Antihistamine / anti-allergy',
  nsaid_analgesic: 'NSAID / analgesic',
  cough_cold_fdc: 'Cough-cold combination',
  cough_expectorant: 'Cough expectorant / mucolytic',
  unindicated_investigation: 'Unindicated investigation',
  other: 'Other low-value',
};

// Category heuristic (kept deliberately small; the engine stamp + the read-time fallback share it).
const ANTIBIOTIC_RE = /\bantibiotic|antimicrobial|amoxicillin|amoxyclav|azithromycin|cefixime|cefpodoxime|cefuroxime|ceftriaxone|ciprofloxacin|levofloxacin|ofloxacin|doxycycline|metronidazole|clarithromycin|augmentin|penicillin|cephalosporin|fluoroquinolone|nitrofurantoin\b/i;
const IMAGING_RE = /\b(x-?ray|radiograph|ct scan|\bct\b|mri|ultrasound|\busg\b|sonograph|imaging|neuroimaging|\bscan\b)\b/i;
const SUPPLEMENT_RE = /\b(supplement|multivitamin|nutraceutical|polypharmac|\bvitamin\b|\btonic\b|probiotic|nutritional|antioxidant|enzyme preparation)\b/i;

// 0.81.8 overuse sub-tags (only applied to what would otherwise be `other`).
// Omission-type findings (a missing safety-net, a dx/complaint mismatch, an undocumented X) are NOT overuse
// — they stay `other` so the 8 tags stay a clean "too much treatment" taxonomy (Decision 7).
const OMISSION_RE = /\b(missing|absent|not documented|undocumented|no follow[- ]?up|safety[- ]?net|failed to|should have|lack(?:s|ing)?|omitted|without documenting|no mention|mismatch|discrepan|not (?:specified|mentioned|recorded))\b/i;
const THERAP_DUP_RE = /\b(duplicat|same class|two .*same|therapeutic duplication|overlapping therap|concurrent .*same)\b/i;
const STEROID_RE = /\b(prednisolone|prednisone|methylprednisolone|dexamethasone|betamethasone|deflazacort|systemic steroid|oral steroid|corticosteroid)\b/i;
const GI_PPI_RE = /\b(omeprazole|pantoprazole|esomeprazole|rabeprazole|lansoprazole|dexlansoprazole|\bppi\b|proton pump|domperidone|metoclopramide|itopride|levosulpiride|prokinetic|antacid|acid suppress)\b/i;
const ANTIHISTAMINE_RE = /\b(cetirizine|levocetirizine|loratadine|desloratadine|fexofenadine|chlorpheniramine|chlorphenamine|hydroxyzine|bilastine|ebastine|pheniramine|antihistamine|montelukast|anti[- ]?allerg)\b/i;
const NSAID_ANALGESIC_RE = /\b(nsaid|diclofenac|aceclofenac|ibuprofen|naproxen|paracetamol|acetaminophen|analgesic|nimesulide|etoricoxib|ketorolac|mefenamic|tramadol|non[- ]?steroidal)\b/i;
const COUGH_COLD_FDC_RE = /\b(cough (?:and|&|\/|-) ?cold|cold fdc|cough[- ]cold|phenylephrine|pseudoephedrine|combination cough|multi[- ]?ingredient cough|cough syrup .*(?:antihistamine|decongestant))\b/i;
const COUGH_EXPECTORANT_RE = /\b(expectorant|mucolytic|ambroxol|bromhexine|guaifenesin|guaiphenesin|acebrophylline|terbutaline syrup|antitussive|dextromethorphan|codeine (?:linctus|syrup))\b/i;
const UNINDICATED_INVEST_RE = /\b(unindicated|unnecessary|not indicated|low[- ]yield|routine)\b[^.]*\b(test|investigation|panel|profile|screen|serolog|assay|blood work)|\b(test|investigation|panel|profile|serolog|assay)\b[^.]*\b(unindicated|unnecessary|not indicated|low[- ]yield)\b/i;

/**
 * Classify an LVC finding into a category from its text. 0.81.8: the 3 base categories (authoritative
 * early-returns) are unchanged; below them the residual `other` is split into 8 overuse sub-tags by priority
 * order, unless the finding is an omission (→ stays `other`). Metadata only.
 */
export function classifyLvcCategory(subject: string | undefined, rationale?: string | null): LvcCategory {
  const hay = `${subject || ''} ${rationale || ''}`.toLowerCase();
  if (ANTIBIOTIC_RE.test(hay)) return 'antibiotic';
  if (IMAGING_RE.test(hay)) return 'imaging';
  if (SUPPLEMENT_RE.test(hay)) return 'supplement_polypharmacy';
  // residual `other` → overuse sub-tags (Part B). Omission-type findings are not overuse.
  if (OMISSION_RE.test(hay)) return 'other';
  if (THERAP_DUP_RE.test(hay)) return 'therapeutic_duplication';
  if (STEROID_RE.test(hay)) return 'systemic_steroid';
  if (GI_PPI_RE.test(hay)) return 'gi_ppi_prokinetic';
  if (ANTIHISTAMINE_RE.test(hay)) return 'antihistamine_allergy';
  if (NSAID_ANALGESIC_RE.test(hay)) return 'nsaid_analgesic';
  if (COUGH_COLD_FDC_RE.test(hay)) return 'cough_cold_fdc';
  if (COUGH_EXPECTORANT_RE.test(hay)) return 'cough_expectorant';
  if (UNINDICATED_INVEST_RE.test(hay)) return 'unindicated_investigation';
  return 'other';
}

/** The low-value verdict tier is the authoritative LVC signal (§5 / §8). */
export function isLowValueVerdict(verdict: unknown): boolean { return verdict === 'low-value'; }

// A structural finding shape — avoids a runtime import of OpdFinding (keeps this core dependency-free).
export type ClassifiableFinding = {
  verdict?: string; subject?: string; rationale?: string | null; informational?: boolean;
  signal_type?: string; rule_ref?: string | null; lvc_category?: string;
};

// A minimal lvc_recommendations shape for the read-time text-match fallback + engine matcher.
export type LvcRuleLite = { id: string; keywords?: string[] | null; statement?: string | null; category?: string | null };

/**
 * Engine stamp: add rule_ref + lvc_category to every low-value, non-informational finding. Applied by
 * the orchestrator AFTER neutralizeMetadataFindings so neutralised (informational) findings are skipped.
 * Additive only — never touches verdict/confidence/domain (score invariance).
 *
 * 0.81.4 (decision 14): when `rules` are supplied, run the SAME deterministic keyword-containment
 * matcher as the read-time fallback (first rule whose any-keyword hits the subject+rationale haystack
 * wins) and stamp rule_ref:<id> + the rule's category when valid. No rules → rule_ref stays null
 * (the 0.81.3 behaviour) — never blocks. NO LLM, NO scoring impact.
 */
export function stampLvcMetadata<T extends ClassifiableFinding>(findings: T[], rules: LvcRuleLite[] = []): T[] {
  return findings.map((f) => {
    if (f.informational || !isLowValueVerdict(f.verdict)) return f;
    const rule = rules.length ? matchRule(f, rules) : null;
    const cat = (rule && asCategory(rule.category)) ?? classifyLvcCategory(f.subject, f.rationale);
    return { ...f, rule_ref: rule ? rule.id : (f.rule_ref ?? null), lvc_category: cat } as T;
  });
}

export type LvcClassified = { is_lvc: boolean; rule_ref: string | null; lvc_category: LvcCategory; stamped: boolean };

const asCategory = (v: unknown): LvcCategory | null =>
  (LVC_CATEGORIES as readonly string[]).includes(String(v)) ? (v as LvcCategory) : null;

/** Public matcher (backfill): the rule id a finding keyword-matches, or null. Same v3.1 semantics as the
 *  engine stamp + read-time fallback — OR across a rule's keyword phrases, longest matched phrase wins
 *  when it wins ALONE; a tie at the top specificity yields null. */
export function matchLvcRule(f: ClassifiableFinding, rules: LvcRuleLite[]): string | null {
  const r = matchRule(f, rules);
  return r ? r.id : null;
}

// ── matcher v3 (decision 25) — ONE implementation used by the engine stamp, the read-time fallback,
// and the backfill. Each KEYWORD is a phrase; keywords in a rule are ALTERNATIVE triggers:
//   · a KEYWORD matches iff EVERY whitespace-split token of it is a WHOLE WORD (case-insensitive,
//     `\b…\b`, special chars escaped) in the subject+rationale haystack; empty keyword → false.
//   · a RULE matches iff ANY of its keywords matches (was v2: EVERY keyword — wrong for the corpus,
//     where CW rules list alternative trigger phrases, so ALL-keywords left 744 findings unmatchable).
//   · specificity: across matching rules the winner is the one whose BEST-matching keyword has the MOST
//     tokens (longest matched phrase = most specific); a TIE at the top token count → null (v3.1,
//     rule-attribution fix D1/D2 — ambiguity is never broken by rule id; a lone match still wins).
//   · zero-keyword / empty-token rules never match. No LLM.
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** De-duped, non-empty keyword phrases for a rule (lowercased/trimmed). */
function ruleKeywords(r: LvcRuleLite): string[] {
  return Array.from(new Set((r.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean)));
}
/** A keyword phrase matches iff every whitespace-split token is a whole word in the haystack. */
function keywordMatches(hay: string, keyword: string): boolean {
  const tokens = keyword.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((t) => new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(hay));
}
/** Token count of a rule's BEST-matching keyword (longest matched phrase), or 0 if none match. */
function bestMatchedTokens(hay: string, kws: string[]): number {
  let best = 0;
  for (const k of kws) {
    if (keywordMatches(hay, k)) {
      const n = k.split(/\s+/).filter(Boolean).length;
      if (n > best) best = n;
    }
  }
  return best;
}
/** Match a finding to a rule (v3.1). Longest matched phrase wins ONLY when it wins alone: a genuine
 *  tie between rules at the top specificity — at any token count — yields null (rule-attribution fix
 *  D1/D2: an ambiguous attribution is a guess, and the old lowest-id-ASC tiebreak made one rule a
 *  catch-all). A single rule matching alone, even on a 1-token keyword, still wins outright. */
function matchRule(f: ClassifiableFinding, rules: LvcRuleLite[]): LvcRuleLite | null {
  const hay = `${f.subject || ''} ${f.rationale || ''}`;
  let winner: LvcRuleLite | null = null, winTokens = 0, tied = false;
  for (const r of rules) {
    const kws = ruleKeywords(r);
    if (!kws.length) continue;
    const tok = bestMatchedTokens(hay, kws);
    if (tok === 0) continue;                              // no keyword of this rule matched
    if (tok > winTokens) { winner = r; winTokens = tok; tied = false; }
    else if (tok === winTokens) tied = true;              // ≥2 rules at the best specificity → ambiguous
  }
  return tied ? null : winner;
}

/**
 * Read-time classify: is this finding LVC, and with what rule_ref + category? Verdict tier is
 * authoritative. Stamped rows (signal_type='low_value_care') pass their metadata through; older rows
 * fall back to a text-match against the provided rules, else the category heuristic + rule_ref null.
 */
export function classifyLvcFinding(f: ClassifiableFinding, rules: LvcRuleLite[] = []): LvcClassified {
  if (f.informational || !isLowValueVerdict(f.verdict)) {
    return { is_lvc: false, rule_ref: null, lvc_category: 'other', stamped: false };
  }
  if (f.signal_type === 'low_value_care') {
    const cat = asCategory(f.lvc_category) ?? classifyLvcCategory(f.subject, f.rationale);
    return { is_lvc: true, rule_ref: f.rule_ref ?? null, lvc_category: cat, stamped: true };
  }
  const rule = matchRule(f, rules);
  const cat = (rule && asCategory(rule.category)) ?? classifyLvcCategory(f.subject, f.rationale);
  return { is_lvc: true, rule_ref: rule ? rule.id : null, lvc_category: cat, stamped: false };
}

// ── precision gate (§5) ──────────────────────────────────────────────────────────
/**
 * The set of rule_refs suppressed by a CURRENT ledger decision. Pass the latest decision per
 * cluster_key (opd_feedback_adjudications); cluster_key convention is `lvc:<rule_ref>`.
 */
export function suppressedRuleRefs(ledger: Array<{ cluster_key?: string; decision?: string }> | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const row of ledger || []) {
    if (row?.decision === 'suppress' && typeof row.cluster_key === 'string' && row.cluster_key.startsWith('lvc:')) {
      const ref = row.cluster_key.slice(4).trim();
      if (ref) out.add(ref);
    }
  }
  return out;
}

/** Gate filter: drop classified findings whose rule_ref is suppressed. Findings with rule_ref null are kept. */
export function applyGate<T extends { rule_ref: string | null }>(classified: T[], suppressed: Set<string>): T[] {
  if (suppressed.size === 0) return classified;
  return classified.filter((c) => !(c.rule_ref && suppressed.has(c.rule_ref)));
}
