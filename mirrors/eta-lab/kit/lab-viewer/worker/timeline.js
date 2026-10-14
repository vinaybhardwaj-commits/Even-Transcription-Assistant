// /timeline (FABLE W49, "ship it"): the Room Timeline. Level 1 (hospital, one day, every room) and Level 2 (one room's whole day).
// Level 3 (per-consult inspector, audio playback) is P2; consult/window rows link to the existing /#/consult SPA meanwhile.
// Design ported from V-approved mockup /home/eta/oc/RoomTimeline-mockup.dc.html (layout, words, colours, legends) - NOT its code.
// Server-rendered, escape-first, zero client script, same Access gate as every route. Reuses encounters.js's reviewed helpers.
// CSP note: the page's style-src is 'nonce-...' only, so no inline style="" attribute anywhere. Proportional bars are drawn as
// inline SVG instead: fill/x/y/width/height are ordinary SVG presentation attributes, not the `style` attribute, so style-src
// does not apply to them. Everything else (tiles, pills, legend swatches, dots) uses fixed CSS classes from the small named palette.
import { turnsOf, coverageOf, validRoomDate } from "./encounters.js";
import { isBlind, BLIND_MSG } from "./blind.js";
import { whyText } from "./consults.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rstr = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const IST_MS = 19800000;
const fmtHM = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16);
const durH = (ms) => { const h = ms / 3600000; return h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(ms / 60000)}m`; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// V-approved palette (TIMELINE-SHAPES.md): blue vs orange for agree/disagree, never red vs green
export const C = { consult: "#0F6B6B", quiet: "#DCD7CD", fault: "#B4471A", missed: "#E07B2E", agree: "#5B8DC9", disagree: "#E07B2E", doctor: "#0F6B6B", patient: "#E0A43A", other: "#A7A39A" };
const SPK_ROT = ["#2F4C8A", "#8A63B8", "#6F7F3A", "#9A6B3F", "#B4471A", "#4A4D52"];   // window-local speaker letters, rotated by rank (same idea as the Consult page's speaker chips)

// ---- whitelist lx/cap/linker/acoustics/fleet's per-room-day file (TIMELINE-SHAPES.md); missing/bad = "not processed yet", never a 500
function span(o, capMs = 24 * 3600 * 1000) {
  const s = Number(o?.start_ms), e = Number(o?.end_ms);
  return Number.isFinite(s) && Number.isFinite(e) && e > s && e - s <= capMs && s >= 0 ? { s, e } : null;
}
function spans(list, extra = () => ({})) {
  return (Array.isArray(list) ? list : []).slice(0, 500).map((x) => { const sp = span(x); return sp && { ...sp, ...extra(x) }; }).filter(Boolean).sort((a, b) => a.s - b.s);
}
const FLEET_KINDS = new Set(["mic_missing", "kiosk_offline", "recorder_restarted", "selftest_ok", "lunch_pause"]);
// W49 palimpsest overnight priority (Fable 28 Sep): the 8 REB engine-layer lanes for the WHOLE room-day, built offline
// by tools/reb_timeline_seed.py (kit.reb's own load_window/.tracks(latest_ok=True) selection, never reimplemented here)
// and merged into this same doc under `reb`. Segments are already on the absolute tape-clock (the seed tool applies the
// same clip-local offset fix as worker/reb.js's per-window rebModel() - eta-refuter-2 #5266 F2), so this Worker only
// whitelists shape, never recomputes anything. A lane not in the doc yet (older/pre-REB room-days) = empty, not an error.
const KOYAL_LANGS = ["hi", "kn", "ml", "te"];   // KOYAL-LANE-SPEC f1f57dc3: one koyal track per prompt language, all four run on every window
const KOYAL_LANES = KOYAL_LANGS.map((l) => `koyal_${l}`);
const SARVAM_LANES = ["sarvam", "sarvam_translate", "sarvam_diar"];   // 6V: the Sarvam lanes (stt, English, speaker turns)
const TEXT_LANES = new Set(["whisper", "medmodel", "indic", "sravaani", "medasr", "translate", "router", "sarvam", "sarvam_translate", ...KOYAL_LANES]);   // every REB lane that carries transcript words
const REB_LANES = ["whisper", "medmodel", "indic", "sravaani", "medasr", "translate", ...KOYAL_LANES, "diar", "acoustic", "tone", "router", ...SARVAM_LANES, "encounter"];
const NULL_IF_ABSENT = new Set(["medmodel", "translate", ...KOYAL_LANES, "router", ...SARVAM_LANES, "encounter"]);   // null = the seed predates this lane; [] = looked, none
function rebLaneSpans(list) { return rebLaneSpansAll((Array.isArray(list) ? list : []).slice(0, 2000)); }
function rebLaneSpansAll(list) {
  let eos = 0;
  const out = (Array.isArray(list) ? list : []).map((x) => {
    const s = Number(x?.t0_ms), e = Number(x?.t1_ms);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || s < 0) return null;
    const raw = rstr(x?.text, 1000), text = raw.replace(/<\/s>/g, "").trim();
    if (raw && !text) { eos++; return null; }   // MedASR emits the literal EOS token "</s>" for silent chunks; stored tracks stay as-is, the viewer shows them as empty
    return { s, e, text: raw === text ? raw : text, engine: rstr(x?.engine, 60) };
  }).filter(Boolean).sort((a, b) => a.s - b.s);
  Object.defineProperty(out, "eos", { value: eos });   // non-enumerable: the arrays stay plain for callers and deepEqual
  return out;
}
const eosOf = (reb) => Object.fromEntries(REB_LANES.filter((k) => Array.isArray(reb[k]) && reb[k].eos > 0).map((k) => [k, { eos: reb[k].eos, kept: reb[k].length }]));
export function timelineDocOf(doc) {
  if (!doc || typeof doc !== "object") return { loaded: false, pqm: [], cap: [], acoustics: null, fleet: [], detected: { acoustic: [], e6: [], jev_loop: [] }, reb: Object.fromEntries(REB_LANES.map((k) => [k, []])), reb_cap: {}, reb_eos: {}, reb_excluded: {}, source: null };
  const num = (v, lo, hi) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v * 100) / 100 : null);
  const ac = doc.acoustics && typeof doc.acoustics === "object" ? {
    missed_speech_pct: num(doc.acoustics.missed_speech_pct, 0, 100), snr_db: Number.isFinite(+doc.acoustics.snr_db) ? Math.round(+doc.acoustics.snr_db) : null,
    noise_floor: ["low", "medium", "high"].includes(doc.acoustics.noise_floor) ? doc.acoustics.noise_floor : null, clipping: doc.acoustics.clipping === true,
    silent_ms: Number.isFinite(+doc.acoustics.silent_ms) && +doc.acoustics.silent_ms >= 0 ? +doc.acoustics.silent_ms : null, missed: spans(doc.acoustics.missed),
  } : null;
  const reb = Object.fromEntries(REB_LANES.map((k) => [k, NULL_IF_ABSENT.has(k) && !Array.isArray(doc.reb?.[k]) ? null : rebLaneSpans(doc.reb?.[k])]));
  return {
    reb_eos: { ...eosOf(reb), ...Object.fromEntries(REB_LANES.filter((k) => Number.isInteger(doc.reb_eos?.[k]?.eos) && doc.reb_eos[k].eos > 0 && Number.isInteger(doc.reb_eos[k].kept) && doc.reb_eos[k].kept >= 0).map((k) => [k, { eos: doc.reb_eos[k].eos, kept: doc.reb_eos[k].kept }])) },   // the seed's count (dropped before capping) wins over the Worker's own count of older docs
    loaded: true, source: rstr(doc.source_sha256, 64).slice(0, 16) || null,
    // suspect (Fable 15:50, linker/surg-link #4759): a PQM auto-timeout artifact (called_at->completed_at exactly 3600s) - the row's
    // end_ms is real but not a real consult duration; render() must draw it start-only, never as a normal start-end bar.
    pqm: spans(doc.pqm_truth, (x) => ({ token: rstr(x?.token, 24), status: ["confirmed", "no_show", "cancelled", "probable", "none"].includes(x?.status) ? x.status : null, suspect: x?.suspect === true })),
    cap: spans(doc.cap_links, (x) => ({ items: Number.isInteger(x?.items) ? x.items : null, captured: Number.isInteger(x?.captured) ? x.captured : null, drugs: Number.isInteger(x?.drugs) ? x.drugs : null, rx_linked: x?.rx_linked === true })),
    acoustics: ac,
    fleet: (Array.isArray(doc.fleet) ? doc.fleet : []).slice(0, 100).map((x) => (FLEET_KINDS.has(x?.kind) && Number.isFinite(+x?.at_ms) ? { kind: x.kind, at: +x.at_ms, message: rstr(x.message, 120) } : null)).filter(Boolean),
    detected: {
      acoustic: spans(doc.detected?.acoustic, (x) => ({ conf: Number.isFinite(+x?.conf) ? Math.round(+x.conf * 100) / 100 : null })),
      e6: spans(doc.detected?.e6, (x) => ({ conf: Number.isFinite(+x?.conf) ? Math.round(+x.conf * 100) / 100 : null })),
      jev_loop: spans(doc.detected?.jev_loop, (x) => ({ conf: Number.isFinite(+x?.conf) ? Math.round(+x.conf * 100) / 100 : null })),
    },
    // translate is null (unknown) when the seed predates that lane; [] only when the seed wrote translate: [] (looked, none)
    reb_cap: Object.fromEntries(REB_LANES.filter((k) => Number.isInteger(doc.reb_cap?.[k]?.n_total) && doc.reb_cap[k].n_total > 0 && Number.isFinite(+doc.reb_cap[k].until_ms)).map((k) => [k, { n: doc.reb_cap[k].n_total, until: +doc.reb_cap[k].until_ms, full: doc.reb_cap[k].full === true }])),
    reb,
    reb_excluded: Object.fromEntries(REB_LANES.filter((k) => Number.isInteger(doc.reb_excluded?.[k]?.n_tracks) && doc.reb_excluded[k].n_tracks > 0).map((k) => [k, { n: doc.reb_excluded[k].n_tracks, reason: rstr(doc.reb_excluded[k].reason, 80) }])),
  };
}

// tape-coverage colour: consult/talk = teal, quiet/no-signal = grey, anything else = a dimmer grey (never red/green)
function statusColor(status) { return status === "text" || status === "refused" ? C.consult : status === "no_signal" ? C.quiet : "#C9C9C9"; }

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// ?from=HH:MM&to=HH:MM (IST, same day): both must be strict and from < to, else null (= the ordinary whole-day view)
export function parseWin(from, to) {
  const a = HM_RE.exec(from ?? ""), b = HM_RE.exec(to ?? "");
  if (!a || !b) return null;
  const fm = +a[1] * 60 + +a[2], tm = +b[1] * 60 + +b[2];
  return fm < tm ? { from: from, to: to, fm, tm } : null;
}
export const FULL_LANE_KEYS = REB_LANES;   // the only lane names that may become an R2 object key (timeline-lanes/<room>/<date>/<lane>.json)
// Zoom a room-day model to one time window. laneDocs = { lane: [raw segments] } read from the uncapped lane objects; only lanes the doc marks
// reb_cap[lane].full are taken, never on a blind room-day (text lanes were emptied above and must stay so).
export function applyWindow(m, laneDocs, win) {
  if (!m || !win) return m;
  const dayStart = Date.parse(`${m.date}T00:00:00+05:30`);
  const s0 = dayStart + win.fm * 60000, s1 = dayStart + win.tm * 60000;
  m.win = { ...win, s: s0, e: s1 };
  if (m.blind) return m;
  for (const k of REB_LANES) {
    const cap = m.d.reb_cap?.[k];
    if (!cap?.full) continue;
    if (!Array.isArray(laneDocs?.[k])) { m.d.reb[k] = []; m.d.reb_cap[k] = { ...cap, notLoaded: true }; continue; }   // fetch failed/missing: never show the capped head as if it were this window
    const all = rebLaneSpansAll(laneDocs[k]), inWin = all.filter((x) => x.e > s0 && x.s < s1);
    if (m.d.reb_eos[k]) m.d.reb_eos[k] = { ...m.d.reb_eos[k], day: true };   // the lane object is already EOS-free; the counts stay the day's, and the label says so
    m.d.reb[k] = inWin.slice(0, 2000);
    m.d.reb_cap[k] = { ...cap, win: true, shown: m.d.reb[k].length, inWin: inWin.length, until: m.d.reb[k].length ? m.d.reb[k][m.d.reb[k].length - 1].e : s0 };
  }
  return m;
}

export function roomDayModel(consult, doc, consults = null) {
  const windows = (consult.windows || []).map((w) => ({ k: w.k, t0: w.t0, t1: w.t1, s: w.s, e: w.e, status: w.status, n_words: w.n_words, run_id: w.run_id }));
  const turns = turnsOf(consult.segments || []);
  const cov = coverageOf(windows, consult.hidden);
  const d = timelineDocOf(doc);
  const blind = isBlind(consult.room_id, consult.date);
  if (blind) for (const k of REB_LANES) if (Array.isArray(d.reb[k])) d.reb[k] = TEXT_LANES.has(k) ? [] : d.reb[k].map((x) => ({ ...x, text: "" }));   // the text lanes are replaced by the notice; no other lane carries words
  const wordWindows = windows.filter((w) => (w.n_words ?? 0) > 0);
  const talkMs = wordWindows.reduce((n, w) => n + Math.max(0, w.e - w.s), 0);
  // 6V: the day's consult clips (worker/consults.js consultsDocOf). Never carried for a blind room-day: no band, no list, no link.
  return { room_id: consult.room_id, room_name: consult.room_name, date: consult.date, blind, windows, hidden: consult.hidden || [], turns, cov, talkMs, d, consults: blind || !consults ? { loaded: false, list: [] } : consults };
}

const CSS = `
.cb a{cursor:pointer}.cb a:hover rect{stroke:#1B1C1E;stroke-width:2}
.crow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 16px;border-top:1px solid var(--line2);font-size:14px}.crow .t{width:130px;flex-shrink:0}
.chip{display:inline-block;border-radius:99px;padding:0 8px;font-size:11px;border:1px solid var(--line);color:var(--dim)}.chip.ok{border-color:#0F6B6B;color:var(--acc)}.chip.bad{border-color:#B4471A;color:#B4471A}.chip.empty{color:var(--mut)}
.btn{display:inline-block;background:var(--fg);color:var(--bg);border-radius:8px;padding:6px 12px;text-decoration:none;font-weight:600;font-size:13px}
.drawer{border:2px solid var(--acc)}.drawer .close{float:right;font-size:13px;font-weight:400}.drawer .dbody{padding:4px 16px 16px}.drawer h3{font-size:14px;margin:18px 0 6px}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0 0 12px}.facts dt{color:var(--mut);font-size:13px}.facts dd{margin:0}
.drawer audio{width:100%;max-width:560px;display:block;margin:8px 0}
table.turns{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0}table.turns th,table.turns td{padding:4px 8px;text-align:left;border-top:1px solid var(--line2);vertical-align:top}
details.dl{border-top:1px solid var(--line2);padding:6px 0}details.dl summary{cursor:pointer}details.dl h4{margin:8px 0 2px;font-size:13px}

:root{--bg:#F4F2EE;--fg:#1B1C1E;--mut:#5E6168;--dim:#33363B;--line:#E2DED6;--line2:#ECE8E0;--card:#FFFFFF;--acc:#0F6B6B}
@media (prefers-color-scheme:dark){:root{--bg:#1B1C1E;--fg:#F4F2EE;--mut:#A7A39A;--dim:#D9D4CA;--line:#3A3A38;--line2:#2E2E2C;--card:#242422;--acc:#3FA7A0}}
*{box-sizing:border-box}body{overflow-wrap:anywhere;margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 'IBM Plex Sans',system-ui,sans-serif}
.mono{font-family:'IBM Plex Mono',ui-monospace,monospace}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line);flex-wrap:wrap}
header h1{font-size:18px;margin:0}header .sub{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
nav a{margin-right:12px;color:var(--acc);text-decoration:none;font-weight:600}
main{padding:20px 20px 60px;max-width:1300px;margin:0 auto}.mut{color:var(--mut);font-size:13px}a{color:var(--acc)}
.dates{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 16px}.dates a{border:1px solid var(--line);border-radius:99px;padding:2px 10px;font-size:12px;text-decoration:none;color:var(--fg)}.dates a.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.tile .l{font-size:12px;color:var(--mut)}.tile .v{font-size:24px;font-weight:600}.tile.attn .v{color:#8A2E0B}.tile .s{font-size:12px;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:16px;overflow:hidden}.card h2{font-size:15px;margin:0;padding:10px 16px}.card h2 .h2s{font-weight:400;font-size:13px;color:var(--mut)}
.arow{display:flex;align-items:center;gap:12px;padding:8px 16px;border-top:1px solid var(--line2);font-size:14px;text-decoration:none;color:inherit}
.arow:hover{background:rgba(0,0,0,.03)}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}.dot.fault{background:#B4471A}
.rrow{display:block;padding:10px 16px;border-top:1px solid var(--line2);text-decoration:none;color:inherit}
.rrow:hover{background:rgba(0,0,0,.03)}
.rrow .top{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;margin-bottom:6px}
.barwrap{border-radius:4px;overflow:hidden;background:var(--line2)}
.legend{display:flex;flex-wrap:wrap;gap:14px;padding:8px 16px 14px;font-size:12px;color:var(--dim)}
.legend span.k{display:flex;align-items:center;gap:6px}.legend .sw{width:14px;height:10px;border-radius:2px;display:inline-block;flex-shrink:0}
.sw-consult{background:#0F6B6B}.sw-quiet{background:#DCD7CD}.sw-fault{background:#B4471A}.sw-missed{background:#E07B2E}.sw-queue{background:transparent;border:2px solid #1B1C1E}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 12px;text-align:left;border-top:1px solid var(--line2)}th{font-size:12px;color:var(--mut);font-weight:600}
.lane{display:flex;align-items:center;border-top:1px solid var(--line2);padding:6px 0}.lane .ll{width:190px;flex-shrink:0;padding-right:12px}
.lane .ll b{font-size:14px;display:block}.lane .ll span{display:block;font-size:12px;color:var(--mut)}
.ltrack{flex-grow:1;position:relative;height:28px}
.laneempty{font-size:13px;color:var(--mut);font-style:italic;padding-left:2px}
`;

// ---- proportional bars as inline SVG (fill/x/width are attributes, not `style=`; CSP-safe). viewBox 0..100 maps directly to percent.
function svgBar(items, dayStart, dayEnd, heightPx, opts = {}) {
  const span = Math.max(1, dayEnd - dayStart);
  const x = (t) => (100 * (t - dayStart)) / span;
  const w = (a, b) => Math.max(0.15, (100 * (b - a)) / span);
  // a `tick` item (Fable 15:50: pqm suspect rows) draws a fixed-width marker at its start only - the item's real end_ms is
  // never used for its width, so a suspect row can never visually read as a normal proportional start-end consult bar.
  const rects = items.map((it) => it.tick
    ? `<rect x="${x(it.s).toFixed(3)}" y="${opts.outline ? 2 : 0}" width="0.4" height="${opts.outline ? 96 : 100}" rx="0.5" fill="${esc(it.c)}"><title>${esc(it.tip ?? "")}</title></rect>`
    : `<rect x="${x(it.s).toFixed(3)}" y="${opts.outline ? 2 : 0}" width="${w(it.s, it.e).toFixed(3)}" height="${opts.outline ? 96 : 100}" rx="1.5" ${opts.outline ? `fill="none" stroke="${esc(it.c)}" stroke-width="3"` : `fill="${esc(it.c)}"`}><title>${esc(it.tip ?? "")}</title></rect>`
  ).join("");
  const now = opts.nowMs != null && opts.nowMs >= dayStart && opts.nowMs <= dayEnd ? `<rect x="${x(opts.nowMs).toFixed(3)}" y="0" width="0.3" height="100" fill="#1B1C1E"><title>Now</title></rect>` : "";
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="${heightPx}" role="img" aria-label="${esc(opts.label ?? "timeline")}">${rects}${now}</svg>`;
}

function laneRow(name, desc, inner) {
  return `<div class="lane"><div class="ll"><b>${esc(name)}</b><span>${esc(desc)}</span></div><div class="ltrack">${inner}</div></div>`;
}
function laneEmpty(name, desc, text) { return laneRow(name, desc, `<span class="laneempty">${esc(text)}</span>`); }

function page(title, subHtml, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>ETA lab — timeline — ${esc(title)}</title><style nonce="__NONCE__">${CSS}</style></head>
<body><header><div><h1>ETA · Room Timeline — ${esc(title)}</h1>${subHtml}</div><nav><a href="/timeline">All rooms</a><a href="/">Viewer</a></nav></header>
<main>${bodyHtml}</main></body></html>`;
}

// ---------------------------------------------------------------- Level 1: hospital, one day, every room
export function hospitalPage(date, rooms, dates) {
  const dayStart = Date.parse(`${date}T00:00:00+05:30`), dayEnd = dayStart + 24 * 3600 * 1000;
  const now = Date.now();
  const dateLinks = dates.slice(0, 60).map((d) => `<a class="${d === date ? "on" : ""}" href="/timeline?date=${esc(d)}">${esc(d)}</a>`).join("");
  const recording = rooms.filter((r) => r.n > 0).length;
  // refuter-2 #4599 L1: linker ships confirmed/probable pqm rows only, never the full queue - "X of Y" would read as a completeness
  // ratio it isn't. Show the raw count with a caveat instead of a fraction.
  const found = rooms.reduce((n, r) => n + (r.d.loaded ? r.d.pqm.filter((p) => p.status === "confirmed").length : 0), 0);
  const anyPqm = rooms.some((r) => r.d.loaded);
  const totalMs = rooms.reduce((n, r) => n + r.coveredMs, 0);   // L3: total window coverage, not just windows with words
  const alerts = rooms.flatMap((r) => r.d.fleet.filter((f) => f.kind === "mic_missing" || f.kind === "kiosk_offline").map((f) => ({ ...f, room: r })));
  const tiles = [
    { l: "Rooms recording today", v: `${recording} of ${rooms.length}`, s: rooms.length - recording ? `${rooms.length - recording} room(s) with no windows` : "all rooms have windows" },
    { l: "Consults found", v: anyPqm ? String(found) : "not processed yet", s: "confirmed, matched by CAP link (not the full queue)" },
    { l: "Audio recorded today", v: durH(totalMs), s: "sum of STT window coverage" },
    { l: "Needs attention", v: String(alerts.length), s: "see below", attn: alerts.length > 0 },
  ];
  const alertRows = alerts.length ? alerts.map((a) => `<a class="arow" href="/timeline/${esc(a.room.room_id)}/${esc(date)}"><span class="dot fault"></span><b>${esc(a.room.room_name)}</b> <span class="mut">${esc(a.message || a.kind)} · ${fmtHM(a.at)} IST</span></a>`).join("") : `<div class="arow mut">Nothing needs attention.</div>`;
  const roomRows = rooms.slice().sort((a, b) => a.room_name.localeCompare(b.room_name)).map((r) => {
    const bar = svgBar(r.windows.map((w) => ({ s: w.s, e: w.e, c: statusColor(w.status), tip: `${w.t0}–${w.t1} ${w.status}` })), dayStart, dayEnd, 26, { nowMs: date === todayIst(now) ? now : null, label: `${r.room_name} coverage` });
    // L2: no pre-registered pass/fail threshold exists for CAP capture - show the ratio itself, neutral, never a Good/Fair verdict
    const capturedSum = r.d.loaded ? r.d.cap.reduce((n, c) => n + (c.captured ?? 0), 0) : 0, itemsSum = r.d.loaded ? r.d.cap.reduce((n, c) => n + (c.items ?? 0), 0) : 0;
    const capText = r.d.loaded && itemsSum ? `${Math.round((100 * capturedSum) / itemsSum)}% captured (${capturedSum} of ${itemsSum})` : "not scored yet";
    return `<a class="rrow" href="/timeline/${esc(r.room_id)}/${esc(date)}">
      <div class="top"><b>${esc(r.room_name)}</b><span class="mut">${r.n} STT windows${r.d.loaded ? ` · ${r.d.pqm.length} confirmed/probable consults` : ""}</span>
        <span class="mut">${esc(capText)}</span></div>
      <div class="barwrap">${bar}</div></a>`;
  }).join("") || `<div class="arow mut">No rooms have STT windows on this date.</div>`;
  return page("All rooms", `<span class="sub">Even Hospital · ${esc(date)}</span>`, `
<div class="dates">${dateLinks}</div>
<div class="tiles">${tiles.map((t) => `<div class="tile${t.attn ? " attn" : ""}"><div class="l">${esc(t.l)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("")}</div>
<div class="card"><h2>Needs attention</h2>${alertRows}</div>
<div class="card"><h2>Every room, today <span class="h2s">— click a room to see its whole day</span></h2>
<div class="legend"><span class="k"><span class="sw sw-consult"></span>Speech heard</span><span class="k"><span class="sw sw-quiet"></span>Recording, quiet</span><span class="k"><span class="sw sw-fault"></span>Fault</span></div>
${roomRows}</div>
<p class="mut">Consults are matched to the patient queue by call-in and complete time. Times are IST.</p>`);
}
function todayIst(nowMs) { return new Date(nowMs + IST_MS).toISOString().slice(0, 10); }

// ---------------------------------------------------------------- Level 2: one room, whole day
// 6V: the consult lane: one band per consult, each an ordinary link to ?consult=<id> (server-rendered drawer, no client script).
const bandClass = (c) => (c.status === "cut" ? C.consult : "#8A7F6E");
function consultLane(m, dayStart, dayEnd) {
  const list = m.consults?.list ?? [];
  if (m.blind) return laneEmpty("Consult clips", "Each consult, from the cutter", BLIND_MSG);
  if (!m.consults?.loaded) return laneEmpty("Consult clips", "Each consult, from the cutter", "not processed yet for this day");
  const inView = list.filter((c) => c.e > dayStart && c.s < dayEnd);
  if (!inView.length) return laneEmpty("Consult clips", "Each consult, from the cutter", "No consult detected.");
  const span = Math.max(1, dayEnd - dayStart), x = (t) => (100 * (Math.max(t, dayStart) - dayStart)) / span, w = (a, b) => Math.max(0.3, (100 * (Math.min(b, dayEnd) - Math.max(a, dayStart))) / span);
  const href = (c) => `/timeline/${encodeURIComponent(m.room_id)}/${encodeURIComponent(m.date)}?consult=${encodeURIComponent(c.id)}#consult`;
  const bands = inView.map((c) => {
    const tip = `${c.doctor || "Consult"} ${hm2(c.s)}–${hm2(c.e)} IST, ${c.minutes} min` + (c.status === "cut" ? " · clip ready" : ` · not cut: ${whyText(c)}`);
    const sel = m.drawerId === c.id;
    return `<a href="${esc(href(c))}" aria-label="${esc(tip)}"><rect x="${x(c.s).toFixed(3)}" y="3" width="${w(c.s, c.e).toFixed(3)}" height="94" rx="1.5" ${c.status === "cut" ? `fill="${bandClass(c)}"` : `fill="none" stroke="${bandClass(c)}" stroke-width="2" stroke-dasharray="4 3"`}${sel ? ` stroke="#1B1C1E" stroke-width="3"` : ""}><title>${esc(tip)}</title></rect></a>`;
  }).join("");
  return laneRow("Consult clips", "Each consult. Solid = clip ready, dashed = not cut. Click one to open it.",
    `<svg class="cb" viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="34" role="group" aria-label="Consult clips">${bands}</svg>`);
}
const hm2 = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16);
function consultList(m) {
  if (m.blind || !m.consults?.loaded || !m.consults.list.length) return "";
  const rows = m.consults.list.map((c) => `<div class="crow"><span class="t mono">${hm2(c.s)}–${hm2(c.e)}</span><b>${esc(c.doctor || "Doctor not recorded")}</b><span class="mut">${esc(c.minutes)} min</span>
<span class="chip ${c.status === "cut" ? "ok" : "empty"}">${c.status === "cut" ? "Clip ready" : "Not cut"}</span>${c.status === "cut" ? "" : `<span class="mut">${esc(whyText(c))}</span>`}
<a href="/timeline/${esc(encodeURIComponent(m.room_id))}/${esc(encodeURIComponent(m.date))}?consult=${esc(encodeURIComponent(c.id))}#consult">${c.status === "cut" ? "Open, play and download" : "Open"}</a></div>`).join("");
  return `<div class="card"><h2>Consults <span class="h2s">— ${m.consults.list.length} on this day; click one to hear it and see everything held for that time</span></h2>${rows}</div>`;
}

export function roomDayPage(m) {
  if (!m) return page("Room", "", `<p class="mut">This room-day has no data.</p>`);
  const dayStart0 = Date.parse(`${m.date}T00:00:00+05:30`);
  const dayStart = m.win ? m.win.s : dayStart0, dayEnd = m.win ? m.win.e : dayStart0 + 24 * 3600 * 1000;
  const now = Date.now(), nowMs = m.date === todayIst(now) ? now : null;
  const d = m.d;
  const cov = m.cov;
  const tiles = [
    { l: "Recorded today", v: durH(cov.covered_ms), s: `${cov.kept} STT windows` },
    // L1: linker ships confirmed/probable rows only, never the full queue - a raw count with a caveat, not a completeness ratio
    { l: "Consults found", v: d.loaded ? String(d.pqm.filter((p) => p.status === "confirmed").length) : "not processed yet", s: "confirmed, matched by CAP link (not the full queue)" },
    // L3: a 15-min window with one word counts fully here - this is "time in windows that have words", not measured talk time
    { l: "Time in windows with words", v: m.blind ? "–" : `${Math.round((100 * m.talkMs) / Math.max(1, cov.covered_ms))}%`, s: m.blind ? "not shown for a blinded room-day" : "of recorded time" },
    // L4: acoustics' figure is a small reference-VAD sample (A1 conditions), a lower bound - never a validated threshold, so no red flag
    { l: "Speech missed", v: d.acoustics && d.acoustics.missed_speech_pct !== null ? `${d.acoustics.missed_speech_pct}%` : "not processed yet", s: d.acoustics ? "sampled, lower bound (reference VAD, A1 conditions)" : "not sent for transcription" },
  ];
  const sttLane = laneRow("Speech heard", m.blind ? "Bench windows (word counts withheld)" : "Bench windows, teal = with words", svgBar(m.windows.map((w) => ({ s: w.s, e: w.e, c: (w.n_words ?? 0) > 0 ? C.consult : C.quiet, tip: `${w.t0}–${w.t1} · ${w.status}` })), dayStart, dayEnd, 28, { nowMs, label: "speech heard" }));
  const missedLane = !d.acoustics || !d.acoustics.missed.length ? laneEmpty("Speech missed", "Reference VAD vs what was sent for transcription (sampled, lower bound)", d.acoustics ? "None in the sampled chunks." : "not processed yet") :
    laneRow("Speech missed", "Reference VAD vs what was sent for transcription (sampled, lower bound)", svgBar(d.acoustics.missed.map((x) => ({ ...x, c: C.missed, tip: "Speech not sent for transcription" })), dayStart, dayEnd, 20));
  const spkLane = !m.turns.length ? laneEmpty("Who spoke", "Labelled turns (letters are window-local)", "No labelled speaker turns.") :
    laneRow("Who spoke", "Labelled turns (letters are window-local)", svgBar(m.turns.map((t) => ({ s: t.s, e: t.e, c: t.key.length > 1 ? C.other : SPK_ROT[t.key.charCodeAt(0) % SPK_ROT.length], tip: `Speaker ${t.key}` })), dayStart, dayEnd, 20));
  const queueLane = !d.loaded || !d.pqm.length ? laneEmpty("Patient queue", "Call-in to complete, from PQM", d.loaded ? "No PQM consults recorded." : "not processed yet") :
    laneRow("Patient queue", "Call-in to complete, from PQM", svgBar(d.pqm.map((p) => ({ ...p, c: "#1B1C1E", tick: p.suspect,
      tip: p.suspect ? `Queue ${p.token || "?"} called ${fmtHM(p.s)} - end time unknown (queue timer ran out)` : `Queue ${p.token || "?"} ${fmtHM(p.s)}–${fmtHM(p.e)} · ${p.status ?? "?"}` })), dayStart, dayEnd, 22, { outline: true }));
  const rxLane = !d.loaded || !d.cap.length ? laneEmpty("Prescription", "Linked CAP prescription checks", d.loaded ? "No CAP links recorded." : "not processed yet") :
    laneRow("Prescription", "Linked CAP prescription checks", svgBar(d.cap.map((cl) => ({ s: cl.s, e: cl.s + 60000, c: C.consult, tip: `${cl.captured ?? "?"} of ${cl.items ?? "?"} items captured` })), dayStart, dayEnd, 18));
  const detItems = d.loaded ? [...d.detected.acoustic.map((x) => ({ ...x, c: "#9ec5f0", tip: "Acoustic" })), ...d.detected.e6.map((x) => ({ ...x, c: "#f0b98f", tip: "E-6" })), ...d.detected.jev_loop.map((x) => ({ ...x, c: "#e3a6d6", tip: "Jev loop" }))] : [];
  const detLane = !detItems.length ? laneEmpty("Detected encounters", "Acoustic / E-6 / Jev loop", "not processed yet") : laneRow("Detected encounters", "Acoustic / E-6 / Jev loop", svgBar(detItems, dayStart, dayEnd, 20));
  // W49 palimpsest overnight priority (Fable 28 Sep): every REB engine layer, aligned on the SAME day clock as every
  // other lane above - built offline by tools/reb_timeline_seed.py from every window's current (latest_ok=True) tracks,
  // not fetched live here (a room-day can have 50-100+ windows; that fan-out belongs in a box-side batch job, not a
  // Worker request). Same color per layer as the per-window P3 inspector's rebBar() (worker/ui.js), for visual continuity.
  const rebLane = (name, desc, key, color, noneYet) => {
    if (m.blind && TEXT_LANES.has(key)) return laneEmpty(name, desc, BLIND_MSG);
    const items = d.loaded ? d.reb[key] : [];
    const cap = d.reb_cap?.[key];
    if (cap && cap.win) desc = cap.inWin > cap.shown ? `${desc} · PARTIAL in this window: first ${cap.shown} of ${cap.inWin} segments, up to ${fmtHM(cap.until)} IST (day total ${cap.n}). Narrow the window to see the rest.` : `${desc} · window ${fmtHM(m.win.s)}–${fmtHM(m.win.e)} IST: all ${cap.inWin} segments (day total ${cap.n}).`;
    else if (cap && items?.length) desc = `${desc} · PARTIAL: only the first ${items.length} of ${cap.n} segments, up to ${fmtHM(cap.until)} IST.${cap.full ? " Use the hour links above to see the rest." : ""} Nothing after that is shown, so an empty stretch is not "nothing said".`;
    if (cap?.notLoaded) return laneEmpty(name, desc, `not loaded: the full lane for ${fmtHM(m.win.s)}–${fmtHM(m.win.e)} IST could not be fetched (this is not "no segments"). Reload, or use the whole-day view.`);
    const ex = d.reb_excluded?.[key];
    const eo = d.reb_eos?.[key];
    if (eo) desc = `${desc} · ${eo.day ? "day total: " : ""}ran on ${eo.kept + eo.eos} chunks; ${eo.kept} contained words (the rest were silent / end-of-speech only)`;
    if (d.loaded && d.reb[key] === null) return laneEmpty(name, desc, "not checked (seeded before this lane existed)");
    return !items?.length ? laneEmpty(name, desc, ex ? `${ex.n} track${ex.n === 1 ? "" : "s"} excluded, ${ex.reason || "excluded"}; not shown. This is not "no segments".` : eo ? (eo.day ? "No words in this window." : `Ran on ${eo.kept + eo.eos} chunks; ${eo.kept ? eo.kept + " contained words, none in view" : "none contained words"} (silent / end-of-speech only).`) : d.loaded && noneYet ? noneYet : (d.loaded ? "No current track segments for this room-day." : "not processed yet")) :
      laneRow(name, desc, svgBar(items.map((x) => ({ ...x, c: color, tip: `${x.engine}${x.text ? ": " + x.text : ""}` })), dayStart, dayEnd, 18));
  };
  const whisperLane = rebLane("Whisper", "REB stt layer, whisper-* engines", "whisper", "#2f7a4f");
  const hasFull = Object.values(d.reb_cap || {}).some((c) => c.full);
  const hr = (h) => String(h).padStart(2, "0");
  const winChips = !hasFull && !m.win ? "" : `<p class="mut">${m.win ? `Window ${esc(m.win.from)}–${esc(m.win.to)} IST. ` : "Whole day. "}<a href="/timeline/${esc(m.room_id)}/${esc(m.date)}">Whole day</a>${[...Array(15).keys()].map((i) => i + 7).map((h) => ` · <a href="/timeline/${esc(m.room_id)}/${esc(m.date)}?from=${hr(h)}:00&amp;to=${hr(h + 1)}:00">${hr(h)}h</a>`).join("")}</p>`;
  const medmodelLane = rebLane("Medical model", "REB stt layer, medasr engine (Google MedASR)", "medmodel", "#7b4fa8");
  const indicLane = rebLane("IndicConformer", "REB stt layer, indic-ctc-* engines", "indic", "#4a7fb5");
  const sravaaniLane = rebLane("SraVaani", "REB stt layer", "sravaani", "#c17f3e");
  const medasrLane = rebLane("MedASR", "REB terms layer (medasr, whisper-med-merged)", "medasr", "#8a63b8");
  const translateLane = rebLane("Translate", "REB translate layer (English rendering of the STT lanes)", "translate", "#e3a6d6", "Not yet produced: no translate-layer tracks exist for this room-day.");   // layer name "translate" per REB-SPEC-v1 section 2 (layers table: Gemini text->English per Indic STT track)
  const koyalNames = { hi: "Hindi", kn: "Kannada", ml: "Malayalam", te: "Telugu" };
  const koyalLanes = KOYAL_LANGS.map((l) => rebLane(`Koyal · ${koyalNames[l]}`, `REB stt layer, koyal engine, ${l}-IN prompt (every window is run under all four prompts; a wrong-language prompt gives noise)`, `koyal_${l}`, "#b5533c")).join("");
  const diarLane = rebLane("Diar (REB)", "REB diar layer (pyannote/Nemotron) - distinct from Who spoke above", "diar", "#f0b98f");
  const acousticRebLane = rebLane("Acoustic (REB)", "REB acoustics layer (vad_segments, frame stats) - distinct from Speech missed above", "acoustic", "#9ec5f0");
  const routerLane = rebLane("Production router (twin)", "REB stt layer, router-twin-* engines (a copy of what the live router chose)", "router", "#6b8f3a", "Not yet produced: no router-twin tracks exist for this room-day.");
  const sarvamLane = rebLane("Sarvam transcript", "REB stt layer, sarvam-saaras-v3", "sarvam", "#b0446e", "Sarvam not run yet for this room-day.");
  const sarvamTrLane = rebLane("Sarvam English", "REB translate layer, sarvam-saaras-v3", "sarvam_translate", "#d98cb0", "Sarvam not run yet for this room-day.");
  const sarvamDiarLane = rebLane("Sarvam speaker turns", "REB diar layer, sarvam-saaras-v3", "sarvam_diar", "#c9718f", "Sarvam not run yet for this room-day.");
  const encounterLane = rebLane("Visit record", "REB encounter layer (pulse-presence): the doctor and prescription for each consult", "encounter", "#3a6f8f", "Not yet produced: no encounter tracks exist for this room-day.");
  const toneLane = rebLane("Tone", "REB emotion layer (wavlm)", "tone", "#e6d77c");
  const winRows = m.windows.slice().sort((a, b) => a.s - b.s).map((w) => `<tr><td class="mono">${esc(w.t0)}–${esc(w.t1)}</td><td><a href="/#/win/${esc(w.k)}">${esc(w.status)}</a></td><td>${m.blind ? "–" : (w.n_words ?? 0)}</td></tr>`).join("") || `<tr><td colspan="3" class="mut">No windows.</td></tr>`;
  return page(m.room_name, `<span class="sub">Room · whole day · ${esc(m.date)}</span>`, `
<div class="tiles">${tiles.map((t) => `<div class="tile${t.attn ? " attn" : ""}"><div class="l">${esc(t.l)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("")}</div>
${m.drawerHtml ?? ""}${consultList(m)}
<div class="card"><h2>Room timeline layers</h2>${winChips}${consultLane(m, dayStart, dayEnd)}${sttLane}${missedLane}${spkLane}${queueLane}${rxLane}${detLane}${whisperLane}${medmodelLane}${indicLane}${sravaaniLane}${medasrLane}${translateLane}${koyalLanes}${diarLane}${acousticRebLane}${toneLane}${routerLane}${sarvamLane}${sarvamTrLane}${sarvamDiarLane}${encounterLane}
<div class="legend"><span class="k"><span class="sw sw-consult"></span>Speech / consult</span><span class="k"><span class="sw sw-quiet"></span>Quiet</span><span class="k"><span class="sw sw-missed"></span>Missed speech</span><span class="k"><span class="sw sw-queue"></span>Queue consult</span></div></div>
<div class="card"><h2>STT windows <span class="h2s">— click one to open its transcript</span></h2><table><tr><th>Time</th><th>Status</th><th>Words</th></tr>${winRows}</table></div>`);
}

export function dateListOf(rows) { return [...new Set(rows.map((r) => r.ist_date).filter(Boolean))].sort().reverse(); }
export { validRoomDate, DATE_RE };
