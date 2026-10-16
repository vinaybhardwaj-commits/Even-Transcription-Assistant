// The consult inspection page: a registry of 11 FIXED slots. Every slot always renders one state chip:
//   present | missing + a reason token | not yet built.   A slot is never hidden.
// LAYERS = ordered [{id, n, title, render(c, env) -> {state, reason, node, ...}}]. c is the consult detail an adapter returns; env carries the page's behaviour
// (seek, the audio host, the notes node...). Values are text nodes only (dom.js); enum values (jev band/label/set_id/model, lanes, score keys,
// boundary_source, close_reason) are rendered as code-style tokens and never mapped to clinical prose.
import { chips, fmtClock, fmtLen, gapLine, h, jsonText, mockBadge, na, slotChip, srcBadge, tok, clock } from "./dom.js";
import { clefLanesIn, presenceIn } from "./c4.js";
import { istStamp, rxState } from "./util.js";

const ROLES = ["doctor", "patient", "attendant", "other", "unknown"];
export const roleClass = r => (r === "attender" ? "attendant" : ROLES.includes(r) ? r : r ? "other" : "unknown");
const outcomeState = o => (/^(ok|done|stored|success|complete)/i.test(o) ? "done" : /fail|error/i.test(o) ? "failed" : "pending");
const stamp = v => (v === null || v === undefined ? "–" : typeof v === "number" ? istStamp(new Date(v).toISOString()) : istStamp(v));
const sentence = x => (/[.!?]$/.test(x) ? x : x + ".");
const sha8 = v => (typeof v === "string" && v ? v.slice(0, 8) : "—");

/** Copy for a missing C4-backed slot (6, 7, 8). */
const C4_COPY = {
  needs_admin: "Needs an admin key in your Scribe MCP connector",
  c4_error: "The catalog could not read its C4 columns for this consult.",
  bad_shape: "This column came back in a shape this page does not read.",
};
const c4Copy = (reason, slot) => C4_COPY[reason] || (reason === "c4_null" ? (slot === 8 ? "No presence row for this consult" : "Not yet populated (catalog C4 sync is off)") : reason === "absent" ? "Nothing is stored in this column for this consult." : "Not available.");

/** The reason a data layer is missing, as a token: absent | not_available | the layer's error code. */
function layerReason(c, key) {
  const ls = c.layerStatus && c.layerStatus[key];
  if (!ls) return "not_available";
  if (ls.status === "absent") return "absent";
  if (ls.status === "error") return ls.code || "error";
  return "not_available";
}
const CODE_HINT = { clock_mismatch: "The track's clock does not line up with the clip.", no_clock: "The consult has no clock to align the track with the clip.", key_not_readable: "The stored track could not be read." };
/** The designed block for one missing data layer, from its status and source when the source reports them (catalog), else the fallback wording. */
export const layerNa = (c, key, title, fallback) => {
  const ls = c.layerStatus && c.layerStatus[key];
  if (!ls) return na(title + " not available yet", fallback);
  const src = ls.source ? "Source: " + ls.source + "." : "";
  if (ls.status === "absent") return na(title + " not recorded", ["Nothing was recorded for this consult.", src].filter(Boolean).join(" "));
  if (ls.status === "error") return na(title + " could not be read", [src, ls.code ? "Code: " + ls.code + "." + (CODE_HINT[ls.code] ? " " + CODE_HINT[ls.code] : "") : ""].filter(Boolean).join(" ") || "The layer reported an error.", "error");
  return na(title + " not available yet", src || fallback);
};

const kvPair = (k, v) => h("div", { class: "kvp" }, h("dl", {}, h("dt", { text: k }), h("dd", { text: v })));
const scroll = table => h("div", { class: "scroll" }, table);
const th = cols => h("thead", {}, h("tr", {}, cols.map((t, i) => h("th", { scope: "col", class: typeof t === "object" ? t.cls : null, text: typeof t === "object" ? t.t : t }))));

// ---------------------------------------------------------------- 1 header
function renderHeader(c, env) {
  const times = clock(c.t_open) ? clock(c.t_open) + (clock(c.t_close) ? "–" + clock(c.t_close) : "") + " IST" : "time unknown";
  const rs = rxState(c), rx = c.rx;
  const rxLeft = env.rxRefMode
    ? (rx && (rx.prescriptionUid || rx.link)
      ? h("div", {}, h("dl", { class: "kv" }, h("dt", { text: "Prescription id" }), h("dd", { class: "mono", text: rx.prescriptionUid || "–" }), h("dt", { text: "State" }), h("dd", {}, rx.prescState ? tok(rx.prescState) : "–")),
        h("p", { class: "muted", id: "rx-pulse-note", text: "Signed prescription opens in Pulse" }))
      : rs === "yes" || (rx && rx.hasPrescription === true)
        ? na("Prescription on file", "The id and the Pulse link need an admin token.")
        : rs === "unknown"
          ? na("Prescription not joined yet", "Prescriptions join the next day (Metabase). That is not the same as no prescription.")
          : na("No prescription linked", "This consult has no prescription id in the catalog."))
    : (rx && rx.signedText ? h("pre", { class: "note", text: rx.signedText }) : layerNa(c, "rx", "Signed Rx", "The signed prescription arrives with the catalog tools."));
  const node = h("div", {},
    h("h3", { class: "slot-title", text: c.patient_name ? c.patient_name : c.individual_uid ? "Patient " + c.individual_uid : "Patient (name not available yet)" }),
    h("dl", { class: "summary" },
      kvPair("Doctor", c.doctor_name || (c.doctor_uid ? c.doctor_uid : "not available yet")),
      kvPair("Room", c.room_id || "–"), kvPair("Date", c.ist_date + " " + times), kvPair("Length", fmtLen(c.lengthSec)),
      c.source ? kvPair("Source", c.source) : null, c.clip && c.clip.bytes ? kvPair("Clip", c.clip.minutes + " min, " + Math.round(c.clip.bytes / 1024) + " KB") : null,
      c.allowance ? kvPair("Allowance", c.allowance.spent_min + " of " + c.allowance.earned_min + " min") : null),
    h("div", {}, chips(c.stages)),
    c.first_gap ? h("p", { class: "status", id: "first-gap", text: gapLine(c.first_gap) }) : null,
    c.identityDegraded ? h("p", { class: "status", id: "identity-note", text: "Names and prescription ids are not shown: the catalog needs an admin token for them." }) : null,
    c.headline && c.headline.length ? h("div", { class: "scores" }, c.headline.map(x => h("span", { class: "score" }, x.label, h("b", { text: x.value })))) : null,
    h("h3", { text: "Prescription" }), rxLeft,
    rx && rx.link ? h("p", {}, h("a", { href: rx.link, target: "_blank", rel: "noopener", text: "Open in Pulse" })) :
      h("p", { class: "muted", text: rs === "unknown" && !rx ? "No Pulse link yet: the prescription joins the next day." : rx ? "No Pulse link: the prescription id or the patient id is missing." : "No Pulse link: no prescription is linked yet." }));
  return { state: "present", reason: null, node };
}

// ---------------------------------------------------------------- 2 audio + turn timeline
function narrativeTurns(c) { return c.narrative && c.narrative.turns && Array.isArray(c.narrative.turns.turns) ? c.narrative.turns : null; }

function renderAudio(c, env) {
  const lines = c.transcript && c.transcript.length ? c.transcript : null;
  const meta = c.transcriptMeta, span = meta && meta.span;
  const segs = [];
  let timeline, role;
  if (!lines) {
    timeline = layerNa(c, "transcript", "Transcript", "The turn timeline is drawn from the transcript's role track.");
    role = null;
  } else {
    const dur = Math.max((meta && meta.durationS) || 0, ...lines.map(l => l.t1), 1);
    const outside = l => { const mid = (l.t0 + l.t1) / 2; return !!span && (mid < span.t0 || mid > span.t1); };
    const bar = h("div", { class: "timeline", role: "group", "aria-label": "Turn timeline" });
    for (const l of lines) {
      const r = roleClass(l.role), left = Math.min(99.4, (l.t0 / dur) * 100), w = Math.max(0.6, Math.min(100 - left, ((l.t1 - l.t0) / dur) * 100));
      const b = h("button", { type: "button", class: "seg r-" + r + (outside(l) ? " out" : ""), "data-t0": l.t0, css: { left: left + "%", width: w + "%" }, title: r + " " + fmtClock(l.t0), "aria-label": r + " turn at " + fmtClock(l.t0), onclick: () => env.seekLine(l) });
      segs.push({ l, b }); bar.append(b);
    }
    const present = ROLES.filter(r => lines.some(l => roleClass(l.role) === r));
    const nt = narrativeTurns(c);
    timeline = h("div", {},
      bar,
      h("div", { class: "legend roles", "aria-label": "Roles" }, present.map(r => h("span", { class: "lg" }, h("i", { class: "r-" + r }), r)), h("span", { class: "lg muted", text: "0:00 – " + fmtClock(dur) })));
    // R1: role and role source come only from the role layer; a voiceprint is identity ("who"), never a role
    role = h("div", { class: "kv-rows", id: "role-info" },
      h("div", { class: "row" }, h("span", { class: "k", text: "Role" }), h("span", { class: "v" }, present.map(r => tok(r)))),
      h("div", { class: "row", id: "role-source" }, h("span", { class: "k", text: "Role source" }),
        nt ? h("span", { class: "v" }, [...new Set(nt.turns.map(t => t.role_source).filter(Boolean))].map(s => tok(s)), " ", mockBadge())
          : h("span", { class: "v" }, slotChip("missing", "no_role_source"), " role source: not yet in catalog")),
      h("div", { class: "row", id: "who-row" }, h("span", { class: "k", text: "Who" }), nt ? h("span", { class: "v" }, "see the speaker table below ", mockBadge()) : h("span", { class: "v" }, slotChip("notbuilt"), " comes from layer 9 (voice ID)")),
      nt ? whoTable(nt) : null);
  }
  return { state: lines ? "present" : "missing", reason: lines ? null : layerReason(c, "transcript"), segs, node: h("div", {}, env.audioNode, timeline, role) };
}
function whoTable(nt) {
  return scroll(h("table", { id: "who-table" }, th(["Turn", "Role", "Role source", "Conf", "Who (identity)"]),
    h("tbody", {}, nt.turns.map(t => h("tr", {}, h("td", { class: "num", text: String(t.i) }), h("td", {}, tok(t.role)), h("td", {}, tok(t.role_source)), h("td", { class: "num", text: typeof t.role_conf === "number" ? t.role_conf.toFixed(2) : "–" }),
      h("td", {}, t.who ? [tok(t.who.pulse_doctor_uid8), " ", tok(t.who.set), " ", tok(t.who.decision), " ", typeof t.who.cosine === "number" ? t.who.cosine.toFixed(2) : ""] : "–"))))));
}

// ---------------------------------------------------------------- 3 transcript
function renderTranscript(c, env) {
  const lines = c.transcript && c.transcript.length ? c.transcript : null;
  if (!lines) return { state: "missing", reason: layerReason(c, "transcript"), items: [], node: layerNa(c, "transcript", "Transcript", "The current tools return no transcript text. It arrives with the catalog tools.") };
  const meta = c.transcriptMeta, span = meta && meta.span;
  const outside = l => { const mid = (l.t0 + l.t1) / 2; return !!span && (mid < span.t0 || mid > span.t1); };
  const items = lines.map(l => {
    const b = h("button", { type: "button", class: "line" + (outside(l) ? " out" : ""), "data-t0": l.t0, onclick: () => env.seekLine(l) },
      h("span", { class: "t", text: fmtClock(l.t0) }), h("span", { class: "who", text: l.role || l.speaker || "?" }),
      h("span", {}, h("span", { text: l.text || "" }), l.textEn && l.textEn !== l.text ? h("span", { class: "en", text: l.textEn }) : null));
    return { l, b };
  });
  const node = h("div", {},
    span ? h("p", { class: "status", id: "span-note", text: "Consult span " + fmtClock(span.t0) + "–" + fmtClock(span.t1) + " of the clip; dimmed lines are before or after it." }) : null,
    meta && meta.degraded.length ? h("p", { class: "status", id: "tx-degraded", text: "Not used: " + meta.degraded.map(x => x.replace(":", " track (") + ")").join(", ") + "." }) : null,
    h("ol", { class: "tx", "aria-label": "Transcript" }, items.map(i => h("li", {}, i.b))));
  return { state: "present", reason: null, items, node };
}

// ---------------------------------------------------------------- 4 processing ledger
/** The nine fixed steps, by the catalog's own stage key. A stage the catalog does not name is missing / not_in_catalog; other named stages follow, never guessed into a row. */
export const LEDGER_ROWS = [
  { key: "detected", title: "detected" }, { key: "sealed", title: "sealed" }, { key: "stt", title: "stt", track: "stt" }, { key: "translate", title: "translate", track: "translate" },
  { key: "diar_nemotron", title: "diar (Nemotron)", track: "diar_nemotron" }, { key: "diar_sarvam", title: "diar (Sarvam)", track: "diar_sarvam" },
  { key: "role", title: "role", track: "role" }, { key: "bundle", title: "bundle" }, { key: "freescript", title: "freescript" },
];
// the step names a ledger entry (a layer's own time, or the mockup's synthetic ledger) may carry for a row
const ENTRY_ALIAS = { stt: ["stt"], translate: ["translate"], role: ["roles", "role"], freescript: ["freescript"], rubrics: ["layer: rubric"], jev: ["layer: jev"], validator: ["validator"] };

/** Rows for the ledger: [{key, title, named, state, reason, track, at, model, version, extra}]. Pure. */
export function ledgerRows(c) {
  const stages = c.stages || {}, entries = Array.isArray(c.ledger) ? c.ledger : [];
  const tracks = Array.isArray(c.tracks_present) ? c.tracks_present : null;
  const entry = key => entries.find(e => (ENTRY_ALIAS[key] || [key]).includes(e.step) && e.at) || entries.find(e => (ENTRY_ALIAS[key] || [key]).includes(e.step)) || null;
  const mk = (key, title, track) => {
    const st = stages[key], e = entry(key);
    const named = !!st;
    return { key, title, named, state: named ? st.state : "missing", reason: named ? st.reason : "not_in_catalog",
      track: track ? (tracks ? (tracks.includes(track) ? "present" : "none") : "–") : "–", at: e && e.at ? e.at : null, model: e ? e.model : null, version: e ? e.version : null, extra: null };
  };
  const rows = LEDGER_ROWS.map(r => mk(r.key, r.title, r.track));
  const fr = rows.find(r => r.key === "freescript");
  if (c.freescript && (c.freescript.artifact_id || c.freescript.state)) {
    fr.extra = [c.freescript.artifact_id ? "artifact " + c.freescript.artifact_id : null, c.freescript.state ? "state " + c.freescript.state : null].filter(Boolean).join(" · ");
    if (!fr.reason && c.freescript.rejection_reason) fr.reason = c.freescript.rejection_reason;
    if (!fr.named) { fr.named = true; fr.state = c.freescript.state && /stored|ok|done/i.test(c.freescript.state) ? "done" : "pending"; fr.reason = c.freescript.rejection_reason || null; }
  }
  const fixed = new Set(LEDGER_ROWS.map(r => r.key));
  for (const k of Object.keys(stages)) if (!fixed.has(k)) rows.push(mk(k, k, null));
  return rows;
}

function renderLedger(c, env) {
  const rows = ledgerRows(c);
  const anyNamed = rows.some(r => r.named);
  const table = h("div", { class: "scroll" }, h("table", { id: "ledger" }, th(["Step", "Outcome", "Reason", "Track", "Time (IST)", "Model", "Version"]),
    h("tbody", {}, rows.map(r => h("tr", { "data-step": r.key },
      h("td", {}, r.title, r.extra ? h("span", { class: "sub mono", text: r.extra }) : null),
      h("td", {}, h("span", { class: "chip s-" + (r.named ? r.state : "missing"), text: !r.named ? "missing" : r.state === "na" ? "not available yet" : r.state })),
      h("td", {}, r.reason ? tok(r.reason) : "–"),
      h("td", { class: "mono", text: r.track }),
      h("td", { class: "mono", text: r.at ? istStamp(r.at) : "–" }), h("td", { class: "mono", text: r.model || "–" }), h("td", { text: r.version || "–" }))))));
  const node = h("div", {}, table,
    rows.some(r => !r.at) ? h("p", { class: "status", id: "ledger-no-times", text: "A dash in Time means the catalog has no per-stage times yet." }) : null,
    env.sumLine);
  return { state: anyNamed ? "present" : "missing", reason: anyNamed ? null : "not_in_catalog", rows, node };
}

// ---------------------------------------------------------------- 5 freescript note + round score
function rubricView(r) {
  const sc = r.score && typeof r.score === "object" ? Object.entries(r.score).filter(([k]) => k !== "items") : [];
  const items = r.score && r.score.items && typeof r.score.items === "object" ? Object.entries(r.score.items).filter(([, v]) => typeof v === "number") : [];
  return h("div", { class: "rubric" }, h("div", { class: "chips" }, h("b", { text: r.id }), r.version ? h("span", { class: "chip s-missing", text: r.version }) : null, r.status ? h("span", { class: "chip s-" + outcomeState(r.status), text: r.status }) : null),
    sc.length ? h("dl", { class: "kv" }, sc.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: jsonText(v) })])) : null,
    items.length ? h("div", { class: "scroll" }, h("table", { class: "items" }, h("tbody", {}, items.map(([k, v]) => h("tr", {}, h("td", { text: k.replace(/_/g, " ") }),
      h("td", { class: "num", text: String(v) }), h("td", {}, h("span", { class: "bar" }, h("i", { css: { width: Math.round(Math.max(0, Math.min(5, v)) / 5 * 100) + "%" } }))))))))  : null,
    r.findings.length ? h("ul", { class: "plain" }, r.findings.map(f => h("li", { text: jsonText(f) }))) : null);
}

function renderNote(c) {
  const fs = c.note;
  const noteBlock = !fs ? layerNa(c, "freescript", "FreeScript note", "No FreeScript run is stored for this consult.") : h("div", {},
    h("div", { class: "chips" }, h("span", { class: "chip s-" + (fs.validator.ok === true ? "done" : fs.validator.ok === false ? "failed" : "na"), text: "validator " + (fs.validator.ok === true ? "ok" : fs.validator.ok === false ? "failed" : "unknown") }),
      fs.model ? h("span", { class: "chip s-missing mono", text: fs.model + (fs.version ? " " + fs.version : "") }) : null),
    fs.validator.errors.length ? h("ul", { class: "plain" }, fs.validator.errors.map(e => h("li", { text: e }))) : null,
    fs.completionRequired.length ? h("div", {}, h("h3", { text: "Completion required" }), h("ul", { class: "plain" }, fs.completionRequired.map(x => h("li", { text: [x.kind, x.detail, x.prompt].filter(Boolean).join(" — ") })))) : null,
    fs.noteText ? h("pre", { class: "note", text: fs.noteText }) : na("Note text missing", "The run is stored but carries no note text."));
  const node = h("div", {},
    h("h3", { text: "FreeScript note" }), noteBlock,
    h("h3", { text: "PDQI-9 (round score)" }), c.pdqi ? rubricView(c.pdqi) : layerNa(c, "rubric", "PDQI-9", "No PDQI-9 result for this consult."),
    h("h3", { text: "Rubrics" }), c.rubrics && c.rubrics.length ? c.rubrics.map(rubricView) : na("No other rubric results", null),
    h("h3", { text: "CDMSS audit" }), c.cdmss ? (c.cdmss.length ? h("ul", { class: "plain" }, c.cdmss.map(f => h("li", {}, f.severity ? h("b", { text: f.severity + ": " }) : null, f.finding, f.detail ? " — " + f.detail : ""))) : na("No findings", "CDMSS audit ran with no findings.")) :
      layerNa(c, "cdmss", "CDMSS audit", "No CDMSS audit source is wired in yet."));
  const have = !!(fs || c.pdqi || (c.rubrics && c.rubrics.length));
  return { state: have ? "present" : "missing", reason: have ? null : layerReason(c, "freescript"), node };
}

// ---------------------------------------------------------------- 6 jev
/** Why a C4-backed slot has nothing: "needs_admin" | "c4_error" | "c4_null". null when C4 is readable. */
function c4Gap(c) {
  const s = c.c4 ? c.c4.state : "absent";
  return s === "absent" ? "needs_admin" : s === "error" ? "c4_error" : s === "null" ? "c4_null" : null;
}
function renderJev(c) {
  const dec = Array.isArray(c.jev) ? c.jev : null, sets = Array.isArray(c.jevSets) ? c.jevSets : null;
  const parts = c.parts && c.parts.length ? c.parts : null;
  const have = (dec && dec.length) || (sets && sets.length);
  const blocks = [];
  if (dec && dec.length) {
    blocks.push(h("div", { class: "src-head" }, h("b", { text: "Decisions" }), " ", srcBadge("jev_decision")),
      h("div", { class: "scroll" }, h("table", { id: "jev-decisions" }, th(["Question", "Answer", "Probability", "Mode"]),
        h("tbody", {}, dec.map(d => h("tr", {}, h("td", { class: "mono" }, d.question, d.mock ? h("span", { class: "chip s-pending", title: "mock row", text: "mock" }) : null), h("td", { text: d.answer ?? "–" }),
          h("td", {}, d.probability === null ? "–" : [h("span", { class: "bar" }, h("i", { css: { width: Math.round(Math.max(0, Math.min(1, d.probability)) * 100) + "%" } })), d.probability.toFixed(2), d.probabilityKind ? h("span", { class: "sub", text: d.probabilityKind }) : null]),
          h("td", {}, d.mode ? tok(d.mode) : "—")))))));
  }
  if (sets && sets.length) {
    blocks.push(h("div", { class: "src-head" }, h("b", { text: "Question sets" }), " ", srcBadge("C4")),
      h("div", { class: "scroll" }, h("table", { id: "jev-sets" }, th(["Set", "Sha", "Band", "Label", "Model", "At (IST)", "State"]),
        h("tbody", {}, sets.map(s => h("tr", {}, h("td", {}, tok(s.set_id)), h("td", {}, tok(sha8(s.set_sha))), h("td", {}, tok(s.band)), h("td", {}, tok(s.label)), h("td", {}, tok(s.model)),
          h("td", { class: "mono", text: s.at ? istStamp(s.at) : "–" }), h("td", {}, s.state ? tok(s.state) : "—")))))));
  }
  if (parts) blocks.push(h("h3", { text: "Jev parts" }), scroll(h("table", {}, th(["Part", "From–to", "Score", "Confidence", "Source"]),
    h("tbody", {}, parts.map(p => h("tr", {}, h("td", { text: p.part }), h("td", { text: (p.t0 === null ? "–" : fmtClock(p.t0)) + "–" + (p.t1 === null ? "–" : fmtClock(p.t1)) }), h("td", { text: p.score === null ? "–" : String(p.score) }), h("td", { text: p.confidence === null ? "–" : String(p.confidence) }), h("td", { text: p.source || "–" })))))));
  if (have) return { state: "present", reason: null, node: h("div", {}, blocks) };
  // missing: bad shape, the jev layer's own error, then the C4 reason; the stage line says whether the Jev step ran
  const ls = c.layerStatus && c.layerStatus.jev, gap = c4Gap(c), stage = c.stages && c.stages.jev;
  const stageLine = stage && stage.state === "failed" ? "The Jev step failed" + (stage.reason ? ": " + stage.reason : ".") : stage && stage.state === "missing" ? "The Jev step has not run for this consult." : null;
  let reason, node;
  if (c.jevBad) { reason = "bad_shape"; node = na("No Jev decisions for this consult", [C4_COPY.bad_shape, stageLine].filter(Boolean).map(sentence).join(" ")); }
  else if (ls && ls.status === "error") { reason = ls.code || "error"; node = layerNa(c, "jev", "Jev decisions", "No decision log is wired in for this consult yet."); }
  else if (gap) { reason = gap; node = na("No Jev decisions for this consult", [c4Copy(gap, 6), stageLine].filter(Boolean).map(sentence).join(" ")); }
  else {
    // C4 is readable: a null (or missing) jev column is "not populated"; a column with no sets in it is "absent"
    const col = c.c4 && c.c4.state === "ok" && c.c4.data ? c.c4.data.jev : undefined;
    reason = col === undefined || col === null ? "c4_null" : "absent";
    node = na("No Jev decisions for this consult", [c4Copy(reason, 6), stageLine].filter(Boolean).map(sentence).join(" "));
  }
  return { state: "missing", reason, node: h("div", {}, node, blocks) };
}

// ---------------------------------------------------------------- 7 clef / timbre affect
function renderClef(c) {
  const gap = c4Gap(c);
  if (gap) return { state: "missing", reason: gap, node: na("Clef / Timbre affect", c4Copy(gap, 7), gap === "c4_error" ? "error" : null) };
  const col = c.c4.data && "clef_affect" in c.c4.data ? c.c4.data.clef_affect : null;
  if (col === null || col === undefined) return { state: "missing", reason: "c4_null", node: na("Clef / Timbre affect", c4Copy("c4_null", 7)) };
  const lanes = clefLanesIn(col);
  if (lanes === null) return { state: "missing", reason: "bad_shape", node: na("Clef / Timbre affect", c4Copy("bad_shape", 7)) };
  if (!lanes.length) return { state: "missing", reason: "absent", node: na("Clef / Timbre affect", "No lanes are stored for this consult.") };
  const node = h("div", {}, h("p", { class: "status", text: "Raw scores. The calibrated 1-5 column is display-only and is not built yet." }),
    lanes.map(l => h("div", { class: "lane" },
      h("div", { class: "lane-head" }, h("b", { text: "Lane " }), tok(l.lane), " ", h("span", { class: "muted", text: "model" }), " ", tok(l.model_rev), " ", h("span", { class: "muted", text: "at" }), " ", h("span", { class: "mono", text: l.at ? istStamp(l.at) : "–" })),
      scroll(h("table", { class: "lane-table" }, th(["Score", { t: "Raw", cls: "num" }, "Calibrated 1-5"]),
        h("tbody", {}, l.scores.length ? l.scores.map(([k, v]) => h("tr", {}, h("td", {}, tok(k)), h("td", { class: "num", text: v.toFixed(2) }), h("td", {}, slotChip("notbuilt")))) : [h("tr", {}, h("td", { colspan: 3, text: "No scores in this lane." }))]))))));
  return { state: "present", reason: null, node };
}

// ---------------------------------------------------------------- 8 presence / extension / Start Consult
const signedS = ms => (ms >= 0 ? "+" : "−") + (Math.abs(ms) / 1000).toFixed(1) + " s";
const hms = ms => (typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) < 8.6e15 ? new Date(ms + 19800000).toISOString().slice(11, 19) + " IST" : "–");
function renderPresence(c) {
  const gap = c4Gap(c);
  const NB = h("div", { class: "kv-rows", id: "presence-future" },
    [["Extension events", "extension"], ["Start Consult events", "start_consult"], ["consult_uid link status", "link_status"]].map(([t, id]) => h("div", { class: "row", "data-row": id }, h("span", { class: "k", text: t }), h("span", { class: "v" }, slotChip("notbuilt")))));
  if (gap) return { state: "missing", reason: gap, node: h("div", {}, na("Presence", c4Copy(gap, 8), gap === "c4_error" ? "error" : null), NB) };
  const col = c.c4.data && "presence" in c.c4.data ? c.c4.data.presence : null;
  if (col === null || col === undefined) return { state: "missing", reason: "c4_null", node: h("div", {}, na("Presence", c4Copy("c4_null", 8)), NB) };
  const p = presenceIn(col);
  if (p === null) return { state: "missing", reason: "bad_shape", node: h("div", {}, na("Presence", c4Copy("bad_shape", 8)), NB) };
  const off = (v, ref) => (v !== null && typeof ref === "number" ? " (" + signedS(v - ref) + " vs consult " + (ref === c.t_open ? "start" : "end") + ")" : "");
  const node = h("div", {},
    h("div", { class: "kv-rows", id: "presence" },
      h("div", { class: "row" }, h("span", { class: "k", text: "encounter_open" }), h("span", { class: "v mono", text: (p.encounter_open === null ? "–" : hms(p.encounter_open)) + off(p.encounter_open, c.t_open) })),
      h("div", { class: "row" }, h("span", { class: "k", text: "encounter_close" }), h("span", { class: "v mono", text: (p.encounter_close === null ? "–" : hms(p.encounter_close)) + off(p.encounter_close, c.t_close) })),
      h("div", { class: "row" }, h("span", { class: "k", text: "boundary_source" }), h("span", { class: "v" }, tok(p.boundary_source))),
      h("div", { class: "row" }, h("span", { class: "k", text: "close_reason" }), h("span", { class: "v" }, tok(p.close_reason)))),
    NB);
  return { state: "present", reason: null, node };
}

// ---------------------------------------------------------------- 9 voice ID, 10 meta-topics
const NOT_BUILT_9 = "Voice ID (matched clinician centroid, cosine, centroid set) arrives with the narrative layer, about 24 Oct.";
const NOT_BUILT_10 = "The meta-topic timeline arrives with the narrative layer, about 24 Oct.";
function renderVoice(c) {
  const v = c.narrative && c.narrative.voice_id;   // mockup only: the live adapter never sets c.narrative
  if (!v || !Array.isArray(v.speakers)) return { state: "notbuilt", reason: null, node: na("Voice ID: not yet built", NOT_BUILT_9) };
  const node = h("div", {}, h("p", {}, mockBadge()),
    h("div", { class: "chips" }, h("span", { class: "muted", text: "mode" }), tok(v.mode), h("span", { class: "muted", text: "expected" }), tok(v.expected && v.expected.pulse_doctor_uid8), h("span", { class: "muted", text: "model" }), tok(v.model && v.model.embedder)),
    scroll(h("table", { id: "voice-table" }, th(["Speaker", { t: "Speech s", cls: "num" }, "Best", "Set", { t: "Cosine", cls: "num" }, { t: "Margin", cls: "num" }, "Decision", "Abstain reason"]),
      h("tbody", {}, v.speakers.map(s => h("tr", {}, h("td", {}, tok(s.spk)), h("td", { class: "num", text: typeof s.speech_s === "number" ? String(s.speech_s) : "–" }), h("td", {}, tok(s.best && s.best.pulse_doctor_uid8)), h("td", {}, tok(s.best && s.best.set)),
        h("td", { class: "num", text: s.best && typeof s.best.cosine === "number" ? s.best.cosine.toFixed(2) : "–" }), h("td", { class: "num", text: typeof s.margin === "number" ? s.margin.toFixed(2) : "–" }), h("td", {}, tok(s.decision)), h("td", {}, tok(s.abstain_reason))))))),
    v.early ? h("p", { class: "status", text: "Early match: " + (typeof v.early.t_ms_to_first_match === "number" ? (v.early.t_ms_to_first_match / 1000).toFixed(0) + " s" : "–") + " to " + (v.early.pulse_doctor_uid8 || "–") }) : null);
  return { state: "present", reason: null, node };
}
function renderTopics(c) {
  const t = c.narrative && c.narrative.topics;
  if (!t || !Array.isArray(t.segments)) return { state: "notbuilt", reason: null, node: na("Meta-topics: not yet built", NOT_BUILT_10) };
  const o = typeof c.t_open === "number" ? c.t_open : t.segments.length ? Math.min(...t.segments.map(s => s.t0_ms)) : 0;   // the clock origin: the consult start (tape_utc ms)
  const node = h("div", {}, h("p", {}, mockBadge()),
    scroll(h("table", { id: "topics-table" }, th(["From–to", "Topic", { t: "Conf", cls: "num" }, "Speakers", "Source"]),
      h("tbody", {}, t.segments.map(s => h("tr", {}, h("td", { class: "mono", text: fmtClock((s.t0_ms - o) / 1000) + "–" + fmtClock((s.t1_ms - o) / 1000) }), h("td", {}, tok(s.topic)), h("td", { class: "num", text: typeof s.conf === "number" ? s.conf.toFixed(2) : "–" }), h("td", {}, (s.speakers || []).map(x => tok(x))), h("td", {}, tok(s.source))))))));
  return { state: "present", reason: null, node };
}

// ---------------------------------------------------------------- 11 notes
function renderNotes(c, env) {
  return { state: env.dbOk ? "present" : "missing", reason: env.dbOk ? null : "db_unavailable", node: env.notesNode };
}

export const LAYERS = [
  { id: "header", n: 1, title: "Header", render: renderHeader },
  { id: "audio", n: 2, title: "Audio and turn timeline", render: renderAudio },
  { id: "transcript", n: 3, title: "Transcript", render: renderTranscript },
  { id: "ledger", n: 4, title: "Processing ledger", render: renderLedger },
  { id: "note", n: 5, title: "FreeScript note and round score", render: renderNote },
  { id: "jev", n: 6, title: "Jev", render: renderJev },
  { id: "clef", n: 7, title: "Clef / Timbre affect", render: renderClef },
  { id: "presence", n: 8, title: "Presence, extension, Start Consult", render: renderPresence },
  { id: "voice", n: 9, title: "Voice ID", render: renderVoice },
  { id: "topics", n: 10, title: "Meta-topics", render: renderTopics },
  { id: "notes", n: 11, title: "V's notes", render: renderNotes },
];

/** Render the slot with its heading and state chip. Always returns a card, whatever the data. A render that throws becomes missing / render_error (never a hole). */
export function renderSlot(slot, c, env) {
  let r;
  try { r = slot.render(c, env); } catch { r = { state: "missing", reason: "render_error", node: na(slot.title + " could not be drawn", "Something in this consult's data was not in the expected shape.", "error") }; }
  const state = r.state === "present" || r.state === "notbuilt" ? r.state : "missing";
  const reason = state === "missing" ? (typeof r.reason === "string" && r.reason ? r.reason : "unknown") : null;
  const card = h("section", { class: "card slot", id: "layer-" + slot.n, "data-slot": slot.n, "data-state": state, "data-reason": reason }, h("div", { class: "slot-head" }, h("h2", { text: slot.n + ". " + slot.title }), slotChip(state, reason)), r.node);
  return { ...r, state, reason, card };
}

/** The jump index: 11 chips with their states, linking to bare #layer-N anchors. */
export function jumpIndex(results, onJump) {
  return h("nav", { class: "jump", "aria-label": "Layers" }, results.map((r, i) => h("a", { class: "chip jump-chip s-" + (r.state === "present" ? "done" : r.state === "notbuilt" ? "na" : "missing"), href: "#layer-" + (i + 1), "data-n": i + 1, "data-state": r.state, onclick: e => { e.preventDefault(); onJump(i + 1); } },
    h("b", { text: String(i + 1) }), " ", r.state === "present" ? "present" : r.state === "notbuilt" ? "not yet built" : r.reason)));
}
