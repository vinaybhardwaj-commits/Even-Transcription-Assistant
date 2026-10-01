# Notes: ambiguities resolved on the safer reading

1. **Ingest host.** `manifest.json` `host_permissions` is `https://pulse.even.in/*` and `https://www.evenscribe.app/*` (the ETA sink, set for the pilot install; it was a placeholder before).
2. **Route-derived encounters.** R3 says `prescription_uid` becomes an opaque ref, and `consult_uid` comes only from webRequest. So an `encounter_open`/`encounter_close` is emitted when a visible Pulse tab enters or leaves a route with a `prescription_uid`. These carry `prescription_ref` and `encounter_id: null`. Start/End webRequest events carry `encounter_id` (and the current `prescription_ref`, usually null on Start because the draft does not exist yet). ETA joins the two. The same visit can therefore produce two opens and two closes.
3. **Focus events.** The schema has no focus event type. A change in tab focus emits one `heartbeat` with the new `tab_focus`.
4. **Heartbeat and locked.** `locked` is its own event. Heartbeats continue while locked (Chrome may suspend timers on sleep).
5. **Reason set (R10).** `reason` is the sorted, deduped, comma-joined set of active status codes, or `null` when empty. Codes: `body_unavailable`, `identity_unreadable`. `identity_unreadable` is on every event while the Firebase record fails the schema check and the session is not impersonating. It is never added during impersonation (`impersonating: true` is the signal there) and never on a `logout` of a known doctor. `body_unavailable` applies to Start/End events whose body could not be parsed. `events.js` accepts exactly `null`, either code, or both joined.
6. **Impersonation.** The Firebase record is not read while impersonating. Login/logout tracking is paused. Events during impersonation carry email null, display_name null, impersonating true.
7. **Multiple tabs.** Route events use whichever visible tab reported last. Hidden tabs' routes are ignored. Identity is taken from any tab.
8. **Body shape.** `consult_uid` is read at the top level, or under `data` as a fallback. Values must match `[A-Za-z0-9_.:-]{1,128}` or the body counts as unavailable. `prescription_ref` must match `[A-Za-z0-9_-]{1,128}`.
9. **Pending Start/End requests** are kept in worker memory between `onBeforeRequest` and `onCompleted`. If the worker restarts in between, that event is lost.
10. **Server 4xx.** 400/413/422-type answers drop the batch (a poison batch would block the queue for 24 h). 401, 403, 408, 425, 429 and 5xx retry.
11. **Unconfigured.** No `ingest_url` or `token`: events queue, nothing is sent. `ingest_url` must be `https://`.
12. **Email** is lower-cased and trimmed. `uid` is read for the schema check and to detect two different accounts in the record, and never leaves the content script.
13. **Alarm period** 0.5 min needs Chrome 120 or later (`minimum_chrome_version`).
14. The Pulse monorepo copy and ETA repo were not touched. The scout report was read only.
