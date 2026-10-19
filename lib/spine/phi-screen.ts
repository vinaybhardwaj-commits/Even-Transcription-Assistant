/**
 * lib/spine/phi-screen.ts — the PHI screens for POST /api/spine/signals (Spine S1 R3). Pure. tools/eta-spine/post_signals.py mirrors it; both read tools/eta-spine/phi-rules.json (enums, id keys, per-key formats) and tests/fixtures/spine-phi-cases.json.
 *   KEYS    normalise (NFKC, drop combining marks and Unicode Cf, lower-case, fold Cyrillic / Greek lookalikes), then match WORDS. Any key, any depth.
 *   VALUES  attrs.ids is a flat object, keys from ID_KEYS, each value a full match of ITS key's FORMAT (below). close_reason / quality are closed enums per proxy (the 0123 / 0146 / 0156 CHECK sets plus the pqm / cutter sets in tools/eta-consult-cutter).
 *           room_id has the room_id format; source_key has the format of the id key its proxy keys on (SOURCE_KEY_FORMAT; a proxy with no entry has no valid source_key). A name-plus-digits token (ramesh_9845) or a bare phone-like number fits none of them.
 *
 * FORMAT DERIVATION (each regex lives in phi-rules.json; every id is machine-minted, so each is closed to its minting code):
 *   consult_key    `${enc}@${machine}`                          lib/encounter-windows/compute.ts:252; machine = normalizeHostname lib/encounter-windows/types.ts:113 (letters, digits, . _ -; spaces became -).
 *   consult_uid    pqm rows: "pqm_" + 22 hex                    tools/eta-consult-cutter/tools/pqm_windows.py:20
 *                  Pulse rows: the Pulse encounter_id (= enc)   compute.ts:98, types.ts:23. UNVERIFIED: the Pulse extension is not in this repo, so enc is taken as enc_<alnum 6-40>, a uuid, or alnum 20-40.
 *                  Non-hex forms refuse any run of 7+ digits (a phone-like number); the pqm hex form is exempt (hex ids legitimately hold digit runs).
 *   pqm_step_uid   the PQM step uid, copied raw                  pqm_windows.py:55. UNVERIFIED charset: taken as a uuid or 16-64 hex. A row whose step uid is anything else is refused by the poster and counted.
 *   window_id      bench window "bw_<session 8>_<start_ms 13 digits>_<primary|backup>"   lib/bench-window.ts:357 (session id = 8 chars of benchId, lib/room-access/bench.ts:24)
 *                  cutter index: the Neon window id, a small integer (<= 7 digits); pqm rows 10**15 + 48 bits = 16 digits starting 10-12   pqm_windows.py:16-18
 *   room_id        "room_" + 8 chars of [a-hjkmnp-z2-9]         lib/room-access/bench.ts:24-27 (scratch rooms, lib/brain/scratch.ts:35, are not spine signals)
 *   room_day_id    "rd_" + 8 chars of the same alphabet         lib/room-access/brain-state.ts:25-26,42
 *   hypothesis_id  "eh_" + 12 chars of the same alphabet        lib/encounter-hypotheses.ts:126,128
 *   run_id         "ehr_" + 12 (acoustic) | "ets_" + 18 hex (timeline)   lib/encounter-hypotheses.ts:127; lib/encounter-clock/shadow-leave.ts:40,128
 *   shadow_id      "et_" + 18 hex                               lib/encounter-clock/shadow-leave.ts:40,130
 *   source_key     pulse, timeline -> consult_key; acoustic -> hypothesis_id; pqm, cutter, caa -> consult_uid; nemotron_window -> window_id; doctor_activity -> none (not posted in S1).   lib/spine/ingest.ts:79-87, tools/eta-spine/post_signals.py
 */
import type { Proxy } from "./ingest";
import RULES from "../../tools/eta-spine/phi-rules.json";

export const MAX_DEPTH = 12;
export const WORDS = /text|name|phone|patient|transcript|email|uhid|mrn|mobile|dob|aadhaar|addr|address/;
export const ID_KEYS: ReadonlySet<string> = new Set(RULES.id_keys);
export const FORMATS: Readonly<Record<string, RegExp>> = Object.fromEntries(Object.entries(RULES.formats).map(([k, src]) => [k, new RegExp(src)]));
export const SOURCE_KEY_FORMAT: Readonly<Record<string, string>> = RULES.source_key_format;

export const ENUMS: Record<Proxy, { close_reason: ReadonlySet<string>; quality: ReadonlySet<string> }> = Object.fromEntries(
  Object.entries(RULES.enums).map(([p, e]) => [p, { close_reason: new Set(e.close_reason), quality: new Set(e.quality) }]),
) as unknown as Record<Proxy, { close_reason: ReadonlySet<string>; quality: ReadonlySet<string> }>;

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

const fmt = (key: string | undefined, v: unknown): boolean => key !== undefined && typeof v === "string" && FORMATS[key] !== undefined && FORMATS[key]!.test(v);

/** The value screens for one signal whose shape is already checked. -> a refusal code (422) or null. */
export function refuseValues(proxy: Proxy, o: { source_key: unknown; room_id?: unknown; attrs?: Record<string, unknown> }): string | null {
  if (!fmt(SOURCE_KEY_FORMAT[proxy], o.source_key)) return "source_key";
  if (o.room_id !== undefined && o.room_id !== null && !fmt("room_id", o.room_id)) return "room_id";
  const a = o.attrs ?? {};
  if (a.ids !== undefined) {
    const ids = a.ids;
    if (ids === null || typeof ids !== "object" || Array.isArray(ids)) return "attrs_ids";
    for (const [k, x] of Object.entries(ids)) if (!ID_KEYS.has(k) || !fmt(k, x)) return "attrs_ids";
  }
  if (a.close_reason !== undefined && !(typeof a.close_reason === "string" && ENUMS[proxy].close_reason.has(a.close_reason))) return "attrs_close_reason";
  if (a.quality !== undefined && !(typeof a.quality === "string" && ENUMS[proxy].quality.has(a.quality))) return "attrs_quality";
  return null;
}
