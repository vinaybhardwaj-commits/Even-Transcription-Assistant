// The /encounters page (FABLE W44): one room-day per view, with tape/STT lanes lab-viewer already has, plus detected-encounter lanes
// fed by lx's output file (ENCOUNTERS-SHAPES.md). Server-rendered, escape-first, zero client script, same Access gate as every route.
// PHI note: STT window times/status and speaker letters come from the vault (already shown on the Consult page). The detected/pqm/cap
// lanes carry ONLY times, ids and counts (no drug/diagnosis/doctor/patient text) - the shape doc says so and this module never widens that.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rstr = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function span(o, capMs = 24 * 3600 * 1000) {
  const s = Number(o?.start_ms), e = Number(o?.end_ms);
  return Number.isFinite(s) && Number.isFinite(e) && e > s && e - s <= capMs && s >= 0 ? { s, e } : null;
}
// W44.B's fixed phase-choice set (skill rule: whitelist the exact question options, never accept an arbitrary key)
const PHASES = new Set(["greeting_or_opening", "history_taking", "examination", "diagnosis_or_plan_discussion", "prescription_or_advice_readout", "closing_or_follow_up_instructions", "between_patients_or_admin", "staff_or_phone_talk", "none_of_the_above"]);
function spans(list, extra = (x) => ({})) {
  return (Array.isArray(list) ? list : []).slice(0, 500).map((x) => { const sp = span(x); return sp && { ...sp, id: rstr(x?.id, 40), conf: Number.isFinite(+x?.conf) && +x.conf >= 0 && +x.conf <= 1 ? Math.round(+x.conf * 100) / 100 : null, ...extra(x) }; }).filter(Boolean).sort((a, b) => a.s - b.s);
}
// whitelist + type lx's file; anything malformed is dropped, never a 500 (same rule as prescribe/clarity)
export function detectedOf(doc) {
  if (!doc || typeof doc !== "object") return { acoustic: [], e6: [], jev_loop: [], pqm: [], cap: [], loaded: false, source: null };
  return {
    acoustic: spans(doc.detected?.acoustic), e6: spans(doc.detected?.e6),
    jev_loop: spans(doc.detected?.jev_loop, (x) => ({ phase: typeof x?.phase_probs === "object" && x.phase_probs ? Object.entries(x.phase_probs).filter(([k, v]) => PHASES.has(k) && Number.isFinite(+v) && +v >= 0 && +v <= 1).map(([k, v]) => [k, Math.round(+v * 100) / 100]) : null })),
    pqm: spans(doc.pqm_truth, (x) => ({ status: ["confirmed", "no_show", "cancelled", "probable", "none"].includes(x?.status) ? x.status : null })),
    cap: spans(doc.cap_links, (x) => ({ items: Number.isInteger(x?.items) ? x.items : null, captured: Number.isInteger(x?.captured) ? x.captured : null, drugs: Number.isInteger(x?.drugs) ? x.drugs : null })),
    loaded: true, source: rstr(doc.source_sha256, 64).slice(0, 16) || null,
  };
}

// speaker turns from the Consult segments: a maximal run of consecutive segments (same window - letters are window-local) sharing a label
export function turnsOf(segments) {
  const turns = [];
  for (const s of segments) {
    if (!s.sp || s.sp.l === "?") continue;
    const key = s.sp.mixed ? s.sp.seq.join("+") : s.sp.l;
    const last = turns[turns.length - 1];
    if (last && last.w === s.w && last.key === key) { last.e = s.e; last.n++; }
    else turns.push({ w: s.w, key, s: s.t, e: s.e, n: 1 });
  }
  return turns;
}

// tape coverage / speech activity: from the Consult windows list (kept + hidden), no new data needed
export function coverageOf(windows, hidden, dayStartMs) {
  const all = [...windows, ...(hidden || [])];
  const byStatus = {};
  for (const w of windows) byStatus[w.status] = (byStatus[w.status] || 0) + 1;
  const coveredMs = windows.reduce((n, w) => n + Math.max(0, w.e - w.s), 0);
  const wordWindows = windows.filter((w) => (w.n_words ?? 0) > 0).length;
  return { total: all.length, kept: windows.length, hidden: (hidden || []).length, by_status: byStatus, covered_ms: coveredMs, day_ms: 24 * 3600 * 1000, with_speech: wordWindows };
}

export function encounterModel(consult, doc) {
  const windows = (consult.windows || []).map((w) => ({ k: w.k, t0: w.t0, t1: w.t1, s: w.s, e: w.e, status: w.status, n_words: w.n_words, run_id: w.run_id }));
  const turns = turnsOf(consult.segments || []);
  const det = detectedOf(doc);
  return { room_id: consult.room_id, room_name: consult.room_name, date: consult.date, windows, hidden: consult.hidden || [], turns, cov: coverageOf(windows, consult.hidden), det };
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a63;--line:#dcd9cf;--acc:#0b5cab;--card:#fff;--warn:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a09f96;--line:#33332f;--acc:#7db4f0;--card:#1e1e1c;--warn:#f2b8b5}}
*{box-sizing:border-box}body{overflow-wrap:anywhere;margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{border-bottom:1px solid var(--line);padding:10px 16px}header h1{font-size:18px;margin:0 0 6px}nav a{margin-right:14px;color:var(--acc);text-decoration:none;font-weight:600}
main{padding:10px 16px 60px;max-width:1100px;margin:0 auto}.mut{color:var(--mut);font-size:13px}a{color:var(--acc)}
.lane{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:12px 0}.lane h2{font-size:15px;margin:0 0 6px}
.stretches{display:flex;flex-wrap:wrap;gap:3px;margin:4px 0}
.seg{border-radius:4px;padding:1px 6px;font-size:11px;color:#111}.seg.text{background:#a9d9a3}.seg.no_signal{background:#e6d77c}.seg.refused{background:#e3a6d6}.seg.no_text,.seg.untested{background:#c9c9c9}.seg.gap{background:var(--bg);color:var(--mut);border:1px dashed var(--line)}
.row{display:flex;gap:8px;align-items:baseline;padding:3px 0;border-top:1px solid var(--line)}.row:first-child{border-top:none}.row .t{font-variant-numeric:tabular-nums;color:var(--mut);min-width:11em}
.chip{display:inline-block;border-radius:99px;padding:0 8px;font-size:12px;margin-right:6px}.chip.a{background:#9ec5f0}.chip.e{background:#f0b98f}.chip.j{background:#e3a6d6}.chip.c{background:#a9d9a3}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}.card a{font-weight:600}
.datehead{margin:16px 0 4px}
`;

const IST_MS = 19800000;
const fmtHMS = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 19);   // refuter-2 #4467 B1: PQM/detector times are epoch ms UTC; the page is IST throughout, same as dayStart/dayEnd below
const durMin = (ms) => Math.round(ms / 60000);
const STATUS_ORDER = ["text", "refused", "no_signal", "no_text", "untested", "failed"];

// no inline styles (CSP): each stretch of the day is one fixed-size chip labelled with its own span, not a proportional bar
function laneStretches(windows, dayStartMs, dayEndMs) {
  const cells = [];
  let cursor = dayStartMs;
  for (const w of windows.slice().sort((a, b) => a.s - b.s)) {
    if (w.s > cursor + 30000) cells.push({ cls: "gap", t0: cursor, t1: w.s });
    cells.push({ cls: STATUS_ORDER.includes(w.status) ? w.status : "no_text", t0: w.s, t1: Math.max(w.e, w.s + 1000) });
    cursor = Math.max(cursor, w.e);
  }
  if (cursor < dayEndMs - 30000) cells.push({ cls: "gap", t0: cursor, t1: dayEndMs });
  return cells.map((c) => `<span class="seg ${c.cls}" title="${fmtHMS(c.t0)}–${fmtHMS(c.t1)}">${fmtHMS(c.t0).slice(0, 5)}</span>`).join("");
}

function detectedRows(list, cls, label) {
  if (!list.length) return `<p class="mut">${esc(label)}: none</p>`;
  return list.map((d) => `<div class="row"><span class="t">${fmtHMS(d.s)}–${fmtHMS(d.e)}</span><span class="chip ${cls}">${esc(label)}</span>${durMin(d.e - d.s)} min${d.conf !== null ? ` · conf ${d.conf}` : ""}${d.status ? ` · ${esc(d.status)}` : ""}${d.items !== null ? ` · ${d.items} items, ${d.captured ?? "?"} captured, ${d.drugs ?? "?"} drugs` : ""}</div>`).join("");
}

export function encountersPage(m) {
  if (!m) return `<p class="mut">This room-day has no data.</p>`;
  const dayStart = Date.parse(`${m.date}T00:00:00+05:30`), dayEnd = dayStart + 24 * 3600 * 1000;
  const cov = m.cov;
  const winRows = m.windows.slice().sort((a, b) => a.s - b.s).map((w) => `<div class="row"><span class="t">${esc(w.t0)}–${esc(w.t1)}</span><a href="/#/win/${esc(w.k)}">${esc(w.status)}</a>${w.n_words ? ` · ${w.n_words} words` : ""}</div>`).join("") || `<p class="mut">No windows.</p>`;
  // t.w indexes m.windows (NOT the time-sorted copy above): encounterModel maps consult.windows 1:1, in the same order consult() used when it stamped each segment's `w`
  const turnRows = m.turns.slice(0, 300).map((t) => `<div class="row"><span class="t">${fmtHMS(t.s)}–${fmtHMS(t.e)}</span>Speaker ${esc(t.key)} · ${t.n} line${t.n === 1 ? "" : "s"}${m.windows[t.w] ? `<a href="/#/win/${esc(m.windows[t.w].k)}">↳ window</a>` : ""}</div>`).join("") || `<p class="mut">No labelled speaker turns.</p>`;
  const d = m.det;
  const detHtml = !d.loaded ? `<p class="mut">Not loaded yet: no detector output for this room-day (${esc(ENCOUNTERS_SHAPE_HINT)}).</p>` : [
    detectedRows(d.acoustic, "a", "acoustic"), detectedRows(d.e6, "e", "E-6"), detectedRows(d.jev_loop, "j", "Jev loop"),
  ].join("");
  const pqmHtml = !d.loaded ? `<p class="mut">Not loaded yet.</p>` : (d.pqm.length ? d.pqm.map((p) => `<div class="row"><span class="t">${fmtHMS(p.s)}–${fmtHMS(p.e)}</span>${esc(p.status || "consult")} · ${durMin(p.e - p.s)} min</div>`).join("") : `<p class="mut">No PQM truth consults recorded.</p>`);
  const capHtml = !d.loaded ? `<p class="mut">Not loaded yet.</p>` : detectedRows(d.cap, "c", "CAP link");
  return `
<p class="mut">room ${esc(m.room_name)} (${esc(m.room_id)}) · ${esc(m.date)}${d.source ? ` · detector source <code>${esc(d.source)}</code>` : ""}</p>
<div class="lane"><h2>Tape coverage &amp; speech activity</h2>
  <div class="stretches">${laneStretches(m.windows, dayStart, dayEnd)}</div>
  <p class="mut">${cov.kept} STT windows kept (${cov.hidden} overlapping hidden), ${cov.with_speech} with words, ${durMin(cov.covered_ms)} min covered of a day. ${Object.entries(cov.by_status).map(([k, v]) => `${v} ${esc(k)}`).join(", ") || "no windows"}.</p></div>
<div class="lane"><h2>STT windows</h2>${winRows}</div>
<div class="lane"><h2>Detected encounters (acoustic / E-6 / Jev loop)</h2>${detHtml}</div>
<div class="lane"><h2>PQM truth consults</h2>${pqmHtml}</div>
<div class="lane"><h2>CAP prescription links</h2>${capHtml}</div>
<div class="lane"><h2>Speaker turns</h2>${turnRows}</div>
<p class="mut">Tone per turn is not built yet (waits for W45).</p>`;
}
const ENCOUNTERS_SHAPE_HINT = "waiting on lx's per-room-day file";

export function encountersListPage(rows) {
  const byDay = new Map();
  for (const r of rows) (byDay.get(r.date) || byDay.set(r.date, []).get(r.date)).push(r);
  const dates = [...byDay.keys()].sort().reverse();
  const cards = dates.map((date) => {
    const rs = byDay.get(date).sort((a, b) => a.room_name.localeCompare(b.room_name));
    return `<h2 class="mut datehead">${esc(date)}</h2>` + rs.map((r) => `<div class="card"><a href="/encounters/${esc(r.room_id)}/${esc(date)}">${esc(r.room_name)}</a> <span class="mut">${r.n} windows</span></div>`).join("");
  }).join("") || `<p class="mut">No room-days indexed yet.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>ETA lab — encounters</title><style nonce="__NONCE__">${CSS}</style></head>
<body><header><h1>ETA lab — encounters</h1><nav><a href="/">Viewer</a></nav></header>
<main><p class="mut">One room-day per row: tape coverage, STT windows, detected encounters (acoustic / E-6 / Jev loop, once loaded), PQM truth, CAP links, speaker turns.</p>${cards}</main></body></html>`;
}

export function encountersRoomDayPage(model) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>ETA lab — encounters</title><style nonce="__NONCE__">${CSS}</style></head>
<body><header><h1>ETA lab — encounters</h1><nav><a href="/encounters">All room-days</a><a href="/">Viewer</a></nav></header>
<main>${encountersPage(model)}</main></body></html>`;
}

export function validRoomDate(room, date) { return ROOM_RE.test(room ?? "") && DATE_RE.test(date ?? ""); }
