/**
 * lib/runs-export.ts — Excel export for /appropriateness research runs.
 *
 * buildRunSheets() is PURE (no SheetJS, no DOM) — it turns one run record into a set of
 * NORMALIZED, flat sheet definitions keyed by run_id, so researchers can stack the same
 * sheet across many downloaded files into database tables. Sheets:
 *   Runs · Interventions · CW_Flags · PathwayStages · AuditFindings · Completeness ·
 *   Diff · Suggestions · IdealisedCourse · ExtractedCase · Citations
 * Every child row carries run_id + mode so a UNION across files is unambiguous.
 *
 * downloadRunsExcel() (client-only) loads SheetJS from cdnjs (no bundled dep; CAT has no
 * CSP) and writes a single workbook — for ONE run or MANY runs stacked (admin bulk export).
 * Unit-tested via the pure buildRunSheets.
 */

export interface ExportRun {
  id: string;
  mode: 'check' | 'pathway' | 'audit';
  created_at?: string | null;
  scenario?: string | null;
  // The full result payload as produced by each mode. Loosely typed (it's stored JSON).
  output: Record<string, unknown>;
}

export interface SheetDef { name: string; rows: Record<string, unknown>[] }

// Stable sheet order for the workbook.
export const SHEET_ORDER = [
  'Runs', 'Interventions', 'CW_Flags', 'PathwayStages', 'AuditFindings',
  'Completeness', 'ValueScores', 'Prognosis', 'Diff', 'Suggestions', 'IdealisedCourse', 'ExtractedCase', 'Citations',
] as const;

// ── helpers ──────────────────────────────────────────────────────────────────
function asArr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function obj(v: unknown): Record<string, unknown> { return (v && typeof v === 'object') ? v as Record<string, unknown> : {}; }
function str(v: unknown): string { return v == null ? '' : String(v); }
function joinList(v: unknown, sep = ' | '): string { return asArr(v).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean).join(sep); }
function joinIds(v: unknown): string { return asArr(v).map((x) => String(x)).join(';'); }
function dim(v: unknown): { level: string; detail: string } { const o = obj(v); return { level: str(o.level), detail: str(o.detail) }; }

function tariffStr(v: unknown): string {
  return asArr(v).map((t) => {
    const o = obj(t);
    const price = [o.opd != null ? `₹${o.opd} OPD` : '', o.general != null ? `₹${o.general} gen` : '', o.private != null ? `₹${o.private} priv` : '', o.suite != null ? `₹${o.suite} suite` : ''].filter(Boolean).join('/');
    return `${str(o.code)} ${str(o.item)}${price ? ` (${price})` : ''}`.trim();
  }).filter(Boolean).join(' | ');
}

function altStr(v: unknown): string {
  return asArr(v).map((a) => { const o = obj(a); return o.note ? `${str(o.name)} — ${str(o.note)}` : str(o.name); }).filter(Boolean).join(' | ');
}

function pmidOf(s: Record<string, unknown>): string {
  const url = str(s.url);
  return /pubmed\.ncbi/.test(url) ? str(s.item_number) : '';
}

function citationRows(runId: string, mode: string, sources: unknown): Record<string, unknown>[] {
  return asArr(sources).map((sv) => {
    const s = obj(sv);
    return {
      run_id: runId, mode, n: s.n ?? '', book: str(s.book), chapter: str(s.chapter),
      page_start: s.page_start ?? '', item_number: str(s.item_number), pmid: pmidOf(s),
      url: str(s.url), similarity: s.similarity ?? '', source: str(s.source),
      preview: str(s.preview).slice(0, 500),
    };
  });
}

// ── per-run sheet builder (PURE) ─────────────────────────────────────────────
export function buildRunSheets(run: ExportRun): SheetDef[] {
  const runId = run.id;
  const mode = run.mode;
  const out = obj(run.output);
  const sheets = new Map<string, Record<string, unknown>[]>();
  const push = (name: string, row: Record<string, unknown>) => { const a = sheets.get(name) ?? []; a.push(row); sheets.set(name, a); };

  // master Run row (mode-specific fields filled where present)
  const runRow: Record<string, unknown> = {
    run_id: runId, created_at: str(run.created_at), mode, scenario: str(run.scenario),
  };

  if (mode === 'check') {
    const va = obj(out.valueAnalysis);
    runRow.disclaimer = str(va.disclaimer);
    for (const ivv of asArr(va.interventions)) {
      const iv = obj(ivv);
      const b = dim(iv.long_term_benefit), h = dim(iv.harms_risks), c = dim(iv.upfront_cost), l = dim(iv.long_term_care);
      push('Interventions', {
        run_id: runId, intervention: str(iv.intervention), net_value: str(iv.net_value), confidence: iv.confidence ?? '',
        summary: str(iv.summary),
        benefit_level: b.level, benefit_detail: b.detail, harms_level: h.level, harms_detail: h.detail,
        upfront_cost_level: c.level, upfront_cost_detail: c.detail, longterm_care_level: l.level, longterm_care_detail: l.detail,
        alternatives: altStr(iv.alternatives), what_would_change: joinList(iv.what_would_change),
        evidence: joinList(iv.evidence), estimates: joinList(iv.estimates),
        citation_ids: joinIds(iv.citation_ids), tariffs: tariffStr(iv.tariffs),
      });
    }
    for (const fv of asArr(out.flags)) {
      const f = obj(fv); const cit = obj(f.citation);
      push('CW_Flags', {
        run_id: runId, statement: str(f.statement), society: str(f.society), region: str(f.region), specialty: str(f.specialty),
        why_it_applies: str(f.why_it_applies), consider_instead: str(f.consider_instead), rationale: str(f.rationale),
        confidence: f.confidence ?? '', citation_url: str(cit.url), citation_pmid: str(cit.pmid), citation_doi: str(cit.doi), citation_year: str(cit.year),
      });
    }
    for (const r of citationRows(runId, mode, out.valueSources)) push('Citations', r);
  } else if (mode === 'pathway') {
    const sk = obj(out.skeleton); const enr = obj(out.enrichment);
    runRow.detected_stage = str(sk.detectedStage); runRow.working_diagnosis = str(sk.workingDiagnosis);
    runRow.needs_ddx = sk.needsDdx === true ? 'yes' : 'no'; runRow.pathway_summary = str(sk.summary); runRow.disclaimer = str(enr.disclaimer);
    const byId = new Map<string, Record<string, unknown>>();
    for (const nv of asArr(enr.nodes)) { const n = obj(nv); byId.set(str(n.id), n); }
    asArr(sk.stages).forEach((sv, i) => {
      const s = obj(sv); const e = obj(byId.get(str(s.id)));
      push('PathwayStages', {
        run_id: runId, order_index: i + 1, stage_id: str(s.id), kind: str(s.kind), title: str(s.title), action: str(s.action),
        flag: str(e.flag || s.flag), detail: str(e.detail), decision_criteria: str(e.decisionCriteria),
        order_item: str(e.order), alternatives: altStr(e.alternatives),
        evidence: joinList(e.evidence), estimates: joinList(e.estimates), citation_ids: joinIds(e.citation_ids), tariffs: tariffStr(e.tariffs),
      });
    });
    for (const r of citationRows(runId, mode, out.sources)) push('Citations', r);
  } else {
    const report = obj(out.report); const ex = obj(out.extracted); const comp = obj(report.completeness);
    const af = obj(report.adminFacts ?? ex.adminFacts);
    runRow.doc_type = str((ex.docType ?? ex.detectedDocType));
    runRow.diagnosis = str(ex.diagnosis); runRow.procedure = str(ex.procedure);
    runRow.completeness_pct = comp.coverage != null ? Math.round(Number(comp.coverage) * 100) : '';
    runRow.length_of_stay_days = af.lengthOfStayDays != null ? af.lengthOfStayDays : '';
    runRow.admission_type = str(af.admissionType); runRow.care_setting = str(af.careSetting);
    const vs = obj(report.valueScore);
    runRow.care_value_index = vs.headline != null ? vs.headline : '';
    runRow.care_value_band = str(vs.band);
    runRow.value_confidence = str(vs.confidence);
    runRow.low_value_spend = vs.lowValueSpend != null ? vs.lowValueSpend : '';
    runRow.excess_bed_day_cost = vs.excessBedDayCost != null ? vs.excessBedDayCost : '';
    runRow.room_category_inflation = vs.roomCategoryInflation != null ? vs.roomCategoryInflation : '';
    for (const dv of asArr(vs.domains)) {
      const d = obj(dv);
      push('ValueScores', { run_id: runId, domain: str(d.domain), label: str(d.label), score: d.score ?? '', weight: d.weight ?? '', signals: d.n ?? '', basis: str(d.basis) });
    }
    runRow.idealised_summary = str(report.idealisedSummary); runRow.disclaimer = str(report.disclaimer);
    for (const fv of asArr(report.findings)) {
      const f = obj(fv);
      push('AuditFindings', {
        run_id: runId, subject: str(f.subject), verdict: str(f.verdict), confidence: f.confidence ?? '', rationale: str(f.rationale),
        order_item: str(f.order), evidence: joinList(f.evidence), estimates: joinList(f.estimates), citation_ids: joinIds(f.citation_ids), tariffs: tariffStr(f.tariffs),
      });
    }
    for (const iv of asArr(comp.items)) {
      const it = obj(iv);
      push('Completeness', { run_id: runId, field_key: str(it.key), label: str(it.label), section: str(it.section), nabh_ref: str(it.ref), status: str(it.status), mandatory: it.mandatory === true ? 'yes' : 'no', note: str(it.note) });
    }
    for (const dv of asArr(report.diff)) { const d = obj(dv); push('Diff', { run_id: runId, kind: str(d.kind), text: str(d.text), ref: str(d.ref) }); }
    for (const sv of asArr(report.suggestions)) { const s = obj(sv); push('Suggestions', { run_id: runId, priority: s.priority ?? '', text: str(s.text), ref: str(s.ref) }); }
    for (const sv of asArr(report.idealisedStages)) { const s = obj(sv); push('IdealisedCourse', { run_id: runId, stage_id: str(s.id), kind: str(s.kind), title: str(s.title), action: str(s.action), flag: str(s.flag) }); }
    // PX (PRD v1.0): additive Prognosis sheet — only present when the run carries a prognosis.
    const pxr = obj(report.prognosis);
    if (report.prognosis) {
      runRow.px_version = str(pxr.version);
      runRow.px_unmitigated = pxr.n_unmitigated ?? '';
      runRow.px_summary = str(pxr.summary);
      for (const cv of asArr(pxr.complications)) {
        const cc = obj(cv);
        push('Prognosis', {
          run_id: runId, block: 'complication', item: str(cc.complication),
          likelihood: str(cc.likelihood), severity: str(cc.severity), horizon: str(cc.horizon),
          incidence_note: str(cc.incidence_note),
          modifiers: asArr(cc.modifiers).map((m) => { const mo = obj(m); return `${str(mo.direction) === 'lowers' ? '↓' : '↑'} ${str(mo.factor)}`; }).join(' | '),
          status: '', expected: '', found_in_document: '',
          evidence: joinList(cc.evidence), estimates: joinList(cc.estimates), citation_ids: joinIds(cc.citation_ids), note: '',
        });
      }
      const b = obj(pxr.benefit);
      if (pxr.benefit) {
        push('Prognosis', {
          run_id: runId, block: 'benefit', item: str(b.intended_benefit),
          likelihood: '', severity: '', horizon: str(b.time_to_benefit),
          incidence_note: str(b.success_rate_note), modifiers: '',
          status: str(b.documented_expectation_setting), expected: 'expectation-setting documented for the patient',
          found_in_document: str(b.failure_signature),
          evidence: joinList(b.evidence), estimates: joinList(b.estimates), citation_ids: joinIds(b.citation_ids), note: 'found_in_document column carries the failure signature for benefit rows',
        });
      }
      for (const rv of asArr(pxr.safetyNet)) {
        const rr = obj(rv);
        push('Prognosis', {
          run_id: runId, block: 'safety_net', item: str(rr.risk),
          likelihood: '', severity: '', horizon: '', incidence_note: '', modifiers: '',
          status: str(rr.status), expected: str(rr.expected_mitigation), found_in_document: str(rr.found_in_document),
          evidence: '', estimates: '', citation_ids: '', note: str(rr.note),
        });
      }
    }
    push('ExtractedCase', {
      run_id: runId, doc_type: str(ex.docType ?? ex.detectedDocType), confidence: ex.confidence ?? '',
      patient_age: obj(ex.patient).age ?? '', patient_sex: str(obj(ex.patient).sex),
      diagnosis: str(ex.diagnosis), indication: str(ex.indication), procedure: str(ex.procedure),
      investigations: joinList(ex.investigations), treatments: joinList(ex.treatments), medications: joinList(ex.medications),
      course_summary: str(ex.courseSummary), disposition: str(ex.disposition), follow_up: str(ex.followUp),
    });
    for (const r of citationRows(runId, mode, report.sources)) push('Citations', r);
  }

  const defs: SheetDef[] = [{ name: 'Runs', rows: [runRow] }];
  for (const name of SHEET_ORDER) { if (name === 'Runs') continue; const rows = sheets.get(name); if (rows && rows.length) defs.push({ name, rows }); }
  return defs;
}

/** Merge many runs' sheets into one set, stacking rows by sheet name (admin bulk export). */
export function mergeRunSheets(runs: ExportRun[]): SheetDef[] {
  const merged = new Map<string, Record<string, unknown>[]>();
  for (const run of runs) for (const s of buildRunSheets(run)) { const a = merged.get(s.name) ?? []; merged.set(s.name, a.concat(s.rows)); }
  const defs: SheetDef[] = [];
  for (const name of SHEET_ORDER) { const rows = merged.get(name); if (rows && rows.length) defs.push({ name, rows }); }
  return defs;
}

// ── client-only download (SheetJS from cdnjs) ────────────────────────────────
const XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadXLSX(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.XLSX) return Promise.resolve(w.XLSX);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${XLSX_CDN}"]`);
    if (existing) { existing.addEventListener('load', () => resolve(w.XLSX)); existing.addEventListener('error', reject); return; }
    const s = document.createElement('script');
    s.src = XLSX_CDN; s.async = true;
    s.onload = () => (w.XLSX ? resolve(w.XLSX) : reject(new Error('XLSX failed to load')));
    s.onerror = () => reject(new Error('could not load the spreadsheet library'));
    document.head.appendChild(s);
  });
}

/** Build + download a single .xlsx for one run or many stacked runs. */
export async function downloadRunsExcel(runs: ExportRun[], filename: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX: any = await loadXLSX();
  const defs = runs.length === 1 ? buildRunSheets(runs[0]) : mergeRunSheets(runs);
  const wb = XLSX.utils.book_new();
  for (const d of defs) {
    const ws = XLSX.utils.json_to_sheet(d.rows);
    XLSX.utils.book_append_sheet(wb, ws, d.name.slice(0, 31)); // Excel sheet-name cap
  }
  XLSX.writeFile(wb, filename);
}
