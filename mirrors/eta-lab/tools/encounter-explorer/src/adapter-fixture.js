// Same interface over a synthetic dataset (fixtures/mockup.json, field names of the catalog row). Used by the mockup page and by tests.
import { buildDays, listFor } from "./days.js";
import { buildPulseLink } from "./pulse.js";
import { audioPlan, synthWav } from "./audio-synth.js";
import { clampRange, isObj } from "./util.js";
import { c4Of, guardC4, jevSetsIn } from "./c4.js";

const DETAIL_KEYS = ["transcript", "ledger", "note", "pdqi", "rubrics", "jev", "cdmss", "rx", "catalog_c4", "narrative"];

/** @param data {{defaultRange?:{from:string,to:string}, consults:any[]}} */
export function createFixtureImpl(data) {
  let lastUrl = null;   // one object URL at a time: opening another consult frees the previous track
  const consults = (data && Array.isArray(data.consults) ? data.consults : []).map(c => ({
    ...c, rx: c.rx ? { ...c.rx, link: buildPulseLink(c.rx.prescriptionUid, c.rx.individualUid) } : null,
  }));
  const summaries = consults.map(c => { const s = { ...c }; for (const k of DETAIL_KEYS) delete s[k]; return s; });
  const inRange = (c, r) => c.ist_date >= r.from && c.ist_date <= r.to;
  return {
    features: { clipKnown: true },
    async defaultRange() { return (data && data.defaultRange) || null; },
    async listDays(q) {
      const r = clampRange(q.from, q.to);
      return { ok: true, data: buildDays(summaries.filter(c => inRange(c, r)), q), storedAt: null };
    },
    async listConsults({ doctorId, date }) { return { ok: true, data: listFor(summaries, doctorId, date), storedAt: null }; },
    async getConsult(uid) {
      const c = consults.find(x => x.consult_uid === uid);
      if (!c) throw { code: "not_found", message: "no such consult", retryable: false };
      // the same C4 fields the catalog adapter derives (state, jev sets); narrative (turns / voice_id / topics, draft shape v0) exists in the mockup only
      const c4 = c4Of({ row: { ...("catalog_c4" in c ? { catalog_c4: guardC4(c.catalog_c4) } : {}), c4_error: c.c4_error === true } });
      const jevSets = c4.state === "ok" && isObj(c4.data) && "jev" in c4.data ? jevSetsIn(c4.data.jev) : null;
      return { ok: true, data: { ...JSON.parse(JSON.stringify(c)), audioSynthetic: true, c4, jevSets, jevBad: false }, storedAt: null };
    },
    async listPatient({ individual_uid }) {
      const rows = summaries.filter(c => c.individual_uid === individual_uid).sort((a, b) => (a.ist_date === b.ist_date ? (a.t_open ?? 0) - (b.t_open ?? 0) : a.ist_date < b.ist_date ? -1 : 1));
      return { ok: true, data: { rows, truncated: false, from: "2026-09-09", to: "2026-10-13" }, storedAt: null };
    },
    async getAudioUrl(uid) {
      const c = consults.find(x => x.consult_uid === uid);
      if (!c || !c.transcript || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
      const url = URL.createObjectURL(await synthWav(audioPlan(c.lengthSec, c.transcript)));
      if (lastUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(lastUrl);
      return (lastUrl = url);
    },
  };
}
