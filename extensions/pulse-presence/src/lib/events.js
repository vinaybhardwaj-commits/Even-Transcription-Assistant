// Event schema (R6). The original 13 fields, plus four added in 0.1.1: page_name, instance_id, cookie_uid, cookie_name.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  // doctor_uid is the primary identity; email is optional (null for Google logins).
  const BASE_FIELDS = [
    'machine_id', 'room', 'doctor_uid', 'email', 'display_name', 'event', 'encounter_id',
    'prescription_ref', 'ts', 'tab_focus', 'impersonating', 'ext_version', 'reason',
  ];
  // Added in 0.1.1. page_name = first name the Pulse page greets (DOM text, never promoted to doctor_uid).
  // instance_id = random per-install id (de-dupes several Chrome profiles on one Mac).
  // cookie_uid / cookie_name = the cookie-derived identity found stale; non-null only on identity_stale.
  const NEW_FIELDS = ['page_name', 'instance_id', 'cookie_uid', 'cookie_name', 'last_doctor_uid'];
  // Added in 0.1.3. identity_age_s = whole seconds since the doctor_uid on the event was last confirmed by a Pulse
  // identity read; null whenever doctor_uid is null. Optional on the wire like the 0.1.1 fields.
  const AGE_FIELD = 'identity_age_s';
  // last_doctor_uid / last_doctor_age_s (0.1.3): PLACEMENT HINT ONLY, NOT IDENTITY. The last doctor_uid this extension attributed,
  // kept through stale/expired/absent_401, cleared on logout and on a different doctor's login; null while impersonating.
  const LAST_AGE_FIELD = 'last_doctor_age_s';
  // Added in 0.1.4. body_keys = top-level key NAMES of a Start/End JSON body whose consult_uid could not be found
  // (reason body_json_no_key). Names only, never values: sorted, at most 12, each matching ^[a-z][A-Za-z0-9_]{0,31}$ with at most 3 digits in total. Optional on the wire.
  const BODY_KEYS_FIELD = 'body_keys';
  const BODY_KEY_RE = /^[a-z][A-Za-z0-9_]{0,31}$/; // lowercase start; at most 3 digits in total (checked below)
  const EVENT_FIELDS = BASE_FIELDS.concat(NEW_FIELDS, [AGE_FIELD, LAST_AGE_FIELD, BODY_KEYS_FIELD]);
  const EVENT_TYPES = ['login', 'logout', 'encounter_open', 'encounter_close', 'idle', 'active', 'locked', 'heartbeat', 'identity_stale'];
  // R10: reason is null or a sorted, comma-joined set of codes. Fixed codes below, plus the HTTP-status families.
  const REASON_CODES = [
    // body_unavailable is kept so older queued events validate; 0.1.4 no longer emits it (body_<why> codes replace it).
    'body_unavailable', 'body_no_body', 'body_form_no_key', 'body_raw_missing', 'body_raw_file_only', 'body_too_large',
    'body_not_json', 'body_json_no_key', 'body_bad_uid', 'identity_unreadable', 'idle_timeout', 'tab_closed',
    'stale_cookie', 'stale_token', 'invalid_no_doctor', 'none', 'name_invalid', 'name_unreadable',
  ];
  const REASON_STATUS_RE = /^(absent|name_absent)_\d{3}$/;
  const REASONS = [null, ...REASON_CODES, 'body_unavailable,identity_unreadable'];
  const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/;
  const NULLABLE_STRING = ['machine_id', 'room', 'doctor_uid', 'email', 'display_name', 'encounter_id', 'prescription_ref'].concat(NEW_FIELDS);

  function isReasonCode(c) {
    return REASON_CODES.includes(c) || REASON_STATUS_RE.test(c);
  }
  function validReason(r) {
    if (r === null) return true;
    if (typeof r !== 'string' || !r) return false;
    const parts = r.split(',');
    if (!parts.every(isReasonCode)) return false;
    return parts.join(',') === [...new Set(parts)].sort().join(',');
  }

  // ISO 8601 with the Mac's local UTC offset, e.g. 2026-09-30T14:05:00.000+05:30
  function isoLocal(ms) {
    const d = new Date(ms);
    const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3) +
      sign + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
  }

  // Returns a list of problems; empty list means the event matches the schema exactly.
  // The four 0.1.1 fields may be absent so events queued by an older build still ship; when present they are checked.
  function validateEvent(e) {
    const bad = [];
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return ['not an object'];
    const keys = Object.keys(e);
    for (const k of keys) if (!EVENT_FIELDS.includes(k)) bad.push('extra field: ' + k);
    for (const k of BASE_FIELDS) if (!Object.prototype.hasOwnProperty.call(e, k)) bad.push('missing field: ' + k);
    if (bad.length) return bad;
    for (const k of NULLABLE_STRING) {
      if (!Object.prototype.hasOwnProperty.call(e, k) && NEW_FIELDS.includes(k)) continue;
      if (e[k] !== null && (typeof e[k] !== 'string' || e[k].length > 256)) bad.push('bad type: ' + k);
    }
    if (Object.prototype.hasOwnProperty.call(e, AGE_FIELD)) {
      const a = e[AGE_FIELD];
      if (a !== null && !(Number.isInteger(a) && a >= 0 && a <= 31536000)) bad.push('bad type: ' + AGE_FIELD);
      if (a !== null && e.doctor_uid === null) bad.push('identity_age_s without doctor_uid');
    }
    if (Object.prototype.hasOwnProperty.call(e, LAST_AGE_FIELD)) {
      const a = e[LAST_AGE_FIELD];
      if (a !== null && !(Number.isInteger(a) && a >= 0 && a <= 31536000)) bad.push('bad type: ' + LAST_AGE_FIELD);
      if (a !== null && !e.last_doctor_uid) bad.push('last_doctor_age_s without last_doctor_uid');
    }
    if (Object.prototype.hasOwnProperty.call(e, BODY_KEYS_FIELD)) {
      const k = e[BODY_KEYS_FIELD];
      if (k !== null) {
        const ok = Array.isArray(k) && k.length <= 12 && k.every((n) => typeof n === 'string' && n.length <= 32 && BODY_KEY_RE.test(n) && !/(?:\D*\d){4}/.test(n)) &&
          k.join(',') === [...new Set(k)].sort().join(',');
        if (!ok) bad.push('bad type: ' + BODY_KEYS_FIELD);
        else if (!(typeof e.reason === 'string' && e.reason.split(',').includes('body_json_no_key'))) bad.push('body_keys without body_json_no_key');
      }
    }
    if (!EVENT_TYPES.includes(e.event)) bad.push('bad event');
    if (typeof e.ts !== 'string' || !TS_RE.test(e.ts)) bad.push('bad ts');
    if (typeof e.tab_focus !== 'boolean') bad.push('bad type: tab_focus');
    if (typeof e.impersonating !== 'boolean') bad.push('bad type: impersonating');
    if (typeof e.ext_version !== 'string' || !e.ext_version) bad.push('bad type: ext_version');
    if (!validReason(e.reason)) bad.push('bad reason');
    return bad;
  }

  // Builds an event from explicit properties only, so no stray field can ride along.
  function buildEvent(f) {
    const ev = {
      machine_id: f.machine_id ?? null,
      room: f.room ?? null,
      doctor_uid: f.doctor_uid ?? null,
      email: f.email ?? null,
      display_name: f.display_name ?? null,
      event: f.event,
      encounter_id: f.encounter_id ?? null,
      prescription_ref: f.prescription_ref ?? null,
      ts: f.ts,
      tab_focus: !!f.tab_focus,
      impersonating: !!f.impersonating,
      ext_version: f.ext_version,
      reason: f.reason ?? null,
      page_name: f.page_name ?? null,
      instance_id: f.instance_id ?? null,
      cookie_uid: f.cookie_uid ?? null,
      cookie_name: f.cookie_name ?? null,
      last_doctor_uid: f.last_doctor_uid ?? null,
      last_doctor_age_s: f.last_doctor_uid != null && Number.isInteger(f.last_doctor_age_s) && f.last_doctor_age_s >= 0 ? f.last_doctor_age_s : null,
      identity_age_s: f.doctor_uid != null && Number.isInteger(f.identity_age_s) && f.identity_age_s >= 0 ? f.identity_age_s : null,
    };
    // body_keys rides only on a body_json_no_key event, so every other event keeps its exact 0.1.3 shape.
    if (Array.isArray(f.body_keys) && typeof f.reason === 'string' && f.reason.split(',').includes('body_json_no_key')) ev.body_keys = f.body_keys.slice();
    return ev;
  }

  return { BASE_FIELDS, NEW_FIELDS, EVENT_FIELDS, EVENT_TYPES, REASONS, REASON_CODES, validReason, isoLocal, validateEvent, buildEvent };
});
