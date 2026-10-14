import { governedChat } from './trace';

export const DRUGS_MODEL = 'llama3.1:8b';

export function parseLooseJson(s: string): unknown {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch (firstErr) {
    // Recovery: model output was truncated. Walk back to the last well-formed comma boundary
    // and close all open braces/brackets. We give up on the truncated trailing value/key.
    const repaired = repairTruncatedJson(t);
    if (repaired !== null) {
      try { return JSON.parse(repaired); } catch {}
    }
    throw firstErr;
  }
}

function repairTruncatedJson(t: string): string | null {
  // Walk forward, tracking stack of { [ and string state, until we hit truncation.
  // Then trim to last complete key:value pair and close.
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastSafePos = -1; // index AFTER last successfully-completed value at depth>=1
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
    if (c === ',' && stack.length >= 1) lastSafePos = i; // valid trim point at depth >=1
  }
  if (lastSafePos === -1) return null;
  // Truncate to lastSafePos (drop trailing partial), then close all open structures
  let head = t.slice(0, lastSafePos);
  // Re-walk to reconstruct unclosed stack
  const closeStack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') closeStack.push('}');
    else if (c === '[') closeStack.push(']');
    else if (c === '}' || c === ']') closeStack.pop();
  }
  return head + closeStack.reverse().join('');
}

// Normalize a free-text drug name into a canonical lookup string.
// v1.9b: Try PubChem first (free, deterministic, cached). If PubChem returns
// a CID, use the first synonym as the canonical name. Only fall back to the
// LLM if PubChem doesn't recognise the input. Saves ~500ms-1s on common
// brand-name lookups (Glycomet → metformin, Eliquis → apixaban, etc.).
export async function normalizeDrugName(input: string): Promise<string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length > 50) return trimmed; // Too long, skip normalization

  // v1.9b: PubChem shortcut. Soft-fail to LLM if PubChem times out/errors.
  try {
    const { lookupByName, getSynonyms } = await import('./pubchem');
    const cid = await lookupByName(trimmed);
    if (cid !== null) {
      const synonyms = await getSynonyms(cid, 5);
      // PubChem's first non-CAS synonym is typically the canonical/INN name.
      // Filter: prefer lowercase or capitalised short names, skip ALL-CAPS research codes.
      const generic = synonyms.find((s) =>
        s.length > 2 && s.length < 40 &&
        /^[a-z]/i.test(s) &&
        !/^[A-Z]{2,}[\s\-]?\d/.test(s) &&
        !/imidodicarbonimidic|tetrahydropyran/.test(s.toLowerCase())
      );
      if (generic) return generic.toLowerCase();
    }
  } catch {
    // PubChem unavailable — fall through to LLM
  }

  try {
    // Governed envelope (Stage 4): traceless + no gemini → byte-identical local call.
    const r = await governedChat(undefined, 'drugs_normalize', {
      model: DRUGS_MODEL,
      messages: [
        { role: 'system', content: 'Return the generic (INN) name of the drug, lowercase, one word or hyphenated. If a brand is given, return the generic. If misspelled, correct it. If not a drug, return the input unchanged. Output ONLY the name, no quotes, no explanation.' },
        { role: 'user', content: trimmed },
      ],
      temperature: 0,
      max_tokens: 20,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      });
    const out = (r.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    // Sanity: must be alphanumeric+hyphen+space, <50 chars
    if (out && /^[a-z][a-z0-9\s\-]{0,49}$/.test(out)) return out;
    return trimmed;
  } catch {
    return trimmed;
  }
}
