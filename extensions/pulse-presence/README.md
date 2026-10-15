# ETA Pulse Presence

Manifest V3 Chrome extension prototype. It reports which doctor is on Pulse (`https://pulse.even.in`) at which machine and room, and when a consultation starts or ends, to an ETA ingest endpoint. Plain JavaScript, no bundler, no dependencies.

## What it does

- Stale-cookie guard (0.1.1): on the home route the content script also reads the greeting the page renders (`h1[class*="greeting"]`, "Hello, <title> <first name>") and sends only the first name as `page_name`. If the cookie identity's first name differs, the worker emits one `identity_stale` event and reports `doctor_uid: null` with `reason: stale_cookie` until a matching read. See CHANGELOG.md.
- Content script (top frame of `pulse.even.in` only) reads the Firebase auth record from IndexedDB (`firebaseLocalStorageDb` / `firebaseLocalStorage`, key prefix `firebase:authUser:`). It keeps only `uid`, `email`, `displayName`. If the record does not match the expected shape, the doctor is reported as null.
- If the URL has `doctor_email` or `sessionStorage["is-impersonation"] == "true"`, the doctor is null and `impersonating` is true. The Firebase record is not read in that case.
- Route: `prescription_uid` from `/patient/<x>` or `/prescription` becomes an opaque `prescription_ref`. No URL or query string is sent.
- Consult id: the service worker observes (non-blocking) `POST /api/emr/startConsult` and `/api/emr/endConsult`, reads only the `consult_uid` field of the body, and emits `encounter_open` / `encounter_close` after a 2xx response. The `consult_uid` is read at fixed places only: the top level, `.data`, `.payload`, `.consult` or `.data.consult` of a JSON body, under `consult_uid`, `consultUid` or `consult_id` (form bodies: `consult_uid` or `consultUid`), and must pass the id pattern. If it cannot be read, the event is sent with `encounter_id: null` and a `reason` that says why (0.1.4): `body_no_body` (Chrome gave no body or an error), `body_form_no_key`, `body_raw_missing`, `body_raw_file_only`, `body_too_large` (over 64 KB), `body_not_json`, `body_json_no_key`, `body_bad_uid`. `body_unavailable` is no longer emitted but stays valid for old queued events. On `body_json_no_key` only, the event also carries `body_keys`: the top-level key NAMES of the JSON (sorted, at most 12, each matching `^[a-z][A-Za-z0-9_]{0,31}$` with at most 3 digits in total, others dropped), never any value.
- Presence: `chrome.idle` at 120 s (idle, active, locked), tab and window focus, and a 30 s heartbeat alarm.
- Transport: the service worker posts batches of up to 50 events as `{"events":[...]}` to `ingest_url` with `Authorization: Bearer <token>`. Failed events wait in a local queue (`chrome.storage.local`), expire after 24 h, and retry with exponential backoff (10 s doubling, cap 15 min). A 4xx answer other than 401/403/408/425/429 drops the batch.

## Event schema

Exactly these fields, no others: `machine_id, room, doctor_uid, email, display_name, event, encounter_id, prescription_ref, ts, tab_focus, impersonating, ext_version, reason, page_name, instance_id, cookie_uid, cookie_name` (the last four are new in 0.1.1; see CHANGELOG.md for what sink readers must do with them).

`event` is one of `login, logout, encounter_open, encounter_close, idle, active, locked, heartbeat, identity_stale`. `reason` is `null` or the sorted, comma-joined set of active status codes (`body_<why>` codes listed above, `body_unavailable` (legacy), `identity_unreadable`, `idle_timeout`, `tab_closed`, `stale_cookie`, `invalid_no_doctor`, `none`, `absent_<http status>`, `name_absent_<http status>`, `name_invalid`, `name_unreadable`). `ts` is ISO 8601 with the Mac's UTC offset. Every event is validated before it is queued and again before it is sent; an event with any other shape is dropped.

## Managed storage keys

Set by policy (`storage.managed`). For development the same keys are read from `chrome.storage.local` when managed storage lacks them.

| key | meaning |
|---|---|
| `machine_id` | ETA id of this machine |
| `room` | room label for this machine |
| `ingest_url` | `https://` URL of the ETA ingest endpoint |
| `token` | bearer token for the ingest endpoint |

Without `ingest_url` and `token`, events stay in the local queue and nothing is sent.

## Install

`manifest.json` `host_permissions` lists `https://www.evenscribe.app/*`, the ETA ingest host. The extension can only post to hosts listed there. For another ingest host, edit it before packaging.

### Chrome policy-forced install (production)

1. Package the folder (`chrome://extensions` > Pack extension) or publish it privately; note the extension id.
2. Set the enterprise policies on the Mac (managed preferences or MDM):
   - `ExtensionInstallForcelist`: `["<extension-id>;<update-url>"]`
   - `3rdparty` extension policy for the id, with the four keys:
     ```json
     { "3rdparty": { "extensions": { "<extension-id>": {
       "machine_id": "MAC-01", "room": "OPD-3",
       "ingest_url": "https://<eta-ingest-host>/v1/presence", "token": "<token>" } } } }
     ```
3. Restart Chrome and open `chrome://policy` to confirm both policies loaded.

### Unpacked side-load (development)

1. Open `chrome://extensions`, turn on Developer mode, Load unpacked, choose this folder.
2. Open the service worker console from the extension card and set the config:
   ```js
   chrome.storage.local.set({ machine_id: 'DEV-1', room: 'DEV', ingest_url: 'https://<host>/v1/presence', token: '<dev-token>' })
   ```

## Tests

```
npm test
```

Runs `node --test test/*.test.js` (Node 20 or later). Tests use fakes for `chrome.*` and IndexedDB. They cover identity extraction with a token-bearing record, impersonation, route and body parsing, heartbeat, backoff and expiry, and that every outbound event matches the schema exactly.

## Privacy: what is never captured

- Patient names, `individual_uid`, membership ids, phone numbers.
- Any page text or DOM content. The extension does not scrape the page and does not inject scripts into the page.
- Prescription, diagnosis or other free-text fields.
- Request or response bodies, except the single `consult_uid` field of Start/End requests and, when that field cannot be found, the top-level key NAMES (never values) of the JSON body as `body_keys`.
- `stsTokenManager` and any token, the Firebase `uid`, `stream_data.token`, cookies (no `cookies` permission).
- Full URLs or query strings. Only a route type (internally) and the opaque `prescription_ref` are used.
- Chat content, screenshots, keystrokes.

The only data kept locally is the outbound queue and small state (current doctor email and display name, open `prescription_ref`, focus and idle state). Queue entries expire after 24 h.

## Unverified items

See `MANUAL-TEST.md`. Design decisions and safer-reading choices are in `NOTES.md`.
