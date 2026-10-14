/**
 * lib/opd-audit-cats.ts — roll up per-note gaps into a small set of named issue
 * CATEGORIES for the dashboard "Top issues" panel. Pure + shared (server page tags each
 * row; client tallies + filters). Documentation cats are EXACT (from missing_fields);
 * prescribing cats mix exact deterministic checks with keyword sub-themes for low-value.
 */

export type CatGroup = 'documentation' | 'prescribing';
export type CatSev = 'doc' | 'caution' | 'low';

export interface CatDef { key: string; label: string; group: CatGroup; sev: CatSev }

export const CATS: CatDef[] = [
  { key: 'doc:dosing',    label: 'Incomplete medication dosing',             group: 'documentation', sev: 'doc' },
  { key: 'doc:advice',    label: 'No advice / plan recorded',                group: 'documentation', sev: 'doc' },
  { key: 'doc:complaint', label: 'No presenting complaint recorded',         group: 'documentation', sev: 'doc' },
  { key: 'doc:followup',  label: 'No follow-up specified',                   group: 'documentation', sev: 'doc' },
  { key: 'doc:diagnosis', label: 'No diagnosis / impression coded',          group: 'documentation', sev: 'doc' },
  { key: 'rx:nongeneric', label: 'Brand-name / unverifiable prescribing',    group: 'prescribing',   sev: 'caution' },
  { key: 'rx:interaction', label: 'Drug–drug interaction',                   group: 'prescribing',   sev: 'caution' },
  { key: 'rx:duplicate',  label: 'Therapeutic duplication',                  group: 'prescribing',   sev: 'low' },
  { key: 'rx:lv_antibiotic', label: 'Low-value: antibiotic for likely-viral illness', group: 'prescribing', sev: 'low' },
  { key: 'rx:lv_supplement', label: 'Low-value: enzyme / vitamin / supplement combos', group: 'prescribing', sev: 'low' },
  { key: 'rx:lv_antiseptic', label: 'Low-value: topical antiseptics',        group: 'prescribing',   sev: 'low' },
  { key: 'rx:lv_other',   label: 'Low-value: other',                         group: 'prescribing',   sev: 'low' },
];

export const CAT_LABEL: Record<string, string> = Object.fromEntries(CATS.map((c) => [c.key, c.label]));
export const CAT_DEF: Record<string, CatDef> = Object.fromEntries(CATS.map((c) => [c.key, c]));

const MISSING_TO_CAT: Record<string, string> = {
  'Complete medication dosing': 'doc:dosing',
  'Advice / plan': 'doc:advice',
  'Presenting complaint': 'doc:complaint',
  'Follow-up specified': 'doc:followup',
  'Diagnosis / impression': 'doc:diagnosis',
};

interface RowFinding { subject?: string; verdict?: string; rationale?: string; source?: string }

/** Per-note category keys, from its missing NABH fields + its findings. Deduped. */
export function catsForRow(missing: string[] | null | undefined, findings: RowFinding[] | null | undefined): string[] {
  const set = new Set<string>();
  for (const m of missing || []) { const c = MISSING_TO_CAT[m]; if (c) set.add(c); }
  for (const f of findings || []) {
    const subj = (f.subject || '').toLowerCase();
    const txt = `${f.subject || ''} ${f.rationale || ''}`.toLowerCase();
    let primaryRx = false;
    if (subj.startsWith('non-generic') || subj.startsWith('unverified brand')) { set.add('rx:nongeneric'); primaryRx = true; }
    else if (subj.startsWith('interaction')) { set.add('rx:interaction'); primaryRx = true; }
    else if (subj.startsWith('duplicate prescription')) { set.add('rx:duplicate'); primaryRx = true; }
    else if (subj.startsWith('incomplete dosing')) { set.add('doc:dosing'); primaryRx = true; } // fold into documentation
    if (!primaryRx && f.verdict === 'low-value') {
      if (/antibiotic|amoxicill|azithro|cefix|cefpod|ciproflox|levoflox|antimicrobial|metronidazole/.test(txt)) set.add('rx:lv_antibiotic');
      else if (/vitamin|supplement|multivit|enzyme|trypsin|chymotrypsin|serratiopep|probiotic|\btonic\b|nutraceutical|mineral|antioxidant/.test(txt)) set.add('rx:lv_supplement');
      else if (/povidone|iodine|antiseptic|betadine|chlorhexidine|caladryl|calamine/.test(txt)) set.add('rx:lv_antiseptic');
      else set.add('rx:lv_other');
    }
  }
  return [...set];
}
