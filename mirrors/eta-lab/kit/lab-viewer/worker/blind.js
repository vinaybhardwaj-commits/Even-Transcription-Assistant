// R3/W51 blind validation room-days: LIFTED 10 Oct 2026. V ruling O8 (10 Oct ~07:30 to gating-lead #10979, confirmed first-hand to palimpsest-architect, ORDERS-PALIMPSEST-11A):
// the 14 held-out room-days are processed like any other day. BLIND_ROOM_DAYS below is therefore EMPTY and BLIND_CLIPS keeps ONLY the 4 clips of lid-debug's separately sealed set; every function and every call site in the Worker is kept,
// so isBlind() is never true and withoutBlindLines()/blankFirstWords() pass their input through unchanged. Re-imposing the rule = restore the two sets (the old values are kept
// as LIFTED_BLIND_ROOM_DAYS / OLD_BLIND_CLIPS, the record, used by the tests; nothing in the Worker reads them).
// History: transcription counted as use (Fable ruling #6688, list #6715), source excluded_room_days_union in manoj_session_list.json, sha16 f07171dc, 14 entries (eta-refuter-3 PASS #6703).
export const BLIND_SRC_SHA16 = "f07171dc";
const ROOM = { OPD4: "room_ux92qpws", OPD5: "room_4ggnkg5x", OPD7: "room_qyzghzaf" };
const DAYS = ["2026-08-23 OPD7", "2026-09-13 OPD4", "2026-09-14 OPD4", "2026-09-15 OPD7", "2026-09-16 OPD4", "2026-09-18 OPD7", "2026-09-19 OPD4",
  "2026-09-20 OPD4", "2026-09-20 OPD7", "2026-09-23 OPD5", "2026-09-23 OPD7", "2026-09-26 OPD4", "2026-09-28 OPD4", "2026-09-28 OPD7"];
export const LIFTED_BLIND_ROOM_DAYS = new Set(DAYS.map((x) => { const [d, r] = x.split(" "); return `${d}|${ROOM[r]}`; }));   // the record only: nothing reads this
export const BLIND_ROOM_DAYS = new Set();   // LIFTED 10 Oct 2026 (O8)
export const BLIND_MSG = "Blinded: held out for a validation study";
// label200 (CLARITY) clips whose source window is on a blind room-day: label200_room_day.json sha16 de066355 (r2 #6894, lid-debug #6881).
// Clip ids carry no room/date, so they are listed; a clip here is dropped from /clarity and its audio is refused.
export const OLD_BLIND_CLIPS = new Set(["L041", "L057", "L059", "L081", "L102", "L132", "L139", "L152", "L173", "L182"]);   // the record of the 10 old ids: nothing in the Worker reads it
// NOT LIFTED: these 4 are ALSO lid-debug's separately sealed clips (gating-lead #10998 item 1: the O8 lift "does NOT change other sealed sets I have no ruling on (lid-debug's clips
// L041/L057/L139/L182, the L0 v2 E7 pre-reg set): those stay until V says otherwise"). They stay dropped from /clarity and their audio stays refused. The other 6 old ids
// (L059 L081 L102 L132 L152 L173) were listed solely because their source window was on a blind room-day, so they ARE lifted.
export const SEALED_CLIPS = new Set(["L041", "L057", "L139", "L182"]);
export const BLIND_CLIPS = new Set(SEALED_CLIPS);   // what the Worker's guard reads: the sealed 4 only
export const isBlind = (room, date) => BLIND_ROOM_DAYS.has(`${date}|${room}`);
// a vault window key is <run_id>/<room_id>/<ist_date>/<window_id> (optionally with the runs/ prefix and .json suffix)
export function isBlindKey(key) {
  const p = String(key).replace(/^runs\//, "").replace(/\.json$/, "").split("/");
  return p.length === 4 && isBlind(p[1], p[2]);
}
// drop any line of an ndjson index that names a blind room-day (both the room id and the date appear in the line)
export function withoutBlindLines(text) {
  const pairs = [...BLIND_ROOM_DAYS].map((k) => k.split("|"));
  return text.split("\n").filter((l) => !pairs.some(([d, r]) => l.includes(r) && l.includes(d))).join("\n");
}
// view-index rows carry first_words (the first words of a window's transcript): keep the row (status, n_words, timing) but blank the words on blind room-days
// outward blind view-index rows: a whitelist, so no content-derived field (line counts, engine, refusal/no-signal outcome) can ride along
const OUTWARD_KEYS = ["key", "run_id", "producer", "window_id", "room_id", "room_name", "ist_date", "start", "end", "t0", "t1", "has_audio", "complete", "blind"];
export function blankFirstWords(text, outward = false) {
  const pairs = [...BLIND_ROOM_DAYS].map((k) => k.split("|"));
  return text.split("\n").map((l) => {
    if (!pairs.some(([d, r]) => l.includes(r) && l.includes(d))) return l;
    try { const o = JSON.parse(l); if (isBlind(o.room_id, o.ist_date)) { o.first_words = ""; o.n_words = null; o.blind = true; if (outward) { const w = Object.fromEntries(OUTWARD_KEYS.filter((k) => k in o).map((k) => [k, o[k]])); w.status = "held_out"; return JSON.stringify(w); } } return JSON.stringify(o); } catch { return null; }
  }).filter((l) => l !== null).join("\n");
}
