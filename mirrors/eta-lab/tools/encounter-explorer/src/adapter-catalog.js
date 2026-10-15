// Implementation over the encounter catalog tool: ONE Scribe MCP tool, scribe_catalog, action = search | get | clip_audio_chunk.
// Contract: scribe-mcp REPORT-CATALOG-1..6 (shapes as built) and ORDER-CATALOG-7 (audio bytes in chunks). Parsing is defensive:
// unknown or missing -> null, never throws into the UI. The catalog carries no prescription content: the Rx panel shows ids, state and the Pulse link.
import { buildDays, listFor } from "./days.js";
import { buildPulseLink } from "./pulse.js";
import { makeCall, makeCtx, settle, withCtx } from "./mcp-call.js";
import { arr, datesBetween, firstGap, get, isObj, num, str, stateOfStatus } from "./util.js";

export const CATALOG_TOOLS = ["scribe_catalog"];
export const CATALOG_ACTIONS = ["search", "get", "clip_audio_chunk"];
const TOOL = "scribe_catalog";
const CAT_LIMIT = 200, CAT_MAX_PAGES = 40, ROWS_TTL = 60000;
const PULSE_PREFIX = "https://pulse.even.in/";
const CHUNK = 524288, MAX_AUDIO_BYTES = 64 * 1048576, MAX_CHUNKS = 128, RX_WINDOW_DAYS = 31;
const CATALOG_UID = /^[A-Za-z0-9_-]{6,64}$/;
export const validCatalogUid = u => typeof u === "string" && CATALOG_UID.test(u);
const LAYER_KEYS = ["transcript", "parts", "freescript", "rubric", "jev", "identity", "cdmss", "rx"];
/** search rows name the track layers (stt, translate, role, ...); get names the panels. The three transcript tracks are one panel. */
const LAYER_TO_PANEL = { stt: "transcript", translate: "transcript", role: "transcript", parts: "parts" };   // diar_* have no panel: dropped

/** Catalog stage state words -> the chip states. Unknown words are "pending", never "done". */
export function catalogState(s) {
  const k = typeof s === "string" ? s.toLowerCase() : "";
  if (["missing", "absent", "none"].includes(k)) return "missing";
  if (["na", "n/a", "not_available", "unknown"].includes(k)) return "na";
  return stateOfStatus(s);
}
const idStr = v => str(v) ?? (num(v) !== null ? String(v) : null);   // freescript artifact_id is the run id, a number
const sourceStr = v => (Array.isArray(v) ? v.filter(x => typeof x === "string" && x).join("; ") || null : str(v));   // layers.*.source is an array of strings

function normLayerRef(v) { return isObj(v) ? { r2_key: str(v.r2_key), status: str(v.status), engine: str(v.engine) } : null; }

/** One catalog row (a search row or the get row) in the normalised ConsultSummary shape. */
export function normRow(r) {
  if (!isObj(r) || !str(r.consult_uid)) return null;
  const stages = {};
  if (isObj(r.stages)) for (const [k, v] of Object.entries(r.stages)) stages[k] = isObj(v) ? { state: catalogState(v.state), reason: str(v.reason) } : { state: catalogState(v), reason: null };
  const clip = isObj(r.clip) ? { r2_key: str(r.clip.r2_key), r2_status: str(r.clip.r2_status), signature_sha256: str(r.clip.signature_sha256), audio_sha256: str(r.clip.audio_sha256), bytes: num(r.clip.bytes), minutes: num(r.clip.minutes) } : null;
  const tOpen = num(r.t_open), tClose = num(r.t_close);
  const layers = isObj(r.layers) ? Object.fromEntries(["stt", "translate", "diar_sarvam", "diar_nemotron", "role", "parts"].map(k => [k, normLayerRef(r.layers[k])])) : null;
  const idn = isObj(r.identity) ? r.identity : {};
  const rxUid = str(r.prescription_uid) || str(idn.prescription_uid) || str(get(r, "prescription", "prescription_uid"));
  return {
    consult_uid: r.consult_uid, ist_date: str(r.ist_date), doctor_uid: str(r.doctor_uid), room_id: str(r.room_id), t_open: tOpen, t_close: tClose,
    source: r.source === "cutter" || r.source === "caa" ? r.source : null, clip, layers,
    layers_present: [...new Set(arr(r.layers_present).filter(x => typeof x === "string").map(x => LAYER_TO_PANEL[x]).filter(Boolean))],
    freescript: isObj(r.freescript) ? { artifact_id: idStr(r.freescript.artifact_id), state: str(r.freescript.state) } : null,
    stages, first_gap: str(r.first_gap) || firstGap(stages),
    allowance: isObj(r.allowance) ? { earned_min: num(r.allowance.earned_min), spent_min: num(r.allowance.spent_min) } : null,
    prescription: rxUid ? { prescription_uid: rxUid, presc_state: str(idn.presc_state) || str(get(r, "prescription", "presc_state")) } : null,
    has_prescription: typeof r.has_prescription === "boolean" ? r.has_prescription : null,   // null = no joined row yet: unknown, never "no Rx"
    doctor_name: str(r.doctor_name) || str(idn.doctor_name), patient_name: str(r.patient_name) || str(idn.patient_name),
    individual_uid: str(r.individual_uid) || str(idn.individual_uid), prescription_uid: rxUid,
    catalog_version: num(r.catalog_version), generated_at: str(r.generated_at),
    specialty: str(r.specialty), headline: [],
    lengthSec: clip && clip.minutes !== null ? Math.round(clip.minutes * 60) : tOpen !== null && tClose !== null && tClose >= tOpen ? Math.round((tClose - tOpen) / 1000) : null,
  };
}

/** Jev probability: the calibrated one when stored, else the raw one (`probabilities`, a map of answer -> p; older/mock rows may carry p_yes). */
export function jevProbability(d) {
  const cal = num(d.calibrated_p) === null ? null : scale(d.calibrated_p);
  if (cal !== null) return { p: cal, kind: "calibrated" };   // an out-of-range value is not a probability: fall through to the raw one
  const pr = d.probabilities;
  if (isObj(pr)) {
    const a = typeof d.answer === "string" ? d.answer : null;
    const v = a !== null && num(pr[a]) !== null ? pr[a] : num(pr.yes) !== null ? pr.yes : Math.max(...Object.values(pr).map(num).filter(x => x !== null), -1);
    if (num(v) !== null && v >= 0) return { p: scale(v), kind: "raw" };
  }
  const old = [d.p_yes, d.probability, d.p].map(num).find(x => x !== null);
  return old === undefined ? { p: null, kind: null } : { p: scale(old), kind: "raw" };
}
const scale = p => (p >= 0 && p <= 1 ? p : p > 1 && p <= 100 ? p / 100 : null);

const isRxFilterRefusal = e => isObj(e) && e.code === "bad_args" && /has_rx|has_prescription|arrives with/i.test(String(e.message || ""));

function decodeBase64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param caps {{mcp:any, includeText?:boolean, includeIdentity?:boolean, now?:()=>number}} */
/** sha256 of the assembled clip against the catalog's audio_sha256 (chunk answer if it carries one, else the row's clip.audio_sha256). Never throws; never blocks playback. */
async function checksumOf(parts, expected) {
  const want = typeof expected === "string" && /^[0-9a-f]{64}$/i.test(expected.trim()) ? expected.trim().toLowerCase() : null;
  if (!want) return { state: "no_catalog_checksum" };
  try {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", all));
    const got = [...d].map(b => b.toString(16).padStart(2, "0")).join("");
    return { state: got === want ? "match" : "mismatch" };
  } catch { return { state: "no_catalog_checksum", note: "digest unavailable" }; }
}

export function createCatalogImpl(caps = {}) {
  const { mcp } = caps, includeText = caps.includeText !== false, now = caps.now || (() => Date.now());
  const call = makeCall(mcp);
  const rowsCache = new Map();
  const clipHash = new Map();   // consult_uid -> clip.audio_sha256 from the catalog row (the sha256 of the stored FLAC); signature_sha256 hashes the cut-signature JSON and is never compared
  let identityOk = caps.includeIdentity === false ? false : null;   // null = not tried yet, true = names arrive, false = refused (no admin scope) or unavailable
  let chunkSupport = null;                                         // null = unknown, true/false after the feature check
  const features = { hasRxFilter: true, hasRxMaxDays: RX_WINDOW_DAYS, specialtyFilter: false, names: true, rxContent: false, note: "specialty arrives with a later catalog" };

  const withIdentity = (args, plain) => (identityOk === false || plain ? args : { ...args, include_identity: true });
  /** One catalog call that falls back, once, to a plain read when the identity join or the has-prescription filter is refused. */
  async function callWithFallback(args, refresh, ctx, state, plain) {
    const withId = identityOk !== false && !plain;
    try { return await call(TOOL, withIdentity(args, plain), refresh, ctx); }
    catch (e) {
      // Any non-retryable rejection of a call that carried include_identity: try once without it (never rely on the message text; the runtime's
      // refusal shape is unverified). Identity goes off only if the plain read then works; if it fails too, that error is the real one.
      if (withId && isObj(e) && e.code !== "cancelled" && e.retryable !== true) {
        const r = await callWithFallback(args, refresh, ctx, state, true);
        identityOk = false; features.names = false; state.identityDegraded = true;
        return r;   // has_prescription is read scope: the filter still works without the identity join
      }
      if (args.has_prescription && isRxFilterRefusal(e)) { features.hasRxFilter = false; state.rxFilterIgnored = true; const a = { ...args }; delete a.has_prescription; return callWithFallback(a, refresh, ctx, state); }
      throw e;
    }
  }

  async function searchAll(q, ctx, refresh) {
    const key = [q.from, q.to, q.room || "", q.hasRx ? "rx" : "", identityOk].join("|"), hit = rowsCache.get(key);
    if (hit && !refresh && now() - hit.at < ROWS_TTL) return hit.v;
    const rows = [], ids = new Set(), seen = new Set(), st = { identityDegraded: identityOk === false, rxFilterIgnored: false };
    let cursor = null, storedAt = null, truncated = false, total = null, generatedAt = null, blind = 0, identityRows = null, defaultWindow = false;
    for (let p = 0; ; p++) {
      if (p >= CAT_MAX_PAGES) { truncated = true; break; }
      const args = { action: "search", from: q.from, to: q.to, limit: CAT_LIMIT }; if (q.room) args.room = q.room; if (q.hasRx && features.hasRxFilter) args.has_prescription = true; if (cursor !== null) args.cursor = cursor;
      const { data, storedAt: s } = await callWithFallback(args, refresh, ctx, st);
      if (s !== null) storedAt = storedAt === null ? s : Math.min(storedAt, s);
      for (const r of arr(get(data, "rows"))) { const n = normRow(r); if (n) clipHash.set(n.consult_uid, n.clip && n.clip.audio_sha256); if (n && !ids.has(n.consult_uid)) { ids.add(n.consult_uid); rows.push(n); } }
      total = num(get(data, "total_matched")) ?? total; generatedAt = str(get(data, "catalog_generated_at")) || generatedAt; blind = Math.max(blind, num(get(data, "n_blind_excluded")) || 0);
      identityRows = num(get(data, "identity_rows")) ?? identityRows; defaultWindow = defaultWindow || get(data, "default_window") === true;
      if (get(data, "identity_error") === true) st.identityDegraded = true;
      const nc = get(data, "next_cursor");
      if (nc === null || nc === undefined || nc === "") break;
      // an opaque offset: one that repeats means the server is looping
      if (nc === cursor || seen.has(nc)) { truncated = true; break; }
      seen.add(nc); cursor = nc;
    }
    if (total !== null && rows.length < total && !truncated) truncated = true;
    const v = { rows, storedAt, truncated, generatedAt, blind, identityRows, defaultWindow, ...st };
    rowsCache.set(key, { at: now(), v });
    return v;
  }

  const layerOf = (layers, k) => {
    const l = isObj(layers) ? layers[k] : null;
    if (!isObj(l)) return { status: "not_available", source: null, code: null, data: null, nClamped: null };
    const status = ["ok", "absent", "not_available", "error"].includes(l.status) ? l.status : "error";
    return { status, source: sourceStr(l.source), code: str(l.error) || str(l.code) || (status === "error" && !["ok", "absent", "not_available"].includes(l.status) ? "unknown_status" : null), data: status === "ok" ? l.data ?? null : null, nClamped: num(l.n_clamped) };
  };

  function transcriptOf(L, row) {
    const d = L.data;
    if (L.status !== "ok" || !isObj(d)) return { lines: null, status: L, meta: null };
    // segment times are offsets from the clip start (the audio the page plays); a clock other than that is shifted by t_open when it looks like epoch
    const clipClock = d.clock === "ms_from_clip_start", dur = num(d.duration_ms);
    const toS = ms => (ms === null ? null : clipClock || ms < 1e11 ? ms / 1000 : row.t_open !== null ? (ms - row.t_open) / 1000 : null);
    const lines = [];
    arr(d.segments).forEach((sg, k) => {
      if (!isObj(sg)) return;
      let t0 = toS(num(sg.t0_ms)), t1 = toS(num(sg.t1_ms));
      if (t0 === null) return;
      t0 = Math.max(0, t0); if (t1 === null || t1 < t0) t1 = t0;
      if (dur !== null) { t0 = Math.min(t0, dur / 1000); t1 = Math.min(t1, dur / 1000); }
      const en = str(sg.text_en), nat = str(sg.text_native);
      lines.push({ id: "l" + (num(sg.i) ?? k), t0, t1, speaker: str(sg.speaker), role: str(sg.role), lang: str(sg.lang), text: nat || en, textEn: en });
    });
    lines.sort((a, b) => a.t0 - b.t0);
    const sp = isObj(d.consult_span_ms) ? d.consult_span_ms : null, s0 = sp ? num(sp.t0) : null, s1 = sp ? num(sp.t1) : null;
    const meta = {
      span: s0 !== null && s1 !== null && s1 >= s0 ? { t0: Math.max(0, s0 / 1000), t1: dur !== null ? Math.min(s1, dur) / 1000 : s1 / 1000 } : null,
      degraded: arr(d.degraded).filter(x => typeof x === "string"), nClamped: num(d.n_clamped), manifestT0Ms: num(d.manifest_t0_ms), durationS: dur === null ? null : dur / 1000,
    };
    if (!lines.some(l => l.text)) return { lines: null, status: { ...L, status: "not_available", source: "transcript text not included in this read" }, meta };
    return { lines, status: L, meta };
  }

  function noteOf(L) {
    if (L.status !== "ok" || !isObj(L.data)) return null;
    const d = L.data, art = isObj(d.artifact) ? d.artifact : {};
    const vsRaw = d.validator_status, vs = typeof vsRaw === "string" ? vsRaw.toLowerCase() : null;
    const vok = isObj(vsRaw) ? (typeof vsRaw.ok === "boolean" ? vsRaw.ok : null) : vs === null ? (typeof get(art, "validator", "ok") === "boolean" ? art.validator.ok : null) : /^(ok|pass|passed)$/.test(vs) ? true : /^(fail|failed|error|errors)$/.test(vs) ? false : null;
    const errs = isObj(vsRaw) ? arr(vsRaw.errors) : arr(get(art, "validator", "errors"));
    return {
      noteText: str(art.note_text),
      validator: { ok: vok, errors: errs.map(e => (typeof e === "string" ? e : JSON.stringify(e))) },
      completionRequired: arr(art.completion_required).filter(isObj).map(c => ({ kind: str(c.kind), detail: str(c.detail), prompt: str(c.prompt) })),
      model: str(get(art, "generator", "model")), version: str(get(art, "generator", "version")),
    };
  }

  // rubric score holds numbers/booleans only; verdict is a short code or null
  const rubricsOf = L => (L.status !== "ok" ? [] : arr(L.data).filter(isObj).map(r => ({
    id: str(r.rubric_id) || "rubric", version: str(r.version), status: str(r.status),
    score: isObj(r.score) ? r.score : num(r.score) !== null ? { score: r.score } : null, findings: str(r.verdict) ? [r.verdict] : [], createdAt: str(r.created_at) })));

  const jevOf = L => (L.status !== "ok" ? null : arr(L.data).filter(isObj).map(d => {
    const { p, kind } = jevProbability(d), a = d.answer;
    return { question: str(d.question_id) || "?", answer: a === null || a === undefined ? null : String(typeof a === "object" ? JSON.stringify(a) : a), probability: p, probabilityKind: kind, mock: d.mock === true, createdAt: str(d.created_at), raw: d };
  }));

  const latest = rows => rows.map(r => r.createdAt).filter(Boolean).sort().at(-1) || null;
  /** N14: a ledger row carries a time only when its layer has one of its own; the catalog build time is not a step time. */
  function ledgerOf(row, layerStatus, times) {
    const out = [];
    for (const [k, st] of Object.entries(row.stages)) out.push({ step: k, at: null, model: null, version: null, outcome: st.state, reason: st.reason });
    for (const [k, l] of Object.entries(layerStatus)) out.push({ step: "layer: " + k, at: times[k] || null, model: null, version: null, outcome: l.status, reason: [l.source ? "source: " + l.source : null, l.code].filter(Boolean).join(" ") || null });
    return out;
  }

  async function getRaw(uid, ctx) {
    const args = { action: "get", consult_uid: uid, include_text: includeText };
    const st = { identityDegraded: false };
    return { ...(await callWithFallback(args, false, ctx, st)), st };
  }

  return {
    features,
    async defaultRange() { const t = new Date(now()).toISOString().slice(0, 10); return { from: new Date(now() - 29 * 86400000).toISOString().slice(0, 10), to: t }; },

    listDays: withCtx(async (ctx, q) => {
      const dates = datesBetween(q.from, q.to, 92);
      if (q.hasRx && features.hasRxFilter && dates.length > RX_WINDOW_DAYS) throw { code: "bad_args", message: "The has-prescription filter spans at most " + RX_WINDOW_DAYS + " days. Narrow the date range.", retryable: false };
      const r = await searchAll({ from: q.from, to: dates[dates.length - 1] || q.to, room: q.room, hasRx: !!q.hasRx }, ctx, q.refresh);
      const days = buildDays(r.rows, { ...q, hasRx: false, specialty: null }, r.truncated);   // the server did the has-prescription filtering; specialty is not in the catalog
      Object.assign(days, { generatedAt: r.generatedAt, blindExcluded: r.blind, defaultWindow: r.defaultWindow, identityRows: r.identityRows, identityDegraded: r.identityDegraded, rxFilterIgnored: r.rxFilterIgnored });
      return { ok: true, data: days, storedAt: r.storedAt };
    }),

    listConsults: withCtx(async (ctx, { doctorId, date }) => {
      const r = await searchAll({ from: date, to: date }, ctx);
      return { ok: true, data: listFor(r.rows, doctorId, date), storedAt: r.storedAt };
    }),

    getConsult: withCtx(async (ctx, uid) => {
      if (!validCatalogUid(uid)) throw { code: "not_found", message: "not a valid consult uid", retryable: false };
      const { data, storedAt, st } = await getRaw(uid, ctx);
      const row = normRow(get(data, "row"));
      if (row) clipHash.set(row.consult_uid, row.clip && row.clip.audio_sha256);
      if (!row) throw { code: "not_found", message: "the catalog returned no row", retryable: false };
      const raw = isObj(get(data, "layers")) ? data.layers : {};
      const L = Object.fromEntries(LAYER_KEYS.map(k => [k, layerOf(raw, k)]));
      const tr = transcriptOf(L.transcript, row);
      if (tr.status !== L.transcript) L.transcript = tr.status;
      const rubrics = rubricsOf(L.rubric), jev = jevOf(L.jev);
      const layerStatus = Object.fromEntries(LAYER_KEYS.filter(k => k !== "identity").map(k => [k, { status: L[k].status, source: L[k].source, code: L[k].code }]));
      const idd = L.identity.status === "ok" && isObj(L.identity.data) && !("present" in L.identity.data) ? L.identity.data : null;
      const rxd = L.rx.status === "ok" && isObj(L.rx.data) ? L.rx.data : null;
      const prUid = str(get(rxd, "prescription_uid")) || str(get(idd, "prescription_uid")) || row.prescription_uid;
      const indUid = str(get(idd, "individual_uid")) || row.individual_uid;
      const pulse = [str(get(rxd, "pulse_url")), str(get(idd, "pulse_url"))].find(u => u && u.startsWith(PULSE_PREFIX)) || null;   // an href from data is only trusted on the Pulse host
      const times = { rubric: latest(rubrics), jev: jev ? jev.map(j => j.createdAt).filter(Boolean).sort().at(-1) || null : null };
      const detail = {
        ...row,
        doctor_name: str(get(idd, "doctor_name")) || row.doctor_name, patient_name: str(get(idd, "patient_name")) || row.patient_name, individual_uid: indUid, prescription_uid: prUid,
        stages: { ...row.stages }, first_gap: row.first_gap, layerStatus, transcript: tr.lines, transcriptMeta: tr.meta, ledger: ledgerOf(row, layerStatus, times),
        note: noteOf(L.freescript),
        pdqi: rubrics.find(r => /pdqi/i.test(r.id)) || null, rubrics: rubrics.filter(r => !/pdqi/i.test(r.id)),
        jev, jevError: null,
        cdmss: L.cdmss.status === "ok" && Array.isArray(L.cdmss.data) ? L.cdmss.data.filter(isObj).map(f => ({ severity: str(f.severity), finding: str(f.finding) || "finding", detail: str(f.detail) })) : null,
        parts: L.parts.status === "ok" ? arr(L.parts.data).filter(isObj).map(p => ({ part: str(p.part) || "?", t0: num(p.t0_ms) === null ? null : p.t0_ms / 1000, t1: num(p.t1_ms) === null ? null : p.t1_ms / 1000, score: num(p.score), confidence: num(p.confidence), source: str(p.source) })) : null,
        partsClamped: L.parts.nClamped,
        // the catalog does not copy prescription content: ids, state and the Pulse link only (never build the link when the tool sent one)
        rx: prUid || indUid || rxd ? { prescriptionUid: prUid, individualUid: indUid, prescState: str(get(rxd, "presc_state")) || str(get(idd, "presc_state")), hasPrescription: typeof get(rxd, "has_prescription") === "boolean" ? rxd.has_prescription : null,
          signedText: null, link: pulse || buildPulseLink(prUid, indUid), linkFromTool: !!pulse } : null,
        identityDegraded: st.identityDegraded,
      };
      if (jev && jev.length && !(detail.stages.jev && detail.stages.jev.state === "done")) detail.stages = { ...detail.stages, jev: { state: "done", reason: null } };
      return { ok: true, data: detail, storedAt };
    }),

    /** Is the chunk action in the tool's schema? An mcp without describeTool answers "unknown": the first real chunk call then decides. */
    async audioSupported() {
      if (chunkSupport !== null) return chunkSupport;
      if (mcp && typeof mcp.describeTool === "function") {
        try {
          const d = await mcp.describeTool("Scribe MCP", TOOL);
          const en = get(d, "inputSchema", "properties", "action", "enum");
          if (Array.isArray(en)) return (chunkSupport = en.includes("clip_audio_chunk"));
        } catch { /* fall through to the first real call */ }
      }
      return null;
    },

    /**
     * The clip as a Blob, fetched in sequential chunks (the artifact CSP blocks any media from another host, so there is no URL to play).
     * Bounded (size cap, chunk cap), abortable (opts.signal), with progress (opts.onProgress({loaded,total})).
     * Result data: {blob, bytes, minutes, audio_sha256, checksum, contentType}; never a URL.
     */
    async getAudio(uid, opts = {}) {
      if (!validCatalogUid(uid)) throw { code: "not_found", message: "not a valid consult uid", retryable: false };
      if ((await this.audioSupported()) === false) throw { code: "audio_unsupported", message: "this catalog build has no audio action", retryable: false };
      const ctx = makeCtx(), parts = []; let offset = 0, total = null, type = null, sig = null;
      try {
        for (let i = 0; ; i++) {
          if (opts.signal && opts.signal.aborted) throw { code: "cancelled", message: "audio load cancelled", retryable: false };
          if (i >= MAX_CHUNKS) throw { code: "audio_too_large", message: "audio needs too many chunks", retryable: false };
          let res;
          try { res = await call(TOOL, { action: "clip_audio_chunk", consult_uid: uid, offset, length: CHUNK }, false, ctx, { cache: false, signal: opts.signal }); }
          catch (e) {
            // Only the action itself being unknown means "not available yet", and never once the schema (or an earlier chunk) confirmed it.
            // A generic tool_error / not_in_manifest / read_failed etc. is a real error and never persists the NA state.
            if (i === 0 && chunkSupport !== true && isObj(e) && (e.code === "unknown_action" || (e.code === "bad_args" && /clip_audio_chunk|unknown action|action/i.test(String(e.message || ""))))) { chunkSupport = false; throw { code: "audio_unsupported", message: "this catalog build has no audio action", retryable: false }; }
            throw e;
          }
          const d = res.data;
          const len = num(get(d, "length")), b64 = get(d, "base64"), tot = num(get(d, "total_bytes"));
          if (i === 0) { chunkSupport = true; type = str(get(d, "content_type")) || "audio/flac"; sig = str(get(d, "audio_sha256")) || clipHash.get(uid) || null; }
          if (tot === null || tot <= 0 || len === null || len <= 0 || typeof b64 !== "string" || num(get(d, "offset")) !== offset) throw { code: "bad_chunk", message: "the audio chunk was malformed", retryable: false };
          if (total !== null && tot !== total) throw { code: "bad_chunk", message: "the audio size changed while loading", retryable: false };
          total = tot;
          if (total > MAX_AUDIO_BYTES) throw { code: "audio_too_large", message: "the clip is larger than the page will load (" + Math.round(total / 1048576) + " MB)", retryable: false };
          const bytes = decodeBase64(b64);
          if (len > CHUNK || bytes.length !== len) throw { code: "bad_chunk", message: "the audio chunk length did not match", retryable: false };
          parts.push(bytes); offset += len;
          if (opts.onProgress) { try { opts.onProgress({ loaded: offset, total }); } catch { /* progress is cosmetic */ } }
          if (get(d, "done") === true || offset >= total) break;
        }
      } finally { settle(ctx); }
      if (offset !== total) throw { code: "bad_chunk", message: "the audio was incomplete", retryable: false };
      const blob = new Blob(parts, { type });
      return { ok: true, data: { blob, bytes: total, minutes: null, audio_sha256: sig, contentType: type, checksum: await checksumOf(parts, sig) }, storedAt: null };
    },
    async getAudioUrl() { return null; },   // no URL ever: the page plays from a Blob it assembled
  };
}
