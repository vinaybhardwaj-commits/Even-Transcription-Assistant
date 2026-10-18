// The one interface the UI uses. Wraps an implementation: enforces the date floor, never throws.
import { MIN_DATE } from "./types.js";
import { clampRange, isDate } from "./util.js";

export function normErr(e) {
  const o = e && typeof e === "object" ? e : {};
  return { ok: false, code: typeof o.code === "string" ? o.code : "unknown", message: typeof o.message === "string" ? o.message : String(e), retryable: !!o.retryable, ...(typeof o.sealed === "string" ? { sealed: o.sealed } : {}) };
}
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { return normErr(e); } };
const ok = (data, storedAt = null) => ({ ok: true, data, storedAt });

/**
 * @param impl {{listDays,listConsults,getConsult,getAudioUrl,notes:{get,set},defaultRange?}}
 *   each returns a Result, or throws {code,message,retryable}
 */
export function createAdapter(impl) {
  return {
    minDate: MIN_DATE,
    async listDays(q = {}) {
      const r = clampRange(q.from, q.to);
      if (!r) return ok({ cells: [], doctors: [], dates: [], rooms: [], specialties: [], truncated: false });
      return guard(impl.listDays)({ ...q, from: r.from, to: r.to });
    },
    async listConsults(q = {}) {
      if (!q.doctorId || !isDate(q.date) || q.date < MIN_DATE) return ok([]);
      return guard(impl.listConsults)(q);
    },
    async getConsult(uid, opts) { return typeof uid === "string" && uid ? guard(impl.getConsult)(uid, opts) : normErr({ code: "bad_request", message: "no consult uid" }); },
    /** Admin only: every consult of one patient. A source without the lookup answers needs_admin. opts {signal}. */
    async listPatient(q, opts) {
      if (typeof impl.listPatient !== "function") return normErr({ code: "needs_admin", message: "Patient lookup needs an admin key" });
      return guard(impl.listPatient)({ ...q, ...(opts || {}) });
    },
    async getAudioUrl(uid, opts) { try { return (await impl.getAudioUrl(uid, opts)) || null; } catch { return null; } },
    /** Result {url | blob, bytes, minutes}: why the audio is missing is part of the answer. opts: {signal, onProgress}. */
    async getAudio(uid, opts) {
      if (typeof impl.getAudio === "function") return guard((u, o) => impl.getAudio(u, o))(uid, opts);
      const url = await this.getAudioUrl(uid, opts);
      return url ? ok({ url, bytes: null, minutes: null }) : normErr({ code: "not_available", message: "no audio for this consult" });
    },
    /** Which filters this data source can honour; the UI disables the rest. */
    get features() { return { hasRxFilter: true, specialtyFilter: true, names: true, rxContent: true, ...(impl.features || {}) }; },
    notes: {
      get: guard(uid => impl.notes.get(uid)),
      set: guard((uid, text) => impl.notes.set(uid, text)),
    },
    async defaultRange() { try { return (impl.defaultRange && (await impl.defaultRange())) || null; } catch { return null; } },
    raw: impl,
  };
}
export { ok };
