// Same interface over a synthetic dataset (fixtures/mockup.json, field names of the catalog row). Used by the mockup page and by tests.
import { buildDays, listFor } from "./days.js";
import { buildPulseLink } from "./pulse.js";
import { audioPlan, synthWav } from "./audio-synth.js";
import { clampRange } from "./util.js";

const DETAIL_KEYS = ["transcript", "ledger", "note", "pdqi", "rubrics", "jev", "cdmss", "rx"];

/** @param data {{defaultRange?:{from:string,to:string}, consults:any[]}} */
export function createFixtureImpl(data) {
  let lastUrl = null;   // one object URL at a time: opening another consult frees the previous track
  const consults = (data && Array.isArray(data.consults) ? data.consults : []).map(c => ({
    ...c, rx: c.rx ? { ...c.rx, link: buildPulseLink(c.rx.prescriptionUid, c.rx.individualUid) } : null,
  }));
  const summaries = consults.map(c => { const s = { ...c }; for (const k of DETAIL_KEYS) delete s[k]; return s; });
  const inRange = (c, r) => c.ist_date >= r.from && c.ist_date <= r.to;
  return {
    async defaultRange() { return (data && data.defaultRange) || null; },
    async listDays(q) {
      const r = clampRange(q.from, q.to);
      return { ok: true, data: buildDays(summaries.filter(c => inRange(c, r)), q), storedAt: null };
    },
    async listConsults({ doctorId, date }) { return { ok: true, data: listFor(summaries, doctorId, date), storedAt: null }; },
    async getConsult(uid) {
      const c = consults.find(x => x.consult_uid === uid);
      if (!c) throw { code: "not_found", message: "no such consult", retryable: false };
      return { ok: true, data: { ...JSON.parse(JSON.stringify(c)), audioSynthetic: true }, storedAt: null };
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
