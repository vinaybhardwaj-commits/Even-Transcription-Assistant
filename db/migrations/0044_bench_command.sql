-- =====================================================================
-- Migration 0044 — Bench command bus + listener (Operator MCP PRD §8,
-- decisions D4 last-poll-wins / D10 loud bus failure; 19 Aug 2026).
-- Additive + idempotent. Written on branch feat/operator-mcp; run by the
-- orchestrator via /api/run-migrations AFTER the pilot tapes are safe.
--
--   bench_command  — one remote verb for a room's kiosk: start_day |
--                    pause_day | resume_day | end_day. Inserted by the MCP
--                    write tools (source 'mcp'), delivered by the kiosk's
--                    GET /api/bench/commands poll, acked/failed by
--                    POST /api/bench/commands/{id}/ack, lazily expired
--                    (pending > 15 s) by the poll. The kiosk runs the
--                    EXISTING start/pause/resume/end functions — no second
--                    recorder.
--   bench_listener — one row per room, upserted on every kiosk poll:
--                    tab_id + last_poll_at (D4: the newest poll wins; the
--                    other tab is told `superseded`), plus the kiosk's own
--                    view of recording_session_id / paused so the operator
--                    can refuse start on a paused-for-consent room.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bench_command (
  id          text PRIMARY KEY,                       -- 'cmd_' + id (same nanoid family)
  room_id     text NOT NULL REFERENCES room(id),
  kind        text NOT NULL CHECK (kind IN ('start_day','pause_day','resume_day','end_day')),
  args        jsonb,                                  -- e.g. {"override_pause":true}
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','acked','failed','expired')),
  source      text NOT NULL DEFAULT 'mcp',
  result      jsonb,                                  -- kiosk ack payload (e.g. {"session_id":"bs_…"})
  error       text,                                   -- kiosk failure reason (e.g. room_paused)
  created_at  timestamptz NOT NULL DEFAULT now(),
  acked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS bench_command_room_status_created_idx
  ON bench_command (room_id, status, created_at);

CREATE TABLE IF NOT EXISTS bench_listener (
  room_id               text PRIMARY KEY REFERENCES room(id),
  tab_id                text NOT NULL,
  last_poll_at          timestamptz NOT NULL DEFAULT now(),
  recording_session_id  text,                        -- kiosk-reported live session (bs_…) or NULL
  paused                boolean NOT NULL DEFAULT false
);

INSERT INTO schema_migrations (version, name)
VALUES (44, '0044_bench_command')
ON CONFLICT DO NOTHING;
