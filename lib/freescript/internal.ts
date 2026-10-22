/**
 * lib/freescript/internal.ts — C4 (Fable 5.1, FRX-V10), H2 (refute of 6efbc5fc) and Fix2 H2 (refute of 703eefba). Nothing that carries heard text leaves through a read.
 * The projection is an ALLOW-LIST of keys, not a deny-list: a key the list does not name is dropped, so a field a later mapper version adds stays home until it is
 * listed here on purpose. Dropped today, among others: `confirm_internal` (heard strength, frequency, duration, tape pointer, spec rule 25; also the heard `detail`
 * of every completion item), `spans[*].quote_en / quote_native`, every provenance key that holds or nests heard text (`text`, `evidence`, `decision`, `names`,
 * `follow_up`, `medicine`, `procedure`, ...), `slots` and `room_facts`. `completion_required` serves {kind, item_id, prompt_id, prompt} and nothing else.
 * Every serializer calls publicArtifact / publicCompletion. The only way to get the full artifact is `internal: true`, and the only caller that may pass it is
 * `internalReadAllowed()`, which reads a SERVER-SIDE environment flag (default off). It is never taken from a query, body or header. Pure apart from that read.
 */
type Obj = Record<string, unknown>;

/** Top-level artifact keys that are served. Everything else (confirm_internal, room_facts, slots, any new key) is dropped. */
const ARTIFACT_KEEP = [
  "schema_version", "artifact_id", "supersedes", "created_at", "generator", "encounter", "pulse_link", "note_text", "gp_extraction", "clip_boundary", "policy",
  "roster", "confirm_prompts", "withheld", "red_flags", "doctor_words", "kept_out",
] as const;
const SPAN_KEEP = ["span_id", "segment_refs", "t0", "t1", "label", "lang", "span_source", "order_capable", "boundary_quarantined", "relay_of", "role", "reason"] as const;
const PROVENANCE_KEEP = [
  "item_id", "kind", "status", "negated", "speaker", "speaker_source", "evidence_state", "json_pointer", "flags", "confidence", "prompt_id", "support",
  "cited_spans", "alignment", "span_source", "withheld_reason",
] as const;
const COMPLETION_KEEP = ["kind", "item_id", "prompt_id", "prompt"] as const;
export const INTERNAL_KEYS = ["confirm_internal", "room_facts", "slots"] as const;

/** Admin-only debug flag. Server environment only; unset or anything but "1" is off. */
export function internalReadAllowed(): boolean {
  return process.env.FREESCRIPT_INTERNAL_READ === "1";
}

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function pick(o: Obj, keys: readonly string[]): Obj {
  const c: Obj = {};
  for (const k of keys) if (k in o) c[k] = o[k];
  return c;
}

function rowsPick(rows: unknown, keys: readonly string[]): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => (isObj(r) ? pick(r, keys) : r));
}

/** completion_required as served, in the column and in the artifact: the generic prompt only. The heard `detail` is in confirm_internal.completion. */
export function publicCompletion(rows: unknown): unknown {
  return rowsPick(rows, COMPLETION_KEEP);
}

export function publicArtifact(artifact: unknown, opts: { internal?: boolean } = {}): unknown {
  if (!isObj(artifact)) return artifact;
  if (opts.internal === true && internalReadAllowed()) return artifact;
  const out = pick(artifact, ARTIFACT_KEEP);
  if ("spans" in artifact) out.spans = rowsPick(artifact.spans, SPAN_KEEP);
  if ("provenance" in artifact) out.provenance = rowsPick(artifact.provenance, PROVENANCE_KEEP);
  if ("completion_required" in artifact) out.completion_required = publicCompletion(artifact.completion_required);
  return out;
}
