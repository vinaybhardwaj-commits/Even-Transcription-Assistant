/**
 * lib/lab-core.ts — PURE helpers for the Lab MCP (no db/llm imports), strip-types testable.
 */

/** Sanitise a user-supplied experiment/corpus label to a safe slug. */
export function labLabel(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'default';
}

/** Chunk plain text into ~maxChars windows on paragraph boundaries (simple + robust). */
export function chunkText(text: string, maxChars = 1400): string[] {
  const paras = String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 40);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > maxChars && buf) { out.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) out.push(buf);
  return out.flatMap((c) => c.length <= maxChars * 1.5 ? [c] : (c.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) || [c]));
}
