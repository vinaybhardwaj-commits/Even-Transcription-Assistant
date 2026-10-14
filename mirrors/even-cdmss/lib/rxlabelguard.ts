// RxLabelGuard — server-side client. Turns FDA Structured Product Labeling into
// structured drug-interaction pairs with severity tiers + evidence citations.
// Key is read from RXLABELGUARD_API_KEY (server env only — never the client bundle).
// Soft-fails to [] so the deterministic curated rules + the CDMSS LLM/RAG engine
// still answer when the key is absent, the trial lapses, or the API is down.

export type DdiSeverity = 'contraindicated' | 'major' | 'moderate' | 'minor' | 'none' | 'unknown';

export interface DdiPair {
  drug_a: string;
  drug_b: string;
  severity: DdiSeverity;
  mechanism: string;
  recommendation: string;
  source: string;            // e.g. 'FDA SPL', 'EHRC curated rule'
  evidence?: string;         // SPL set id / citation when present
}

const ENDPOINT = 'https://api.rxlabelguard.com/v1/interactions';

export function rxlgConfigured(): boolean {
  return !!process.env.RXLABELGUARD_API_KEY;
}

export async function rxlgInteractions(drugs: string[]): Promise<DdiPair[]> {
  const key = process.env.RXLABELGUARD_API_KEY;
  if (!key || drugs.length < 2) return [];
  // Tight timeout so a slow upstream never stalls the rounds workflow.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ drugs }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { interactions?: Array<Record<string, unknown>> };
    const items = Array.isArray(data.interactions) ? data.interactions : [];
    return items.map((it) => ({
      drug_a: String(it.drug_a ?? ''),
      drug_b: String(it.drug_b ?? ''),
      severity: (String(it.severity ?? 'unknown') as DdiSeverity),
      mechanism: String(it.mechanism ?? ''),
      recommendation: String(it.recommendation ?? ''),
      source: 'FDA SPL',
      evidence: (it.evidence && typeof it.evidence === 'object')
        ? String((it.evidence as Record<string, unknown>).spl_set_id ?? '')
        : undefined,
    })).filter((p) => p.drug_a && p.drug_b);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
