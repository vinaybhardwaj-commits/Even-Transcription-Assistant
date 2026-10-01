// Event schema (R6). Exactly these 12 fields, nothing else, ever.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  const EVENT_FIELDS = [
    'machine_id', 'room', 'email', 'display_name', 'event', 'encounter_id',
    'prescription_ref', 'ts', 'tab_focus', 'impersonating', 'ext_version', 'reason',
  ];
  const EVENT_TYPES = ['login', 'logout', 'encounter_open', 'encounter_close', 'idle', 'active', 'locked', 'heartbeat'];
  // R10: sorted comma-joined set of these two codes, or null.
  const REASONS = [null, 'body_unavailable', 'identity_unreadable', 'body_unavailable,identity_unreadable'];
  const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/;
  const NULLABLE_STRING = ['machine_id', 'room', 'email', 'display_name', 'encounter_id', 'prescription_ref'];

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

  // Returns a list of problems; empty list means the event matches R6 exactly.
  function validateEvent(e) {
    const bad = [];
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return ['not an object'];
    const keys = Object.keys(e);
    for (const k of keys) if (!EVENT_FIELDS.includes(k)) bad.push('extra field: ' + k);
    for (const k of EVENT_FIELDS) if (!Object.prototype.hasOwnProperty.call(e, k)) bad.push('missing field: ' + k);
    if (bad.length) return bad;
    for (const k of NULLABLE_STRING) {
      if (e[k] !== null && (typeof e[k] !== 'string' || e[k].length > 256)) bad.push('bad type: ' + k);
    }
    if (!EVENT_TYPES.includes(e.event)) bad.push('bad event');
    if (typeof e.ts !== 'string' || !TS_RE.test(e.ts)) bad.push('bad ts');
    if (typeof e.tab_focus !== 'boolean') bad.push('bad type: tab_focus');
    if (typeof e.impersonating !== 'boolean') bad.push('bad type: impersonating');
    if (typeof e.ext_version !== 'string' || !e.ext_version) bad.push('bad type: ext_version');
    if (!REASONS.includes(e.reason)) bad.push('bad reason');
    return bad;
  }

  // Builds an event from explicit properties only, so no stray field can ride along.
  function buildEvent(f) {
    return {
      machine_id: f.machine_id ?? null,
      room: f.room ?? null,
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
    };
  }

  return { EVENT_FIELDS, EVENT_TYPES, REASONS, isoLocal, validateEvent, buildEvent };
});
