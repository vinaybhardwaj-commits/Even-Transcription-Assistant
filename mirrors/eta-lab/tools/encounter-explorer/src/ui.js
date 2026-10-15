// All rendering. Data reaches the DOM only as text nodes (textContent); markup is never built from strings.
import { MIN_DATE, STAGES } from "./types.js";
import { SHADE_LABELS, rxState, istStamp, istTimeOf, shadeLevel } from "./util.js";

const clock = ms => istTimeOf(ms) || null;

const GLYPH = { done: "✓", failed: "✗", pending: "…", missing: "–", na: "?" };
const STATE_WORD = { done: "done", failed: "failed", pending: "pending", missing: "missing", na: "not available yet" };

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "css") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "hidden") el.hidden = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) { if (c === null || c === undefined || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}

const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const fmtDate = d => { const t = new Date(d + "T00:00:00Z"); return t.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) + " " + t.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }); };
const fmtLen = s => (s === null || s === undefined ? "–" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"));
const fmtClock = s => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const pct = x => Math.round(x * 100) + "%";
const docLabel = d => (d.doctorName ? d.doctorName : d.doctorId.startsWith("room:") ? "Room " + d.doctorId.slice(5) : "Doctor " + d.doctorId);
const jsonText = v => (v === null || v === undefined ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function chip(stage, info) {
  const state = STATE_WORD[info && info.state] ? info.state : "na", reason = info && info.reason;
  return h("span", { class: "chip s-" + state, title: stage + ": " + STATE_WORD[state] + (reason ? " (" + reason + ")" : "") }, h("span", { "aria-hidden": "true", text: GLYPH[state] }), stage, h("span", { class: "sr", text: " " + STATE_WORD[state] }));
}
/** One chip per stage in the stages map, canonical stages first (a stage the source cannot tell shows as not available yet). */
export function chips(stages) {
  const keys = [...STAGES, ...Object.keys(stages || {}).filter(k => !STAGES.includes(k))];
  return h("span", { class: "chips" }, keys.map(k => chip(k, stages && stages[k])));
}
/** "stt:reason" -> readable line */
export function gapLine(gap) { return gap ? "First gap: " + gap.replace(":", " — ") : null; }

/** The designed "not available yet" block. */
export function na(title, body, kind) {
  return h("div", { class: "na" + (kind === "error" ? " err" : ""), role: kind === "error" ? "alert" : null }, h("span", { class: "dot" }), h("div", {}, h("b", { text: title }), body ? h("span", { text: body }) : null));
}

// [title, body, retry button label | null]. Codes that need a different response from "try again" say so; unknown codes behave like upstream_error.
const ERR_COPY = {
  server_not_connected: ["Scribe MCP not connected", "Add Scribe MCP in claude.ai Settings \u2192 Connectors.", null],
  needs_reauth: ["Scribe MCP needs reconnecting", "Reconnect Scribe MCP in claude.ai Settings \u2192 Connectors.", null],
  selection_required: ["Choose a Scribe MCP connector", "More than one connector is named Scribe MCP. Choose one when asked, then reload.", null],
  not_in_manifest: ["Scribe MCP is not allowed for this view", "It is turned off for this page, or the tool is outside what this page may call. Turn it on in the page's connector settings.", null],
  blocked_by_policy: ["Blocked by your organisation's policy", "Your organisation does not allow this Scribe MCP tool for you.", null],
  approval_required: ["Needs your approval", "Approve the Scribe MCP call to load this.", "Approve and load"],
  consent_required: ["Scribe MCP is not allowed yet", "Allow Scribe MCP for this page, then try again.", "Try again"],
  not_granted: ["Live data is not available in this view", "This view cannot reach Scribe MCP.", null],
  capability_disabled: ["Not available in this view", "This view cannot use that capability.", null],
  capability_removed: ["Not available in this view", "This view cannot use that capability.", null],
  rate_limited: ["Scribe MCP is rate limited", "Wait a moment, then try again.", "Try again"],
  server_unavailable: ["Scribe MCP is unavailable", "The server did not answer. Try again in a moment.", "Try again"],
  server_not_found: ["Scribe MCP not found", "The connector no longer exists. Re-add it in claude.ai Settings \u2192 Connectors.", null],
  not_found: ["Not found", "This consult is not in the loaded data.", null],
  bad_request: ["Request rejected", "The request was refused as malformed.", null],
  user_changed: ["Signed-in user changed", "Reload the page.", null],
  bad_args: ["Request rejected", "The catalog refused the request as malformed.", null],
  catalog_unavailable: ["Catalog unavailable", "The encounter catalog could not be read. Try again in a moment.", "Try again"],
  bad_clip_key: ["Audio clip location refused", "The catalog's clip location failed the audio check, so no link was issued.", null],
  blind_room_day: ["Blind room-day", "This room-day is held back for blind scoring and is not shown.", null],
  key_not_readable: ["Layer not readable", "The stored layer could not be read.", null],
  bad_range: ["Audio clip ended early", "The catalog says the clip is shorter than the page expected, so the audio could not be completed. The transcript still works.", null],
  read_failed: ["Audio could not be read", "The stored clip could not be read just now. Try again in a moment.", "Try again"],
  clip_not_found: ["Audio clip not found", "The catalog lists a clip for this consult, but the stored file is missing.", null],
  identity_unavailable: ["Names and prescriptions unavailable", "The identity data could not be read. Try again in a moment.", "Try again"],
  too_many_matches: ["Too many matches", "Narrow the filter or the date range.", null],
  unknown_action: ["Catalog action not available", "This catalog build does not offer that action.", null],
};
/** @param retry optional: re-runs the failed load; only offered where a fresh user gesture is the right response */
export function errBlock(r, retry) {
  const [title, body, btn] = ERR_COPY[r.code] || ["Could not load", "Something went wrong reading Scribe MCP. Try again.", "Try again"];
  const el = na(title, body + (r.code ? " (" + r.code + ")" : ""), "error");
  if (btn && retry) el.lastChild.append(h("div", {}, h("button", { type: "button", class: "btn", onclick: () => retry(), text: btn })));
  return el;
}
const SAMPLE_COPY = {
  rate_limited: "Too many questions right now. Wait a moment and try again.", prompt_too_large: "This consult is too large to send. Try a narrower question.",
  sampling_disabled: "Ask Claude is turned off for this page.", not_granted: "Ask Claude is not allowed for this view.", session_expired: "The session expired. Reload the page.",
  refused: "Claude declined to answer that.", empty_completion: "Claude returned no answer. Try rephrasing.", upstream_error: "Claude could not answer right now. Try again.",
  invalid_request: "That question could not be sent.", capability_disabled: "Ask Claude is not available in this view.", queue_overflow: "Too many requests are waiting. Try again shortly.",
};

export function mountApp(root, ctx) {
  const { adapter, caps } = ctx;
  const S = { range: null, room: "", specialty: "", hasRx: false, hideEmpty: true, days: null, daysErr: null, doctor: null, date: null, list: null, listErr: null, uid: null, storedAt: null, token: 0 };
  const view = h("main", { id: "view" });
  const srcEl = h("span", { class: "src" });
  const top = h("header", { class: "top" }, h("h1", { text: "Encounter Explorer" }), srcEl);
  root.replaceChildren(top, view);
  if (ctx.adapterName === "mockup") document.body.append(h("div", { class: "banner", role: "note", text: "Mockup: synthetic data" }));
  let cleanup = null;
  const leave = () => { if (cleanup) { const f = cleanup; cleanup = null; try { f(); } catch { /* leaving */ } } };

  const source = () => (ctx.adapterName === "mockup" ? "Mockup: synthetic data" : caps.mcp ? "Scribe MCP connected" : "Scribe MCP not connected");
  function paintSource() {
    const t = (S.generatedAt ? " · catalog generated " + new Date(S.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "") + (S.storedAt ? " · data as of " + new Date(S.storedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
    srcEl.textContent = source() + t;
  }
  const noteStored = r => { if (r && r.ok && r.storedAt) S.storedAt = S.storedAt ? Math.min(S.storedAt, r.storedAt) : r.storedAt; paintSource(); };

  // ---------------------------------------------------------------- routing
  function go(token) { if (location.hash === "#" + token) render(); else location.hash = token; }
  function render() {
    leave();
    let t = location.hash.replace(/^#/, "");
    if (t === "list" && !(S.doctor && S.date)) t = "overview";
    if (t === "detail" && !S.uid) t = "overview";
    if (!["overview", "list", "detail"].includes(t)) t = "overview";
    S.token++;
    view.replaceChildren();
    if (t === "overview") renderOverview(); else if (t === "list") renderList(); else renderDetail();
    paintSource();
  }
  window.addEventListener("hashchange", render);

  const crumbs = items => h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, items.flatMap((it, i) => [i ? "/" : null, it]));
  const back = (label, token) => h("button", { class: "link-btn", type: "button", onclick: () => go(token), text: label });

  // ---------------------------------------------------------------- overview
  async function loadDays(refresh) {
    const my = ++S.token;
    const span = Math.round((Date.parse(S.range.to + "T00:00:00Z") - Date.parse(S.range.from + "T00:00:00Z")) / 86400000) + 1;
    const maxDays = (adapter.features || {}).hasRxMaxDays;
    if (S.hasRx && (adapter.features || {}).hasRxFilter !== false && maxDays && span > maxDays) {
      box.replaceChildren(na("Narrow the date range", "The has-prescription filter covers at most " + maxDays + " days; this range is " + span + " days. Shorten the range or turn the filter off."));
      return;
    }
    box.replaceChildren(h("div", { class: "loading", role: "status", text: "Loading doctor-days…" }));
    const r = await adapter.listDays({ from: S.range.from, to: S.range.to, room: S.room || null, specialty: S.specialty || null, hasRx: S.hasRx, refresh: !!refresh });
    if (my !== S.token) return;
    noteStored(r);
    if (!r.ok) { S.days = null; S.daysErr = r; } else { S.days = r.data; S.daysErr = null; S.generatedAt = r.data.generatedAt || null; }
    paintGrid();
  }
  let box, filterEl;
  function clampInputs() {
    let { from, to } = S.range;
    if (from < MIN_DATE) from = MIN_DATE;
    if (to < from) to = from;
    const cap = addDays(from, 61); if (to > cap) to = cap;
    S.range = { from, to };
  }
  function renderOverview() {
    const fromI = h("input", { type: "date", id: "f-from", min: MIN_DATE, value: S.range.from });
    const toI = h("input", { type: "date", id: "f-to", min: MIN_DATE, value: S.range.to });
    const roomS = h("select", { id: "f-room" }, h("option", { value: "", text: "All rooms" }));
    const specS = h("select", { id: "f-spec" }, h("option", { value: "", text: "All specialties" }));
    const rx = h("input", { type: "checkbox", id: "f-rx" });
    rx.checked = S.hasRx;
    const hide = h("input", { type: "checkbox", id: "f-hide" });
    hide.checked = S.hideEmpty;
    const rxLabel = h("label", { class: "inline" }, rx, "Has prescription");
    // the data source says which filters it can honour (and can change its mind after a call: a refused filter is switched off)
    S.applyFeat = () => {
      const f = adapter.features || {};
      rx.disabled = f.hasRxFilter === false; rx.title = rx.disabled ? "Not available from this data source yet" : "";
      specS.disabled = f.specialtyFilter === false; specS.title = specS.disabled ? "Not in the catalog yet" : "";
      rxLabel.lastChild.textContent = rx.disabled ? "Has prescription (not available yet)" : "Has prescription";
      specS.options[0].text = specS.disabled ? "Specialty (not in the catalog yet)" : "All specialties";
    };
    const apply = () => {
      S.range = { from: fromI.value || MIN_DATE, to: toI.value || fromI.value || MIN_DATE }; clampInputs();
      fromI.value = S.range.from; toI.value = S.range.to;
      S.room = roomS.value; S.specialty = specS.value; S.hasRx = rx.checked; S.hideEmpty = hide.checked; loadDays();
    };
    for (const el of [fromI, toI, roomS, specS, rx, hide]) el.addEventListener("change", apply);
    filterEl = { roomS, specS };
    box = h("div", { id: "grid-box" });
    view.append(
      h("div", { class: "filters", role: "search" },
        h("label", {}, "From", fromI), h("label", {}, "To", toI), h("label", {}, "Room", roomS), h("label", {}, "Specialty", specS),
        rxLabel, h("label", { class: "inline" }, hide, "Hide empty days"),
        h("button", { class: "btn", type: "button", id: "refresh", onclick: () => loadDays(true), text: "Refresh" })),
      box);
    S.applyFeat();
    loadDays();
  }
  function fillOptions(sel, values, current, allLabel) {
    sel.replaceChildren(h("option", { value: "", text: allLabel }), ...values.map(v => h("option", { value: v, text: v })));
    if (current && !values.includes(current)) sel.append(h("option", { value: current, text: current }));
    sel.value = current;
  }
  function paintGrid() {
    if (S.daysErr) { box.replaceChildren(errBlock(S.daysErr, () => loadDays(true))); return; }
    const d = S.days;
    if (S.applyFeat) S.applyFeat();
    fillOptions(filterEl.roomS, d.rooms, S.room, "All rooms"); fillOptions(filterEl.specS, d.specialties, S.specialty, "All specialties");
    if (S.applyFeat) S.applyFeat();
    // notes the data source asks us to show (none for the live-tools build and the mockup)
    const notes = [];
    if (d.defaultWindow) notes.push(na("Showing the last 30 days", "No dates were sent, so the catalog chose its default window."));
    if (S.hasRx && d.identityRows === 0) notes.push(na("No prescription data joined yet", "The catalog has not joined prescription data for these days. That is not the same as no prescription."));
    if (d.rxFilterIgnored) notes.push(na("Has-prescription filter not applied", "This catalog build refused the filter, so the list is unfiltered."));
    if (d.identityDegraded) notes.push(h("p", { class: "status", id: "identity-note", text: "Names are not shown: the catalog needs an admin token for them." }));
    if (!d.doctors.length) {
      box.replaceChildren(na("No consults in this range", "Nothing matches these filters between " + S.range.from + " and " + S.range.to + ". Data starts at " + MIN_DATE + "."), ...notes);
      return;
    }
    const by = new Map(d.cells.map(c => [c.doctorId + "|" + c.date, c]));
    const dates = S.hideEmpty ? d.dates.filter(x => d.cells.some(c => c.date === x)) : d.dates;
    const head = h("tr", {}, h("th", { scope: "col", text: "Doctor" }), dates.map(x => h("th", { scope: "col", class: "num", text: fmtDate(x) })));
    const rows = d.doctors.map(doc => h("tr", {},
      h("th", { scope: "row" }, docLabel(doc), h("span", { class: "sub", text: doc.specialty || (doc.doctorName ? "" : "name not available yet") })),
      dates.map(date => {
        const c = by.get(doc.doctorId + "|" + date);
        if (!c) return h("td", {}, h("span", { class: "cell empty", "aria-label": "no consults" }, "·"));
        return h("td", {}, h("button", { type: "button", class: "cell", "data-lv": shadeLevel(c.completeness),
          "aria-label": c.consults + " consults, " + pct(c.completeness) + " complete, " + docLabel(doc) + " " + date,
          onclick: () => { S.doctor = doc; S.date = date; S.list = null; go("list"); } }, h("b", { text: String(c.consults) }), h("small", { text: pct(c.completeness) })));
      })));
    box.replaceChildren(
      h("div", { class: "card" },
        h("div", { class: "scroll" }, h("table", { class: "grid" }, h("thead", {}, head), h("tbody", {}, rows))),
        h("div", { class: "legend" }, "Number = consults. Shade = share of pipeline chips done:", SHADE_LABELS.map((t, i) => h("span", { class: "lg" }, h("i", { "data-lv": i }), t)))),
      ...notes,
      ...(d.truncated ? [na("Some sources hit their row cap", "Counts for busy days may be low.")] : []),
      ...(d.blindExcluded ? [na("Blind room-days left out", d.blindExcluded + " consult(s) in blind room-days are not shown.")] : []));
  }

  // ---------------------------------------------------------------- list
  function renderList() {
    leave();
    const doc = S.doctor, date = S.date;
    const body = h("div", {}, h("div", { class: "loading", role: "status", text: "Loading consults…" }));
    view.append(crumbs([back("Overview", "overview"), h("span", { text: docLabel(doc) + " · " + date })]), h("h2", { text: docLabel(doc) + " · " + fmtDate(date) }), body);
    const my = S.token;
    adapter.listConsults({ doctorId: doc.doctorId, date }).then(r => {
      if (my !== S.token) return;
      noteStored(r);
      if (!r.ok) { body.replaceChildren(errBlock(r, () => render())); return; }
      if (!r.data.length) { body.replaceChildren(na("No consults", "This doctor-day has no consults.")); return; }
      const open = c => { S.uid = c.consult_uid; go("detail"); };
      const rows = r.data.map(c => h("tr", { class: "row-click", onclick: e => { if (!e.target.closest("button")) open(c); } },
        h("td", { class: "c-time" }, h("button", { type: "button", class: "link-btn", onclick: () => open(c), "aria-label": "Open consult at " + (clock(c.t_open) || "unknown time") }, clock(c.t_open) ? clock(c.t_open) + " IST" : "–")),
        h("td", { class: "c-room" }, c.room_id || "–"), h("td", { class: "num c-len", text: fmtLen(c.lengthSec) }), h("td", { class: "c-chips" }, chips(c.stages), c.first_gap ? h("span", { class: "sub gap", text: gapLine(c.first_gap) }) : null),
        h("td", { class: "c-scores" }, c.headline.length ? c.headline.map(x => h("span", { class: "score" }, x.label, h("b", { text: x.value }))) : h("span", { class: "muted", text: "–" })),
        h("td", { class: "c-rx", "data-label": "Rx linked: " }, { yes: "yes", no: "no", unknown: "not joined yet" }[rxState(c)])));
      body.replaceChildren(h("div", { class: "card" }, h("div", { class: "scroll" }, h("table", { class: "list" },
        h("thead", {}, h("tr", {}, ["Time", "Room", "Length", "Stages", "Scores", "Rx linked"].map((t, i) => h("th", { scope: "col", class: i === 2 ? "num" : null, text: t })))),
        h("tbody", {}, rows)))));
    });
  }

  // ---------------------------------------------------------------- detail
  function renderDetail() {
    const uid = S.uid, my = S.token;
    const doc = S.doctor;
    const body = h("div", {}, h("div", { class: "loading", role: "status", text: "Loading consult…" }));
    view.append(crumbs([back("Overview", "overview"), doc && S.date ? back(docLabel(doc) + " · " + S.date, "list") : null, h("span", { class: "mono", text: uid })]), body);
    adapter.getConsult(uid).then(async r => {
      if (my !== S.token) return;
      noteStored(r);
      if (!r.ok) { body.replaceChildren(errBlock(r, () => render())); return; }
      const c = r.data, stops = [];
      cleanup = () => stops.forEach(f => f());
      const nodes = await detailNodes(c, stops, my);
      if (my !== S.token) { stops.forEach(f => f()); return; }   // left while the audio was being prepared: undo what was set up
      body.replaceChildren(...nodes);
    });
  }

  const mb = n => (n / 1048576).toFixed(1);
  /** The audio panel state when there is no player. "Not playable here" is a design state, not an error. */
  function audioNa(r) {
    if (r.code === "audio_unsupported") return na("Audio isn't playable inside the artifact yet", "Transcript timing still works.");
    if (r.code === "audio_too_large") return na("Audio too large to load here", r.message || "The clip is larger than this page loads. The transcript still works.");
    if (r.code && ERR_COPY[r.code]) return errBlock({ code: r.code });
    if (r.code === "bad_chunk") return na("Audio could not be loaded", "A piece of the audio arrived damaged. The transcript still works.", "error");
    return na("Audio not available yet", "Clip audio arrives with the catalog tools.");
  }

  async function detailNodes(c, stops, my) {
    // Audio loads after the page has rendered (the clip can be large); a click on a transcript line before it is ready is queued.
    const audioHost = h("div", { id: "audio-host" });
    const sumLine = h("p", { class: "status", id: "audio-checksum", role: "status" });
    const progress = h("p", { class: "status", id: "audio-progress", role: "status" });
    const ac = new AbortController();
    let audio = null, pendingSeek = null, objUrl = null, wire = null;
    stops.push(() => { ac.abort(); if (objUrl && objUrl.startsWith("blob:")) { try { URL.revokeObjectURL(objUrl); } catch { /* gone */ } } objUrl = null; });
    const playFrom = t => {
      if (!audio) { pendingSeek = t; return; }
      try { audio.currentTime = t; const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch { /* seek only */ }
    };
    const span = c.transcriptMeta && c.transcriptMeta.span;
    const startAudio = async () => {
      audioHost.replaceChildren(progress); progress.textContent = "Loading audio\u2026";
      const r = await adapter.getAudio(c.consult_uid, { signal: ac.signal, onProgress: p => { progress.textContent = "Loading audio\u2026 " + mb(p.loaded) + " of " + mb(p.total) + " MB"; } });
      if (ac.signal.aborted || my !== S.token) return;
      if (!r.ok || !r.data || (!r.data.url && !r.data.blob)) { audioHost.replaceChildren(audioNa(r)); return; }
      const cs = r.data.checksum && r.data.checksum.state;
      if (cs) sumLine.textContent = cs === "match" ? "Audio checksum matches catalog" : cs === "mismatch" ? "Audio checksum does not match catalog" : "No catalog checksum for this audio";
      objUrl = r.data.blob ? URL.createObjectURL(r.data.blob) : r.data.url;
      const el = h("audio", { controls: true, preload: "metadata", src: objUrl, "aria-label": "Consult audio" });
      // never leave a dead player: if the browser cannot play what we assembled, say so instead
      el.addEventListener("error", () => { if (audio === el) { audio = null; audioHost.replaceChildren(na("Audio could not be played", "The browser could not decode this audio" + (el.error && el.error.code ? " (media error " + el.error.code + ")" : "") + ". The transcript still works.", "error")); } });
      el.addEventListener("loadedmetadata", () => {
        const t = pendingSeek !== null ? pendingSeek : span ? span.t0 : null;   // open at the start of the consult, not of the clip
        if (t !== null && t > 0) { try { el.currentTime = t; } catch { /* not seekable */ } }
        if (pendingSeek !== null) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
        pendingSeek = null;
      }, { once: true });
      audio = el;
      if (wire) wire(el);
      audioHost.replaceChildren(...[el, c.audioSynthetic ? h("p", { class: "status", id: "synth-audio", text: "Synthetic audio: a tone blip marks each transcript line (pitch by speaker). Click a line to jump to it." }) : null].filter(Boolean));   // replaceChildren would print a null
    };

    const times = clock(c.t_open) ? clock(c.t_open) + (clock(c.t_close) ? "–" + clock(c.t_close) : "") + " IST" : "time unknown";
    const header = h("section", { class: "card" },
      h("h2", { text: c.patient_name ? c.patient_name : c.individual_uid ? "Patient " + c.individual_uid : "Patient (name not available yet)" }),
      h("dl", { class: "summary" },
        kvPair("Doctor", c.doctor_name || (c.doctor_uid ? c.doctor_uid : "not available yet")),
        kvPair("Room", c.room_id || "–"), kvPair("Date", c.ist_date + " " + times), kvPair("Length", fmtLen(c.lengthSec)),
        c.source ? kvPair("Source", c.source) : null, c.clip && c.clip.bytes ? kvPair("Clip", c.clip.minutes + " min, " + Math.round(c.clip.bytes / 1024) + " KB") : null,
        c.allowance ? kvPair("Allowance", c.allowance.spent_min + " of " + c.allowance.earned_min + " min") : null),
      h("div", {}, chips(c.stages)),
      c.first_gap ? h("p", { class: "status", id: "first-gap", text: gapLine(c.first_gap) }) : null,
      c.identityDegraded ? h("p", { class: "status", id: "identity-note", text: "Names and prescription ids are not shown: the catalog needs an admin token for them." }) : null,
      c.headline.length ? h("div", { class: "scores" }, c.headline.map(x => h("span", { class: "score" }, x.label, h("b", { text: x.value })))) : null);

    // transcript
    let transcript;
    if (!c.transcript || !c.transcript.length) transcript = layerNa(c, "transcript", "Transcript", "The current tools return no transcript text. It arrives with the catalog tools.");
    else {
      const outside = l => { const mid = (l.t0 + l.t1) / 2; return !!span && (mid < span.t0 || mid > span.t1); };
      const items = c.transcript.map(l => {
        const b = h("button", { type: "button", class: "line" + (outside(l) ? " out" : ""), "data-t0": l.t0, onclick: () => { mark(l); playFrom(l.t0); } },
          h("span", { class: "t", text: fmtClock(l.t0) }), h("span", { class: "who", text: l.role || l.speaker || "?" }),
          h("span", {}, h("span", { text: l.text || "" }), l.textEn && l.textEn !== l.text ? h("span", { class: "en", text: l.textEn }) : null));
        return { l, b };
      });
      var mark = l => { for (const it of items) it.b.classList.toggle("now", it.l === l); };
      wire = el => {
        const onTime = () => {
          const t = el.currentTime; let cur = null;
          for (const it of items) if (it.l.t0 <= t) cur = it.l;
          mark(cur); const node = cur && items.find(i => i.l === cur).b; if (node && !el.paused) node.scrollIntoView({ block: "nearest" });
        };
        el.addEventListener("timeupdate", onTime); el.addEventListener("seeked", onTime);
      };
      const meta = c.transcriptMeta;
      transcript = h("div", {},
        span ? h("p", { class: "status", id: "span-note", text: "Consult span " + fmtClock(span.t0) + "\u2013" + fmtClock(span.t1) + " of the clip; dimmed lines are before or after it." }) : null,
        meta && meta.degraded.length ? h("p", { class: "status", id: "tx-degraded", text: "Not used: " + meta.degraded.map(x => x.replace(":", " track (") + ")").join(", ") + "." }) : null,
        h("ol", { class: "tx", "aria-label": "Transcript" }, items.map(i => h("li", {}, i.b))));
    }
    const audioSec = h("section", { class: "card" }, h("h2", { text: "Audio and transcript" }), audioHost, transcript);
    startAudio();

    // ledger
    const ledger = h("section", { class: "card" }, h("h2", { text: "Processing ledger" }),
      c.ledger.length ? h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Step", "Time (IST)", "Model", "Version", "Outcome", "Failure reason"].map(t => h("th", { scope: "col", text: t })))),
        h("tbody", {}, c.ledger.map(l => h("tr", {}, h("td", { text: l.step }), h("td", { class: "mono", text: l.at ? istStamp(l.at) : "–" }), h("td", { class: "mono", text: l.model || "–" }), h("td", { text: l.version || "–" }),
          h("td", {}, l.outcome ? h("span", { class: "chip s-" + outcomeState(l.outcome), text: l.outcome }) : "–"), h("td", { text: l.reason || "–" })))))) :
        na("No ledger rows yet", "No pipeline steps are indexed for this consult."),
      c.ledger.length && c.ledger.some(l => !l.at) ? h("p", { class: "status", id: "ledger-no-times", text: "A dash in Time means the catalog has no time for that step yet." }) : null, sumLine);

    // scores
    const fs = c.note;
    const noteBlock = !fs ? layerNa(c, "freescript", "FreeScript note", "No FreeScript run is stored for this consult.") : h("div", {},
      h("div", { class: "chips" }, h("span", { class: "chip s-" + (fs.validator.ok === true ? "done" : fs.validator.ok === false ? "failed" : "na"), text: "validator " + (fs.validator.ok === true ? "ok" : fs.validator.ok === false ? "failed" : "unknown") }),
        fs.model ? h("span", { class: "chip s-missing mono", text: fs.model + (fs.version ? " " + fs.version : "") }) : null),
      fs.validator.errors.length ? h("ul", { class: "plain" }, fs.validator.errors.map(e => h("li", { text: e }))) : null,
      fs.completionRequired.length ? h("div", {}, h("h3", { text: "Completion required" }), h("ul", { class: "plain" }, fs.completionRequired.map(x => h("li", { text: [x.kind, x.detail, x.prompt].filter(Boolean).join(" — ") })))) : null,
      fs.noteText ? h("pre", { class: "note", text: fs.noteText }) : na("Note text missing", "The run is stored but carries no note text."));
    const scores = h("section", { class: "card" }, h("h2", { text: "Scores" }),
      h("h3", { text: "FreeScript note" }), noteBlock,
      h("h3", { text: "PDQI-9" }), c.pdqi ? rubricView(c.pdqi) : layerNa(c, "rubric", "PDQI-9", "No PDQI-9 result for this consult."),
      h("h3", { text: "Rubrics" }), c.rubrics.length ? c.rubrics.map(rubricView) : na("No other rubric results", null),
      h("h3", { text: "Jev decisions" }), jevView(c.jev, c.jevError, c.stages && c.stages.jev, c),
      h("h3", { text: "CDMSS audit" }), c.cdmss ? (c.cdmss.length ? h("ul", { class: "plain" }, c.cdmss.map(f => h("li", {}, f.severity ? h("b", { text: f.severity + ": " }) : null, f.finding, f.detail ? " — " + f.detail : ""))) : na("No findings", "CDMSS audit ran with no findings.")) :
        layerNa(c, "cdmss", "CDMSS audit", "No CDMSS audit source is wired in yet."),
      c.parts && c.parts.length ? h("div", {}, h("h3", { text: "Jev parts" }), h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Part", "From–to", "Score", "Confidence", "Source"].map(t => h("th", { scope: "col", text: t })))),
        h("tbody", {}, c.parts.map(p => h("tr", {}, h("td", { text: p.part }), h("td", { text: (p.t0 === null ? "–" : fmtClock(p.t0)) + "–" + (p.t1 === null ? "–" : fmtClock(p.t1)) }), h("td", { text: p.score === null ? "–" : String(p.score) }), h("td", { text: p.confidence === null ? "–" : String(p.confidence) }), h("td", { text: p.source || "–" }))))))) : null);

    // prescription
    const rx = c.rx;
    const rxRefMode = adapter.features && adapter.features.rxContent === false;   // the catalog carries ids, state and a Pulse link, not the prescription
    const rxLeft = rxRefMode
      ? (rx && (rx.prescriptionUid || rx.link)
        ? h("div", {}, h("dl", { class: "kv" }, h("dt", { text: "Prescription id" }), h("dd", { class: "mono", text: rx.prescriptionUid || "\u2013" }), h("dt", { text: "State" }), h("dd", { text: rx.prescState || "\u2013" })),
          h("p", { class: "muted", id: "rx-pulse-note", text: "Signed prescription opens in Pulse" }))
        : rx && rx.hasPrescription === true
          ? na("Prescription on file", "The id and the Pulse link need an admin token.")
          : na("No prescription linked", "This consult has no prescription id in the catalog. If identity data has not been joined yet, that is not the same as no prescription."))
      : (rx && rx.signedText ? h("pre", { class: "note", text: rx.signedText }) : layerNa(c, "rx", "Signed Rx", "The signed prescription arrives with the catalog tools."));
    const rxSec = h("section", { class: "card" }, h("h2", { text: "Prescription" }), h("div", { class: "two" },
      h("div", {}, h("h3", { text: rxRefMode ? "Prescription" : "Doctor's signed Rx" }), rxLeft),
      h("div", {}, h("h3", { text: "FreeScript note" }), fs && fs.noteText ? h("pre", { class: "note", text: fs.noteText }) : na("FreeScript note not available yet", null))),
      rx && rx.link ? h("p", {}, h("a", { href: rx.link, target: "_blank", rel: "noopener", text: "Open in Pulse" })) :
        h("p", { class: "muted", text: rx ? "No Pulse link: the prescription id or the patient id is missing." : "No Pulse link: no prescription is linked yet." }));

    return [header, h("div", { class: "detail-grid" }, h("div", {}, audioSec, ledger), h("div", {}, scores, rxSec)), notesSection(c, stops), askSection(c, stops)];
  }
  /** The designed state for one data layer, from its status and source when the source reports them (catalog), else the fallback wording. */
  const CODE_HINT = { clock_mismatch: "The track's clock does not line up with the clip.", no_clock: "The consult has no clock to align the track with the clip.", key_not_readable: "The stored track could not be read." };
  const layerNa = (c, key, title, fallback) => {
    const ls = c.layerStatus && c.layerStatus[key];
    if (!ls) return na(title + " not available yet", fallback);
    const src = ls.source ? "Source: " + ls.source + "." : "";
    if (ls.status === "absent") return na(title + " not recorded", ["Nothing was recorded for this consult.", src].filter(Boolean).join(" "));
    if (ls.status === "error") return na(title + " could not be read", [src, ls.code ? "Code: " + ls.code + "." + (CODE_HINT[ls.code] ? " " + CODE_HINT[ls.code] : "") : ""].filter(Boolean).join(" ") || "The layer reported an error.", "error");
    return na(title + " not available yet", src || fallback);
  };
  const kvPair = (k, v) => h("div", { class: "kvp" }, h("dl", {}, h("dt", { text: k }), h("dd", { text: v })));

  const outcomeState = o => (/^(ok|done|stored|success|complete)/i.test(o) ? "done" : /fail|error/i.test(o) ? "failed" : "pending");
  function rubricView(r) {
    const sc = r.score && typeof r.score === "object" ? Object.entries(r.score).filter(([k]) => k !== "items") : [];
    const items = r.score && r.score.items && typeof r.score.items === "object" ? Object.entries(r.score.items).filter(([, v]) => typeof v === "number") : [];
    return h("div", { class: "rubric" }, h("div", { class: "chips" }, h("b", { text: r.id }), r.version ? h("span", { class: "chip s-missing", text: r.version }) : null, r.status ? h("span", { class: "chip s-" + outcomeState(r.status), text: r.status }) : null),
      sc.length ? h("dl", { class: "kv" }, sc.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: jsonText(v) })])) : null,
      items.length ? h("div", { class: "scroll" }, h("table", { class: "items" }, h("tbody", {}, items.map(([k, v]) => h("tr", {}, h("td", { text: k.replace(/_/g, " ") }),
        h("td", { class: "num", text: String(v) }), h("td", {}, h("span", { class: "bar" }, h("i", { css: { width: Math.round(Math.max(0, Math.min(5, v)) / 5 * 100) + "%" } }))))))))  : null,
      r.findings.length ? h("ul", { class: "plain" }, r.findings.map(f => h("li", { text: jsonText(f) }))) : null);
  }
  function jevView(j, err, stage, c) {
    if (j === null) {
      if (c && c.layerStatus && c.layerStatus.jev) return layerNa(c, "jev", "Jev decisions", "No decision log is wired in for this consult yet.");
      if (err && ERR_COPY[err]) return errBlock({ code: err });
      if (stage && (stage.state === "failed" || stage.state === "missing")) return na("No Jev decisions for this consult", stage.state === "failed" ? "The Jev step failed" + (stage.reason ? ": " + stage.reason : ".") : "The Jev step has not run for this consult.");
      return na("Jev decisions not available yet", "No decision log is wired in for this consult yet.");
    }
    if (!j.length) return na("No Jev decisions", "Nothing is logged for this consult.");
    return h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Question", "Answer", "Probability"].map(t => h("th", { scope: "col", text: t })))),
      h("tbody", {}, j.map(d => h("tr", {}, h("td", { class: "mono" }, d.question, d.mock ? h("span", { class: "chip s-pending", title: "mock row", text: "mock" }) : null), h("td", { text: d.answer ?? "–" }),
        h("td", {}, d.probability === null ? "–" : [h("span", { class: "bar" }, h("i", { css: { width: Math.round(Math.max(0, Math.min(1, d.probability)) * 100) + "%" } })), d.probability.toFixed(2), d.probabilityKind ? h("span", { class: "sub", text: d.probabilityKind }) : null]))))));
  }

  // ---------------------------------------------------------------- shared notes
  const DENIED = new Set(["invalid_argument", "not_granted", "revoked", "capability_disabled", "capability_removed", "bad_request"]);
  const fmtWhen = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleString("en-GB"); };
  function notesSection(c, stops) {
    const sec = h("section", { class: "card", id: "notes" }, h("h2", { text: "Admin notes" }));
    if (!caps.db) { sec.append(na("Shared notes unavailable", "The db capability is not available in this view, so notes are read-only.")); return sec; }
    const ta = h("textarea", { id: "note-text", "aria-label": "Admin notes (shared)", disabled: true, placeholder: "Loading\u2026" });
    const st = h("div", { class: "status", role: "status" });
    sec.append(ta, st);
    let timer = null, dirty = false, gone = false, failed = false, readOnly = false;
    const nameOf = async id => {
      if (!id) return "unknown";
      try { const p = caps.user ? (await caps.user.profiles([id]))[id] : null; return p ? (p.isMe ? "you" : p.name) : id; } catch { return id; }
    };
    const saved = async n => { const when = n && n.updated_at ? fmtWhen(n.updated_at) : null; st.textContent = n ? "Saved " + (when ? when + " " : "") + "by " + await nameOf(n.updated_by) : "No note yet"; };
    const lock = why => { readOnly = true; dirty = false; ta.readOnly = true; st.textContent = why; };
    const flush = async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!dirty || readOnly) return; dirty = false;
      st.textContent = "Saving\u2026";
      const r = await adapter.notes.set(c.consult_uid, ta.value);
      if (gone) return;
      if (r.ok) { failed = false; const g = await adapter.notes.get(c.consult_uid); if (g.ok) await saved(g.data); }
      else if (DENIED.has(r.code)) lock("Notes are read-only for you (" + r.code + ").");
      else { dirty = true; failed = true; st.textContent = "Not saved (" + r.code + "). Edit the note to try again."; }
    };
    ta.addEventListener("input", () => { if (readOnly) return; dirty = true; failed = false; st.textContent = "Unsaved changes\u2026"; if (timer) clearTimeout(timer); timer = setTimeout(flush, 800); });
    ta.addEventListener("blur", () => { if (!failed) flush(); });   // a failed save is retried only by a new edit, never by every blur
    stops.push(() => { gone = false; if (!failed) flush(); gone = true; });
    adapter.notes.get(c.consult_uid).then(async r => {
      if (gone) return;
      if (!r.ok) { sec.replaceChildren(h("h2", { text: "Admin notes" }), errBlock(r)); return; }
      ta.disabled = false; ta.placeholder = "Notes shared with other admins"; ta.value = r.data ? r.data.text : ""; await saved(r.data);
      let can = null; try { can = caps.user ? await caps.user.can("data.write") : null; } catch { can = null; }
      if (can === false && !gone) lock("Notes are read-only: you do not have write access to this page's data.");
    });
    return sec;
  }

  // ---------------------------------------------------------------- Ask Claude
  function askSection(c, stops) {
    if (!caps.sample) return h("section", { hidden: true, id: "ask" });
    const q = h("input", { type: "text", id: "ask-q", "aria-label": "Question about this consult", placeholder: "Ask about this consult only" });
    const out = h("div", { class: "answer", id: "ask-out", hidden: true, "aria-live": "polite" });
    const go1 = h("button", { type: "button", class: "btn primary", id: "ask-go", text: "Ask Claude" });
    const stop = h("button", { type: "button", class: "btn", id: "ask-stop", text: "Stop", hidden: true });
    let ac = null;
    const run = async () => {
      const question = q.value.trim();
      if (!question || ac) return;                        // one call at a time, whether it came from the button or from Enter
      const mine = ac = new AbortController(); go1.disabled = true; stop.hidden = false; out.hidden = false; out.textContent = "Thinking\u2026";
      let partial = "";
      try {
        const prompt = await buildPrompt(c, question);
        const res = await caps.sample(prompt, { signal: mine.signal, onText: u => { partial = u.text; if (ac === mine) out.textContent = u.text; } });
        if (ac === mine) out.textContent = res.text + (res.truncated ? "\n[answer was cut short]" : "");
      } catch (e) {
        const code = e && typeof e.code === "string" ? e.code : "";
        const keep = code === "refused" ? "" : (e && typeof e.text === "string" && e.text) || partial;   // refused withdraws any partial (sample.d.ts)
        if (ac === mine) out.textContent = code === "cancelled" ? (keep ? keep + "\n[stopped]" : "Stopped.") : (SAMPLE_COPY[code] || "Could not get an answer. Try again.") + (code ? " (" + code + ")" : "") + (keep ? "\n\n" + keep : "");
      }
      if (ac === mine) { go1.disabled = false; stop.hidden = true; ac = null; }
    };
    go1.addEventListener("click", run);
    q.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
    stop.addEventListener("click", () => { if (ac) ac.abort(); });
    stops.push(() => { if (ac) ac.abort(); });            // leaving the consult cancels a call in flight
    return h("section", { class: "card", id: "ask" }, h("h2", { text: "Ask Claude about this consult" }),
      h("p", { class: "muted", text: "Only this consult's loaded data and your question are sent." }), h("div", { class: "ask" }, q, go1, stop), out);
  }
  async function buildPrompt(c, question) {
    const data = JSON.parse(JSON.stringify(c, (k, v) => (k === "raw" ? undefined : v)));
    let max = Infinity;
    try { const l = await caps.sample.limits(); if (l && l.maxPromptBytes) max = l.maxPromptBytes; } catch { /* no limits */ }
    const make = () => "You answer questions about ONE clinic consult. Use only the consult data below; if the answer is not in it, say so.\n\nCONSULT DATA (JSON):\n" + JSON.stringify(data) + "\n\nQUESTION: " + question;
    let p = make();
    while (new TextEncoder().encode(p).length > max && data.transcript && data.transcript.length > 1) { data.transcript = data.transcript.slice(0, Math.floor(data.transcript.length / 2)); data.transcriptTruncated = true; p = make(); }
    return p;
  }

  // ---------------------------------------------------------------- start
  (async () => {
    S.range = (await adapter.defaultRange()) || { from: MIN_DATE, to: MIN_DATE };
    clampInputs();
    paintSource();
    render();
  })();
  return { go };
}
