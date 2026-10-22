/**
 * lib/freescript/internal.ts — C4 (Fable 5.1, FRX-V10) and H2 (refute of 6efbc5fc). Nothing that carries heard text leaves through a read:
 *   - `confirm_internal` (heard strength, frequency, duration, tape pointer, spec rule 25),
 *   - `spans[*].quote_en / quote_native` (the tape's words, which hold the same values and any previous patient's identifiers),
 *   - `provenance[*].text / evidence / decision / names` (a quote, or "<brand> <strength>"),
 *   - `slots` (regimen parts of the mapper) and `room_facts` (allergies and vitals as heard).
 * Every serializer calls publicArtifact. The only way to get the full artifact is `internal: true`, and the only caller that may pass it is
 * `internalReadAllowed()`, which reads a SERVER-SIDE environment flag (default off). It is never taken from a query, body or header. Pure apart from that read.
 */
export const INTERNAL_KEYS = ["confirm_internal", "room_facts", "slots"] as const;
const SPAN_DROP = ["quote_en", "quote_native"] as const;
const PROVENANCE_DROP = ["text", "evidence", "decision", "names"] as const;

/** Admin-only debug flag. Server environment only; unset or anything but "1" is off. */
export function internalReadAllowed(): boolean {
  return process.env.FREESCRIPT_INTERNAL_READ === "1";
}

function dropKeys(rows: unknown, keys: readonly string[]): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return r;
    const c: Record<string, unknown> = { ...(r as Record<string, unknown>) };
    for (const k of keys) delete c[k];
    return c;
  });
}

export function publicArtifact(artifact: unknown, opts: { internal?: boolean } = {}): unknown {
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
  if (opts.internal === true && internalReadAllowed()) return artifact;
  const out: Record<string, unknown> = { ...(artifact as Record<string, unknown>) };
  for (const k of INTERNAL_KEYS) delete out[k];
  if ("spans" in out) out.spans = dropKeys(out.spans, SPAN_DROP);
  if ("provenance" in out) out.provenance = dropKeys(out.provenance, PROVENANCE_DROP);
  return out;
}
