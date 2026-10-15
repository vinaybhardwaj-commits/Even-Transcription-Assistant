// Implementation over the CURRENT Scribe MCP tools. Parsing is defensive: unknown or missing -> null, never throws into the UI.
import { buildDays, listFor } from "./days.js";
import { buildPulseLink } from "./pulse.js";
import { MIN_DATE } from "./types.js";
import { makeCall, withCtx } from "./mcp-call.js";
import { arr, datesBetween, firstGap, get, isObj, istDateOf, num, str, stateOfStatus, toEpochMs, uidOfUnitKey } from "./util.js";

export const TOOLS = ["scribe_reb_index", "scribe_freescript", "scribe_rubric", "scribe_jev_decisions", "scribe_list_encounters", "scribe_encounter", "scribe_stt_runs"];
/** A consult uid goes into a db path (notes/<uid>), so it must be one plain segment. */
export const validUid = u => typeof u === "string" && /^[A-Za-z0-9_-]+$/.test(u);
const PAGE = 1000, MAX_PAGES = 20, DAY_TTL = 60000;

/** @param caps {{mcp:any, db?:any, userId?:()=>Promise<string|null>}} */
export function createCurrentImpl(caps = {}) {
  const { mcp, db, userId } = caps;
  const dayCache = new Map(), rubCache = new Map();
  const uidDate = new Map();

  const call = makeCall(mcp);

  async function rebPaged(date, refresh, ctx) {
    const rows = [], ids = new Set(), seen = new Set(); let cursor = null, storedAt = null;
    for (let p = 0; p < MAX_PAGES; p++) {
      const args = { ist_date: date, limit: PAGE }; if (cursor !== null) args.cursor = cursor;
      const { data, storedAt: s } = await call("scribe_reb_index", args, refresh, ctx);
      storedAt = minT(storedAt, s);
      for (const r of arr(get(data, "rows")).filter(isObj)) {
        if (str(r.ist_date) && r.ist_date !== date) continue;          // a row stamped with another day is not this day's
        if (r.id !== undefined && r.id !== null) { if (ids.has(r.id)) continue; ids.add(r.id); }
        rows.push(r);
      }
      const nc = get(data, "next_cursor");
      if (nc === null || nc === undefined || nc === "") return { rows, storedAt, truncated: false };
      // the cursor is an increasing integer keyset: one that repeats or goes back means the server is looping
      if (nc === cursor || seen.has(nc) || (typeof nc === "number" && typeof cursor === "number" && nc <= cursor)) return { rows, storedAt, truncated: true };
      seen.add(nc); cursor = nc;
    }
    return { rows, storedAt, truncated: true };
  }
  const isShadow = r => r.shadow === true || r.shadow === "true";
  const minT = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

  async function rubricsFor(from, to, refresh, ctx) {
    const key = from + "|" + to;
    const hit = rubCache.get(key);
    if (hit && !refresh && Date.now() - hit.at < DAY_TTL) return hit.v;
    const { data, storedAt } = await call("scribe_rubric", { action: "results", lab: true, from, to, limit: 200 }, refresh, ctx);
    const rows = arr(get(data, "results")).filter(isObj), by = new Map();
    for (const r of rows) {
      const uid = uidOfUnitKey(get(r, "unit_key")); if (!uid) continue;
      if (!by.has(uid)) by.set(uid, []);
      by.get(uid).push({ id: str(r.rubric_id) || "rubric", version: str(r.version), status: str(r.status), score: isObj(r.score) ? r.score : null, findings: arr(r.findings) });
    }
    const v = { by, storedAt, truncated: rows.length >= 200 };
    rubCache.set(key, { at: Date.now(), v });
    return v;
  }

  async function loadDay(date, refresh, ctx) {
    const hit = dayCache.get(date);
    if (hit && !refresh && Date.now() - hit.at < DAY_TTL) return hit.v;
    const [reb, fs, rub] = await Promise.all([
      rebPaged(date, refresh, ctx),
      call("scribe_freescript", { action: "read", ist_date: date, limit: 50 }, refresh, ctx),
      rubricsFor(date, date, refresh, ctx),
    ]);
    const fsRows = arr(get(fs.data, "rows")).filter(r => isObj(r) && validUid(r.consult_uid) && (str(r.ist_date) === null || r.ist_date === date));
    const byUid = new Map();
    for (const r of reb.rows) {
      const wid = str(get(r, "window_id")); if (!wid || !wid.startsWith("consult-")) continue;
      const uid = wid.slice(8); if (!validUid(uid)) continue;
      if (!byUid.has(uid)) byUid.set(uid, { rows: [], fs: null });
      byUid.get(uid).rows.push(r);
    }
    for (const r of fsRows) { if (!byUid.has(r.consult_uid)) byUid.set(r.consult_uid, { rows: [], fs: null }); byUid.get(r.consult_uid).fs = r; }
    const items = [];
    for (const [uid, g] of byUid) { uidDate.set(uid, date); items.push(summarise(uid, date, g.rows, g.fs, rub.by.get(uid) || [])); }
    const v = {
      items, storedAt: [reb.storedAt, fs.storedAt, rub.storedAt].reduce(minT, null),
      truncated: reb.truncated || rub.truncated || arr(get(fs.data, "rows")).length >= 50,
      raw: byUid,
    };
    dayCache.set(date, { at: Date.now(), v });
    return v;
  }

  function stageOf(rows, layer) {
    const rs = rows.filter(r => get(r, "layer") === layer && !isShadow(r));
    if (!rs.length) return { state: "missing", reason: null };
    const st = rs.map(r => stateOfStatus(get(r, "status")));
    const state = st.includes("done") ? "done" : st.includes("failed") ? "failed" : "pending";
    return { state, reason: state === "done" ? null : str(rs.find(r => str(r.reason))?.reason) };
  }

  function summarise(uid, date, rows, fsr, rubs) {
    const art = isObj(get(fsr, "artifact")) ? fsr.artifact : null;
    const room = str(rows.find(r => str(r.room_id))?.room_id) || str(get(fsr, "room_id")) || str(get(fsr, "room_slug")) || str(get(art, "encounter", "room"));
    const docUid = str(get(art, "encounter", "doctor", "pulse_doctor_uid")) || str(get(fsr, "doctor_uid8"));
    const t0s = rows.map(r => toEpochMs(r.t0_ms, date)).filter(x => x !== null);
    const t1s = rows.map(r => toEpochMs(r.t1_ms, date)).filter(x => x !== null);
    let tOpen = t0s.length ? Math.min(...t0s) : null, tClose = t1s.length ? Math.max(...t1s) : null;
    if (tOpen === null) { const w = Date.parse(str(get(art, "encounter", "window_start")) || ""); if (!Number.isNaN(w)) tOpen = w; }
    if (tClose === null) { const w = Date.parse(str(get(art, "encounter", "window_end")) || ""); if (!Number.isNaN(w)) tClose = w; }
    const rxUid = str(get(fsr, "prescription_uid")) || str(get(art, "pulse_link", "prescription_uid"));
    const vOk = get(fsr, "validator", "ok");
    const fsState = fsr ? (/fail|error/i.test(String(get(fsr, "state"))) ? "failed" : "done") : "missing";
    const nErr = arr(get(fsr, "validator", "errors")).length;
    const stages = {
      stt: stageOf(rows, "stt"), diar: stageOf(rows, "diar"),
      freescript: { state: fsState, reason: fsState === "failed" ? str(get(fsr, "state")) : null },
      validator: fsr ? (vOk === true ? { state: "done", reason: null } : vOk === false ? { state: "failed", reason: nErr + " validator error(s)" } : { state: "pending", reason: null }) : { state: "missing", reason: null },
      rubrics: rubs.length ? (rubs.some(r => stateOfStatus(r.status) === "failed") ? { state: "failed", reason: null } : { state: "done", reason: null }) : { state: "missing", reason: null },
      jev: { state: "na", reason: null }, cdmss: { state: "na", reason: null }, rx: { state: rxUid ? "done" : "missing", reason: null },
    };
    const pd = rubs.find(r => /pdqi/i.test(r.id));
    const headline = [];
    if (fsr) headline.push({ label: "validator", value: vOk === true ? "ok" : vOk === false ? nErr + " err" : "?" });
    const pv = pd && scoreHeadline(pd.score); if (pv !== null && pv !== undefined) headline.push({ label: "PDQI-9", value: String(pv) });
    if (rubs.length) headline.push({ label: "rubrics", value: String(rubs.length) });
    return {
      consult_uid: uid, ist_date: date, doctor_uid: docUid, room_id: room, t_open: tOpen, t_close: tClose,
      source: null, clip: null, layers: null,
      freescript: fsr ? { artifact_id: str(get(art, "artifact_id")), state: str(get(fsr, "state")) } : null,
      stages, first_gap: firstGap(stages), allowance: null,
      prescription: rxUid ? { prescription_uid: rxUid, presc_state: null } : null,
      doctor_name: null, patient_name: null, individual_uid: str(get(art, "pulse_link", "individual_uid")), prescription_uid: rxUid,
      catalog_version: null, generated_at: null,
      specialty: str(get(art, "encounter", "doctor", "specialty")), headline,
      lengthSec: tOpen !== null && tClose !== null && tClose >= tOpen ? Math.round((tClose - tOpen) / 1000) : null,
    };
  }

  function ledgerOf(rows, fsr) {
    const out = rows.map(r => ({
      step: [str(r.layer) || "step", str(r.engine)].filter(Boolean).join(" / ") + (isShadow(r) ? " (shadow)" : ""),
      at: str(r.finished_at) || str(r.started_at) || str(r.indexed_at), model: str(r.model), version: str(r.version),
      outcome: str(r.status), reason: str(r.reason),
    }));
    if (fsr) out.push({ step: "freescript", at: str(fsr.created_at) || str(get(fsr, "artifact", "created_at")), model: str(get(fsr, "generator", "model")) || str(get(fsr, "artifact", "generator", "model")), version: str(get(fsr, "generator", "version")) || str(get(fsr, "artifact", "generator", "version")), outcome: str(fsr.state) || "stored", reason: null });
    return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  function jevOf(data) {
    const pick = (o, ...ks) => { for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k]; return null; };
    return arr(get(data, "decisions")).filter(isObj).map(d => {
      const p = pick(d, "probability", "p", "prob", "confidence");
      const a = pick(d, "answer", "decision", "value", "label");
      const q = pick(d, "question_id", "question", "key", "id");
      const pr = num(p);
      return { question: q === null ? "?" : typeof q === "object" ? JSON.stringify(q) : String(q), answer: a === null ? null : String(typeof a === "object" ? JSON.stringify(a) : a), probability: pr === null ? null : pr > 1 && pr <= 100 ? pr / 100 : pr >= 0 && pr <= 1 ? pr : null, raw: d };
    });
  }

  return {
    async defaultRange() { const t = istDateOf(Date.now()); return { from: istDateOf(Date.now() - 6 * 86400000), to: t }; },

    listDays: withCtx(async (ctx, q) => {
      const dates = datesBetween(q.from, q.to, 62);
      const all = []; let truncated = false, storedAt = null;
      for (let i = 0; i < dates.length; i += 4) {
        const part = await Promise.all(dates.slice(i, i + 4).map(d => loadDay(d, q.refresh, ctx)));
        for (const p of part) { all.push(...p.items); truncated = truncated || p.truncated; storedAt = minT(storedAt, p.storedAt); }
      }
      return { ok: true, data: buildDays(all, { ...q, to: dates[dates.length - 1] || q.to }, truncated), storedAt };
    }),

    listConsults: withCtx(async (ctx, { doctorId, date }) => {
      const day = await loadDay(date, false, ctx);
      return { ok: true, data: listFor(day.items, doctorId, date), storedAt: day.storedAt };
    }),

    getConsult: withCtx(async (ctx, uid) => {
      if (!validUid(uid)) throw { code: "not_found", message: "not a valid consult uid", retryable: false };
      let date = uidDate.get(uid) || null;
      if (!date) {
        const { data } = await call("scribe_freescript", { action: "read", consult_uid: uid, limit: 1 }, false, ctx);
        date = str(get(arr(get(data, "rows"))[0], "ist_date"));
      }
      if (!date) {
        const { data } = await call("scribe_reb_index", { window_id: "consult-" + uid, limit: 1 }, false, ctx);
        date = str(get(arr(get(data, "rows"))[0], "ist_date"));
      }
      if (date && date < MIN_DATE) date = null;
      if (!date) throw { code: "not_found", message: "consult not found in loaded data", retryable: false };
      const day = await loadDay(date, false, ctx);
      const base = day.items.find(c => c.consult_uid === uid);
      if (!base) throw { code: "not_found", message: "consult not found for its date", retryable: false };
      const g = day.raw.get(uid) || { rows: [], fs: null };
      const fsr = g.fs, art = isObj(get(fsr, "artifact")) ? fsr.artifact : null;
      const rubs = (await rubricsFor(date, date, false, ctx)).by.get(uid) || [];
      let jev = null, jevError = null;
      try { jev = jevOf((await call("scribe_jev_decisions", { subject_type: "consult", subject_id: uid, limit: 100 }, false, ctx)).data); } catch (e) { jev = null; jevError = (e && typeof e.code === "string" && e.code) || "unknown"; }
      const stages = { ...base.stages }; if (jev !== null) stages.jev = { state: jev.length ? "done" : "missing", reason: null };
      const prUid = base.prescription_uid;
      const indUid = base.individual_uid;
      const detail = {
        ...base, stages, first_gap: firstGap(stages), transcript: null,
        ledger: ledgerOf(g.rows, fsr),
        note: fsr ? {
          noteText: str(get(art, "note_text")),
          validator: { ok: typeof get(fsr, "validator", "ok") === "boolean" ? fsr.validator.ok : null, errors: arr(get(fsr, "validator", "errors")).map(e => (typeof e === "string" ? e : JSON.stringify(e))) },
          completionRequired: arr(get(fsr, "completion_required")).filter(isObj).map(c => ({ kind: str(c.kind), detail: str(c.detail), prompt: str(c.prompt) })),
          model: str(get(art, "generator", "model")) || str(get(fsr, "generator", "model")),
          version: str(get(art, "generator", "version")) || str(get(fsr, "generator", "version")),
        } : null,
        pdqi: rubs.find(r => /pdqi/i.test(r.id)) || null,
        rubrics: rubs.filter(r => !/pdqi/i.test(r.id)),
        jev, jevError, cdmss: null,
        rx: fsr ? { prescriptionUid: prUid, individualUid: indUid, signedText: null, link: buildPulseLink(prUid, indUid) } : null,
      };
      return { ok: true, data: detail, storedAt: day.storedAt };
    }),

    async getAudioUrl() { return null; },

    notes: createNotes(db, userId),

    // Doctor-PWA encounters: currently empty, kept so the adapter covers them.
    doctorEncounters: {
      async list(args = {}) { return unwrapOrThrow(await call("scribe_list_encounters", { window: "all", limit: 25, ...args })); },
      async get(encounterId) { return unwrapOrThrow(await call("scribe_encounter", { encounter_id: encounterId })); },
      async sttRuns(encounterId) { return unwrapOrThrow(await call("scribe_stt_runs", { encounter_id: encounterId })); },
    },
  };
}
/** Shared admin notes: db doc notes/{consult_uid}. Ids only; names are resolved by the UI. */
export function createNotes(db, userId) {
  return {
    async get(uid) {
      if (!db) throw { code: "capability_disabled", message: "shared notes unavailable" };
      if (!validUid(uid)) throw { code: "bad_request", message: "not a valid consult uid" };
      const snap = await db.doc("notes/" + uid).get();
      const d = snap && snap.exists ? snap.data() : null;
      return { ok: true, data: d ? { text: typeof d.text === "string" ? d.text : "", updated_by: str(d.updated_by), updated_at: str(d.updated_at) } : null, storedAt: null };
    },
    async set(uid, text) {
      if (!db) throw { code: "capability_disabled", message: "shared notes unavailable" };
      if (!validUid(uid)) throw { code: "bad_request", message: "not a valid consult uid" };
      const by = userId ? await userId().catch(() => null) : null;
      await db.doc("notes/" + uid).set({ text: String(text), updated_by: by, updated_at: new Date().toISOString() });
      return { ok: true, data: null, storedAt: null };
    },
  };
}

const unwrapOrThrow = r => r.data;

function scoreHeadline(score) {
  if (!isObj(score)) return null;
  for (const k of ["overall", "total", "mean", "score", "avg"]) if (typeof score[k] === "number") return Math.round(score[k] * 100) / 100;
  return null;
}
