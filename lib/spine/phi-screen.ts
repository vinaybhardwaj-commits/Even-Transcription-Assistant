/**
 * lib/spine/phi-screen.ts — the PHI screens for POST /api/spine/signals (Spine S1 R2). Pure. tools/eta-spine/post_signals.py mirrors it; both read tests/fixtures/spine-phi-cases.json.
 *   KEYS    normalise (NFKC, drop combining marks and Unicode Cf, lower-case, fold Cyrillic / Greek lookalikes), then match WORDS. Any key, any depth.
 *   VALUES  attrs.ids is a flat object, keys from ID_KEYS, values ID_RE tokens. close_reason / quality are closed enums per proxy (the 0123 / 0146 / 0156 CHECK sets plus the pqm / cutter sets in tools/eta-consult-cutter).
 *           source_key and room_id are ID_RE tokens. Anything else is refused.
 */
import type { Proxy } from "./ingest";

export const MAX_DEPTH = 12;
export const WORDS = /text|name|phone|patient|transcript|email|uhid|mrn|mobile|dob|aadhaar|addr|address/;
export const ID_RE = /^[A-Za-z0-9_@.:-]{1,120}$/;
export const ID_KEYS: ReadonlySet<string> = new Set(["consult_key", "consult_uid", "hypothesis_id", "room_day_id", "shadow_id", "run_id", "pqm_step_uid", "window_id"]);

const PULSE_REASON = ["endConsult", "url_clear", "next_open", "logout", "idle_timeout", "cap_90m", "open"];
const PULSE_QUALITY = ["clean", "ambiguous", "multi_doctor", "unclosed", "unattributed"];
const ACOUSTIC_REASON = ["non_speech", "unjudged_gap", "tape_off", "dead_mic", "end_of_input", "content_boundary", "pulse_end", "jev_end", "next_start", "last_doc_turn", "cap_90m"];
const TIMELINE_REASON = ["patient_left", "next_start", "tape_off", "dead_mic", "cap"];
const PQM_QUALITY = ["pqm", "suspect"];
const CUTTER_STATUS = ["cut", "skipped", "error", "planned", "deferred", "deferred_long"];

export const ENUMS: Record<Proxy, { close_reason: ReadonlySet<string>; quality: ReadonlySet<string> }> = {
  pulse: { close_reason: new Set(PULSE_REASON), quality: new Set(PULSE_QUALITY) },
  acoustic: { close_reason: new Set(ACOUSTIC_REASON), quality: new Set() },
  timeline: { close_reason: new Set(TIMELINE_REASON), quality: new Set() },
  pqm: { close_reason: new Set(["pqm"]), quality: new Set(PQM_QUALITY) },
  cutter: { close_reason: new Set([...PULSE_REASON, "pqm"]), quality: new Set([...CUTTER_STATUS, ...PULSE_QUALITY, ...PQM_QUALITY]) },
  caa: { close_reason: new Set(), quality: new Set() },
  doctor_activity: { close_reason: new Set(), quality: new Set() },
  nemotron_window: { close_reason: new Set(), quality: new Set() },
};

const LOOKALIKE: Record<string, string> = {
  "ı": "i", "а": "a", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l",
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
};

/** The form a key is matched in. */
export function normKey(k: string): string {
  const s = k.normalize("NFKC").normalize("NFD").replace(/[\p{Mn}\p{Cf}]/gu, "").toLowerCase();
  let out = "";
  for (const ch of s) out += LOOKALIKE[ch] ?? ch;
  return out;
}

/** "text_key" when any key at any depth matches WORDS, "too_deep" past MAX_DEPTH (containers only), else null. */
export function refuseKeys(v: unknown, depth = 0): "text_key" | "too_deep" | null {
  if (v === null || typeof v !== "object") return null;
  if (depth > MAX_DEPTH) return "too_deep";
  if (Array.isArray(v)) { for (const x of v) { const r = refuseKeys(x, depth + 1); if (r) return r; } return null; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (WORDS.test(normKey(k))) return "text_key";
    const r = refuseKeys(x, depth + 1);
    if (r) return r;
  }
  return null;
}

const idTok = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/** The value screens for one signal whose shape is already checked. -> a refusal code (422) or null. */
export function refuseValues(proxy: Proxy, o: { source_key: unknown; room_id?: unknown; attrs?: Record<string, unknown> }): string | null {
  if (!idTok(o.source_key)) return "source_key";
  if (o.room_id !== undefined && o.room_id !== null && !idTok(o.room_id)) return "room_id";
  const a = o.attrs ?? {};
  if (a.ids !== undefined) {
    const ids = a.ids;
    if (ids === null || typeof ids !== "object" || Array.isArray(ids)) return "attrs_ids";
    for (const [k, x] of Object.entries(ids)) if (!ID_KEYS.has(k) || !idTok(x)) return "attrs_ids";
  }
  if (a.close_reason !== undefined && !(typeof a.close_reason === "string" && ENUMS[proxy].close_reason.has(a.close_reason))) return "attrs_close_reason";
  if (a.quality !== undefined && !(typeof a.quality === "string" && ENUMS[proxy].quality.has(a.quality))) return "attrs_quality";
  return null;
}
