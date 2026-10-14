// Reference-dataset interaction layer. Looks up specific drug-pair interactions
// in the `ddi_reference` table (ingested from DDInter, severity-gated to
// Major/Moderate at load — see /api/admin/seed-ddi-reference). This is the
// "exhaustive specific-pair" layer that complements the class/tag engine.
// Safe before the table exists: the lookup soft-fails to [].

import { sql } from './db';
import type { DdiPair } from './rxlabelguard';

// Salt/form/route words that must not be used as match tokens (avoid false hits).
const STOP = new Set([
  'acid', 'sodium', 'potassium', 'chloride', 'sulphate', 'sulfate', 'hydrochloride', 'hcl',
  'human', 'calcium', 'magnesium', 'citrate', 'phosphate', 'bicarbonate', 'succinate',
  'besylate', 'mesylate', 'maleate', 'tartrate', 'base', 'oral', 'nasal', 'ophthalmic',
  'topical', 'inhalation', 'liposomal', 'oil', 'gel',
]);

export function norm(s: string): string {
  return (s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ingredient tokens for matching — splits combination products (e.g.
// "Piperacillin+Tazobactam" → ["piperacillin", "tazobactam"]).
export function ingredientTokens(name: string): string[] {
  return norm(name)
    .split(/\s*[+/&,]\s*|\band\b/)
    .map((t) => t.trim())
    .filter((t) => t.length > 3 && !STOP.has(t));
}

interface RefRow { drug_a: string; drug_b: string; severity: string; source: string }

export async function referenceInteractions(names: string[]): Promise<DdiPair[]> {
  const drugs = names.map((n) => ({ name: n, toks: ingredientTokens(n) })).filter((d) => d.toks.length);
  const allToks = [...new Set(drugs.flatMap((d) => d.toks))];
  if (allToks.length < 2) return [];

  let rows: RefRow[] = [];
  try {
    rows = (await sql`
      SELECT drug_a, drug_b, severity, source
      FROM ddi_reference
      WHERE drug_a = ANY(${allToks}::text[]) AND drug_b = ANY(${allToks}::text[])
    `) as RefRow[];
  } catch {
    return []; // table not seeded yet — engine still runs on class/curated/RxLabelGuard
  }

  const out: DdiPair[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const a = drugs.find((d) => d.toks.includes(r.drug_a));
    const b = drugs.find((d) => d.toks.includes(r.drug_b));
    if (!a || !b || a.name.toLowerCase() === b.name.toLowerCase()) continue;
    const key = [a.name.toLowerCase(), b.name.toLowerCase()].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const sev = r.severity.toLowerCase();
    out.push({
      drug_a: a.name, drug_b: b.name,
      severity: (sev === 'major' ? 'major' : sev === 'moderate' ? 'moderate' : 'minor') as DdiPair['severity'],
      mechanism: `Documented ${sev} interaction (${r.source}).`,
      recommendation: 'Verify against the reference and manage per severity.',
      source: r.source,
    });
  }
  return out;
}
