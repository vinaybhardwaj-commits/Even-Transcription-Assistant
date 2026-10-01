// Start/End consult request body parsing (R3). Extracts the single field consult_uid; nothing else survives.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  const START_URL = 'https://pulse.even.in/api/emr/startConsult';
  const END_URL = 'https://pulse.even.in/api/emr/endConsult';
  const UID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
  const MAX_BYTES = 64 * 1024;

  function classifyUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const base = u.origin + u.pathname;
    if (base === START_URL) return 'start';
    if (base === END_URL) return 'end';
    return null;
  }

  function validUid(x) {
    return typeof x === 'string' && UID_RE.test(x) ? x : null;
  }

  // requestBody is the webRequest details.requestBody. Returns { ok, consult_uid }.
  function parseConsultBody(requestBody) {
    const fail = { ok: false, consult_uid: null };
    try {
      if (!requestBody || requestBody.error) return fail;
      if (requestBody.formData && Array.isArray(requestBody.formData.consult_uid)) {
        const uid = validUid(requestBody.formData.consult_uid[0]);
        return uid ? { ok: true, consult_uid: uid } : fail;
      }
      if (!Array.isArray(requestBody.raw)) return fail;
      const parts = [];
      let total = 0;
      for (const p of requestBody.raw) {
        if (!p || !p.bytes) continue;
        const b = new Uint8Array(p.bytes);
        total += b.length;
        if (total > MAX_BYTES) return fail;
        parts.push(b);
      }
      if (!parts.length) return fail;
      const all = new Uint8Array(total);
      let o = 0;
      for (const b of parts) { all.set(b, o); o += b.length; }
      const parsed = JSON.parse(new TextDecoder('utf-8').decode(all));
      if (!parsed || typeof parsed !== 'object') return fail;
      let uid = validUid(parsed.consult_uid);
      if (!uid && parsed.data && typeof parsed.data === 'object') uid = validUid(parsed.data.consult_uid);
      return uid ? { ok: true, consult_uid: uid } : fail;
    } catch (e) {
      return fail;
    }
  }

  return { START_URL, END_URL, classifyUrl, parseConsultBody };
});
