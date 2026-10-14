// 6V: consult clips in the palimpsest viewer (V, 8 Oct 2026). Every consult is a highlighted band on the room-day timeline; clicking one opens a
// drawer with the clip (play + download), the visit facts, the Sarvam transcript and every other lane the palimpsest holds over the same span.
//
// Data (all read-only here):
//   consults/<room>/<date>.json   in eta-lab-ratings, built by tools/consults_seed.py from the cutter index (latest row per consult)
//   reb/<date>/<room>/<window>/   in eta-lab-results (through worker/reb.js rebModel), windows found with the Neon index route (read token)
//   reb/<date>/<room>/_consults/<consult_uid>/   the consult-scope tracks (Sarvam); same layout as a window
//   consult-clips/<date>/<room-slug>/<id>/{consult,doctor}.flac   in eta-audio, streamed by the /clip route behind an HMAC-signed 15-minute link
// Blind room-days (R3/W51): nothing is rendered, listed, signed or served; a refusal is a bare 404. The server-rendered page needs no client script.
import { isBlind } from "./blind.js";
import { rebModel } from "./reb.js";
import { LANES, LANE_BY_KEY, WORD_LANES, KOYAL_NAMES } from "./lanes.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rstr = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const IST_MS = 19800000;
const hm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16);
const hms = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 19);
export const CONSULT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const PREFIX_RE = /^consult-clips\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;
export const CLIP_FILES = { c: "consult.flac", d: "doctor.flac" };
const FILES = CLIP_FILES;
export const CLIP_TTL_S = 900;
const STATUS = new Set(["cut", "skipped", "error", "deferred_long"]);
const SKIP_KINDS = {
  no_session: "No recording was found for this time",
  final_no_session: "No recording was found for this time, even after 24 hours",
  silent_audio: "The recording for this time was silent",
  cut_failed: "The clip could not be cut (technical problem)",
  too_long: "Too long to cut automatically; held for review",
};
const QUALITY = {
  clean: "Clear: one doctor, start and end recorded",
  unattributed: "The doctor could not be identified from the records",
  multi_doctor: "More than one doctor was signed in",
  unclosed: "The end of the consult was not recorded",
  ambiguous: "The records disagree about this consult",
};
const CLOSE = {
  url_clear: "The doctor closed the consult page",
  endConsult: "The doctor ended the consult",
  cap_90m: "Stopped at the 90-minute limit",
  next_open: "The next consult started",
  idle_timeout: "No activity for a while",
};
const LANG = { en: "English", hi: "Hindi", kn: "Kannada", ml: "Malayalam", te: "Telugu", ta: "Tamil", mr: "Marathi", bn: "Bengali", gu: "Gujarati", pa: "Punjabi", od: "Odia" };
const langName = (l) => (l ? LANG[String(l).split("-")[0].toLowerCase()] ?? String(l) : "");

// ---------------------------------------------------------------- the per-day consult doc (whitelisted; the clip prefix never leaves the server)
export function consultsDocOf(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.consults)) return { loaded: false, list: [] };
  const list = [];
  for (const c of doc.consults.slice(0, 500)) {
    const s = Number(c?.s), e = Number(c?.e);
    if (!CONSULT_ID_RE.test(c?.id ?? "") || !Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > 6 * 3600 * 1000 || s < 0) continue;
    const status = STATUS.has(c.status) ? c.status : "error";
    const prefix = typeof c.prefix === "string" && PREFIX_RE.test(c.prefix) ? c.prefix : null;
    list.push({
      id: c.id, doctor: rstr(c.doctor, 80), s, e, minutes: Number.isFinite(+c.minutes) ? Math.round(+c.minutes * 10) / 10 : Math.round((e - s) / 6000) / 10,
      quality: rstr(c.quality, 24), closeReason: rstr(c.close_reason, 24), status, why: SKIP_KINDS[c.skip_kind] ? c.skip_kind : status === "deferred_long" ? "too_long" : status === "error" ? "cut_failed" : null,
      prefix, whole: status === "cut" && prefix && Number(c.bytes?.consult) > 0, doctorOnly: status === "cut" && prefix && Number(c.bytes?.doctor) > 0,
    });
  }
  list.sort((a, b) => a.s - b.s);
  return { loaded: true, list };
}
export const whyText = (c) => (c.status === "cut" ? null : SKIP_KINDS[c.why] ?? "The clip was not cut");
export const qualityText = (q) => QUALITY[q] ?? "Not stated";
export const closeText = (r) => CLOSE[r] ?? "Not stated";

// A consult span is blind when the IST day of its start OR of its end-1s is a blind day for the room (the same rule the seed applies to windows).
export function spanBlind(room, s, e) {
  const day = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
  return isBlind(room, day(s)) || isBlind(room, day(Math.max(s, e - 1000)));
}

// ---------------------------------------------------------------- signed clip links: <payload b64url>.<hmac b64url>, HMAC-SHA256 with the Worker secret CLIP_HMAC_KEY
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function hmacKey(env, usage) {
  const raw = typeof env.CLIP_HMAC_KEY === "string" ? env.CLIP_HMAC_KEY.trim() : "";
  if (raw.length < 32) return null;   // too short to be a real key: links are off rather than weak (the handover says 32)
  return crypto.subtle.importKey("raw", new TextEncoder().encode(raw), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
export async function signClip(env, { room, date, id, file, dl }, nowS = Math.floor(Date.now() / 1000)) {
  const key = await hmacKey(env, "sign");
  if (!key || !FILES[file]) return null;
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ r: room, d: date, u: id, f: file, a: dl ? 1 : 0, x: nowS + CLIP_TTL_S })));
  const sig = b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}
// -> { r, d, u, f, a } | null. Null for a tampered, malformed or expired token; callers answer a bare 404.
export async function verifyClip(env, token, nowS = Math.floor(Date.now() / 1000)) {
  try {
    const key = await hmacKey(env, "verify");
    const parts = typeof token === "string" ? token.split(".") : [];
    if (!key || parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
    if (!(await crypto.subtle.verify("HMAC", key, unb64u(parts[1]), new TextEncoder().encode(parts[0])))) return null;   // constant-time inside verify
    const p = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    if (!(Number.isFinite(p.x) && p.x > nowS && p.x <= nowS + CLIP_TTL_S + 60) || !FILES[p.f]) return null;
    return { r: String(p.r), d: String(p.d), u: String(p.u), f: p.f, a: p.a === 1 };
  } catch { return null; }
}
export const clipFileName = (date, c, file, dl) => `consult-${date}-${hm(c.s).replace(":", "")}${file === "d" ? "-doctor-only" : ""}.flac`;

// ---------------------------------------------------------------- windows over a span: the Neon index route first, an R2 listing as the fallback
const WID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
async function windowsFromIndex(env, room, date, s, e) {
  const token = typeof env.REB_INDEX_READ_TOKEN === "string" ? env.REB_INDEX_READ_TOKEN.trim() : "";
  if (!token) return null;
  const base = String(env.REB_INDEX_BASE_URL || "https://www.evenscribe.app").replace(/\/+$/, "");
  const f = env.__rebFetch ?? fetch;
  const win = new Map();
  let cursor = null;
  for (let page = 0; page < 6; page++) {
    const url = `${base}/api/reb/index?ist_date=${encodeURIComponent(date)}&room_id=${encodeURIComponent(room)}&limit=5000${cursor ? `&cursor=${cursor}` : ""}`;
    const r = await f(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const body = await r.json();
    for (const x of Array.isArray(body?.rows) ? body.rows : []) {
      const t0 = Number(x?.t0_ms), t1 = Number(x?.t1_ms);
      if (WID_RE.test(x?.window_id ?? "") && Number.isFinite(t0) && Number.isFinite(t1) && t0 < e && t1 > s) win.set(x.window_id, { t0, t1 });
    }
    cursor = body?.next_cursor;
    if (!cursor) break;
  }
  return [...win].sort((a, b) => a[1].t0 - b[1].t0).map(([id]) => id);
}
async function windowsFromR2(env, room, date, s, e) {
  if (!env.RESULTS?.list) return [];
  const out = [];
  const page = await env.RESULTS.list({ prefix: `reb/${date}/${room}/`, delimiter: "/", limit: 1000 });
  const ids = (page.delimitedPrefixes ?? []).map((p) => p.split("/")[3]).filter((w) => WID_RE.test(w ?? "") && !w.startsWith("_")).slice(0, 150);
  for (const w of ids) {
    try {
      const o = await env.RESULTS.get(`reb/${date}/${room}/${w}/manifest.json`);
      const m = o ? JSON.parse(await o.text()) : null;
      if (m && Number(m.t0_ms) < e && Number(m.t1_ms) > s) out.push([w, Number(m.t0_ms)]);
    } catch { /* an unreadable manifest is a window we cannot place, not an error */ }
  }
  return out.sort((a, b) => a[1] - b[1]).map(([id]) => id);
}
export async function windowsOverSpan(env, room, date, s, e) {
  let ids = null;
  try { ids = await windowsFromIndex(env, room, date, s, e); } catch { ids = null; }
  if (ids === null) { try { ids = await windowsFromR2(env, room, date, s, e); } catch { ids = []; } }
  return ids.slice(0, 16);
}

// ---------------------------------------------------------------- the drawer model
const crop = (segs, s, e) => segs.filter((g) => g.t1_ms > s && g.t0_ms < e).sort((a, b) => a.t0_ms - b.t0_ms);
export async function drawerModel(env, room, date, c) {
  if (spanBlind(room, c.s, c.e)) return null;
  const ids = await windowsOverSpan(env, room, date, c.s, c.e);
  const scopes = [...ids.map((w) => ({ id: w, scope: "window" })), { id: `_consults/${c.id}`, scope: "consult" }];
  const loaded = await Promise.all(scopes.map(async (sc) => ({ sc, m: await rebModel(env, date, room, sc.id, { rich: true, absoluteOk: sc.scope === "consult" }).catch(() => ({ loaded: false })) })));
  const tracks = [];
  for (const { sc, m } of loaded) if (m.loaded) for (const t of m.tracks) tracks.push({ ...t, scope: sc.scope, segments: crop(t.segments, c.s, c.e), had: t.segments.length });
  // a consult-scope track replaces the same (layer, engine, config) read from windows: the consult cut is the closer evidence
  const consultKeys = new Set(tracks.filter((t) => t.scope === "consult").map((t) => `${t.layer}\0${t.engine}\0${t.config_hash}`));
  const kept = tracks.filter((t) => t.scope === "consult" || !consultKeys.has(`${t.layer}\0${t.engine}\0${t.config_hash}`));
  const lanes = new Map();
  for (const t of kept) {
    const key = LANES.find((l) => l.test(t.layer, t.engine)).key;
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(t);
  }
  return { room_id: room, date, c, lanes, windows: ids.length, scopeFound: loaded.some((x) => x.sc.scope === "consult" && x.m.loaded) };
}

// ---------------------------------------------------------------- rendering
function laneStatus(tracks) {
  const withSegs = tracks.filter((t) => t.status === "ok" && t.segments.length);
  if (withSegs.length) return { word: "Done", cls: "ok" };
  if (tracks.some((t) => t.status === "ok" || t.status === "empty")) return { word: "Ran; nothing in this part", cls: "empty" };
  if (tracks.some((t) => t.status === "failed")) return { word: "Did not complete", cls: "bad" };
  return { word: "Skipped", cls: "empty" };
}
function laneTitle(key, t) {
  const L = LANE_BY_KEY[key];
  if (key === "koyal") { const n = KOYAL_NAMES[t?.cfg_lang]; return n ? `${L.label} · ${n}` : L.label; }
  return L.label;
}
// raw speaker ids ("SPEAKER_00", "spk_1") become "Speaker 1", "Speaker 2" in order of first appearance within one lane
const speakerLabels = () => { const order = new Map(); return (id) => { if (!id) return ""; if (!order.has(id)) order.set(id, order.size + 1); return `Speaker ${order.get(id)}`; }; };
const ATTRIBUTION = { warehouse: "The hospital's own consult record", extension: "The doctor's sign-in on the computer", none: "Not identified" };

function sarvamBlock(dm) {
  const stt = (dm.lanes.get("sarvam") ?? []).filter((t) => t.status === "ok");
  const tr = (dm.lanes.get("sarvam_translate") ?? []).filter((t) => t.status === "ok");
  const segs = stt.flatMap((t) => t.segments).sort((a, b) => a.t0_ms - b.t0_ms);
  if (dm.c.status !== "cut") return `<p class="mut">Not available: ${esc(whyText(dm.c))}.</p>`;
  const all = dm.lanes.get("sarvam") ?? [];
  if (!all.length) return `<p class="laneempty">Sarvam not run yet.</p>`;
  if (!stt.length) { const bad = all.find((t) => t.status === "failed"); return `<p class="laneempty">Sarvam did not complete${bad?.reason ? ": " + esc(bad.reason) : ""}.</p>`; }
  if (!segs.length) return `<p class="laneempty">Sarvam ran, and heard nothing in this part.</p>`;
  const en = tr.flatMap((t) => t.segments);
  const order = new Map();
  const spk = (id) => { if (!id) return "–"; if (!order.has(id)) order.set(id, order.size + 1); return `Speaker ${order.get(id)}`; };
  const overlap = (g) => en.filter((x) => x.t1_ms > g.t0_ms && x.t0_ms < g.t1_ms).map((x) => x.text).join(" ");
  const hasEn = en.length > 0;
  const rows = segs.slice(0, 400).map((g) => `<tr><td class="mono">${esc(hms(g.t0_ms))}</td><td>${esc(spk(g.speaker))}</td><td>${esc(langName(g.lang))}${g.conf != null ? ` <span class="mut">${Math.round(g.conf * 100)}%</span>` : ""}</td><td>${esc(g.text)}</td>${hasEn ? `<td>${esc(overlap(g))}</td>` : ""}</tr>`).join("");
  return `<table class="turns"><tr><th>Time (IST)</th><th>Who</th><th>Language</th><th>Said</th>${hasEn ? "<th>In English</th>" : ""}</tr>${rows}</table>${segs.length > 400 ? `<p class="mut">Showing the first 400 of ${segs.length} turns.</p>` : ""}${hasEn ? "" : `<p class="mut">No English translation exists for this consult yet.</p>`}`;
}
function otherLane(key, tracks, c) {
  const L = LANE_BY_KEY[key];
  const st = laneStatus(tracks);
  const groups = key === "koyal" ? tracks.map((t) => [t]) : [tracks];
  const body = groups.map((g) => {
    const segs = g.flatMap((t) => t.segments).sort((a, b) => a.t0_ms - b.t0_ms);
    const head = key === "koyal" ? `<h4>${esc(laneTitle(key, g[0]))}</h4>` : "";
    const reason = g.find((t) => t.status === "failed" && t.reason)?.reason;
    if (!segs.length) return `${head}<p class="laneempty">${esc(g.some((t) => t.status === "failed") ? `Did not complete${reason ? ": " + reason : ""}` : "Ran, and found nothing in this part.")}</p>`;
    const words = WORD_LANES.has(key);
    const label = speakerLabels();
    return `${head}<table class="turns"><tr><th>Time (IST)</th><th>${words ? "Who" : "Speaker"}</th><th>${words ? "Said" : "Note"}</th></tr>${segs.slice(0, 200).map((g2) => `<tr><td class="mono">${esc(hms(g2.t0_ms))}</td><td>${esc(label(g2.speaker) || (words ? langName(g2.lang) : ""))}</td><td>${esc(g2.text)}</td></tr>`).join("")}</table>${segs.length > 200 ? `<p class="mut">Showing the first 200 of ${segs.length}.</p>` : ""}`;
  }).join("");
  return `<details class="dl"><summary><b>${esc(L.label)}</b>${L.retired ? ` <span class="chip">retired engine</span>` : ""} <span class="chip ${st.cls}">${esc(st.word)}</span> <span class="mut">${esc(L.help)}</span></summary>${body}</details>`;
}
function provenance(dm) {
  const rows = [];
  for (const [key, tracks] of dm.lanes) for (const t of tracks) rows.push(`<tr><td>${esc(laneTitle(key, t))}</td><td>${esc(t.engine)}</td><td>${esc(t.version)}</td><td class="mono">${esc(t.config_hash)}</td><td class="mono">${esc(t.job_id ?? "")}</td><td>${esc(t.finished_at ?? "")}</td><td>${esc(t.status)}</td></tr>`);
  if (!rows.length) return "";
  return `<details class="dl"><summary><b>Where this came from</b> <span class="mut">engine, version, settings, job and time written</span></summary><table class="turns"><tr><th>Lane</th><th>Engine</th><th>Version</th><th>Settings</th><th>Job</th><th>Written</th><th>State</th></tr>${rows.join("")}</table></details>`;
}
function visitFacts(dm) {
  const c = dm.c;
  const enc = (dm.lanes.get("encounter") ?? []).flatMap((t) => t.segments).find((g) => g.x?.consult_uid === c.id) ?? (dm.lanes.get("encounter") ?? []).flatMap((t) => t.segments)[0];
  const x = enc?.x ?? {};
  const rows = [
    ["Doctor", x.display_name || c.doctor || "Not recorded"],
    ["Time (IST)", `${hm(c.s)}–${hm(c.e)}`],
    ["Length", `${c.minutes} minutes`],
    ["How well it was recorded", x.quality ? qualityText(x.quality) : qualityText(c.quality)],
    ["How it ended", closeText(c.closeReason)],
    ["Prescription", x.prescription_ref || x.warehouse_prescription_uid || (dm.lanes.get("encounter") ? "No prescription linked" : "Not available yet")],
  ];
  if (x.attribution) rows.splice(4, 0, ["Who named the doctor", ATTRIBUTION[x.attribution] ?? x.attribution]);
  return `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}
// links = { play, download, doctorDownload } (signed paths, or null), audio = { whole: bool, doctor: bool } = what actually exists in storage
export function drawerHtml(dm, links, audio, closeHref) {
  const c = dm.c;
  const clip = c.status !== "cut" ? `<p class="laneempty">Consult not cut: ${esc(whyText(c))}.</p>`
    : !links ? `<p class="laneempty">Downloads are not switched on yet.</p>`
    : !audio.whole ? `<p class="laneempty">The clip was cut but is not in storage yet, so it cannot be played here.</p>`
    : `<audio controls preload="none" src="${esc(links.play)}"></audio><p><a class="btn" href="${esc(links.download)}">Download the consult audio</a>${audio.doctor && links.doctorDownload ? ` <a class="btn" href="${esc(links.doctorDownload)}">Download the doctor-only audio</a>` : ""}</p><p class="mut">Download links work for 15 minutes; reload the page for a fresh one.</p>`;
  const order = LANES.map((l) => l.key).filter((k) => !["sarvam", "sarvam_translate", "sarvam_diar", "encounter"].includes(k));
  const others = order.filter((k) => dm.lanes.has(k)).map((k) => otherLane(k, dm.lanes.get(k), c)).join("");
  const diarS = dm.lanes.has("sarvam_diar") ? otherLane("sarvam_diar", dm.lanes.get("sarvam_diar"), c) : "";
  const notProcessed = order.filter((k) => !dm.lanes.has(k) && ["router", "koyal", "medical", "diar", "acoustics"].includes(k)).map((k) => `<p class="mut"><b>${esc(LANE_BY_KEY[k].label)}:</b> not processed for this part of the day.</p>`).join("");
  return `<section class="card drawer" id="consult"><h2>${esc(c.doctor || "Consult")} · ${esc(hm(c.s))}–${esc(hm(c.e))} IST · ${esc(c.minutes)} min <a class="close" href="${esc(closeHref)}">Close</a></h2>
<div class="dbody">${visitFacts(dm)}${clip}
<h3>What was said (Sarvam)</h3>${sarvamBlock(dm)}${diarS}
<h3>Everything else held for this time</h3>${others || `<p class="laneempty">Nothing else has been processed for this part of the day.</p>`}${notProcessed}${provenance(dm)}</div></section>`;
}
