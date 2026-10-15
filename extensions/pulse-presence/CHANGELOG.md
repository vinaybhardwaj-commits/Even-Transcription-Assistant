# Changelog

## 0.1.4 — body_unavailable split into reason codes (diagnostic)

Why: 65% of live encounter_open events carried encounter_id null with reason body_unavailable, and that one reason covered
seven failure paths. No new page access is added.

- `reason` on a Start/End event whose consult_uid could not be read is now `body_<why>`: no_body, form_no_key, raw_missing,
  raw_file_only, too_large, not_json, json_no_key, bad_uid. `body_unavailable` stays in the accepted list but is not emitted.
- New optional field `body_keys`, only on `body_json_no_key`: sorted top-level key names of the JSON body (max 12, each max
  32 chars of `A-Za-z0-9_`, others dropped). Never values.
- consult_uid is also read from `.payload`, `.consult`, `.data.consult`, and under `consultUid` / `consult_id`
  (form: `consultUid`). The id pattern is unchanged. No other field is guessed from.
- Server: POST /api/presence stores the event verbatim (reason is free text, unknown keys are kept in payload), so no server change is needed.

## 0.1.3 — every presence event names the current doctor, with its age

Why: only about 16% of presence heartbeats carried a doctor_uid, so a doctor could not be placed in a room at a given
time. The identity the extension holds from its login and encounter reads is now stamped on every event, with how
fresh it is. No name is added. The server stores the event verbatim as JSON, so no server change is needed.

### Wire change (additive)

| field | value |
|---|---|
| `identity_age_s` | Whole seconds since the `doctor_uid` on the event was last confirmed by a Pulse identity read. Null whenever `doctor_uid` is null. Optional on the wire (an older build's queued events still ship). On a `logout` it is the age of the departing doctor's identity. |

### Placement hint: `last_doctor_uid`, `last_doctor_age_s` (PLACEMENT HINT ONLY, NOT IDENTITY)

Every event also carries the most recent `doctor_uid` this Mac's extension attributed, while it still holds it, and the
whole seconds since that doctor was last confirmed (both null when none, and always null while `impersonating`).
It exists so a room can be placed ("which doctor was last at this Mac"), not to prove who is logged in.
- Set on every confirming, non-stale identity read.
- KEPT through `stale_cookie`, `stale_token`, `absent_401` and other read-failure reasons.
- Cleared on a true logout (visible absent read with no failure reason), idle timeout, last-tab close, and when a
  different doctor logs in (a stale new doctor also clears it).
- `doctor_uid` semantics are unchanged and fail-closed. Nothing on the server may treat `last_doctor_uid` as identity.

### Reason `none`

On `heartbeat`, `idle`, `active` and `locked`, when `doctor_uid` is null, the session is not impersonated and no other
reason applies, `reason` is `none`. When another reason applies (`absent_401`, `stale_cookie`, `idle_timeout`, ...) it is
kept as is and `none` is not added. During impersonation `reason` stays null (`impersonating: true` is the signal).
`login`, `logout`, `encounter_*` and `identity_stale` never get `none`.

### Unchanged

Identity is still withheld (doctor_uid null) while stale, unreadable or impersonating, and cleared on logout, idle
timeout and last-tab close. Nothing is sent from a cleared identity.

## 0.1.2 — OTP logins: Bearer on the identity read

Why: OTP (phone) logins have no `__session` cookie, so the cookie-only identity read answered 401 (`absent_401`) while
the page greeted a doctor. With V's approval the content script now reads the page's own Firebase access token from
IndexedDB (read-only) and sends it as `Authorization: Bearer` (POST `{}`) to `pulse.even.in` only, as the page does.
The token is held in a local variable for the call and is never logged, stored, posted or returned.
No record, several records or a malformed token: the cookie call, as before. Expired token: cookie call; if that answers
401/403 the read is unknown (`invalid`, reason `stale_token`), never `absent`, so no logout (an existing Firebase record
means the doctor has not signed out; the page renews the token on its next API call). A cookie 200 or another failure
keeps its own result and reason. Both Bearer fetches use `redirect: 'error'`. New reason code `stale_token` (stored as
free text by the ETA ingest). Build seq continues as `0.1.2.<seq>`.

## 0.1.1 — stale-cookie guard, status visibility, instance id

Why: Pulse never clears its Google session cookie, and doctors who sign in by phone OTP run the page under an auth the
extension cannot see. The cookie-authed identity read (`/api/auth/clinical/access/verify` + `/api/auth/getName`) can
therefore name the PREVIOUS doctor, or nobody. The extension no longer asserts an identity the page contradicts, and
every identity failure is visible in `reason`. The warehouse doctor per consult stays authoritative on the server.

Source: DOM text (the home-page greeting) and HTTP statuses only. No cookie, token or browser storage is read, stored
or sent; the one value written to `chrome.storage.local` for this feature is the random `instance_id`.

### New wire fields (every event carries all four; null when not applicable)

| field | value |
|---|---|
| `page_name` | First name from the home greeting (`h1[class*="greeting"]`, "Hello, Dr Manoj" -> `Manoj`). Last value seen, kept across routes, cleared on the login route. Null during impersonation. NEVER a doctor_uid; it is a witness, not an identity. |
| `instance_id` | 32 hex chars, random, minted once per extension install (chrome.storage.local), not derived from anything personal. Lets the sink de-dupe several Chrome profiles on one Mac. |
| `cookie_uid` | Non-null only on `identity_stale`: the doctor_uid the cookie read returned. |
| `cookie_name` | Non-null only on `identity_stale`: the display_name the cookie read returned. |

`tab_focus` is unchanged and is the per-instance "this profile's Pulse tab is the focused window's active tab" flag
(there is no separate `profile_focus` field).

### New event type

`identity_stale`, emitted once when the cookie identity's first name (case-insensitive, "Dr"/"Dr." ignored) differs from
`page_name`, and again only if the cookie doctor_uid changes while stale. Its row has `doctor_uid: null`,
`display_name: null`, `reason: stale_cookie`, `page_name`, `cookie_uid`, `cookie_name`. The earlier `login` for that
cookie doctor, if the greeting had not rendered yet, is NOT retracted by a `logout`; readers should close it out using
`cookie_uid`.

### Stale behaviour

- While stale: every heartbeat / idle / active / locked / encounter row has `doctor_uid: null`, `display_name: null`,
  `email: null`, `reason` containing `stale_cookie`, and `page_name`. `encounter_open` / `encounter_close` still carry
  `encounter_id` (consult_uid) and `prescription_ref`.
- No `login` is emitted for a stale identity, and no `logout` is emitted for it (idle_timeout, tab close, visible
  logout, cookie switch) because its login was never asserted.
- Stale ends on the next identity report whose greeting matches the cookie (or a different cookie doctor): a normal
  `login` follows.
- Either side unknown (greeting not rendered, getName failed) is NOT stale: no evidence of a mismatch.
- Cookie absent but the page greets someone: rows carry `doctor_uid: null`, `reason: absent_<status>`, `page_name`.
  Show "page says <page_name>"; do not treat it as an identity.

### `reason` values (sorted, comma-joined set; null when clean)

| reason | meaning |
|---|---|
| `absent_401`, `absent_403` | verify returned 401/403: no cookie session (also sets identity absent). |
| `absent_<n>` (e.g. `absent_500`, `absent_404`, `absent_429`) | verify returned another non-2xx. Identity stays fail-closed (null doctor); last-known is kept, no logout. |
| `invalid_no_doctor` | verify returned 2xx but no usable doctor object (contract change). Fail-closed. Replaces `identity_unreadable` for this case. |
| `identity_unreadable` | network error or unreadable body on verify. Fail-closed, last-known kept. Unchanged. |
| `stale_cookie` | cookie identity contradicts the page greeting (see above). |
| `name_absent_<n>`, `name_unreadable`, `name_invalid` | getName failed (non-2xx / network or bad JSON / 2xx without a name). The doctor_uid is still asserted, `display_name` is null, so the stale check cannot run. |
| `body_unavailable`, `idle_timeout`, `tab_closed` | unchanged. |

Absent/invalid reasons ride on every event (heartbeats included) while the condition holds, and clear on the next good
read. A hidden Pulse tab's 401 does not evict a doctor logged in elsewhere, so it does not change the reason either.

### Compatibility

- Wire shape is now 17 fields. A sink that rejects unknown fields must be updated before this build is rolled.
- Events queued by an older build (13 fields) still ship as-is; the four new fields are optional in validation.
- Manifest version base is `0.1.1`; `kit/build-kit.sh` appends `.<seq>` per host (Chrome allows four numeric parts), so
  the next build is `0.1.1.<build-seq + 1>`.
