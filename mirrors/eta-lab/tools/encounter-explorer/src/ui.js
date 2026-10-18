// All rendering. Data reaches the DOM only as text nodes (textContent); markup is never built from strings.
import { MIN_DATE } from "./types.js";
import { SHADE_LABELS, docKey, rxState, sealedReason, shadeLevel } from "./util.js";
import { chips, clock, fmtClock, fmtLen, gapLine, h, mb, na, slotChip } from "./dom.js";
import { LAYERS, jumpIndex, renderSlot } from "./layers.js";
import { explorerAnchor, parseAnchor } from "./links.js";

const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const fmtDate = d => { const t = new Date(d + "T00:00:00Z"); return t.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) + " " + t.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }); };
const pct = x => Math.round(x * 100) + "%";
const docLabel = d => (d.doctorName ? d.doctorName : d.doctorId.startsWith("room:") ? "Room " + d.doctorId.slice(5) : "Doctor " + d.doctorId);

const CONNECT_COPY = "This page needs a Claude connector named exactly **Scribe MCP**, set up with your own Scribe key. Ask V for a key. Never paste a key into this page or a chat.";
// [title, body, retry button label | null]. Codes that need a different response from "try again" say so; unknown codes behave like upstream_error.
const ERR_COPY = {
  server_not_connected: ["Scribe MCP not connected", CONNECT_COPY, null],
  needs_reauth: ["Scribe MCP needs reconnecting", "Reconnect Scribe MCP in claude.ai Settings → Connectors.", null],
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
  server_not_found: ["Scribe MCP not found", CONNECT_COPY, null],
  not_found: ["Not found", "This consult is not in the loaded data.", null],
  bad_request: ["Request rejected", "The request was refused as malformed.", null],
  user_changed: ["Signed-in user changed", "Reload the page.", null],
  bad_args: ["Request rejected", "The catalog refused the request as malformed.", null],
  catalog_unavailable: ["Catalog unavailable", "The catalog is being rebuilt. Try again in a minute.", "Try again"],
  bad_clip_key: ["Audio clip location refused", "The catalog's clip location failed the audio check, so no link was issued.", null],
  blind_room_day: ["Blind room-day", "This room-day is held back for blind scoring and is not shown.", null],
  key_not_readable: ["Layer not readable", "The stored layer could not be read.", null],
  bad_range: ["Audio clip ended early", "The catalog says the clip is shorter than the page expected, so the audio could not be completed. The transcript still works.", null],
  read_failed: ["Audio could not be read", "The stored clip could not be read just now. Try again in a moment.", "Try again"],
  clip_not_found: ["Audio clip not found", "The catalog lists a clip for this consult, but the stored file is missing.", null],
  identity_unavailable: ["Names and prescriptions unavailable", "The identity data could not be read. Try again in a moment.", "Try again"],
  too_many_matches: ["Too many matches", "Narrow the filter or the date range.", null],
  unknown_action: ["Catalog action not available", "This catalog build does not offer that action.", null],
  needs_admin: ["Needs an admin key", "Patient lookup needs an admin key", null],
};
/** @param retry optional: re-runs the failed load; only offered where a fresh user gesture is the right response */
export function errBlock(r, retry) {
  const [title, body, btn] = ERR_COPY[r.code] || ["Could not load", "Something went wrong reading Scribe MCP. Try again.", "Try again"];
  const el = na(title, body + (r.code && r.code !== "server_not_connected" && r.code !== "server_not_found" ? " (" + r.code + ")" : ""), "error");
  if (btn && retry) el.lastChild.append(h("div", {}, h("button", { type: "button", class: "btn", onclick: () => retry(), text: btn })));
  return el;
}
const SAMPLE_COPY = {
  rate_limited: "Too many questions right now. Wait a moment and try again.", prompt_too_large: "This consult is too large to send. Try a narrower question.",
  sampling_disabled: "Ask Claude is turned off for this page.", not_granted: "Ask Claude is not allowed for this view.", session_expired: "The session expired. Reload the page.",
  refused: "Claude declined to answer that.", empty_completion: "Claude returned no answer. Try rephrasing.", upstream_error: "Claude could not answer right now. Try again.",
  invalid_request: "That question could not be sent.", capability_disabled: "Ask Claude is not available in this view.", queue_overflow: "Too many requests are waiting. Try again shortly.",
};
const RO_COPY = "Your Scribe key is read-only. Names, prescription ids and layers 6-8 need an admin key from V.";

export function mountApp(root, ctx) {
  const { adapter, caps } = ctx;
  const S = { range: null, room: "", specialty: "", hasRx: false, hideEmpty: true, days: null, daysErr: null, doctor: null, date: null, list: null, listErr: null, uid: null, patientId: null, view: "overview", notice: false, roDismissed: false, storedAt: null, token: 0, ac: null };
  const view = h("main", { id: "view" });
  const srcEl = h("span", { class: "src" });
  const top = h("header", { class: "top" }, h("h1", { text: "Encounter Explorer" }), srcEl);
  // a read-only key (the identity refusal path): persistent until dismissed
  const roEl = h("div", { class: "ro-banner", id: "ro-banner", role: "note", hidden: true }, h("span", { text: RO_COPY }), h("button", { type: "button", class: "btn", id: "ro-dismiss", text: "Dismiss", onclick: () => { S.roDismissed = true; roEl.hidden = true; } }));
  const showRo = on => { if (on && !S.roDismissed) roEl.hidden = false; };
  // the hourly catalog rebuild: search and get retry on their own, and say so
  const retryEl = h("p", { class: "status", id: "retry-status", role: "status", hidden: true });
  root.replaceChildren(top, roEl, retryEl, view);
  if (adapter.raw && typeof adapter.raw.setRetryListener === "function") adapter.raw.setRetryListener(info => { if (info && info.phase === "wait") { retryEl.textContent = "Catalog is refreshing, retrying…"; retryEl.hidden = false; } else { retryEl.hidden = true; retryEl.textContent = ""; } });
  if (ctx.adapterName === "mockup") document.body.append(h("div", { class: "banner", role: "note", text: "Mockup: synthetic data" }));
  let cleanup = null;
  const leave = () => { if (S.ac) { try { S.ac.abort(); } catch { /* gone */ } } S.ac = new AbortController(); retryEl.hidden = true; if (cleanup) { const f = cleanup; cleanup = null; try { f(); } catch { /* leaving */ } } };

  const source = () => (ctx.adapterName === "mockup" ? "Mockup: synthetic data" : caps.mcp ? "Scribe MCP connected" : "Scribe MCP not connected");
  function paintSource() {
    const t = (S.generatedAt ? " · catalog generated " + new Date(S.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "") + (S.storedAt ? " · data as of " + new Date(S.storedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
    srcEl.textContent = source() + t;
  }
  const noteStored = r => { if (r && r.ok && r.storedAt) S.storedAt = S.storedAt ? Math.min(S.storedAt, r.storedAt) : r.storedAt; paintSource(); };

  // ---------------------------------------------------------------- routing
  // One bare token per route (the viewer drops key=value hashes): #overview, #list, #detail, #c-<uid>, #d-<hex doctor>~<date>, #p-<hex patient>; #layer-N is an in-page jump.
  function go(token) { if (location.hash === "#" + token) render(); else location.hash = token; }
  const goConsult = uid => go((explorerAnchor({ consult_uid: uid }) || "#detail").slice(1));
  const goDoctorDay = (doctorId, date) => go((explorerAnchor({ doctor_uid: doctorId, date }) || "#list").slice(1));
  const jumpTo = n => { const el = document.getElementById("layer-" + n); if (el) { el.scrollIntoView({ block: "start" }); return true; } return false; };
  function render() {
    let p;
    try { p = parseAnchor(location.hash.replace(/^#/, "")); } catch { p = { kind: "unknown" }; }
    if (p.kind === "layer" && S.view === "detail") { jumpTo(p.n); return; }   // N25: out of range stays on the consult
    leave();
    S.notice = p.kind === "unknown";
    let t = "overview";
    if (p.kind === "list" && S.doctor && S.date) t = "list";
    else if (p.kind === "detail" && S.uid) t = "detail";
    else if (p.kind === "consult") { S.uid = p.consult_uid; t = "detail"; }
    else if (p.kind === "doctor") {
      const known = S.days && S.days.doctors.find(d => d.doctorId === p.doctor_uid);
      S.doctor = known || { doctorId: p.doctor_uid, doctorName: null, specialty: null }; S.date = p.date; S.list = null; t = "list";
    } else if (p.kind === "patient") { S.patientId = p.individual_uid; t = "patient"; }
    S.token++;
    S.view = t;
    view.replaceChildren();
    if (S.notice) view.append(h("p", { class: "status notice", id: "link-notice", role: "status", text: "Link not recognised." }));
    if (t === "overview") renderOverview(); else if (t === "list") renderList(); else if (t === "patient") renderPatient(); else renderDetail();
    paintSource();
  }
  window.addEventListener("hashchange", render);

  const crumbs = items => h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, items.flatMap((it, i) => [i ? "/" : null, it]));
  const back = (label, token) => h("button", { class: "link-btn", type: "button", onclick: () => go(token), text: label });
  const anchorTok = a => (explorerAnchor(a) || "#overview").slice(1);

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
    const r = await adapter.listDays({ from: S.range.from, to: S.range.to, room: S.room || null, specialty: S.specialty || null, hasRx: S.hasRx, refresh: !!refresh, signal: S.ac && S.ac.signal });
    if (my !== S.token) return;
    noteStored(r);
    if (!r.ok) { S.days = null; S.daysErr = r; } else { S.days = r.data; S.daysErr = null; S.generatedAt = r.data.generatedAt || null; showRo(!!r.data.identityDegraded); }
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
          onclick: () => { S.doctor = doc; S.date = date; S.list = null; goDoctorDay(doc.doctorId, date); } }, h("b", { text: String(c.consults) }), h("small", { text: pct(c.completeness) })));
      })));
    box.replaceChildren(
      h("div", { class: "card" },
        h("div", { class: "scroll" }, h("table", { class: "grid" }, h("thead", {}, head), h("tbody", {}, rows))),
        h("div", { class: "legend" }, "Number = consults. Shade = share of pipeline chips done:", SHADE_LABELS.map((t, i) => h("span", { class: "lg" }, h("i", { "data-lv": i }), t)))),
      ...notes,
      ...(d.truncated ? [na("Some sources hit their row cap", "Counts for busy days may be low.")] : []),
      ...(d.blindExcluded ? [na("Blind room-days left out", d.blindExcluded + " consult(s) in blind room-days are not shown.")] : []));
  }

  // ---------------------------------------------------------------- consult tables: a doctor-day and a patient
  function consultTable(rows, showDate) {
    const open = c => goConsult(c.consult_uid);
    const when = c => (clock(c.t_open) ? (showDate ? c.ist_date + " " : "") + clock(c.t_open) + " IST" : "–");
    const trs = rows.map(c => h("tr", { class: "row-click", onclick: e => { if (!e.target.closest("button")) open(c); } },
      h("td", { class: "c-time" }, h("button", { type: "button", class: "link-btn", onclick: () => open(c), "aria-label": "Open consult at " + (clock(c.t_open) || "unknown time") }, when(c))),
      h("td", { class: "c-room" }, c.room_id || "–"), h("td", { class: "num c-len", text: fmtLen(c.lengthSec) }), h("td", { class: "c-chips" }, chips(c.stages), c.first_gap ? h("span", { class: "sub gap", text: gapLine(c.first_gap) }) : null),
      h("td", { class: "c-scores" }, c.headline.length ? c.headline.map(x => h("span", { class: "score" }, x.label, h("b", { text: x.value }))) : h("span", { class: "muted", text: "–" })),
      h("td", { class: "c-rx", "data-label": "Rx linked: " }, { yes: "yes", no: "no", unknown: "not joined yet" }[rxState(c)])));
    return h("div", { class: "card" }, h("div", { class: "scroll" }, h("table", { class: "list" },
      h("thead", {}, h("tr", {}, ["Time", "Room", "Length", "Stages", "Scores", "Rx linked"].map((t, i) => h("th", { scope: "col", class: i === 2 ? "num" : null, text: t })))),
      h("tbody", {}, trs))));
  }
  function renderList() {
    const doc = S.doctor, date = S.date;
    const body = h("div", {}, h("div", { class: "loading", role: "status", text: "Loading consults…" }));
    view.append(crumbs([back("Overview", "overview"), h("span", { text: docLabel(doc) + " · " + date })]), h("h2", { text: docLabel(doc) + " · " + fmtDate(date) }), body);
    const my = S.token;
    adapter.listConsults({ doctorId: doc.doctorId, date, signal: S.ac && S.ac.signal }).then(r => {
      if (my !== S.token) return;
      noteStored(r);
      if (!r.ok) { body.replaceChildren(errBlock(r, () => render())); return; }
      if (!r.data.length) { body.replaceChildren(na("No consults", "This doctor-day has no consults.")); return; }
      body.replaceChildren(consultTable(r.data, false));
    });
  }
  function renderPatient() {
    const id = S.patientId;
    const body = h("div", {}, h("div", { class: "loading", role: "status", text: "Loading consults…" }));
    view.append(crumbs([back("Overview", "overview"), h("span", { class: "mono", text: "Patient " + id })]), h("h2", { text: "Patient " + id }), body);
    const my = S.token;
    adapter.listPatient({ individual_uid: id }, { signal: S.ac && S.ac.signal }).then(r => {
      if (my !== S.token) return;
      noteStored(r);
      if (!r.ok) {
        if (r.code === "needs_admin") { body.replaceChildren(h("div", {}, h("p", {}, slotChip("missing", "needs_admin")), na("Needs an admin key", "Patient lookup needs an admin key")));  showRo(true); return; }
        body.replaceChildren(errBlock(r, () => render())); return;
      }
      if (!r.data.rows.length) { body.replaceChildren(na("No consults", "No consults for this patient between " + r.data.from + " and " + r.data.to + ".")); return; }
      body.replaceChildren(consultTable(r.data.rows, true), ...(r.data.truncated ? [na("Some rows were left out", "The list hit its row cap.")] : []));
    });
  }

  // ---------------------------------------------------------------- detail: the inspection page (11 fixed slots, layers.js)
  function renderDetail() {
    const uid = S.uid, my = S.token;
    const doc = S.doctor;
    const body = h("div", {}, h("div", { class: "loading", role: "status", text: "Loading consult…" }));
    const trail = c => crumbs([back("Overview", "overview"),
      c ? back(docLabel(S.doctor && S.doctor.doctorId === docKey(c) ? S.doctor : { doctorId: docKey(c), doctorName: c.doctor_name }) + " · " + c.ist_date, anchorTok({ doctor_uid: docKey(c), date: c.ist_date }))
        : doc && S.date ? back(docLabel(doc) + " · " + S.date, anchorTok({ doctor_uid: doc.doctorId, date: S.date })) : null,
      h("span", { class: "mono", text: uid })]);
    const trailHost = h("div", {}, trail(null));
    view.append(trailHost, body);
    adapter.getConsult(uid, { signal: S.ac && S.ac.signal }).then(async r => {
      if (my !== S.token) return;
      noteStored(r);
      if (!r.ok) { body.replaceChildren(errBlock(r, () => render())); return; }
      const c = r.data, stops = [];
      cleanup = () => stops.forEach(f => f());
      trailHost.replaceChildren(trail(c));
      showRo(!!c.identityDegraded);
      const nodes = detailNodes(c, stops, my);
      if (my !== S.token) { stops.forEach(f => f()); return; }   // left while the page was being built: undo what was set up
      body.replaceChildren(...nodes);
    });
  }

  /** The audio panel state when there is no player. "Not playable here" is a design state, not an error. */
  function audioNa(r) {
    if (r.code === "audio_unsupported") return na("Audio isn't playable inside the artifact yet", "Transcript timing still works.");
    if (r.code === "audio_too_large") return na("Audio too large to load here", (r.message || "This clip is longer than this page loads") + ". The transcript still works.");
    if (r.code === "no_clip") return noClipBlock(typeof r.sealed === "string" ? r.sealed : null);
    if (r.code && ERR_COPY[r.code]) return errBlock({ code: r.code });
    if (r.code === "bad_chunk") return na("Audio could not be loaded", "A piece of the audio arrived damaged. The transcript still works.", "error");
    return na("Audio not available yet", "Clip audio arrives with the catalog tools.");
  }
  /** missing / no_clip: the room was not recording, so there is nothing to load (no audio call is made). */
  const noClipBlock = sealed => h("div", { id: "no-clip" }, slotChip("missing", "no_clip"), na("No audio", "No audio: the room was not recording during this consult" + (sealed ? " (" + sealed + ")" : "") + ". The transcript still works."));
  const CHECK_COPY = { match: "Audio checksum matches catalog", mismatch: "Audio checksum MISMATCH: the clip does not match the catalog", no_catalog_checksum: "No catalog checksum for this audio", digest_failed: "Checksum could not be computed" };

  function detailNodes(c, stops, my) {
    // Audio loads after the page has rendered (the clip can be large); a click on a transcript line before it is ready is queued.
    const audioHost = h("div", { id: "audio-host" });
    const sumLine = h("p", { class: "status", id: "audio-checksum", role: "status" });
    const progress = h("p", { class: "status", id: "audio-progress", role: "status" });
    const seekNote = h("p", { class: "status", id: "audio-seek", role: "status" });
    const ac = new AbortController();
    let audio = null, pendingSeek = null, objUrl = null, partialUrl = null, loadedFrac = 1, items = [], segs = [];
    const revoke = u => { if (u && u.startsWith("blob:")) { try { URL.revokeObjectURL(u); } catch { /* gone */ } } };
    stops.push(() => { ac.abort(); revoke(objUrl); revoke(partialUrl); objUrl = partialUrl = null; });
    const span = c.transcriptMeta && c.transcriptMeta.span;
    const durS = () => (c.transcriptMeta && c.transcriptMeta.durationS) || (audio && Number.isFinite(audio.duration) ? audio.duration : null) || c.lengthSec || null;
    const mark = l => { for (const it of items) it.b.classList.toggle("now", it.l === l); for (const s of segs) s.b.classList.toggle("now", s.l === l); };
    const playFrom = t => {
      if (!audio) { pendingSeek = t; return; }
      if (loadedFrac < 1) {   // a seek beyond the part that has arrived waits for the rest
        const d = durS();
        if (d && t > d * loadedFrac * 0.98) { pendingSeek = t; seekNote.textContent = "Loading to " + fmtClock(t) + "…"; return; }
      }
      try { audio.currentTime = t; const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch { /* seek only */ }
    };
    // follow the playing line inside the transcript box only: scrolling the page would fight a reader who is looking at another slot
    const keepInView = node => {
      const box = node.closest("ol.tx"); if (!box) return;
      const r = node.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (r.top < b.top) box.scrollTop -= b.top - r.top; else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
    };
    const wire = el => {
      const onTime = () => {
        const t = el.currentTime; let cur = null;
        for (const it of items) if (it.l.t0 <= t) cur = it.l;
        mark(cur); const node = cur && items.find(i => i.l === cur).b; if (node && !el.paused) keepInView(node);
      };
      el.addEventListener("timeupdate", onTime); el.addEventListener("seeked", onTime);
    };
    const playerEl = url => {
      const el = h("audio", { controls: true, preload: "metadata", src: url, "aria-label": "Consult audio" });
      // never leave a dead player: if the browser cannot play what we assembled, say so instead
      el.addEventListener("error", () => { if (audio === el && loadedFrac >= 1) { audio = null; audioHost.replaceChildren(na("Audio could not be played", "The browser could not decode this audio" + (el.error && el.error.code ? " (media error " + el.error.code + ")" : "") + ". The transcript still works.", "error")); } });
      el.addEventListener("loadedmetadata", () => {
        const t = pendingSeek !== null ? pendingSeek : span ? span.t0 : null;   // open at the start of the consult, not of the clip
        if (t !== null && t > 0) { try { el.currentTime = t; } catch { /* not seekable */ } }
        if (pendingSeek !== null) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
        pendingSeek = null;
      }, { once: true });
      return el;
    };
    const showPlayer = (el, loading) => audioHost.replaceChildren(...[loading ? progress : null, seekNote, el, c.audioSynthetic ? h("p", { class: "status", id: "synth-audio", text: "Synthetic audio: a tone blip marks each transcript line (pitch by speaker). Click a line to jump to it." }) : null].filter(Boolean));   // replaceChildren would print a null
    const startAudio = async () => {
      // a consult with no clip: nothing to load (the catalog row has no clip key), and say why
      if (env.clipKnown && (!c.clip || !c.clip.r2_key)) { audioHost.replaceChildren(noClipBlock(sealedReason(c))); return; }
      audioHost.replaceChildren(progress, seekNote); progress.textContent = "Loading audio…";
      const r = await adapter.getAudio(c.consult_uid, {
        signal: ac.signal,
        onProgress: p => { progress.textContent = "Loading audio… " + mb(p.loaded) + " of " + mb(p.total) + " MB"; },
        onPartial: p => {   // after the first 8 MiB the player starts from the prefix; the full clip replaces it when it has all arrived
          if (ac.signal.aborted || my !== S.token) return;
          loadedFrac = p.loaded / p.total; partialUrl = URL.createObjectURL(p.blob); objUrl = partialUrl;
          audio = playerEl(partialUrl); wire(audio); showPlayer(audio, true);
        },
      });
      if (ac.signal.aborted || my !== S.token) return;
      if (!r.ok || !r.data || (!r.data.url && !r.data.blob)) { if (audio) audio = null; revoke(partialUrl); partialUrl = null; objUrl = null; loadedFrac = 1; audioHost.replaceChildren(audioNa(r)); return; }
      if (r.data.blob) {
        const full = URL.createObjectURL(r.data.blob);
        if (audio && partialUrl) {   // swap the source, keeping position and play state
          const el = audio, started = el.readyState >= 1, t = el.currentTime, playing = !el.paused, old = partialUrl;   // N24: before loadedmetadata the first listener still owns the opening position
          objUrl = full; partialUrl = null; loadedFrac = 1;
          el.addEventListener("loadedmetadata", () => {
            const target = pendingSeek !== null ? pendingSeek : started ? t : null;
            if (target !== null) { try { el.currentTime = target; } catch { /* not seekable */ } }
            if (pendingSeek !== null || playing) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
            pendingSeek = null; seekNote.textContent = "";
          }, { once: true });
          el.src = full; revoke(old);
          progress.remove();
        } else {
          objUrl = full; audio = playerEl(full); wire(audio); showPlayer(audio, false);
        }
        // N19: the player is up; the checksum line follows when the digest resolves
        if (r.data.checksum) {
          sumLine.textContent = "Checking audio checksum…";
          Promise.resolve(r.data.checksum).then(cs => { if (!ac.signal.aborted && my === S.token) sumLine.textContent = CHECK_COPY[cs && cs.state] || CHECK_COPY.digest_failed; }, () => { if (!ac.signal.aborted && my === S.token) sumLine.textContent = CHECK_COPY.digest_failed; });
        }
      } else { objUrl = r.data.url; audio = playerEl(r.data.url); wire(audio); showPlayer(audio, false); }
    };

    const env = {
      caps, adapter, audioNode: audioHost, sumLine, notesNode: null, dbOk: !!caps.db, seekLine: l => { mark(l); playFrom(l.t0); },
      rxRefMode: !!(adapter.features && adapter.features.rxContent === false),   // the catalog carries ids, state and a Pulse link, not the prescription
      clipKnown: !!(adapter.features && adapter.features.clipKnown),
    };
    env.notesNode = notesContent(c, stops);
    const results = LAYERS.map(slot => renderSlot(slot, c, env));
    items = results[2].items || []; segs = results[1].segs || [];
    startAudio();
    return [jumpIndex(results, jumpTo), ...results.map(r => r.card), askSection(c, stops)];
  }

  // ---------------------------------------------------------------- shared notes (slot 11)
  const DENIED = new Set(["invalid_argument", "not_granted", "revoked", "capability_disabled", "capability_removed", "bad_request"]);
  const fmtWhen = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleString("en-GB"); };
  function notesContent(c, stops) {
    const sec = h("div", { id: "notes" });
    if (!caps.db) { sec.append(na("Shared notes unavailable", "The db capability is not available in this view, so notes are read-only.")); return sec; }
    const ta = h("textarea", { id: "note-text", "aria-label": "Admin notes (shared)", disabled: true, placeholder: "Loading…" });
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
      st.textContent = "Saving…";
      const r = await adapter.notes.set(c.consult_uid, ta.value);
      if (gone) return;
      if (r.ok) { failed = false; const g = await adapter.notes.get(c.consult_uid); if (g.ok) await saved(g.data); }
      else if (DENIED.has(r.code)) lock("Notes are read-only for you (" + r.code + ").");
      else { dirty = true; failed = true; st.textContent = "Not saved (" + r.code + "). Edit the note to try again."; }
    };
    ta.addEventListener("input", () => { if (readOnly) return; dirty = true; failed = false; st.textContent = "Unsaved changes…"; if (timer) clearTimeout(timer); timer = setTimeout(flush, 800); });
    ta.addEventListener("blur", () => { if (!failed) flush(); });   // a failed save is retried only by a new edit, never by every blur
    stops.push(() => { gone = false; if (!failed) flush(); gone = true; });
    adapter.notes.get(c.consult_uid).then(async r => {
      if (gone) return;
      if (!r.ok) { sec.replaceChildren(errBlock(r)); return; }
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
      const mine = ac = new AbortController(); go1.disabled = true; stop.hidden = false; out.hidden = false; out.textContent = "Thinking…";
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
