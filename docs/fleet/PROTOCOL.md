# Fleet control plane: wire protocol v1 (TS-H3 #40, server side)

Audience: the Swift helper builder. Everything here is implemented and tested in `lib/fleet/*` and `app/api/fleet/*` on branch `gating/ts-h3`
(tests: `tests/unit/fleet-control-pg.test.ts`, `tests/unit/fleet-jws-vector.test.ts`). Base URL: the production origin of the app. HTTPS 443 only, honour the system proxy.
All bodies are UTF-8 JSON. All responses carry `cache-control: no-store`. Error bodies are `{"ok":false,"error":"<code>"}`; success bodies carry `"ok":true`.

## 1. Identity
- The helper generates one Ed25519 keypair (RFC 8032). The server stores only the PUBLIC key, as standard base64 (with padding) of the 32 raw bytes: exactly 44 characters.
- One device per `install_id`, forever. Same key again is idempotent. A different key for the same install is `409 KEY_CONFLICT` (rotation is a later slice; do not overwrite).
- `device_id` = `dev_` + 24 lowercase hex chars, assigned by the server at registration.

## 2. Token format (JWS compact, EdDSA)
`base64url(header) . base64url(payload) . base64url(signature)`; base64url has NO padding and no `+` `/`. The signature is Ed25519 over the ASCII bytes of `<b64url(header)>.<b64url(payload)>`.
The server parses strictly: three parts, canonical base64url (re-encoding must give identical text), a 64-byte signature, header and payload JSON objects, total length <= 4096.
- header: `{"alg":"EdDSA","typ":"JWT","kid":"<device_id>"}` (`kid` must equal `iss`)
- payload for every device request:

| claim | rule |
|---|---|
| `iss` | the device_id |
| `aud` | `evenscribe-fleet` |
| `iat`, `exp` | integer unix SECONDS; `0 < exp-iat <= 300`; accepted while `exp >= now-120` and `iat <= now+120` |
| `jti` | 8..64 chars `[A-Za-z0-9_-]`, fresh per request (a UUID is fine). Accepted ONCE per device |
| `htm` | `GET` or `POST`, the request method |
| `htu` | the request PATH only, no host, no query: `/api/fleet/poll` or `/api/fleet/results` |
| `bsha` | POST only: `base64url(SHA-256(raw request body bytes))`. MUST be absent on GET |

Send it as `Authorization: Device <token>`. Build a NEW token for EVERY request, including retries (a re-sent token is `401 replay`). Sign the body bytes you actually send; do not re-serialise.

## 3. POST /api/fleet/register
Headers: `Authorization: Bearer <room session JWT>` (the app's `eta_room_session` value, aud "room"; obtained over XPC), `content-type: application/json`. Body <= 8 KB:
```
{"install_id":"<room_install.install_id>","machine":"<hostname>","hw_model":"Macmini9,1","serial_hash":"<64 lowercase hex, optional>",
 "helper_version":"0.2.0","key_alg":"ed25519","public_key":"<44-char base64>","proof":"<registration proof JWS>"}
```
`hw_model` <= 64, `helper_version` <= 32 chars, both optional. `machine` must equal the install's hostname (after the repo's normalisation) when the install has one.

Registration proof (proves you hold the private key; signed by the NEW key). header `kid` = `install:<install_id>`; payload:
`iss`=install_id, `aud`=`evenscribe-fleet-register`, `iat`, `exp` (same rules as above), `jti`, `htm`=`POST`, `htu`=`/api/fleet/register`, `pk`=`base64url(SHA-256(32 raw public-key bytes))`. No `bsha` (the proof sits inside the body).
A proof is single-use: on any retry build a fresh proof.

Responses: `201 {"ok":true,"device_id","server_key_ids":["fk1","fk2"],"poll_url":"/api/fleet/poll","registered_at"}` (first time) or `200` (same key again, same device_id).
Errors: 400 `bad_install_id|bad_machine|bad_hw_model|bad_serial_hash|bad_helper_version|bad_key_alg|bad_public_key|bad_proof|bad_json|bad_body` · 401 `room_auth` (missing/expired/invalid room JWT) or a proof failure
`bad_proof|bad_signature|bad_audience|expired|not_yet_valid|ttl_too_long|request_mismatch|proof_key_mismatch|replay` · 403 `room_mismatch|machine_mismatch` · 404 `unknown_install` · 409 `KEY_CONFLICT|REVOKED|RETIRED` · 413 `too_large` · 503 `db`.
On 409 `REVOKED` or `RETIRED` STOP: do not retry; an operator must re-enrol.

## 4. GET /api/fleet/poll?wait=25
`wait` is an integer 0..25 (default 25); anything else is `400 bad_wait`. The server holds the request up to `wait` seconds, checking about every 1.5 s, and answers the moment a command is deliverable.
Allow the HTTP client a timeout of at least 35 s (server maxDuration 35).
`200`:
```
{"ok":true,"server_time":"<ISO-8601 ms Z>","kill_switch":{"global":false},"commands":[<envelope v2>, ...]}
```
`kill_switch.global:true` (optional `reason`): no commands are served; keep polling at the normal cadence. An empty `commands` after the wait is NORMAL: re-poll immediately.
Errors: 401 with one of `malformed|unknown_device|revoked|bad_signature|bad_audience|expired|not_yet_valid|ttl_too_long|request_mismatch|replay` · 400 `bad_wait` · 503 `db`.
- `401 revoked` or `401 unknown_device`: the key is dead. STOP polling, report it through the app (the app reports `helper_state` on its bench poll, section 9), wait for re-enrolment.
- `401 expired|not_yet_valid`: your clock is off (>120 s); fix time, do not hammer.
- `401 replay|bad_signature|request_mismatch|malformed`: a client bug; log, back off.
- Other errors and network failures: backoff 1, 2, 4 ... 60 s, then re-poll. Reset to immediate re-poll after any 200.

### Envelope v2 as served
```
{"v":2,"cmd_id":"…","device_id":"dev_…","machine":"…","verb":"…","params":{…},"issued_at":"2026-10-10T07:00:00.000Z","expires_at":"2026-10-10T07:05:00.000Z",
 "nonce":"<24-char base64 of 16 bytes>","issuer":{"kind":"operator|steward|bot","id":"…"},"approval_ref":"…"|null,"key_id":"fk1","signature":"<88-char base64>"}
```
Every field is served as the issuer signed it (`machine` is the value stored when the command was queued, never the device's current registration), with one exception: `params` is stored as jsonb, so its KEYS COME BACK IN A DIFFERENT ORDER. Verify per PRD §5.3, which canonicalises (sorts keys) before checking the signature, so this is harmless; never verify over the raw bytes of the response. Timestamps are ISO-8601 UTC with EXACTLY milliseconds; `approval_ref` is ALWAYS present (string or `null`). The signature covers the canonical JSON of the envelope MINUS `signature`
(see section 8 for the exact canonical form and the verifier). The signature is REAL from protocol v1.1 (TS-H4): the server signs every command with its Ed25519 key.
Delivery is AT-LEAST-ONCE: a delivered command with no result is offered again after 30 s until it expires. Deduplicate on `cmd_id` and `nonce`. Never execute after `expires_at`; report `refused/expired` instead.
At most 10 commands per poll, oldest first. A command is only ever served to the device it was issued to.

## 5. POST /api/fleet/results
Body <= 16 KB. Token has `htm` POST, `htu` `/api/fleet/results`, `bsha` of the exact body.
```
{"cmd_id":"…","device_id":"<yours>","outcome":"ok|refused|failed|unsupported","reason":null|"<[a-z0-9_]{1,64}>","started_at":"<ISO>","finished_at":"<ISO>",
 "detail":{…closed per-verb object, <= 4096 bytes serialised, keys [a-z_][a-z0-9_]*, depth <= 4, NO PHI…},
 "upload":null|{"kind":"diag_bundle","r2_key":"fleet/diag/<device_id>/<anything>","bytes":412331}}
```
`device_id` must equal the signer. `upload.r2_key` must start with `fleet/diag/<your device_id>/` (the file upload itself is a later slice).
Responses: `200 {"ok":true,"duplicate":false}`; an identical resend (same fields; `detail` compared as JSON, key order irrelevant) is `200 duplicate:true`, so retry freely after a lost response. Errors: 400 `bad_*|bad_json` · 401 (as poll) · 403 `device_mismatch` ·
404 `unknown_command` (no such command, OR it was issued to another device: indistinguishable) · 409 `not_delivered` (it never went out in a poll) | `RESULT_CONFLICT` (a different answer was already recorded) · 413 · 503.
A result may be sent after `expires_at` (e.g. `refused`/`expired`) as long as the command was delivered.

## 6. Replay protection, time and limits
- `fleet_jti` keeps each (signer, jti) for 15 minutes, longer than the 540 s a token can ever be accepted (`iat` up to 120 s in the future + 300 s lifetime + `exp` up to 120 s in the past). A second use is `401 replay`.
- Server clock is authoritative for expiry; `server_time` in every poll answer lets the helper measure its skew.
- The server NEVER sends anything unasked: commands exist only as rows an authorised issuer queued. There is no endpoint that accepts a command, a shell string or a file path. The verb catalogue is closed (`lib/fleet/verbs.ts`).

## 7. Test vectors (verified by tests/unit/fleet-jws-vector.test.ts; "now" = 1760000100)
```
private seed (hex)   0707070707070707070707070707070707070707070707070707070707070707
public key (base64)  6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=
SHA-256(pubkey) b64url _oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk
device_id            dev_000000000000000000000001   install_id inst_example
```
The three example tokens (poll, results, registration proof) are in `tests/unit/fleet-jws-vector.test.ts`, which asserts them against this key. They are not repeated here: they are
throwaway fixed-seed tokens, kept in one place so a secret scanner has a single allow-listed spot to know about.
Claims, in the order the vectors use: poll `iss=dev_000000000000000000000001, aud=evenscribe-fleet, iat=1760000000, exp=1760000300, jti=11111111-2222-3333-4444-555555555555, htm=GET, htu=/api/fleet/poll`;
results the same with `jti=66666666-7777-8888-9999-000000000000, htm=POST, htu=/api/fleet/results, bsha=<below>`; proof `iss=inst_example, aud=evenscribe-fleet-register, jti=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee, htm=POST, htu=/api/fleet/register, pk=<SHA-256(pubkey) above>` with header `kid=install:inst_example`.
The results body (no trailing newline) and its hash:
```
{"cmd_id":"cmd_x","device_id":"dev_000000000000000000000001","outcome":"ok"}
bsha = on8FSnX0CaYo7SsNSlFyxaqytNjjSkAxzSyDEGghZ7o
```
Ed25519 is deterministic, so a correct client reproduces these tokens byte-for-byte from the seed and the claims in the order shown (`JSON` key order as listed in section 2; the server does not require an order, the vectors fix one).

## 8. Envelope v2: signing, canonical form, catalogue, verifier (TS-H4 #41; protocol v1.1)

### 8.1 What is signed
`signature` = standard base64 (88 chars, padded) of the Ed25519 signature over the UTF-8 bytes of the CANONICAL JSON of the envelope WITHOUT the `signature` field. The remaining 12 fields are all present and signed:
`v` (2) · `cmd_id` · `device_id` · `machine` · `verb` · `params` · `issued_at` · `expires_at` · `nonce` · `issuer` {`kind`,`id`} · `approval_ref` (string or `null`, always present) · `key_id`.
The helper compiles in TWO server public keys (`fk1`, `fk2`: current and next) and verifies with the one named by `key_id`. The signing key is never served. Unknown `key_id` = `bad_signature`.

### 8.2 Canonical JSON (what you must reproduce byte for byte)
- Objects: keys sorted bytewise ascending at every depth; every key matches `^[a-z_][a-z0-9_]*$` (so no integer-like keys; an envelope with another key shape is malformed/bad_signature).
- No whitespace between tokens. Output is UTF-8.
- Numbers: INTEGERS ONLY, decimal, no exponent, no leading zeros, no `-0`, magnitude <= 2^53-1. The server never signs a float; if you receive one, the signature cannot be valid. (The two fractions in the PRD are integer percents: `input_volume_pct`, `volume_pct`, 0..100.)
- Strings: `"` and `\` escaped as `\"` and `\\`; control characters U+0000..U+001F as `\b \f \n \r \t` or `\u00xx` (lowercase hex); EVERYTHING ELSE LITERALLY (non-ASCII, U+007F, U+2028, U+2029 are not escaped). Lone surrogates are refused. (This is ECMAScript `JSON.stringify` string escaping. Swift's `JSONSerialization`/`JSONEncoder` do NOT match it by default: write the serializer by hand.)
- `true`, `false`, `null` literals; arrays keep their order.
- Note: the poll response is ordinary JSON; `params` key ORDER in it is not the signed order. Re-canonicalise the parsed envelope, never hash the received bytes.

### 8.3 The catalogue: 20 verbs, closed params (anything else is `verb_not_allowed` / `bad_params`)
| verb | runs | privileged | params (all other keys refused) |
|---|---|---|---|
| `helper_status` | helper | no | `{}` |
| `collect_diag` | helper | no | `scope` (required: `recorder\|audio\|power\|chrome\|helper`), `log_lines` (int 1..500) |
| `report_diag` | app (XPC) | no | `{}` |
| `coreaudiod_reset` | helper | YES | `{}` |
| `usb_reseat` | helper | YES | `port` (string 1..32, optional; helper answers `unsupported` until hardware exists) |
| `restart_recorder` | helper | YES | `force` (boolean, optional) |
| `reload_launchagent` | helper | YES | `{}` |
| `wake` | helper | no | `{}` |
| `list_audio_inputs` | app | no | `{}` |
| `select_audio_input` | app | no | `device_uid` (required, string 1..128), `input_volume_pct` (int 0..100) |
| `pmset_enforce` | helper | no | `{}` (the baseline is compiled into the helper: sleep 0, disksleep 0, displaysleep 0, powernap 0, autorestart 1, womp 1; the result reports the diff) |
| `schedule_poweron` | helper | no | `time` (optional, `HH:MM` 24-hour zero padded; the helper uses 07:05 when absent) |
| `chrome_policy_apply` | helper | no | `machine_id` (the machine's normalised hostname, 1..128), `room` (the room's name, 1..128), `token` (printable ASCII 8..256, no spaces), `update_url` (optional; only `https://www.evenscribe.app/ext/[<dir>/]update.xml`). **The server fills `machine_id`, `room` and `token` itself** (see 8.8); an operator may only suggest `update_url` |
| `chrome_relaunch` | helper | YES | `profile` (optional, string 1..64). **Refused 07:30-21:30 IST even with an approval_ref** (`clinic_hours_no_chrome_restart`) |
| `open_pulse` | helper | no | `profile` (required, string 1..64) |
| `policy_cycle` | helper | YES | `profile` (optional, string 1..64). Same clinic-hours refusal as `chrome_relaunch` |
| `retire_legacy` | helper | no | `component` (required, only `presence-guard`; `kiosk-health` is NOT retirable), `purge_secrets` (optional boolean) |
| `self_test` | app | no | `volume_pct` (int 0..100, optional) |
| `pieces_inventory` | app | no | `since` (ISO-8601 ms Z string, optional) |
| `pieces_reupload` | app | no | `since` (ISO-8601 ms Z string, optional) |
Strings must have no control characters and no surrogates. The split "3 diagnose + 5 helper + 2 power + 5 chrome/legacy + 5 app" follows #41/#42/#43 (`wake` is #43's, listed with the helper verbs); if the helper build disagrees about where a verb runs, say so: it is one line in `lib/fleet/verbs.ts`.

### 8.4 Approval (`approval_ref`)
`approval_ref` matches `^[A-Za-z0-9_-]{3,64}$`. The server REFUSES to issue a privileged verb inside clinic hours (07:30 inclusive to 21:30 exclusive, IST, every day) without one, and `restart_recorder` with `force:true` at ANY hour without one.
The helper re-applies the same rule as its local gate `clinic_hours_needs_approval`.

**Chrome restarts (#44), also enforced at enqueue:** `chrome_relaunch` and `policy_cycle` close the doctors' Pulse window, so the server refuses them from 07:30 to 21:30 IST EVEN WITH an `approval_ref` (HTTP 409 `clinic_hours_no_chrome_restart`). The helper applies the same rule as its local gate (`clinic_hours_no_chrome_restart`). Outside those hours they need no approval (they still count as privileged for the 10-per-hour ceiling).

**Session gate (#42), also enforced at enqueue:** while the device's room has an OPEN session (`bench_session` recording or paused), `coreaudiod_reset`, `usb_reseat`, `restart_recorder` and `reload_launchagent` are refused with `session_open` (HTTP 409) unless an `approval_ref` is given, and `restart_recorder` additionally needs `force:true`. The helper re-checks the live session itself (local gate `session_open`).

**Ceilings per device, also enforced at enqueue (HTTP 429 `rate_limited`):** at most 1 `coreaudiod_reset` per 30 minutes and at most 10 privileged verbs per hour, counted from issue time (a command that expired undelivered does not count). The enqueue count is best effort under concurrency; the helper compiles in the same numbers as its own last line of defence (verifier step 9). The server records that the reference was supplied; it does not (and cannot) check Vinay's GO itself.

### 8.5 Verifier order (the helper must refuse at the FIRST failing step; reason codes go in the result)
1 `malformed` (not exactly the 13 fields / wrong types / bad nonce / bad issuer kind) · 2 `bad_signature` (also: unknown `key_id`) · 3 `expired` (`expires_at - issued_at` <= 900 s, and `issued_at - 120 s` <= now <= `expires_at`) ·
4 `replay` (nonce among the last 1,000 seen, kept root-only) · 5 `machine_mismatch` (`device_id` is not yours, or `machine` differs from yours after the repo's hostname normalisation) · 6 `verb_not_allowed` · 7 `bad_params` ·
8 local gates (`session_open`, `no_console_user`, `clinic_hours_needs_approval`, `hid_active`) · 9 `rate_limited` (<= 10 privileged verbs per hour; <= 1 `coreaudiod_reset` per 30 min) · 10 `kill_switch`.
A refusal is reported as a result with `outcome:"refused"` and `reason` = the code. The reference implementation is `verifyEnvelope` in `lib/fleet/envelope.ts`.

### 8.6 Who can queue a command (server side)
Exactly one route: `POST /api/admin/fleet/commands`, admin cookie only, body `{device_id, verb, params?, approval_ref?, ttl_s?}` (ttl 30..900, default 300). One outstanding command per (device, verb), enforced by the database (migration 0151: partial unique index on queued/delivered rows), so parallel requests yield one command and `409 outstanding` for the rest; a command past its TTL stops counting. Every enqueue writes its `fleet_audit` row in the SAME statement as the command (both land or neither does). A delivered command whose TTL passed before its answer can still be answered (`refused/expired`). Nothing queues automatically.
`GET /api/admin/fleet` (admin) and the MCP view `scribe_kiosks view=helper|commands` are read-only and never expose signatures, nonces, keys or result details.

### 8.7 Vectors (fixed FAKE key: seed 0x0b x 32; verified by tests/unit/fleet-h4-envelope.test.ts, which also checks them against an independent node script)
```
private seed (hex)     0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b
public key (base64)    Zr5+Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo=      (key_id "fk1")
```
Vector A (a diagnose command, `approval_ref` null). Canonical bytes (one line, no trailing newline):
```
{"approval_ref":null,"cmd_id":"cmd_00000000000000000001","device_id":"dev_000000000000000000000001","expires_at":"2026-10-10T07:05:00.000Z","issued_at":"2026-10-10T07:00:00.000Z","issuer":{"id":"op_example","kind":"operator"},"key_id":"fk1","machine":"EXAMPLE-MAC","nonce":"AAECAwQFBgcICQoLDA0ODw==","params":{"log_lines":200,"scope":"audio"},"v":2,"verb":"collect_diag"}
```
signature:
```
rvpslFmkoahEZ7Mng3sQodi3DMeNwysqjwzx0KUk62hODq+SeDJYH/lKo68Kxpyd0rZuYtunCSlhuCaga7+aAQ==
```
Vector B (forced restart with an approval_ref; same key): the envelope is vector A with `cmd_id` `cmd_00000000000000000002`, `verb` `restart_recorder`, `params` `{"force":true}`, `approval_ref` `go_example1`, `nonce` `EBESExQVFhcYGRobHB0eHw==`, `issued_at` `2026-10-10T07:10:00.000Z`, `expires_at` `2026-10-10T07:15:00.000Z`.
signature:
```
5OGLMDD9y38GH6MO0eX4Y+dFqVGYqrFm7Ya3uClkmq1ChctvKmaWOUT/CP+IPubuC41cQKItO55iMhLCNwinDg==
```

## 9. What the APP reports about the helper and the power schedule (TS-H6 #43, TS-H9 #46; read-only on the server)
**There is no helper heartbeat.** The helper has no server credential for telemetry. Everything the server learns about the helper, the power schedule and the console arrives on the room APP's own bench poll
(`GET /api/bench/commands`, the ~1.5 s poll with the room session cookie that already carries `install_id`, `app_version`, ...). These query fields are OPTIONAL; an app that omits them leaves the last
reading in place (a poll without a field never clears it). Each is validated on its own and dropped if malformed; an unknown or malformed value is "not reported", never a refusal of the poll.

| query field | value | stored as |
|---|---|---|
| `helper_version` | version string, `^[0-9A-Za-z][0-9A-Za-z._+-]*$`, <= 32 | `room_install.helper_version` |
| `helper_registration` | `enabled` \| `requires_approval` \| `not_registered` | `helper_registration` |
| `helper_xpc_ok` | `true` \| `false` | `helper_xpc_ok` |
| `helper_state` | `ok`, or a short lower-case reason code `^[a-z][a-z_]{0,31}$` (e.g. `xpc_down`, `not_registered`, `stopped`). `ok` is the only healthy value | `helper_state` |
| `console_user` | `true` \| `false`: a console (GUI) user was logged in at this poll | `console_user` |
| `power_schedule` | text <= 64, no control characters, e.g. `MTWRFSU 07:05` | `power_schedule` |
| `pmset_drift` | comma-separated names of pmset settings that drifted from the baseline, each `^[a-z0-9_.-]{1,48}$`, at most 20; the empty string means "none drifted" | `pmset_drift` (jsonb array) |

The server stores them AFTER it has answered the poll (a deferred, best-effort write that can neither delay nor fail the poll); the next poll's answer never waits on it.

`helper_bad_since` is NOT reported by the app: the server sets it when `helper_state` is not `ok` (or `helper_xpc_ok` is `false`) and clears it on the first good reading; a poll that carries neither field leaves it alone.
(Field spellings are the server's definition; the server ignores unknown query keys, so a client that spells one differently simply reports nothing for it.)

**Attention rules the server derives (3 minutes = 180 s):**
- `helper_missing` (amber): the app is polling (a bench poll within 3 min) AND it has reported `helper_state` other than `ok`, or `helper_xpc_ok` false, continuously for over 3 min. A room whose app has never reported helper state raises nothing.
- `app_missing` (red): no bench poll for over 3 min, between 07:30 and 21:30 IST, for an install whose last report had `console_user` true. Never raised outside those hours or for an install that never polled. The attention list additionally drops it when R1 already reports the whole Mac unreachable (one red row per fault); the per-device Bench / MCP view shows it from the poll alone.

Bench (the helper panel) and `scribe_kiosks view=helper` show these fields and the derived state read-only. The server never sends a command because of them.

### 8.8 The extension token in `chrome_policy_apply` (TS-H7 #44)
The token is the extension's ingest token, SERVER-SIDE CONFIG (the deploy environment), never operator input. When an operator enqueues `chrome_policy_apply` the server builds `{machine_id, room, token[, update_url]}` itself, signs that, and stores the command with `token` replaced by the marker
`"[redacted:server_token]"`; the database, the audit log, the admin and MCP views, the enqueue response and the logs never hold the real value. The real value is put back ONLY into the envelope served to the target device's own authenticated `GET /api/fleet/poll`, so the
helper receives exactly the params that were signed (verify as usual). Consequences the helper may see: (a) if the server's token is rotated between enqueue and delivery the delivered token differs from the signed one and the envelope fails `bad_signature` (re-issue); (b) while the server has no token
configured the command is simply not delivered (it stays queued until it expires). The helper must never log, echo or put the token in a result `detail`.

## 10. POST /api/kiosk-health from the app with the device credential (TS-H10 #47)
The helper has no server credential, so the room APP posts the helper's spooled events: `POST /api/kiosk-health` with `Authorization: Device <device JWS>`: the SAME per-device Ed25519 token it signs for `/api/fleet/*` (section 2: `aud` `evenscribe-fleet`, `htm` POST, `htu` `/api/kiosk-health`, `bsha` = hash of the exact body, single-use `jti`; invalid = 401). (Until TS-H8 the server wrongly checked the room session JWT here; the room session JWT is NOT accepted under `Device`.) The body and event shapes are exactly the
daemon's: `{ "events": [ { machine, room_id, install_id, boot_id, seq, source, kind, ts, payload } ] }`, 1..500 events, ~3 MB. The standalone daemon keeps using `Authorization: Bearer <ingest token>` unchanged.
A Device post is confined to its own device: every event must have `source` `"helper"`, a `machine` equal to THIS device's machine (hostname compared after the usual normalisation) and a `room_id` that is absent or this device's room. `steward.result` events are allowed (they only touch tickets of that same machine). Each event that is not acceptable is rejected by name in `rejected_reasons`
(`wrong_source`, `machine_not_in_room`, `room_mismatch`) and the rest of the batch is still stored. Idempotency is on `(machine, boot_id, seq, source)` (migration 0156 added `source`: the helper and the daemon each count their own `seq`, so a helper event is never swallowed as a duplicate of a daemon event); replays are `duplicates`.
**Cross-source de-duplication (shadow period), one-to-one:** only the standalone daemon (`source` "daemon") and the helper (`source` "helper") are ever de-duplicated against each other; events of any other source are never touched. An incoming event is absorbed ONLY by a stored event of the OTHER source of that pair
with the same Mac (any hostname spelling), the same `kind` and `ts` within 2 s (inclusive). Pairing is ONE-TO-ONE: a stored event absorbs at most one incoming event (nearest `ts` first), so several distinct events around one stored event are NOT all lost: with one daemon event stored, three distinct helper events at -1.5 s, 0 and +1.5 s give
2 accepted and 1 deduped. Twins already used by earlier batches stay used. An absorbed event is counted in the response's `deduped` and recorded (identity only) in `kiosk_health_dedupe`; re-sending an absorbed event (a replay after a lost response) is absorbed again without using another twin. Events of the same source are never twins of each other.
If the de-duplication lookup itself fails the batch is stored as is (a duplicate is better than a lost event).
Response: `200 {ok, accepted, duplicates, deduped, rejected, rejected_reasons}`; `503 {error:"db"}` on a database fault (keep the spool and retry); `401` unauthorized; `413` body over 3 MB.

## 11. The signed release record (TS-H8 #45, room app 0.1.37)
`GET /api/room-recorder/release?channel=stable` (room session cookie, as before) keeps its four fields (`version`, `sha256`, `size_bytes`, `blob_url`) and may add TWO more: `record` (a JSON object) and `record_signature` (standard base64 of a 64-byte Ed25519 signature).
They are present only when (a) an admin has opened that version to a rollout stage, (b) the room has an active registered helper device (the server maps the room session to the newest active device of the room; the app sends nothing new), and
(c) the record passes the app's own parser. Otherwise only the four fields are returned and the user-level updater works as before.
**Unsigned:** if the server has no signing key (`FLEET_COMMAND_SIGNING_KEY` unset) the record is returned with `record_signature: null`. **The app must refuse it** (and does: it only hands the helper a record that came with a signature, and the helper verifies the signature against its compiled-in `fk1`); the user-level updater is unaffected.
The record is EXACTLY these sixteen fields: `v` (1), `version`, `channel` (`stable`|`test`), `pkg_url` (https, our host or `*.public.blob.vercel-storage.com`, <= 512, no credentials/port/fragment), `pkg_sha256` (64 lowercase hex), `pkg_size` (integer, 1..400 MiB),
`min_helper`, `cohort` (`home_office`|`audiometry`|`opd1`|`pct`|`all`), `rollout_pct` (0..100), `device_cohorts` (<= 8 names), `device_id`, `machine`, `issued_at`, `expires_at` (ISO ms Z, a ONE-HOUR window), `nonce` (fresh 16 random bytes, base64), `key_id` (`fk1`).
Signed bytes = the canonical JSON of the record (section 8.2). **Eligibility is the app's call**: `all` = everyone; a named cohort = devices whose `device_cohorts` contain it (set by an admin); `pct` = devices whose bucket < `rollout_pct`, where bucket = first four bytes (big-endian) of SHA-256(`"<device_id>|<version>"`) modulo 100.
Which stage a version is in changes ONLY by an admin action (audited): nothing rolls out by itself. Vector (fixed FAKE seed 0x0b x 32, key id fk1, public key in 8.7; for device `dev_000000000000000000000001`, version `0.1.37`, this device's bucket is 48):
```
canonical record bytes:
{"channel":"stable","cohort":"pct","device_cohorts":["audiometry","home_office"],"device_id":"dev_000000000000000000000001","expires_at":"2026-10-11T11:00:00.000Z","issued_at":"2026-10-11T10:00:00.000Z","key_id":"fk1","machine":"EXAMPLE-MAC","min_helper":"0.2.0","nonce":"AAECAwQFBgcICQoLDA0ODw==","pkg_sha256":"abababababababababababababababababababababababababababababababab","pkg_size":123456789,"pkg_url":"https://www.evenscribe.app/dl/room-recorder-0.1.37.pkg","rollout_pct":50,"v":1,"version":"0.1.37"}
record_signature:
PyQlGaM2bOoJqraj93geRAdu67DdscrsOQGF7ZntnMiT2x0a0LsQJlZVgEf0d7XzpXmN33tStc7cyTnmMM8vCw==
```
Admin actions (admin cookie only, each audited in `fleet_audit`): `POST /api/admin/fleet/releases/rollout` `{version, channel, pkg_url, pkg_sha256, pkg_size, min_helper?, cohort, rollout_pct?}` sets the stage (the version must be a published, un-withdrawn macOS release; the pkg fields are the admin's statement of what the helper downloads, validated for shape and host, not fetched);
`POST /api/admin/fleet/releases/cohorts` `{device_id, cohorts:[home_office|audiometry|opd1,...]}` sets a device's cohorts; `GET /api/admin/fleet/releases` reads both.

## 12. Steward tickets with the device credential (TS-H8 #49)
`GET /api/steward/tickets?machine=<machine>` accepts `Authorization: Device <device JWS>` (`htm` GET, `htu` `/api/steward/tickets`, no `bsha`, single-use `jti`) as well as the old bearer. A Device caller may only ask for ITS OWN machine (`machine` equal to the device's machine after normalisation, else 403 `machine_mismatch`).
The response is unchanged (`{ok, key_id, tickets:[{ticket, signature}]}`, tickets signed by the existing steward key `6275a79b`; the server does not yet serve v2 `{envelope}` items there). Results go back as `steward.result` events on `POST /api/kiosk-health` (section 10).
A `steward.result` whose `ticket_id` is a fleet command's `cmd_id` and whose `nonce` is that command's nonce (how a v2 item is reported: INFERRED, agreed with the app builder) records the command's result when the command was delivered to a device of that machine: `done`->`ok`, `failed`->`failed`, `rejected`/`expired`->`refused`, `unsupported`->`unsupported`.

## 13. Bench poll: the helper's update progress (TS-H8 #45)
Three more OPTIONAL query fields on the app's bench poll, handled like section 9 (validated one by one, dropped if malformed, last reading kept when omitted): `helper_update_step` (`^[a-z][a-z_]{0,31}$`), `helper_update_version` (version string <= 32), `helper_update_result` (`^[a-z][a-z_]{0,31}$`). Display only (Bench, `scribe_kiosks view=helper`).
