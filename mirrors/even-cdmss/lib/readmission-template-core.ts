/**
 * lib/readmission-template-core.ts — PURE flatten + hop planning + coverage reducer for
 * KX clinical templates as SOURCE 4 of the readmission evidence catalog
 * (CDMSS-READMISSIONS-R2-PRD v1.0 §3.2/§3.4; CDMSS-PRD-READMISSION-KX-TEMPLATES v0.2
 * T-2..T-6, T-12; R2 constraints 13-17). PR A only: OT / PAC / progress.
 *
 * ZERO db, ZERO model, ZERO React. lib/readmission/db13.ts fetches rows (fail-safe),
 * lib/readmission/assemble.ts de-identifies (the ONLY PHI choke point) and slots the
 * items into the catalog; THIS file decides what a row contributes, which hops a
 * fetch must run, and what the five-state coverage object says.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   · patient_name / patient_mobile — never selected, never modelled on the row type.
 *   · deidText — nothing here is de-identified; assemble.ts does that to EVERY string
 *     (facts included) before anything reaches the catalog or a chip counts as present.
 *   · Any notion of "no OT row = uneventful". A missing template is UNKNOWN / ABSENT,
 *     never a negative intra-op finding (T-5).
 */

// ── the row as db13.ts hands it over (only the columns the SELECT names) ─────────

export type TemplateSource = 'ot_note' | 'pac_note' | 'progress_note';

export interface KxTemplateRow {
  uid: string | null;
  encounterId: string | null;
  uhid: string | null;
  templateName: string | null;
  status: string | null;
  createdAt: string | null;
  /** First-class OT column (97/97 filled). Null on PAC / progress. */
  surgeryName: string | null;
  /** The rendered template dump — the narrative. */
  note: string | null;
  /** KX `{name, valueString}` array as TEXT (may be invalid JSON, may be null). */
  componentJson: string | null;
}

// ── allowlist + caps (templates PRD §3/§4.1, R2 PRD §3.2) ────────────────────────

/** OT `component_json` names with a human meaning AND real fill (templates PRD §3).
 *  Everything else — `TF-7835`, `KSNC`, PAC `Allergies220` (0/47) — is dropped. */
export const OT_FACT_ALLOWLIST: readonly string[] = [
  'surgery-name', 'surgeaon_ot_notes', 'ot-from', 'ot-to', 'special-equpiments',
  'ptnt_position', 'right-left', 'ans', 'opfinf', 'assist_notes', 'incision-plan',
];

/** Human labels for the allowlisted OT names (the catalog reads them, the model too). */
export const OT_FACT_LABELS: Readonly<Record<string, string>> = {
  'surgery-name': 'surgery', 'surgeaon_ot_notes': 'surgeon OT notes', 'ot-from': 'OT from', 'ot-to': 'OT to',
  'special-equpiments': 'special equipment', 'ptnt_position': 'patient position', 'right-left': 'side',
  'ans': 'anaesthesia', 'opfinf': 'operative findings', 'assist_notes': 'assistant notes', 'incision-plan': 'incision plan',
};

/** Narrative truncation BEFORE de-identification (INFERRED caps, R2 PRD §3.2). */
export const TEMPLATE_NARRATIVE_CAP: Readonly<Record<TemplateSource, number>> = {
  ot_note: 2000, pac_note: 2000, progress_note: 800,
};

/** Row caps per stay (templates PRD §4.1). Progress is oldest-first so the catalog does
 *  not drown the recon in ward chatter. */
export const TEMPLATE_ROW_CAP: Readonly<Record<TemplateSource, number>> = { ot_note: 20, pac_note: 5, progress_note: 40 };

/** Evidence-id prefixes — must not collide with the catalog's existing S R L LX M IX RX T F. */
export const TEMPLATE_ID_PREFIX: Readonly<Record<TemplateSource, string>> = { ot_note: 'OT', pac_note: 'PAC', progress_note: 'P' };

// ── flatten ──────────────────────────────────────────────────────────────────────

export interface TemplateFact { name: string; value: string }

export interface FlattenedTemplate {
  source: TemplateSource;
  side: 'index' | 'readmit';
  at: string | null;
  templateName: string | null;
  surgeryName: string | null;
  /** Allowlisted, non-empty facts only (OT); always [] for PAC / progress in PR A. */
  facts: TemplateFact[];
  /** The `note`, trimmed and truncated. NOT de-identified here. */
  narrative: string;
}

const s = (v: unknown): string | null => (v == null ? null : String(v).trim() === '' ? null : String(v).trim());

/** Parse KX component_json defensively: anything that is not an array of {name, valueString}
 *  objects yields [] and the caller keeps the `note`. Never throws. */
export function parseComponentJson(raw: unknown): TemplateFact[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  const out: TemplateFact[] = [];
  for (const el of parsed) {
    if (!el || typeof el !== 'object') continue;
    const name = s((el as Record<string, unknown>).name);
    const value = s((el as Record<string, unknown>).valueString);
    if (name && value) out.push({ name, value });
  }
  return out;
}

/** OT facts: allowlist only, in allowlist order, deduped by name (first wins). The
 *  first-class `surgery_name` column stands in for `surgery-name` when the json lacks it. */
export function allowlistedOtFacts(facts: TemplateFact[], surgeryName: string | null): TemplateFact[] {
  const byName = new Map<string, string>();
  for (const f of facts) if (OT_FACT_ALLOWLIST.includes(f.name) && !byName.has(f.name)) byName.set(f.name, f.value);
  if (!byName.has('surgery-name') && surgeryName) byName.set('surgery-name', surgeryName);
  return OT_FACT_ALLOWLIST.filter((n) => byName.has(n)).map((n) => ({ name: n, value: byName.get(n)! }));
}

export function flattenTemplateRow(row: KxTemplateRow, source: TemplateSource, side: 'index' | 'readmit'): FlattenedTemplate {
  const note = s(row.note) ?? '';
  const cap = TEMPLATE_NARRATIVE_CAP[source];
  const narrative = note.length > cap ? `${note.slice(0, cap)}…` : note;
  // PAC and progress contribute `note` only in PR A (templates PRD §4.2 / T-4).
  const facts = source === 'ot_note' ? allowlistedOtFacts(parseComponentJson(row.componentJson), s(row.surgeryName)) : [];
  return {
    source, side,
    at: s(row.createdAt),
    templateName: s(row.templateName),
    surgeryName: source === 'ot_note' ? s(row.surgeryName) : null,
    facts,
    narrative,
  };
}

/** Constraint 13-14: usable = nonempty trimmed narrative OR an allowlisted fact with a
 *  nonempty value. Judged on whatever text the caller passes (assemble passes the
 *  DE-IDENTIFIED flattened row, so a chip never counts as present on raw text). */
export function hasUsableText(f: Pick<FlattenedTemplate, 'narrative' | 'facts'>): boolean {
  return f.narrative.trim() !== '' || f.facts.some((x) => x.value.trim() !== '');
}

// ── hop planning (templates PRD §2 / T-3; constraints 15-16) ─────────────────────

export type TemplateHop =
  | { kind: 'encounter'; encounterId: string }
  | { kind: 'uhid_ipdno'; uhid: string; ipdNo: string }               // discharged-history fallback
  | { kind: 'uhid_window'; uhid: string; fromTs: string; toTs: string }; // PAC pre-admit OPR / OPVST

/**
 * OT / progress: encounter_id (current ADT hop) is PRIMARY; the discharged-history hop
 * (uhid + ipd_no) is the FALLBACK, run only when the primary yields nothing and a
 * discharge row exists. Returned in run order.
 */
export function planOtProgressHops(args: { encounterId: string; fallback: { uhid: string | null; ipdNo: string | null } | null }): TemplateHop[] {
  const hops: TemplateHop[] = [{ kind: 'encounter', encounterId: args.encounterId }];
  if (args.fallback?.uhid && args.fallback.ipdNo) hops.push({ kind: 'uhid_ipdno', uhid: args.fallback.uhid, ipdNo: args.fallback.ipdNo });
  return hops;
}

/**
 * Readmit-side discharged-history fallback (R2 Addendum A1). Built ONLY from the READMIT
 * stay's own discharge-summary row — its `uhid` + `ipd_no` — never from the readmit
 * encounter id itself (that is the primary hop; re-querying it as the fallback is a no-op).
 * No readmit summary row (a still-admitted or never-summarised return stay) → null: the
 * fallback is skipped rather than faked. `uhidHint` (the finding row's uhid) fills in only
 * when the summary row carries no uhid.
 */
export function readmitFallbackFrom(
  summary: { uhid: string | null; ipdNo: string | null } | null | undefined,
  uhidHint: string | null,
): { uhid: string; ipdNo: string } | null {
  if (!summary?.ipdNo) return null;
  const uhid = summary.uhid ?? uhidHint;
  return uhid ? { uhid, ipdNo: summary.ipdNo } : null;
}

/**
 * PAC: TWO hops, BOTH always run, union deduped by uid — the encounter hop (the 19/47 IP
 * hits) AND the uhid window `[index.admitAt − 30d, index.dischargeAt]` (the OPR / OPVST
 * majority). PAC is NEVER joined on encounter alone (T-3, constraint 15). No uhid → the
 * window hop cannot run and only the encounter hop is planned — the caller records that
 * PAC coverage then rests on one hop.
 */
export function planPacHops(args: { encounterId: string; uhid: string | null; window: { fromTs: string; toTs: string } | null }): TemplateHop[] {
  const hops: TemplateHop[] = [{ kind: 'encounter', encounterId: args.encounterId }];
  if (args.uhid && args.window) hops.push({ kind: 'uhid_window', uhid: args.uhid, fromTs: args.window.fromTs, toTs: args.window.toTs });
  return hops;
}

const DAY = 86_400_000;
/** The PAC pre-admit window (INFERRED, templates PRD §2): [admit − 30d, discharge]. Null
 *  when either end is unknown — a window is never guessed. */
export function pacWindow(admitAt: string | null, dischargeAt: string | null): { fromTs: string; toTs: string } | null {
  const a = admitAt ? Date.parse(/^\d{4}-\d{2}-\d{2} /.test(admitAt) ? admitAt.replace(' ', 'T') : admitAt) : NaN;
  const d = dischargeAt ? Date.parse(/^\d{4}-\d{2}-\d{2} /.test(dischargeAt) ? dischargeAt.replace(' ', 'T') : dischargeAt) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(d)) return null;
  return { fromTs: new Date(a - 30 * DAY).toISOString(), toTs: new Date(d).toISOString() };
}

/** Union of hop results, deduped by uid (rows without a uid are kept — they cannot collide). */
export function dedupTemplateRows(rows: KxTemplateRow[]): KxTemplateRow[] {
  const seen = new Set<string>();
  const out: KxTemplateRow[] = [];
  for (const r of rows) {
    if (r.uid) { if (seen.has(r.uid)) continue; seen.add(r.uid); }
    out.push(r);
  }
  return out;
}

// ── coverage — the honesty object (R2 PRD §3.4; constraints 13-16, 21) ───────────

export type TemplateCoverageStatus = 'present' | 'empty' | 'absent' | 'fetch_failed';
export interface TemplateCoverageEntry { status: TemplateCoverageStatus; count: number }
export interface TemplateCoverage { ot: TemplateCoverageEntry; pac: TemplateCoverageEntry; progress: TemplateCoverageEntry }

export type TemplateFetchOutcome = 'ok' | 'fetch_failed';
export interface TemplateFetchOutcomes { ot_note: TemplateFetchOutcome; pac_note: TemplateFetchOutcome; progress_note: TemplateFetchOutcome }

export const COVERAGE_KEY: Readonly<Record<TemplateSource, keyof TemplateCoverage>> = { ot_note: 'ot', pac_note: 'pac', progress_note: 'progress' };

/**
 * One source's coverage. `count` = matched rows for this case (both stays, both hops,
 * usable or not) — the number a care manager reads as "N rows in db13".
 *   present      looked, ≥1 row with usable text
 *   empty        looked, rows exist, none usable (progress measures 151/811 blank)
 *   absent       looked, no row on any hop
 *   fetch_failed the query faulted — a fault is NEVER absent
 * Never-looked (tier-3 / pre-R2) is not a state here: the caller leaves the object off
 * the finding and the chip reads `unknown`.
 */
export function coverageFor(outcome: TemplateFetchOutcome, rows: Array<Pick<FlattenedTemplate, 'narrative' | 'facts'>>): TemplateCoverageEntry {
  if (outcome === 'fetch_failed') return { status: 'fetch_failed', count: 0 };
  if (!rows.length) return { status: 'absent', count: 0 };
  return { status: rows.some(hasUsableText) ? 'present' : 'empty', count: rows.length };
}

/** The whole object from per-source outcomes + the (de-identified) flattened rows. */
export function reduceTemplateCoverage(outcomes: TemplateFetchOutcomes, rows: Array<Pick<FlattenedTemplate, 'source' | 'narrative' | 'facts'>>): TemplateCoverage {
  const by = (src: TemplateSource) => rows.filter((r) => r.source === src);
  return {
    ot: coverageFor(outcomes.ot_note, by('ot_note')),
    pac: coverageFor(outcomes.pac_note, by('pac_note')),
    progress: coverageFor(outcomes.progress_note, by('progress_note')),
  };
}
