// Route parsing and impersonation rule (R2, R3). Returns route type and an opaque ref only,
// never a URL, query string, individual_uid or membership id.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  const PULSE_ORIGIN = 'https://pulse.even.in';
  const REF_RE = /^[A-Za-z0-9_-]{1,128}$/;

  function parseRoute(href) {
    const none = { type: 'other', prescription_ref: null, doctor_email_present: false };
    let u;
    try { u = new URL(href); } catch (e) { return none; }
    if (u.origin !== PULSE_ORIGIN) return none;
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const doctorEmail = u.searchParams.has('doctor_email');
    const raw = u.searchParams.get('prescription_uid');
    const ref = raw && REF_RE.test(raw) ? raw : null;
    let type = 'other';
    if (path === '/') type = 'home';
    else if (path === '/login') type = 'login';
    else if (path === '/prescription') type = 'prescription';
    else if (/^\/patient\/[^/]+$/.test(path)) type = 'patient';
    const carriesRef = type === 'prescription' || type === 'patient';
    return { type, prescription_ref: carriesRef ? ref : null, doctor_email_present: doctorEmail };
  }

  // R2: doctor_email query param, or sessionStorage is-impersonation == "true".
  function isImpersonating(href, sessionValue) {
    return parseRoute(href).doctor_email_present || sessionValue === 'true';
  }

  return { PULSE_ORIGIN, REF_RE, parseRoute, isImpersonating };
});
