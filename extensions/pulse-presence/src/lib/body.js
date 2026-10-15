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

  const WHY = ['no_body', 'form_no_key', 'raw_missing', 'raw_file_only', 'too_large', 'not_json', 'json_no_key', 'bad_uid'];
  const UID_KEYS = ['consult_uid', 'consultUid', 'consult_id'];
  const FORM_KEYS = ['consult_uid', 'consultUid'];
  const KEY_NAME_RE = /^[a-z][A-Za-z0-9_]{0,31}$/; // lowercase start, API-key style
  const TOO_MANY_DIGITS_RE = /(?:\D*\d){4}/; // more than 3 digits in total (ids, phone numbers, split numbers) never pass
  const MAX_KEY_NAMES = 12;
  const MAX_KEY_LEN = 32;

  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

  // Top-level key NAMES only, never values: sorted, at most 12, each at most 32 chars of [A-Za-z0-9_], others dropped.
  function safeKeyNames(obj) {
    if (!isObj(obj)) return [];
    return Object.keys(obj).filter((k) => k.length <= MAX_KEY_LEN && KEY_NAME_RE.test(k) && !TOO_MANY_DIGITS_RE.test(k)).sort().slice(0, MAX_KEY_NAMES);
  }

  const bad = (why, extra) => Object.assign({ ok: false, consult_uid: null, why }, extra || {});

  // Exactly one distinct valid candidate is ok. Any present-but-invalid candidate, or two different valid ones, is bad_uid.
  function resolve(cands) {
    if (!cands.length) return {};
    const valid = new Set();
    for (const c of cands) {
      const u = validUid(c);
      if (!u) return { present: true };
      valid.add(u);
    }
    return valid.size === 1 ? { uid: [...valid][0] } : { present: true };
  }

  // Collects every candidate at the fixed paths: top level, .data, .payload, .consult, .data.consult.
  function findUid(parsed) {
    const holders = [parsed];
    for (const k of ['data', 'payload', 'consult']) if (isObj(parsed[k])) holders.push(parsed[k]);
    if (isObj(parsed.data) && isObj(parsed.data.consult)) holders.push(parsed.data.consult);
    const cands = [];
    for (const h of holders) for (const k of UID_KEYS) if (Object.prototype.hasOwnProperty.call(h, k)) cands.push(h[k]);
    return resolve(cands);
  }

  // requestBody is the webRequest details.requestBody. Returns { ok, consult_uid, why? }.
  // On failure why is one of WHY; body_keys (key names only) accompanies json_no_key.
  function parseConsultBody(requestBody) {
    try {
      if (!requestBody || requestBody.error) return bad('no_body');
      if (requestBody.formData && typeof requestBody.formData === 'object') {
        const cands = [];
        for (const k of FORM_KEYS) {
          const v = requestBody.formData[k];
          if (Array.isArray(v)) { if (v.length) cands.push(...v); else cands.push(undefined); } // every value counts; empty is present but invalid
        }
        const f = resolve(cands);
        if (f.uid) return { ok: true, consult_uid: f.uid };
        return bad(f.present ? 'bad_uid' : 'form_no_key');
      }
      if (!Array.isArray(requestBody.raw)) return bad('raw_missing');
      const parts = [];
      let total = 0;
      let fileOnly = false;
      for (const p of requestBody.raw) {
        if (!p) continue;
        if (!p.bytes) { if (p.file) fileOnly = true; continue; }
        const b = new Uint8Array(p.bytes);
        total += b.length;
        if (total > MAX_BYTES) return bad('too_large');
        parts.push(b);
      }
      if (!parts.length) return bad(fileOnly ? 'raw_file_only' : 'raw_missing');
      const all = new Uint8Array(total);
      let o = 0;
      for (const b of parts) { all.set(b, o); o += b.length; }
      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8').decode(all)); } catch (e) { return bad('not_json'); }
      if (!parsed || typeof parsed !== 'object') return bad('not_json');
      const f = Array.isArray(parsed) ? {} : findUid(parsed);
      if (f.uid) return { ok: true, consult_uid: f.uid };
      if (f.present) return bad('bad_uid');
      return bad('json_no_key', { body_keys: safeKeyNames(parsed) });
    } catch (e) {
      return bad('no_body');
    }
  }

  return { START_URL, END_URL, WHY, classifyUrl, parseConsultBody, safeKeyNames };
});
