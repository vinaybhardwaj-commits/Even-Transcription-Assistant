/** STT Engine Lab — Word/Character Error Rate + medical-term recall (L3). */

export function normalizeForWer(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance<T>(a: T[], b: T[]): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Word Error Rate vs a reference. null if no reference. Can exceed 1 (many insertions); rounded to 3dp. */
export function wer(reference: string, hypothesis: string): number | null {
  const r = normalizeForWer(reference).split(" ").filter(Boolean);
  if (r.length === 0) return null;
  const h = normalizeForWer(hypothesis).split(" ").filter(Boolean);
  return Math.round((editDistance(r, h) / r.length) * 1000) / 1000;
}

/** Character Error Rate (over the normalized string). */
export function cer(reference: string, hypothesis: string): number | null {
  const r = [...normalizeForWer(reference)];
  if (r.length === 0) return null;
  const h = [...normalizeForWer(hypothesis)];
  return Math.round((editDistance(r, h) / r.length) * 1000) / 1000;
}

/** Fraction of critical terms present (substring match on the normalized hypothesis). */
export function termRecall(terms: Array<{ term: string }>, hypothesis: string): number | null {
  if (!terms || terms.length === 0) return null;
  const hay = normalizeForWer(hypothesis);
  let matched = 0;
  for (const t of terms) {
    const needle = normalizeForWer(t.term);
    if (needle && hay.includes(needle)) matched++;
  }
  return Math.round((matched / terms.length) * 1000) / 1000;
}
