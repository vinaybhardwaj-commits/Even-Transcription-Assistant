# SPINE-S1-R4-BUILD (branch spine/s1-signals, on 937e0583; no rebase)
## Changed
- tools/eta-spine/phi-rules.json, lib/spine/phi-screen.ts: consult_uid = `pqm_`+22 hex (pqm_windows.py:20) | `[a-z0-9]{20,32}` (lib/buddy/relay.ts:82), 7-digit guard kept. consult_key enc part likewise. No uuid form: no producer in the repo mints one. enc_ramesh, enc_ramesh9845 now fail. New id key `pulse_enc_id` (proxies pulse, pqm only, via `id_key_proxies`), placeholder `^(?!.*[0-9]{7})[A-Za-z0-9_-]{8,64}$`, PENDING-PROBE (.bc/PULSE-ENC-PROBE.md did not exist).
- Reason codes (TS `refuseValueReason`, py `Refused.reason`; server answer unchanged): source_key[.digit_run], room_id, attrs_ids.<allowlisted key>[.digit_run|.proxy], attrs_ids.unknown_key (key name never echoed), attrs_ids.not_object, close_reason, quality, text_key, attrs_key, too_deep.
- tools/eta-spine/post_signals.py: dry-run prints `refused_by_reason` (never a value); `conflict` and rc 3 kept when a later batch is `skipped`; keyless rows counted as skipped (were dropped); new `--kind nemotron_window` (rows of diarize_nemotron_window; latest per window_id; status ok|empty with audio_ms>0; t_open = start_ms or the 13 digits of the bw_ id, t_close = t_open+audio_ms; attrs.ids.window_id only; no room_id).
- phi-screen.ts header: machine is the raw event machine, normalised upstream (machine-keys.ts:4).
- Fixture tests/fixtures/spine-phi-cases.json: refute's room_id and step uid cases ported, +18 value cases with expected reason; uid-shaped synthetic ids replace enc_test* in spine tests that pass the screen.
## Tests (own logs)
- pytest tools/eta-spine: 35 passed. Spine vitest files: 8 files, 88 passed.
- TS == py on .bc/oref-r3-tests/cases.json: 935 format + 72 signal verdicts, 0 divergences; and on the shared fixture (code and reason).
- Gate (.bc/gate.log; `--minWorkers=1` added: bare `--maxWorkers=4` throws "minThreads and maxThreads must not conflict" on this 24-core host): typecheck 0, typecheck:tests 0, vitest `Test Files 2 failed | 456 passed | 1 skipped (459)`, `Tests 2 failed | 9417 passed | 5 skipped (9424)`. The 2 failures are e11-silent-room-window and no-identity-literals, the same two as R3 and base e9f7e6a2 (refuter-confirmed); none in spine files. The && chain stopped there, so build and silent ran separately: `npm run build` 0; `check:silent` "Found 9" (accepted, none in spine). swift N/A on Linux.
## Mutants (.bc/mut-r4.py, .bc/mut-r4.log): killed 58 / 58 applied
18 new (consult_uid/consult_key widened back, reason codes dropped in TS and py, counts not kept, digit_run reason dropped, conflict dropped after skipped, proxy limit dropped, pulse_enc_id guard dropped, nemotron t_close/failed rows/latest-wins/keyless, key leak in unknown_key) + the R3 16 (R3 room_id and R12 step uid now killed by the builder suite) + the R2/R3 builder set. Not applied (pattern text gone): OREF R1, R4, R15, R16 (re-expressed as N10, N12, N13, N14), and 4 old builder patterns for the removed ID_RE / acoustic SQL text (the acoustic ones are OREF R8/R9, killed).
## Assumptions
- nemotron input shape (window_id, status, audio_ms, optional start_ms) is taken from migration 0140 columns; the box export format is UNVERIFIED.
- Reason codes are poster/test-side detail; the HTTP error stays the coarse code so existing clients and tests are unchanged.
## Open risks
- pulse_enc_id placeholder admits a name-like token (`ramesh_abcd`); only charset, length and the 7-digit guard are enforced. Replace when the probe lands.
- consult_uid `[a-z0-9]{20,32}` still admits a 20+ letter name; format cannot close that. A Pulse uid with a 7-digit run (~0.1-0.3% base36, 24% if ObjectId-shaped) is refused as `source_key.digit_run`, counted, not dropped: run --dry-run on real files before the first --post.
- Shared test files not touched by this round: no PG apply; pg tests ran against throwaway postgres:16.
