// scripts/lib/theme-match.mjs — THE S4.1 semantic theme matcher, shared by the measurement
// scripts (ipd-s4-theme-rescore + ipd-consensus-gold-harness). Extracted VERBATIM from the
// original inline copy in ipd-s4-theme-rescore.mjs (f315974): the judge prompt, the letter
// indexing, the null-mapping rule and the cache-key formula are byte-for-byte the S4.1 original;
// the only change is that the cache is INJECTED, so each caller owns its own cache file.
//
// WHY HERE (scripts/lib), NOT lib/: this is MEASUREMENT tooling, not app code. It calls the model
// via chatWithFallback the same way the rescore script always did — deliberately OUTSIDE the
// reasoning-governance layer (which governs lib/ + app/ model calls, not scripts). Living in
// scripts/lib keeps that invariant intact while giving the two scripts one matcher, not a copy.
// The consensus-gold harness reuses it so the union is deduped by the EXACT S4.1 judge; re-running
// the shipped rescore proves its output is byte-identical (cache-backed).
//
// No engine, no frozen core, no gold mutation. Judge = Gemini utility model (Flash) with Ollama
// fallback, temperature 0. Deterministic given the cache.
import { createHash } from 'crypto';
import { chatWithFallback, geminiUtilityModel, TEXT_MODEL } from '../../lib/llm.ts';

export const JUDGE_SYSTEM = `You judge whether two short clinical-audit finding titles describe the SAME clinical concern about the same episode. Paraphrase, word order, abbreviation (IV/intravenous), and generic-vs-specific phrasing of the SAME concern all count as a match. Different concerns (e.g. antibiotic DURATION vs antibiotic CHOICE; a stay-length concern vs a drug-interaction concern) do NOT match.
You are given GOLD themes (numbered) and RUN findings (lettered) from the same case. For EACH run finding output the number of the gold theme it expresses, or null if none.
Return ONLY JSON: {"map":{"A":1,"B":null,...}}`;

export const keyOf = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 24);

/**
 * Map each candidate ("RUN finding") to the reference ("GOLD theme") index it expresses, or null.
 * VERBATIM S4.1 semantics — the same "same clinical concern?" judgement; the consensus-gold harness
 * reuses it both for gold↔run mapping and for folding near-duplicate extras onto cluster reps.
 */
export async function judgeMap(reference, candidates, cache, saveCache) {
  const key = keyOf(JSON.stringify([reference, candidates]));
  if (cache.judge[key]) return cache.judge[key];
  const letters = candidates.map((_, i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''));
  const user = `GOLD themes:\n${reference.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nRUN findings:\n${candidates.map((s, i) => `${letters[i]}. ${s}`).join('\n')}\n\nOutput the JSON map now.`;
  const res = await chatWithFallback({
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }],
    temperature: 0, max_tokens: 800,
  }, geminiUtilityModel());
  const raw = res?.choices?.[0]?.message?.content ?? '';
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  const parsed = JSON.parse(raw.slice(a, b + 1));
  const map = {};
  candidates.forEach((s, i) => {
    const v = parsed.map?.[letters[i]];
    const n = Number(v);
    map[s] = Number.isFinite(n) && n >= 1 && n <= reference.length ? n - 1 : null;
  });
  cache.judge[key] = map; saveCache();
  return map;
}
