// lib/investigations.ts
// ─────────────────────────────────────────────────────────────────────────────
// Investigation-findings parser (feature: capture investigation results in
// Ask + DDx). A doctor pastes ANY investigation output — labs, imaging, ECG,
// micro, path, POC tests, in any format — and this LLM-driven engine normalises
// it into structured, abnormal-flagged findings that the reasoning pipeline can
// treat as stated patient findings.
//
// Design principles:
//   • Robust to anything: the model parses free text; there is NO fixed test list.
//   • No fabrication: extract only what was written; classify, never diagnose.
//   • FAIL-OPEN: if parsing errors/times out, the verbatim text still flows into
//     reasoning via `promptBlock` so a differential is never blocked. Callers can
//     rely on a non-null result whenever the raw input is non-empty.
//   • Reuses the calling surface's already-warm Ollama model (no new cold-load).
// ─────────────────────────────────────────────────────────────────────────────
import { governedChat, logEvent } from './trace';

export type InvestigationFlag = 'low' | 'normal' | 'high' | 'critical' | 'abnormal' | 'indeterminate';
export type InvestigationCategory = 'lab' | 'imaging' | 'ecg' | 'micro' | 'pathology' | 'vital' | 'other';

export type InvestigationFinding = {
  test: string;
  value: string;
  unit?: string | null;
  flag: InvestigationFlag;
  category: InvestigationCategory;
  note?: string | null;
};

export type ParsedInvestigations = {
  raw: string;
  findings: InvestigationFinding[];
  summary: string;
  /** Short clinical terms for the abnormal findings — used to steer retrieval. */
  abnormalTerms: string[];
  /** Formatted block injected into the reasoning prompt (always includes verbatim text). */
  promptBlock: string;
  /** True when the LLM parse succeeded and produced ≥1 structured finding. */
  structured: boolean;
};

const MAX_RAW = 4000;
const FLAGS = new Set<InvestigationFlag>(['low', 'normal', 'high', 'critical', 'abnormal', 'indeterminate']);
const CATS = new Set<InvestigationCategory>(['lab', 'imaging', 'ecg', 'micro', 'pathology', 'vital', 'other']);

const PARSE_SYSTEM = `You are a clinical data normaliser. You receive a free-text dump of investigation RESULTS (labs, imaging, ECG, microbiology, pathology, point-of-care tests) for ONE patient, plus the patient's age and sex. Convert it into structured JSON.

HARD RULES:
1. Extract ONLY what is written. Never invent a test, value, or result not present in the text. If the text is vague (e.g. "bloods normal"), capture it as ONE finding with that stated meaning — do not expand it into specific named tests.
2. Flag each finding using standard adult reference ranges, adjusted for the patient's age and sex where relevant:
   - "low" / "high"  = numeric value outside the reference range
   - "critical"      = a panic/critical value or an unambiguous emergency result (e.g. troponin clearly elevated, K+ >6.5 or <2.5, ST-elevation on ECG, intracranial haemorrhage, large pneumothorax)
   - "normal"        = within range, or an explicitly normal/negative qualitative result ("no acute bleed", "negative", "unremarkable")
   - "abnormal"      = a qualitative abnormal result with no numeric range (e.g. "consolidation on CXR")
   - "indeterminate" = a value you cannot classify without more context
3. Do NOT diagnose. A short "note" may name the abnormality (e.g. "hyponatraemia", "anterior ST-elevation") but must never assert a final diagnosis.
4. category is one of: lab | imaging | ecg | micro | pathology | vital | other.

Return ONLY this JSON object (no prose, no markdown fences, lowercase keys):
{"summary":"one clause naming the key abnormalities","findings":[{"test":"name","value":"as written","unit":"unit or null","flag":"low|normal|high|critical|abnormal|indeterminate","category":"lab|imaging|ecg|micro|pathology|vital|other","note":"<=8 words or null"}]}`;

function parseLooseJson(s: string): unknown {
  let t = (s || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function coerceFinding(x: unknown): InvestigationFinding | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const test = typeof o.test === 'string' ? o.test.trim() : '';
  if (!test) return null;
  const value = o.value == null ? '' : String(o.value).trim();
  let unit = o.unit == null || o.unit === '' ? null : String(o.unit).trim();
  // Drop the literal "null"/"none"/"n/a"/dash some models emit as a string unit,
  // and de-duplicate a unit the model already baked into the value (e.g. value
  // "0.84 ng/mL" + unit "ng/mL", or value "2 mm" + unit "mm") so the chip reads cleanly.
  if (unit && /^(null|none|n\/?a|nil|-|–|—)$/i.test(unit)) unit = null;
  if (unit && value.toLowerCase().includes(unit.toLowerCase())) unit = null;
  const flagRaw = String(o.flag ?? '').toLowerCase().trim() as InvestigationFlag;
  const catRaw = String(o.category ?? '').toLowerCase().trim() as InvestigationCategory;
  const flag: InvestigationFlag = FLAGS.has(flagRaw) ? flagRaw : 'abnormal';
  const category: InvestigationCategory = CATS.has(catRaw) ? catRaw : 'other';
  const note = o.note == null || o.note === '' ? null : String(o.note).trim().slice(0, 80);
  return { test: test.slice(0, 80), value: value.slice(0, 120), unit: unit ? unit.slice(0, 24) : null, flag, category, note };
}

function flagLabel(f: InvestigationFlag): string {
  return f === 'critical' ? 'CRITICAL'
    : f === 'high' ? 'HIGH'
    : f === 'low' ? 'LOW'
    : f === 'abnormal' ? 'ABNORMAL'
    : f === 'indeterminate' ? '?'
    : 'NORMAL';
}

function buildPromptBlock(findings: InvestigationFinding[], raw: string): string {
  if (findings.length === 0) {
    return `INVESTIGATION RESULTS (already back — treat as stated patient findings; never cite a result not listed here):\nVerbatim as entered: "${raw}"`;
  }
  const lines = findings.map((f) => {
    const valueBit = [f.value, f.unit].filter(Boolean).join(' ');
    const noteBit = f.note ? ` — ${f.note}` : '';
    return `- [${flagLabel(f.flag)}] ${f.test}${valueBit ? ' ' + valueBit : ''}${noteBit}`;
  });
  return [
    'INVESTIGATION RESULTS (already back — treat as STATED patient findings: abnormal results rule diagnoses IN, normal/negative results rule them DOWN; never cite a result not listed here):',
    ...lines,
    `Verbatim as entered: "${raw}"`,
  ].join('\n');
}

// A bare direction/severity word carries no retrieval signal on its own
// (e.g. "elevated", "inconclusive") — these polluted the DDx query embedding.
const GENERIC_TERM = /^(elevated|raised|increased|decreased|reduced|low|high|positive|negative|abnormal|normal|inconclusive|indeterminate|pending|unremarkable|nonspecific|non-specific|mild|moderate|severe|slight|marked|borderline|present|absent)$/i;
const QUALIFIER_PREFIX = /^(mildly|moderately|severely|slightly|markedly|grossly|borderline|mild|moderate|severe|slight|marked|elevated|raised|increased|decreased|reduced|low|high)\s+/i;

function cleanTerm(raw: string): string {
  let t = (raw || '').trim();
  let prev = '';
  // strip leading severity/direction qualifiers: "mild anemia"→"anemia", "elevated ESR"→"ESR"
  while (t !== prev) { prev = t; t = t.replace(QUALIFIER_PREFIX, '').trim(); }
  return t;
}

// Build SPECIFIC clinical terms from the abnormal findings to steer retrieval.
// Skips normals and uninterpretable results, prefers the named abnormality
// (note) over the raw test, and drops bare qualifiers that add only noise.
function deriveAbnormalTerms(findings: InvestigationFinding[]): string[] {
  const terms: string[] = [];
  for (const f of findings) {
    if (f.flag === 'normal' || f.flag === 'indeterminate') continue;
    for (const candidate of [f.note, f.test]) {
      const term = cleanTerm(candidate || '');
      if (term && term.length >= 3 && !GENERIC_TERM.test(term)) { terms.push(term); break; }
    }
  }
  // de-dup, cap to keep the retrieval query bounded
  return Array.from(new Set(terms.map((t) => t.trim()).filter(Boolean))).slice(0, 10);
}

/**
 * Parse a free-text investigation dump into structured, flagged findings.
 * Returns null ONLY when `raw` is empty/whitespace. On any LLM/parse failure it
 * returns a fail-open result whose `promptBlock` carries the verbatim text so the
 * downstream pipeline still receives the investigations.
 */
export async function parseInvestigations(
  raw: string,
  opts: { age?: number | string; sex?: string; model: string; traceId?: string; gemini?: string },
): Promise<ParsedInvestigations | null> {
  const clean = (raw || '').trim();
  if (!clean) return null;
  const bounded = clean.slice(0, MAX_RAW);

  const fallback: ParsedInvestigations = {
    raw: bounded,
    findings: [],
    summary: '',
    abnormalTerms: [],
    promptBlock: buildPromptBlock([], bounded),
    structured: false,
  };

  const ageTxt = opts.age != null && String(opts.age).trim() !== '' ? String(opts.age) : 'not given';
  const sexTxt = opts.sex && opts.sex !== '?' ? String(opts.sex) : 'not given';
  const userMsg = `Patient: age ${ageTxt}, sex ${sexTxt}.\n\nInvestigation results (verbatim):\n${bounded}\n\nOutput the JSON now, starting with {.`;

  let content = '';
  try {
    const params = {
      model: opts.model,
      messages: [
        { role: 'system', content: PARSE_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.1,
      max_tokens: 900,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    };
    // Governed envelope (Stage 4). Traceless callers historically ran LOCAL-ONLY (no gemini)
    // — preserved exactly by withholding the gemini opt when there is no trace.
    const res = await governedChat(opts.traceId, 'investigations_parse', params, {
      gemini: opts.traceId ? opts.gemini : undefined,
      promptRef: 'investigations/PARSE_SYSTEM',
    });
    content = (res as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '';
  } catch (e) {
    if (opts.traceId) await logEvent(opts.traceId, 'investigations_parsed', 'investigations', { raw: bounded, ok: false, error: String((e as Error).message) });
    return fallback;
  }

  try {
    const parsed = parseLooseJson(content) as { summary?: unknown; findings?: unknown };
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map(coerceFinding).filter((f): f is InvestigationFinding => f !== null).slice(0, 40)
      : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 240) : '';
    const abnormalTerms = deriveAbnormalTerms(findings);
    const result: ParsedInvestigations = {
      raw: bounded,
      findings,
      summary,
      abnormalTerms,
      promptBlock: buildPromptBlock(findings, bounded),
      structured: findings.length > 0,
    };
    if (opts.traceId) {
      await logEvent(opts.traceId, 'investigations_parsed', 'investigations', {
        raw: bounded,
        ok: true,
        finding_count: findings.length,
        abnormal_count: findings.filter((f) => f.flag !== 'normal').length,
        summary,
        findings,
        abnormal_terms: abnormalTerms,
      });
    }
    return result;
  } catch (e) {
    if (opts.traceId) await logEvent(opts.traceId, 'investigations_parsed', 'investigations', { raw: bounded, ok: false, parse_error: String((e as Error).message), llm_content: content.slice(0, 600) });
    return fallback;
  }
}
