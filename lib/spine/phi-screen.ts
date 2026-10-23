/**
 * lib/spine/phi-screen.ts — the PHI screens for POST /api/spine/signals (Spine S1 R3). Pure. tools/eta-spine/post_signals.py mirrors it; both read tools/eta-spine/phi-rules.json (enums, id keys, per-key formats) and tests/fixtures/spine-phi-cases.json.
 *   KEYS    normalise (NFKC, drop combining marks and Unicode Cf, lower-case, fold Cyrillic / Greek lookalikes), then match WORDS. Any key, any depth.
 *   VALUES  attrs.ids is a flat object, keys from ID_KEYS, each value a full match of ITS key's FORMAT (below). close_reason / quality are closed enums per proxy (the 0123 / 0146 / 0156 CHECK sets plus the pqm / cutter sets in tools/eta-consult-cutter).
 *           room_id has the room_id format; source_key has the format of the id key its proxy keys on (SOURCE_KEY_FORMAT; a proxy with no entry has no valid source_key). A name-plus-digits token (ramesh_9845) or a bare phone-like number fits none of them.
 *
 * FORMAT DERIVATION (each regex lives in phi-rules.json; every id is machine-minted, so each is closed to its minting code):
 *   consult_key    `${enc}@${machine}`                          lib/encounter-windows/compute.ts:252. machine is the RAW event machine; it is normalised upstream (letters, digits, . _ -) in lib/encounter-windows/machine-keys.ts:4, so real rows already have that spelling. The machine part keeps the 7-digit guard (unchanged); the enc part is the Pulse form below.
 *   consult_uid    pqm rows: "pqm_" + 22 hex                    tools/eta-consult-cutter/tools/pqm_windows.py:20
 *                  Pulse rows: the Pulse encounter id (enc = compute.ts:98, types.ts:23; consult_uid IS enc, compute.ts:253). EXACTLY 26 chars of [a-z0-9], with at least one letter and no run of 10+ digits (the pulse_enc_id form). Basis (N2, 23 Oct 2026): the gating-lead's read-only production probe of eta_encounter_windows, 1238 rows: consult_uid length 26 for all, 4 hold a 7-digit run (0.32%), 0 hold a 10-digit run. The earlier 20-32 / 7-digit form came from lib/buddy/relay.ts:82 SAFE_CONSULT_UID, which is a CONSUMER-side validator, not a minting path; no code in this repo mints a Pulse uid, so the probe is the only evidence of its length. The 7-digit guard refused real signals (0.32% by the probe), hence the phone-length 10-run guard.
 *                  The letter lookahead is implied by the 10-run guard (26 digits always hold a 10-run); it is kept for the exact mirror of pulse_enc_id. So an all-digit value is refused with the plain reason, never `.digit_run` (pinned in the fixture, n2_*_all_digit). In consult_key the lookahead is confined to the enc part.
 *                  The pqm hex form is exempt from the guards (hex ids legitimately hold digit runs). The poster counts a guard refusal as `.digit_run`.
 *   pulse_enc_id   Allowed for proxies pulse and pqm only (id_key_proxies). Shape from the gating-lead production probe (23 Oct 2026): exactly 26 chars of [a-z0-9]. It needs at least one letter (an all-digit string is not a minted id) and uses a PHONE-LENGTH guard, no run of 10+ digits (Indian mobile = 10, +91 form = 12), not the 7-digit guard: a uniformly random 26-char id holds a 7-9 digit run about 0.19% of the time, and the 10-run rule refuses about 0.0034%. The poster counts a guard refusal as `.digit_run`. The format still admits a name-shaped token of 26 lowercase chars; only the charset, length, letter and phone guards are enforced.
 *   pqm_step_uid   the PQM step uid, copied raw                  pqm_windows.py:55. UNVERIFIED charset: taken as a uuid or 16-64 hex. A row whose step uid is anything else is refused by the poster and counted.
 *   window_id      bench window "bw_<session 8>_<start_ms 13 digits>_<primary|backup>"   lib/bench-window.ts:357 (session id = 8 chars of benchId, lib/room-access/bench.ts:24)
 *                  cutter index: the Neon window id, a small integer (<= 7 digits); pqm rows 10**15 + 48 bits = 16 digits starting 10-12   pqm_windows.py:16-18
 *   room_id        "room_" + 8 chars of [a-hjkmnp-z2-9]         lib/room-access/bench.ts:24-27 (scratch rooms, lib/brain/scratch.ts:35, are not spine signals)
 *   room_day_id    "rd_" + 8 chars of the same alphabet         lib/room-access/brain-state.ts:25-26,42
 *   hypothesis_id  "eh_" + 12 chars of the same alphabet        lib/encounter-hypotheses.ts:126,128
 *   acoustic_key   room_day_id + ":" + epoch minute of the interval start in base 36 (4-6 chars, no 7-digit run)   lib/spine/ingest.ts acousticKey
 *   run_id         "ehr_" + 12 (acoustic) | "ets_" + 18 hex (timeline)   lib/encounter-hypotheses.ts:127; lib/encounter-clock/shadow-leave.ts:40,128
 *   shadow_id      "et_" + 18 hex                               lib/encounter-clock/shadow-leave.ts:40,130
 *   source_key     pulse, timeline -> consult_key; acoustic -> acoustic_key; pqm, cutter, caa -> consult_uid; nemotron_window -> window_id; doctor_activity -> none (not posted in S1).   lib/spine/ingest.ts:79-87, tools/eta-spine/post_signals.py
 */
import type { Proxy } from "./ingest";
import RULES from "../../tools/eta-spine/phi-rules.json";

export const MAX_DEPTH = 12;
export const WORDS = /text|name|phone|patient|transcript|email|uhid|mrn|mobile|dob|aadhaar|addr|address/;
export const ID_KEYS: ReadonlySet<string> = new Set(RULES.id_keys);
export const FORMATS: Readonly<Record<string, RegExp>> = Object.fromEntries(Object.entries(RULES.formats).map(([k, src]) => [k, new RegExp(src)]));
export const SOURCE_KEY_FORMAT: Readonly<Record<string, string>> = RULES.source_key_format;
export const ID_KEY_PROXIES: Readonly<Record<string, readonly string[]>> = RULES.id_key_proxies;
/** The 7-digit guard clause; a value that fails its format but passes without it was refused by the guard alone. */
export const DIGIT_GUARD = "(?!.*[0-9]{7})";
/** The phone-length guard (10+ digits) of pulse_enc_id and the Pulse form of consult_uid / consult_key; stripped too when asking whether the guard alone refused a value. */
export const PHONE_GUARD = "(?!.*[0-9]{10})";
const UNGUARDED: Readonly<Record<string, RegExp>> = Object.fromEntries(Object.entries(RULES.formats).map(([k, src]) => [k, new RegExp(src.replaceAll(DIGIT_GUARD, "").replaceAll(PHONE_GUARD, ""))]));

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

/** A refusal: `code` is what the server answers (422), `reason` is the finer code the poster counts. Neither ever holds a value or an unlisted key. */
export type Refusal = { code: string; reason: string };

const idKeyReason = (k: string, x: unknown, proxy: string): string | null => {
  if (!ID_KEYS.has(k)) return "attrs_ids.unknown_key";
  const allowed = ID_KEY_PROXIES[k];
  if (allowed && !allowed.includes(proxy)) return `attrs_ids.${k}.proxy`;
  if (fmt(k, x)) return null;
  return typeof x === "string" && UNGUARDED[k]!.test(x) ? `attrs_ids.${k}.digit_run` : `attrs_ids.${k}`;
};

/** The value screens for one signal whose shape is already checked. -> a refusal or null. */
export function refuseValueReason(proxy: Proxy, o: { source_key: unknown; room_id?: unknown; attrs?: Record<string, unknown> }): Refusal | null {
  if (!fmt(SOURCE_KEY_FORMAT[proxy], o.source_key)) {
    const k = SOURCE_KEY_FORMAT[proxy];
    return { code: "source_key", reason: k !== undefined && typeof o.source_key === "string" && UNGUARDED[k]?.test(o.source_key) ? "source_key.digit_run" : "source_key" };
  }
  if (o.room_id !== undefined && o.room_id !== null && !fmt("room_id", o.room_id)) return { code: "room_id", reason: "room_id" };
  const a = o.attrs ?? {};
  if (a.ids !== undefined) {
    const ids = a.ids;
    if (ids === null || typeof ids !== "object" || Array.isArray(ids)) return { code: "attrs_ids", reason: "attrs_ids.not_object" };
    for (const [k, x] of Object.entries(ids)) { const r = idKeyReason(k, x, proxy); if (r) return { code: "attrs_ids", reason: r }; }
  }
  if (a.close_reason !== undefined && !(typeof a.close_reason === "string" && ENUMS[proxy].close_reason.has(a.close_reason))) return { code: "attrs_close_reason", reason: "close_reason" };
  if (a.quality !== undefined && !(typeof a.quality === "string" && ENUMS[proxy].quality.has(a.quality))) return { code: "attrs_quality", reason: "quality" };
  return null;
}

export const refuseValues = (proxy: Proxy, o: Parameters<typeof refuseValueReason>[1]): string | null => refuseValueReason(proxy, o)?.code ?? null;
