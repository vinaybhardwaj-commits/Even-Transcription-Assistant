// /timeline (FABLE W49, "ship it"): the Room Timeline. Level 1 (hospital, one day, every room) and Level 2 (one room's whole day).
// Level 3 (per-consult inspector, audio playback) is P2; consult/window rows link to the existing /#/consult SPA meanwhile.
// Design ported from V-approved mockup /home/eta/oc/RoomTimeline-mockup.dc.html (layout, words, colours, legends) - NOT its code.
// Server-rendered, escape-first, zero client script, same Access gate as every route. Reuses encounters.js's reviewed helpers.
// CSP note: the page's style-src is 'nonce-...' only, so no inline style="" attribute anywhere. Proportional bars are drawn as
// inline SVG instead: fill/x/y/width/height are ordinary SVG presentation attributes, not the `style` attribute, so style-src
// does not apply to them. Everything else (tiles, pills, legend swatches, dots) uses fixed CSS classes from the small named palette.
import { turnsOf, coverageOf, validRoomDate } from "./encounters.js";

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
export function timelineDocOf(doc) {
  if (!doc || typeof doc !== "object") return { loaded: false, pqm: [], cap: [], acoustics: null, fleet: [], detected: { acoustic: [], e6: [], jev_loop: [] }, source: null };
  const num = (v, lo, hi) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v * 100) / 100 : null);
  const ac = doc.acoustics && typeof doc.acoustics === "object" ? {
    missed_speech_pct: num(doc.acoustics.missed_speech_pct, 0, 100), snr_db: Number.isFinite(+doc.acoustics.snr_db) ? Math.round(+doc.acoustics.snr_db) : null,
    noise_floor: ["low", "medium", "high"].includes(doc.acoustics.noise_floor) ? doc.acoustics.noise_floor : null, clipping: doc.acoustics.clipping === true,
    silent_ms: Number.isFinite(+doc.acoustics.silent_ms) && +doc.acoustics.silent_ms >= 0 ? +doc.acoustics.silent_ms : null, missed: spans(doc.acoustics.missed),
  } : null;
  return {
    loaded: true, source: rstr(doc.source_sha256, 64).slice(0, 16) || null,
    pqm: spans(doc.pqm_truth, (x) => ({ token: rstr(x?.token, 24), status: ["confirmed", "no_show", "cancelled", "probable", "none"].includes(x?.status) ? x.status : null })),
    cap: spans(doc.cap_links, (x) => ({ items: Number.isInteger(x?.items) ? x.items : null, captured: Number.isInteger(x?.captured) ? x.captured : null, drugs: Number.isInteger(x?.drugs) ? x.drugs : null, rx_linked: x?.rx_linked === true })),
    acoustics: ac,
    fleet: (Array.isArray(doc.fleet) ? doc.fleet : []).slice(0, 100).map((x) => (FLEET_KINDS.has(x?.kind) && Number.isFinite(+x?.at_ms) ? { kind: x.kind, at: +x.at_ms, message: rstr(x.message, 120) } : null)).filter(Boolean),
    detected: {
      acoustic: spans(doc.detected?.acoustic, (x) => ({ conf: Number.isFinite(+x?.conf) ? Math.round(+x.conf * 100) / 100 : null })),
      e6: spans(doc.detected?.e6, (x) => ({ conf: Number.isFinite(+x?.conf) ? Math.round(+x.conf * 100) / 100 : null })),
      jev_loop: spans(doc.detected?.jev_loop, (x) => ({ conf: Number.isFinite(+x?.conf) ? Math.round(+x.conf * 100) / 100 : null })),
    },
  };
}

// tape-coverage colour: consult/talk = teal, quiet/no-signal = grey, anything else = a dimmer grey (never red/green)
function statusColor(status) { return status === "text" || status === "refused" ? C.consult : status === "no_signal" ? C.quiet : "#C9C9C9"; }

export function roomDayModel(consult, doc) {
  const windows = (consult.windows || []).map((w) => ({ k: w.k, t0: w.t0, t1: w.t1, s: w.s, e: w.e, status: w.status, n_words: w.n_words, run_id: w.run_id }));
  const turns = turnsOf(consult.segments || []);
  const cov = coverageOf(windows, consult.hidden);
  const d = timelineDocOf(doc);
  const wordWindows = windows.filter((w) => (w.n_words ?? 0) > 0);
  const talkMs = wordWindows.reduce((n, w) => n + Math.max(0, w.e - w.s), 0);
  return { room_id: consult.room_id, room_name: consult.room_name, date: consult.date, windows, hidden: consult.hidden || [], turns, cov, talkMs, d };
}

const CSS = `
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
  const rects = items.map((it) => `<rect x="${x(it.s).toFixed(3)}" y="${opts.outline ? 2 : 0}" width="${w(it.s, it.e).toFixed(3)}" height="${opts.outline ? 96 : 100}" rx="1.5" ${opts.outline ? `fill="none" stroke="${esc(it.c)}" stroke-width="3"` : `fill="${esc(it.c)}"`}><title>${esc(it.tip ?? "")}</title></rect>`).join("");
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
export function roomDayPage(m) {
  if (!m) return page("Room", "", `<p class="mut">This room-day has no data.</p>`);
  const dayStart = Date.parse(`${m.date}T00:00:00+05:30`), dayEnd = dayStart + 24 * 3600 * 1000;
  const now = Date.now(), nowMs = m.date === todayIst(now) ? now : null;
  const d = m.d;
  const cov = m.cov;
  const tiles = [
    { l: "Recorded today", v: durH(cov.covered_ms), s: `${cov.kept} STT windows` },
    // L1: linker ships confirmed/probable rows only, never the full queue - a raw count with a caveat, not a completeness ratio
    { l: "Consults found", v: d.loaded ? String(d.pqm.filter((p) => p.status === "confirmed").length) : "not processed yet", s: "confirmed, matched by CAP link (not the full queue)" },
    // L3: a 15-min window with one word counts fully here - this is "time in windows that have words", not measured talk time
    { l: "Time in windows with words", v: `${Math.round((100 * m.talkMs) / Math.max(1, cov.covered_ms))}%`, s: "of recorded time" },
    // L4: acoustics' figure is a small reference-VAD sample (A1 conditions), a lower bound - never a validated threshold, so no red flag
    { l: "Speech missed", v: d.acoustics && d.acoustics.missed_speech_pct !== null ? `${d.acoustics.missed_speech_pct}%` : "not processed yet", s: d.acoustics ? "sampled, lower bound (reference VAD, A1 conditions)" : "not sent for transcription" },
  ];
  const sttLane = laneRow("Speech heard", "Bench windows, teal = with words", svgBar(m.windows.map((w) => ({ s: w.s, e: w.e, c: (w.n_words ?? 0) > 0 ? C.consult : C.quiet, tip: `${w.t0}–${w.t1} · ${w.status}` })), dayStart, dayEnd, 28, { nowMs, label: "speech heard" }));
  const missedLane = !d.acoustics || !d.acoustics.missed.length ? laneEmpty("Speech missed", "Reference VAD vs what was sent for transcription (sampled, lower bound)", d.acoustics ? "None in the sampled chunks." : "not processed yet") :
    laneRow("Speech missed", "Reference VAD vs what was sent for transcription (sampled, lower bound)", svgBar(d.acoustics.missed.map((x) => ({ ...x, c: C.missed, tip: "Speech not sent for transcription" })), dayStart, dayEnd, 20));
  const spkLane = !m.turns.length ? laneEmpty("Who spoke", "Labelled turns (letters are window-local)", "No labelled speaker turns.") :
    laneRow("Who spoke", "Labelled turns (letters are window-local)", svgBar(m.turns.map((t) => ({ s: t.s, e: t.e, c: t.key.length > 1 ? C.other : SPK_ROT[t.key.charCodeAt(0) % SPK_ROT.length], tip: `Speaker ${t.key}` })), dayStart, dayEnd, 20));
  const queueLane = !d.loaded || !d.pqm.length ? laneEmpty("Patient queue", "Call-in to complete, from PQM", d.loaded ? "No PQM consults recorded." : "not processed yet") :
    laneRow("Patient queue", "Call-in to complete, from PQM", svgBar(d.pqm.map((p) => ({ ...p, c: "#1B1C1E", tip: `Queue ${p.token || "?"} ${fmtHM(p.s)}–${fmtHM(p.e)} · ${p.status ?? "?"}` })), dayStart, dayEnd, 22, { outline: true }));
  const rxLane = !d.loaded || !d.cap.length ? laneEmpty("Prescription", "Linked CAP prescription checks", d.loaded ? "No CAP links recorded." : "not processed yet") :
    laneRow("Prescription", "Linked CAP prescription checks", svgBar(d.cap.map((cl) => ({ s: cl.s, e: cl.s + 60000, c: C.consult, tip: `${cl.captured ?? "?"} of ${cl.items ?? "?"} items captured` })), dayStart, dayEnd, 18));
  const detItems = d.loaded ? [...d.detected.acoustic.map((x) => ({ ...x, c: "#9ec5f0", tip: "Acoustic" })), ...d.detected.e6.map((x) => ({ ...x, c: "#f0b98f", tip: "E-6" })), ...d.detected.jev_loop.map((x) => ({ ...x, c: "#e3a6d6", tip: "Jev loop" }))] : [];
  const detLane = !detItems.length ? laneEmpty("Detected encounters", "Acoustic / E-6 / Jev loop", "not processed yet") : laneRow("Detected encounters", "Acoustic / E-6 / Jev loop", svgBar(detItems, dayStart, dayEnd, 20));
  const toneLane = laneEmpty("Tone", "Patient distress", "Not shown yet: the emotion model is still being validated.");
  const winRows = m.windows.slice().sort((a, b) => a.s - b.s).map((w) => `<tr><td class="mono">${esc(w.t0)}–${esc(w.t1)}</td><td><a href="/#/win/${esc(w.k)}">${esc(w.status)}</a></td><td>${w.n_words ?? 0}</td></tr>`).join("") || `<tr><td colspan="3" class="mut">No windows.</td></tr>`;
  return page(m.room_name, `<span class="sub">Room · whole day · ${esc(m.date)}</span>`, `
<div class="tiles">${tiles.map((t) => `<div class="tile${t.attn ? " attn" : ""}"><div class="l">${esc(t.l)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("")}</div>
<div class="card"><h2>Room timeline layers</h2>${sttLane}${missedLane}${spkLane}${queueLane}${rxLane}${detLane}${toneLane}
<div class="legend"><span class="k"><span class="sw sw-consult"></span>Speech / consult</span><span class="k"><span class="sw sw-quiet"></span>Quiet</span><span class="k"><span class="sw sw-missed"></span>Missed speech</span><span class="k"><span class="sw sw-queue"></span>Queue consult</span></div></div>
<div class="card"><h2>STT windows <span class="h2s">— click one to open its transcript</span></h2><table><tr><th>Time</th><th>Status</th><th>Words</th></tr>${winRows}</table></div>`);
}

export function dateListOf(rows) { return [...new Set(rows.map((r) => r.ist_date).filter(Boolean))].sort().reverse(); }
export { validRoomDate, DATE_RE };
