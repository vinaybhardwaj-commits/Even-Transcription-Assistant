// Shared observability taxonomy — gives every CAT feature and every trace-event
// kind a readable label, a group, and a colour, so the admin surfaces can render
// the whole system (not just the 7 original modules) consistently.
// Pure data + helpers. No deps.

export type FeatureGroup = 'Decision support' | 'Right Care' | 'Audit' | 'Learn' | 'Reference' | 'System';

export interface FeatureMeta { label: string; group: FeatureGroup; color: string }

const RIGHT_CARE = '#b45309';   // warm amber-brown — Right Care family
const DECISION = '#0f766e';     // teal — core decision support
const CALC = '#0e7490';         // cyan-teal — calculators
const LEARN = '#534ab7';        // violet — learn/education
const REF = '#595346';          // warm grey — reference
const AUDIT = '#9a4827';        // coral — pharmacist medication audit
const SYS = '#78715f';          // muted — system/other

// Exact-feature map. Families (coach_*, calc names, drugs_*) are normalised below.
const MAP: Record<string, FeatureMeta> = {
  ask: { label: 'Ask', group: 'Decision support', color: DECISION },
  ddx: { label: 'Differential', group: 'Decision support', color: DECISION },
  drugs_lookup: { label: 'Drugs · lookup', group: 'Decision support', color: DECISION },
  drugs_interactions: { label: 'Drugs · interactions', group: 'Decision support', color: DECISION },

  appropriateness_value: { label: 'Right Care · Order check (value)', group: 'Right Care', color: RIGHT_CARE },
  appropriateness: { label: 'Right Care · Order check (flags)', group: 'Right Care', color: RIGHT_CARE },
  pathway: { label: 'Right Care · Care pathway (skeleton)', group: 'Right Care', color: RIGHT_CARE },
  pathway_enrich: { label: 'Right Care · Care pathway (enrich)', group: 'Right Care', color: RIGHT_CARE },
  doc_audit_extract: { label: 'Right Care · Record audit (read)', group: 'Right Care', color: RIGHT_CARE },
  doc_audit: { label: 'Right Care · Record audit (analyze)', group: 'Right Care', color: RIGHT_CARE },

  med_audit: { label: 'Medication Audit', group: 'Audit', color: AUDIT },

  search: { label: 'Knowledge base', group: 'Reference', color: REF },
  topics: { label: 'Topic guides', group: 'Learn', color: LEARN },
  practice: { label: 'Practice', group: 'Learn', color: LEARN },
  coach: { label: 'Coach', group: 'Learn', color: LEARN },
  digest_generate: { label: 'Shift digest', group: 'Learn', color: LEARN },
  calculators: { label: 'Calculators', group: 'Decision support', color: CALC },
};

const CALC_FEATURES = new Set([
  'egfr', 'news2', 'abg', 'hyponatremia', 'sepsis_bundle', 'nihss', 'abcd2', 'curb65',
  'wells_dvt', 'wells_pe', 'heart', 'timi', 'sofa', 'qtc', 'alvarado', 'calc_sidebar',
]);

/** Canonical key for grouping/filtering (collapses families). */
export function normalizeFeature(feature: string): string {
  if (!feature) return 'other';
  if (feature.startsWith('coach')) return 'coach';
  if (feature.startsWith('drugs')) return feature; // keep lookup vs interactions distinct in detail
  if (CALC_FEATURES.has(feature)) return 'calculators';
  return feature;
}

export function featureMeta(feature: string): FeatureMeta {
  const key = normalizeFeature(feature);
  if (MAP[key]) return MAP[key];
  if (MAP[feature]) return MAP[feature];
  // Unknown feature: humanise + neutral colour.
  return { label: humanize(feature), group: 'System', color: SYS };
}

/** Filter options for the observability list, grouped. */
export const FEATURE_FILTERS: { value: string; label: string; group: FeatureGroup }[] = [
  { value: 'ask', label: 'Ask', group: 'Decision support' },
  { value: 'ddx', label: 'Differential', group: 'Decision support' },
  { value: 'drugs_lookup', label: 'Drugs · lookup', group: 'Decision support' },
  { value: 'drugs_interactions', label: 'Drugs · interactions', group: 'Decision support' },
  { value: 'calculators', label: 'Calculators', group: 'Decision support' },
  { value: 'appropriateness_value', label: 'Right Care · Order check (value)', group: 'Right Care' },
  { value: 'appropriateness', label: 'Right Care · Order check (flags)', group: 'Right Care' },
  { value: 'pathway', label: 'Right Care · Care pathway', group: 'Right Care' },
  { value: 'pathway_enrich', label: 'Right Care · Pathway enrich', group: 'Right Care' },
  { value: 'doc_audit_extract', label: 'Right Care · Record audit (read)', group: 'Right Care' },
  { value: 'doc_audit', label: 'Right Care · Record audit (analyze)', group: 'Right Care' },
  { value: 'med_audit', label: 'Medication Audit', group: 'Audit' },
  { value: 'search', label: 'Knowledge base', group: 'Reference' },
  { value: 'topics', label: 'Topic guides', group: 'Learn' },
  { value: 'practice', label: 'Practice', group: 'Learn' },
  { value: 'coach', label: 'Coach', group: 'Learn' },
  { value: 'digest_generate', label: 'Shift digest', group: 'Learn' },
];

// ── Trace-event taxonomy ─────────────────────────────────────────────────────
export type EventTone = 'llm' | 'retrieval' | 'source' | 'cost' | 'critique' | 'result' | 'phi' | 'flag' | 'error' | 'neutral';

export interface EventMeta { label: string; tone: EventTone }

const EVENT_MAP: Record<string, EventMeta> = {
  request_received: { label: 'Request received', tone: 'neutral' },
  llm_request: { label: 'LLM request', tone: 'llm' },
  llm_response: { label: 'LLM response', tone: 'llm' },
  llm_response_stream_started: { label: 'LLM stream started', tone: 'llm' },
  llm_response_stream_complete: { label: 'LLM response', tone: 'llm' },
  llm_stream_usage: { label: 'LLM stream usage', tone: 'llm' },
  provider_fallback: { label: 'Provider fallback → Ollama', tone: 'error' },
  llm_error: { label: 'LLM error', tone: 'error' },
  retrieval_hydrated: { label: 'RAG retrieval', tone: 'retrieval' },
  investigation_retrieval: { label: 'Investigation retrieval', tone: 'retrieval' },
  plos_search: { label: 'PLOS search', tone: 'retrieval' },
  critique_parsed: { label: 'Self-critique', tone: 'critique' },
  final_answer: { label: 'Final answer', tone: 'result' },
  // Right Care — Order check (value + flags)
  lvc_recall: { label: 'Recommendation recall', tone: 'retrieval' },
  lvc_candidates: { label: 'Candidate recommendations', tone: 'result' },
  lvc_judge_verdicts: { label: 'Applicability judgement', tone: 'result' },
  lvc_flags: { label: 'Choosing Wisely flags', tone: 'flag' },
  lvc_value_sources: { label: 'Value — sources retrieved', tone: 'source' },
  lvc_value_tariffs: { label: 'Value — EHRC tariffs matched', tone: 'cost' },
  lvc_value_critique: { label: 'Value — self-critique', tone: 'critique' },
  lvc_value_result: { label: 'Value analysis', tone: 'result' },
  // Right Care — Care pathway
  pathway_skeleton_result: { label: 'Pathway skeleton', tone: 'result' },
  pathway_sources: { label: 'Pathway — sources retrieved', tone: 'source' },
  pathway_tariffs: { label: 'Pathway — EHRC tariffs matched', tone: 'cost' },
  pathway_enrich_critique: { label: 'Pathway — self-critique', tone: 'critique' },
  pathway_enrich_result: { label: 'Pathway enrichment', tone: 'result' },
  // Medication Audit
  med_audit_saved: { label: 'Medication audit saved', tone: 'result' },
  // Right Care — Record audit
  doc_audit_extract_result: { label: 'Document read → de-identified extract', tone: 'phi' },
  doc_audit_sources: { label: 'Audit — sources retrieved', tone: 'source' },
  doc_audit_critique: { label: 'Audit — self-critique', tone: 'critique' },
  doc_audit_result: { label: 'Audit report', tone: 'result' },
  // Right Care — PX prognosis pass (PRD v1.0; llm labels doc_audit_prognosis / _critique / _revise ride the generic llm rows)
  doc_audit_prognosis_critique: { label: 'Foreseeability — self-critique', tone: 'critique' },
  doc_audit_prognosis_result: { label: 'Foreseeable outcomes & safety-netting', tone: 'result' },
};

export function eventMeta(kind: string): EventMeta {
  return EVENT_MAP[kind] || { label: humanize(kind), tone: 'neutral' };
}

function humanize(s: string): string {
  if (!s) return '—';
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
