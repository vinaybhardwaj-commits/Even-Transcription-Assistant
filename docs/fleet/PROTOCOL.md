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
- `401 revoked` or `401 unknown_device`: the key is dead. STOP polling, report via heartbeat, wait for re-enrolment.
- `401 expired|not_yet_valid`: your clock is off (>120 s); fix time, do not hammer.
- `401 replay|bad_signature|request_mismatch|malformed`: a client bug; log, back off.
- Other errors and network failures: backoff 1, 2, 4 ... 60 s, then re-poll. Reset to immediate re-poll after any 200.

### Envelope v2 as served
```
{"v":2,"cmd_id":"…","device_id":"dev_…","machine":"…","verb":"…","params":{…},"issued_at":"2026-10-10T07:00:00.000Z","expires_at":"2026-10-10T07:05:00.000Z",
 "nonce":"<24-char base64 of 16 bytes>","issuer":{"kind":"operator|steward|bot","id":"…"},"approval_ref":"…"|null,"key_id":"fk1","signature":"<88-char base64>"}
```
Every field is served as the issuer signed it (`machine` is the value stored when the command was queued, never the device's current registration), with one exception: `params` is stored as jsonb, so its KEYS COME BACK IN A DIFFERENT ORDER. Verify per PRD §5.3, which canonicalises (sorts keys) before checking the signature, so this is harmless; never verify over the raw bytes of the response. Timestamps are ISO-8601 UTC with EXACTLY milliseconds; `approval_ref` is ALWAYS present (string or `null`). The signature covers the canonical JSON of the envelope MINUS `signature`
(keys sorted bytewise at every depth, no whitespace, UTF-8, integers only; PRD §5.3). Verify per PRD §5.3 (this slice does not sign; the signer and server keys arrive with #41).
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
