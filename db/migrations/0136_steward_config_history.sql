-- =====================================================================
-- Migration 0136 — steward_config_history: who changed which Room Steward setting, from what, to what, and why (Scribe MCP S2L).
-- NUMBERING: GATING ruled 0136 for this file (bus #9996); 0135 is reb_track_index, 0134 is Arch #21's.
--
-- WHY. scribe_steward_command (lib/mcp/tools/s2l.ts, lib/steward/write.ts) lets an authorised operator change a steward_config key. steward_config keeps only
-- the CURRENT value of each key, so without this table a change leaves no trace of what it replaced. Every command writes ONE row here in the SAME
-- statement as the steward_config change (a single data-modifying CTE: both happen or neither does), carrying the value before and after, the actor and the
-- operator's stated reason. `via` says which door made the change; today only 'mcp'.
--
--   id          text   primary key (sch_<nanoid>), minted by the writer
--   key         text   the steward_config key that changed (shadow, kill_switch, start_day_live, rooms, schedule, operator_note, alert_mutes)
--   kind        text   the command kind that made the change (set_shadow, kill_switch, ..., mute_alerts)
--   room_id     text   the room the command named, when it named one (add_room, flag_room, note, mute_alerts); NULL otherwise. FK-free on purpose.
--   before      jsonb  the key's value before the change; NULL when the key did not exist
--   after       jsonb  the key's value after the change
--   actor       text   the resolved MCP actor (mcp:<token id>)
--   reason      text   the operator's reason, 1..280 characters
--   via         text   'mcp'
--   created_at  timestamptz
-- No patient identifier belongs here: config values and operator reasons only.
--
-- GRANTS: none. steward_config_history is APP-OWNED, same as steward_config and reb_track_index (0135): written and read through the app connection only.
-- ADDITIVE AND IDEMPOTENT (IF NOT EXISTS throughout; no transaction; plain statements for the Neon HTTP runner).
-- =====================================================================
CREATE TABLE IF NOT EXISTS steward_config_history (
  id          text        PRIMARY KEY,
  key         text        NOT NULL,
  kind        text,
  room_id     text,
  before      jsonb,
  after       jsonb       NOT NULL,
  actor       text        NOT NULL,
  reason      text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 280),
  via         text        NOT NULL DEFAULT 'mcp' CHECK (via IN ('mcp')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS steward_config_history_created_idx ON steward_config_history (created_at DESC);
CREATE INDEX IF NOT EXISTS steward_config_history_key_idx ON steward_config_history (key);
CREATE INDEX IF NOT EXISTS steward_config_history_room_idx ON steward_config_history (room_id, created_at DESC) WHERE room_id IS NOT NULL;

COMMENT ON TABLE steward_config_history IS
  'One row per Room Steward config change made through the Scribe MCP: key, before, after, actor, reason. Written in the same statement as the steward_config change.';

INSERT INTO schema_migrations (version, name)
VALUES (136, '0136_steward_config_history')
ON CONFLICT DO NOTHING;
