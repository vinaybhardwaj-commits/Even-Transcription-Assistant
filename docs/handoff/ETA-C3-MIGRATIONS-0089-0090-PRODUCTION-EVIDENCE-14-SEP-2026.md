# ETA C3 — migrations 0089 and 0090 applied to production: evidence

**Production sha at apply:** `14a4f38` (`/api/health` cache-busted, twice; `/api/admin/emotion-windows`
answered 401, so the C3 code and both migration files were deployed).
**Ruling:** Option 2 — apply without a captured before/after element (V, 14 Sep 2026).

## NOT CAPTURED — stated plainly
- **Per-statement row counts were NOT captured.** `POST /api/run-migrations` runs each migration file as
  one transaction and returns only migration names (`applied`, `skipped`, `errored`); it reports no
  statement list and no row counts. The Builder has no production database access to count them.
- **A before/after `speakers_json` element was NOT captured.** No production route or MCP tool returns
  `room_diarize_window.speakers_json`; the only reader (`/api/admin/speaker-calibration`) returns counts.
- **The rewrite's scope, measured before applying: 15 rows / 57 speakers, across `bs_z3gpbh6e`
  (5 rows, 18 speakers) and `bs_g3dwud4p` (10 rows, 39 speakers).**

## The pre-0090 counting method (recorded BEFORE applying, repeated identically after)
1. **Sessions.** `scribe_list_sessions` through the production MCP door
   (`POST https://www.evenscribe.app/api/mcp`, Bearer `SCRIBE_MCP_TOKEN`), called once per IST date from
   2026-07-01 to 2026-09-14 inclusive with `{ "ist_date": <date>, "limit": 200 }`. The tool has no paging
   and caps at 200 sessions; by date, no single day reached the cap, so the union is complete for the
   range. Sessions de-duplicated by id; kept those with `chunk_count > 0`.
2. **Rows.** For each kept session:
   `GET https://www.evenscribe.app/api/admin/speaker-calibration?session_id=<id>` with
   `Authorization: Bearer $MIGRATION_SECRET`. That route runs
   `SELECT d.window_id, d.speakers_json FROM room_diarize_window d JOIN bench_window w ON w.id = d.window_id
    WHERE w.session_id = <id> AND d.state = 'ok' ORDER BY w.start_ms ASC`
   and returns `windows_with_results` (the number of those rows) and `speakers_seen` (the total length of
   the `speakers_json` arrays in them).
3. **Totals.** `ok rows` = Σ `windows_with_results`; `speakers` = Σ `speakers_seen`, over every kept session.

**Pre-0090 result:** 212 sessions in range, 123 with chunks, **ok rows 15 | speakers 57**; non-zero only
for `bs_z3gpbh6e` (5 | 18) and `bs_g3dwud4p` (10 | 39). No errors reported by the route.

**What this method CANNOT see:** key names. It counts rows and array elements, and 0090 changes neither
— it moves `type` / `label` / `source` / `role_source` under `unverified_service_guess` inside each
element. An unchanged count after 0090 is expected either way; this method cannot verify the rewrite.

## Applied

Pre-check (`GET /api/run-migrations`): 86 recorded, max 88; 89 and 90 not recorded.
`POST https://www.evenscribe.app/api/run-migrations` at 2026-09-13T20:00:15Z → **HTTP 200**. Response body,
verbatim:

```json
{"applied":["0089_room_emotion","0090_diarize_run_id_and_service_guess"],"skipped":["0001_init","0002_llm_traces","0003_note_edited","0004_encounter_status_draft_partial","0005_launch_readiness_attestation","0006_multilingual_transcription","0007_diarization","0008_identification_label","0009_tagged_transcript","0010_clinician_table","0011_encounter_note_type","0012_clinician_backfill","0014_repoint_fks","0015_drop_doctor","0016_clinician_pin_plaintext","0017_voice_sample","0018_stt_engine","0019_stt_fanout","0020_stt_gold","0021_stt_routing","0022_stt_even_pipeline","0023_ekascribe_scribe_only","0024_voice_sample_passive_unique","0025_stt_fanout_started_at","0026_elevenlabs_scribe","0027_indicconformer","0028_indicconformer_fanout_on","0029_indic_comprehension","0030_processing_progress","0031_translated_flag","0032_process_attempts","0033_processing_step_lock","0034_transcript_flag","0035_language_timeline","0036_router_job_id","0037_notegen_encounter_cols","0038_notegen_nabh","0039_notegen_expansion_log","0040_notegen_note_types","0041_room_bench","0042_brain_tables","0043_bench_event","0044_bench_command","0045_bench_chunk_source","0046_scratch_graph","0047_warehouse_cue_key","0048_visit_arm","0049_visit_ambiguity","0050_turn_cue_keys","0051_narrow_replay_key","0052_stt_window_type","0053_brain_role_grants","0054_live_monitor_indexes","0055_clinician_names_and_specialty","0056_visit_reality","0057_bench_window","0058_run_subject_add","0059_run_subject_agree","0060_run_encounter_nullable","0061_stt_subject_job","0062_room_stage_and_marker_index","0063_diarize_slot","0064_ended_disagrees","0065_room_processing_switches","0066_mic_levels","0067_repair_end_times","0068_rebind_cardiology_and_spare_device","0069_build3_corrective","0070_clear_unreported_spare_levels","0071_stt_window_measure","0072_evidence_spine","0073_gemini_stt_engine","0074_room_diarize","0075_room_install","0076_bootstrap_token_fk","0077_install_input_device_name","0078_install_update_fields","0079_install_assigned_channel","0080_bench_command_set_audio_input","0081_room_states_and_verbs","0082_scribe_job","0084_stt_routing_room_to_route","0085_room_turn_speaker_role","0086_stt_engine_route","0087_stt_engine_family_route","0088_room_diarize_window_retry"],"errored":null}
```

Post-check: 88 recorded, max 90; 89 and 90 recorded.

## The pre-0090 count, repeated by the identical method

212 sessions in range, 123 with chunks, no day at the 200 cap → **ok rows 15 | speakers 57**, non-zero
only for `bs_g3dwud4p` (10 | 39) and `bs_z3gpbh6e` (5 | 18); no route errors. `embeddings_usable` 57 of
57.

**The rewrite is NOT verified by this.** The counts are identical before and after, which is what 0090
should produce, and this method cannot see where `type` lives inside an element. The one thing it does
show: the calibration reader still finds all 57 embeddings at the top level, so the rewrite did not move
or drop them. Whether the 15 rows' `type`/`label`/`source`/`role_source` now sit under
`unverified_service_guess` is unconfirmed until someone with database access reads an element, e.g.
`SELECT window_id, speakers_json->0 FROM room_diarize_window WHERE state = 'ok' LIMIT 1;`
(expected: no top-level `type`, an `unverified_service_guess` object).

## Production checks (deployment `dpl_4ZeDjRkYTJhL3h63kvpDqMcezc84`, sha `14a4f38`)

- **tools/list:** 27 tools.
- **Legacy names:** the 0f27b8c capture published 52 names; 33 are no longer listed. Sampled through
  `tools/call`, each answered with its own handler (`_meta.tool` = the name, `isError: false`):
  `scribe_list_voiceprints`, `scribe_stt_routing`, `scribe_list_stt_engines`, `scribe_voice_health`,
  `scribe_list_voice_samples`, `scribe_stt_health`, `scribe_get_clusters` (all read scope).
  **NOT done on production: only-their-scope tokens.** Scoped tokens come from `SCRIBE_MCP_TOKENS`, a
  Vercel environment map the Builder cannot read or add to; the only token available is the
  `SCRIBE_MCP_TOKEN` fallback, which carries all three scopes. That every name refuses a token without
  its scope is proven in-process by `tests/unit/mcp-surface-aliases.test.ts`, not on production.
- **Kind enum:** `emotion_window` present in `scribe_job_submit.kind` and `scribe_job_list.kind` (9 kinds,
  `emotion_clip` absent).
- **Voiceprints:** 7, `summary { total: 7, matchable: 7 }`, every row with `clinician_status`.
- **Routing:** room/english and room/indic → `route`; `route.is_paid` false.
- **Crons:** `GET /api/admin/emotion-windows` 200 every five minutes (19:35:17 … 20:00:17 UTC) logging
  `[emotion] EMOTION_ENABLED is off — enqueueing nothing (this is the shipped state)`;
  `GET /api/admin/diarize-windows` 200 every five minutes (19:35:44 … 20:00:44 UTC) logging
  `[room-diarize] ROOM_DIARIZE_ENABLED is off — enqueueing nothing (this is the shipped state)`.
- **Jobs:** 0 `emotion_window` jobs, 0 `diarize_window` jobs. Both features ship dormant.
