// R3/W51 blind validation room-days (Fable ruling #6688, list #6715): transcription counts as use, so every text-bearing
// surface for these room-days is withheld SERVER-SIDE (the text never reaches the client). Audio and non-text lanes stay.
// Source: excluded_room_days_union in manoj_session_list.json, sha16 f07171dc, 14 entries; OPD4/OPD5/OPD7 mapped to the
// room ids reb's collector uses (eta-refuter-3 PASS #6703). Changed only on Fable's order.
export const BLIND_SRC_SHA16 = "f07171dc";
const ROOM = { OPD4: "room_ux92qpws", OPD5: "room_4ggnkg5x", OPD7: "room_qyzghzaf" };
const DAYS = ["2026-08-23 OPD7", "2026-09-13 OPD4", "2026-09-14 OPD4", "2026-09-15 OPD7", "2026-09-16 OPD4", "2026-09-18 OPD7", "2026-09-19 OPD4",
  "2026-09-20 OPD4", "2026-09-20 OPD7", "2026-09-23 OPD5", "2026-09-23 OPD7", "2026-09-26 OPD4", "2026-09-28 OPD4", "2026-09-28 OPD7"];
export const BLIND_ROOM_DAYS = new Set(DAYS.map((x) => { const [d, r] = x.split(" "); return `${d}|${ROOM[r]}`; }));
export const BLIND_MSG = "Blinded: held out for a validation study";
// label200 (CLARITY) clips whose source window is on a blind room-day: label200_room_day.json sha16 de066355 (r2 #6894, lid-debug #6881).
// Clip ids carry no room/date, so they are listed; a clip here is dropped from /clarity and its audio is refused.
export const BLIND_CLIPS = new Set(["L041", "L057", "L059", "L081", "L102", "L132", "L139", "L152", "L173", "L182"]);
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
export function blankFirstWords(text) {
  const pairs = [...BLIND_ROOM_DAYS].map((k) => k.split("|"));
  return text.split("\n").map((l) => {
    if (!pairs.some(([d, r]) => l.includes(r) && l.includes(d))) return l;
    try { const o = JSON.parse(l); if (isBlind(o.room_id, o.ist_date)) o.first_words = ""; return JSON.stringify(o); } catch { return null; }
  }).filter((l) => l !== null).join("\n");
}
