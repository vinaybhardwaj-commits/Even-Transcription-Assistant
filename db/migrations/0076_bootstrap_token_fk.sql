-- =====================================================================
-- Migration 0076 — the foreign key 0075 should have carried.
--
-- WHY (Install and Fleet PRD §4.1, §12.3 item 4). §4.1 specifies
-- `room_bootstrap_token.install_id` as "not null, foreign key to `room_install`". Migration 0075
-- declared the column `text NOT NULL` and gave `room_id` its REFERENCES but not `install_id`.
-- That was an omission, not a decision, and it was caught by V reading the shipped migration
-- against the spec rather than by anything in the build. This is the correction.
--
-- WHAT IT PREVENTS. Nothing today: `mintBootstrapToken` writes the install row and the token row
-- in one transaction, install first, so every token in production already points at a real
-- install. The constraint matters for what the database will REFUSE later — a token row written
-- by any future path that forgets the ordering, or an install deleted out from under a live
-- token. The nightly cleanup already deletes the token before the install (lib/room-install.ts,
-- `cleanupExpiredInstalls`), which is the correct order and stays correct under this constraint.
--
-- ON DELETE RESTRICT, NOT CASCADE. A cascade would let a stray `DELETE FROM room_install` take
-- live enrolment credentials with it silently. RESTRICT makes that delete fail and say so, which
-- is what the operator needs to see. It also matches the ordering the cleanup job already uses.
--
-- NOT VALID, THEN VALIDATE. Adding the constraint in two steps takes only a SHARE UPDATE
-- EXCLUSIVE lock for the validation scan rather than holding an ACCESS EXCLUSIVE lock over the
-- whole table while it verifies every row. On a table this size the difference is academic; the
-- habit is not, and the two-step form is what a large table would need.
--
-- IDEMPOTENT. The DO block checks pg_constraint by name, so a re-run does nothing at all.
-- ADDITIVE. No column is added, dropped, renamed or rewritten. No row is touched.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_bootstrap_token_install_fk'
  ) THEN
    -- Any orphan would make the VALIDATE below fail loudly rather than silently skip. Reported
    -- here first so the reason is in the migration output, not inferred from a constraint error.
    PERFORM 1
       FROM room_bootstrap_token t
      WHERE NOT EXISTS (SELECT 1 FROM room_install i WHERE i.install_id = t.install_id);
    IF FOUND THEN
      RAISE EXCEPTION
        '0076: room_bootstrap_token has rows whose install_id names no room_install. Resolve these before adding the constraint.';
    END IF;

    ALTER TABLE room_bootstrap_token
      ADD CONSTRAINT room_bootstrap_token_install_fk
      FOREIGN KEY (install_id) REFERENCES room_install(install_id)
      ON DELETE RESTRICT
      NOT VALID;

    ALTER TABLE room_bootstrap_token
      VALIDATE CONSTRAINT room_bootstrap_token_install_fk;

    RAISE NOTICE '0076: room_bootstrap_token.install_id now references room_install(install_id)';
  ELSE
    RAISE NOTICE '0076: room_bootstrap_token_install_fk already present, nothing to do';
  END IF;
END
$$;

COMMENT ON COLUMN room_bootstrap_token.install_id IS
  'The install this token enrols. FK to room_install(install_id) ON DELETE RESTRICT, added by 0076 — PRD §4.1 specified it and 0075 omitted it. RESTRICT rather than CASCADE so a stray delete of an install fails loudly instead of silently taking live enrolment credentials with it.';

INSERT INTO schema_migrations (version, name)
VALUES (76, '0076_bootstrap_token_fk')
ON CONFLICT DO NOTHING;
