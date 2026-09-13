# 0084 + 0085 applied (scratch evidence)

Runner: POST /api/run-migrations on dpl_5xejJkV8wuq43LmyytyoSkzXK6dQ
(even-transcription-assistant-qdgxhh3x7.vercel.app, serving 4054c40). Shared Neon DB = production.

PRE-CHECK (GET, before): 81 recorded, max 82. Diff against db/migrations: PENDING exactly
0084_stt_routing_room_to_route, 0085_room_turn_speaker_role. The 81-vs-82 gap is numbering only
(0013 never existed; 0083 deleted in edf27ef). Nothing else would have been applied.

APPLY: HTTP 200, applied [0084_stt_routing_room_to_route, 0085_room_turn_speaker_role].
POST-CHECK: 83 recorded, max 85, 84 and 85 present.

0084 — stt_routing, read through scribe_stt_routing before and after:
  room english: sarvam (2026-08-23 02:23:40) -> route (2026-09-13 00:49:35)
  room indic:   sarvam (2026-08-23 02:23:40) -> route (2026-09-13 00:49:35)
  live english deepgram, live indic sarvam, note english whisper, note indic sarvam: UNCHANGED.
  `route` has NO stt_engine row (before and after). resolveRouting requires stt_engine.enabled,
  so room now resolves to NULL -> the drain raises `no_engine`. Room STT cannot bill sarvam, and
  it also cannot transcribe on route until a route stt_engine row exists.

0085 — room_turn_speaker:
  version 85 is recorded, and each migration writes its own schema_migrations row at the END of
  the file, so every ALTER and DO block before it executed.
  Independent proof for three of the four columns: the preview's scribe_window_speakers SELECTs
  clinician_id, role, match_confidence; it returned a COMPUTED summary (turns 0), not failSafe's
  `summary: {}` fallback, so the SELECT succeeded. no_role_reason and the six CHECK constraints are
  evidenced only by the recorded version — no tool here reads pg_constraint.
