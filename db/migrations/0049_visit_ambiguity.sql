-- =====================================================================
-- Migration 0049 — the visit's ambiguity (ETA Fuse slice 4 follow-up, 21 Aug 2026).
-- Additive + idempotent. One column, nothing else.
--
-- Arm A won the bake-off. It emits a CLOSED SET of reasons naming why it could
-- not settle a case, and until now those reasons were written into end_reason
-- because there was nowhere else to put them. That conflated two different
-- questions:
--
--   end_reason  — why did this visit END?     ('pulse_note' | 'day_rollover')
--   ambiguity   — why are we UNSURE about it?  (the closed set in rules.ts)
--
-- A visit can be both ended and uncertain, and the old arrangement could not say
-- so. From 0049 on, end_reason is written ONLY when state = 'ended' (A6), and
-- every ambiguity reason goes here instead.
--
-- NO CHECK: the reason set is enforced in code, where it can be changed with a
-- test, rather than in a constraint that a future arm would have to migrate
-- around. Same reasoning as cue.type, cue.source and visit.arm.
--
-- NO INDEX: nothing filters on it. Slice 5 reads whole days.
--
-- NOT TOUCHED, deliberately: visit_arm_opened_by_key (0048's partial unique
-- index on (arm, opened_by)), visit.state's CHECK, visit_room_day_idx, and
-- every column and index on cue, room_day and speaker_cluster.
-- =====================================================================

ALTER TABLE visit
  ADD COLUMN IF NOT EXISTS ambiguity text;

INSERT INTO schema_migrations (version, name)
VALUES (49, '0049_visit_ambiguity')
ON CONFLICT DO NOTHING;
