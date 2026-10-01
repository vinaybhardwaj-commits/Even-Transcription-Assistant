# Manual test checklist (read-only)

Run on V's own Chrome, on a Mac, by a browser agent or a person. Three items are unverified from code alone. Do not click Start or End consultation on a real patient. Do not paste any token into a report.

Setup: load the extension unpacked, open its service worker console (`chrome://extensions` > Inspect views). Set dev config in `chrome.storage.local` to point at a local echo server or `https://httpbin.org/post` style sink you control. Sign in to Pulse normally.

## 1. Firebase IndexedDB record on a real Mac

Read-only. In DevTools on `https://pulse.even.in` > Application > IndexedDB:

- [ ] Database `firebaseLocalStorageDb` exists with object store `firebaseLocalStorage`.
- [ ] A record with key starting `firebase:authUser:` exists while signed in, and is gone after signing out.
- [ ] `value` has `uid` (string), `email` (string with @), `displayName` (string or null). Note only field names and types, not values.
- [ ] Doctors on Google login (not OTP): same record exists, or note the difference.
- [ ] Extension side: service worker console shows a `login` event queued for the signed-in email; sign out shows `logout`.
- [ ] Two Pulse tabs open: no duplicate login events.
- [ ] Open a URL with `?doctor_email=x@y.z`: next heartbeat has `email: null`, `impersonating: true`.

Result: PASS / FAIL, and the actual record shape if it differs.

## 2. webRequest body visibility for Start/End

Use a test consult only, or a staging Pulse origin cloned in a scratch copy of the manifest. If no safe test consult exists, skip the click and record "not run".

- [ ] With a test consult, Start produces `encounter_open` with `encounter_id` equal to the consult uid (compare with Network tab, request payload field `consult_uid`).
- [ ] End produces `encounter_close` with the same `encounter_id`.
- [ ] If `encounter_id` is null and `reason` is `body_unavailable`, record the Chrome version. That means the fallback path applies and ETA must join `prescription_ref` to the consult server-side.
- [ ] A failed request (offline) produces no event.
- [ ] No event contains individual_uid, names or any other body field.

Result: PASS / FAIL / FALLBACK (with Chrome version).

## 3. CSP effect

- [ ] Pulse loads normally with the extension on (no console CSP errors attributable to the extension).
- [ ] Events reach the ingest sink: the POST comes from the service worker (Network tab of the service worker console), not from the page. The page CSP `connect-src` must not block it.
- [ ] Content script runs (a `login` event appears within 30 s of load).
- [ ] Extension does not appear in the page's DOM or globals.

Result: PASS / FAIL, with any console error text (no tokens).

## Also check

- [ ] Idle: leave the Mac untouched for 2 minutes: `idle` event; touch it: `active`. Lock screen: `locked`.
- [ ] Heartbeat about every 30 s while signed in.
- [ ] Block the ingest host, wait, unblock: queued events arrive in one batch, in order, none older than 24 h.
