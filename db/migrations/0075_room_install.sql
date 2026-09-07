-- =====================================================================
-- Migration 0075 — the install registry: which Mac runs which room.
--
-- WHY (Install and Fleet PRD §4.1, D7/D8/D9/D10, Build R1). Four clinic rooms are dark. Today the
-- only way to put software in a room is to walk to it. This build gives the admin app a way to
-- install the native Room Recorder with one Terminal paste, and a card that says which Mac runs
-- which room. Three tables land here. NO EXISTING TABLE IS ALTERED — `room`, `bench_listener`,
-- `bench_command` and `bench_session` keep exactly the shape they have.
--
--   app_release            one row per published bundle. The download address, and the two
--                          numbers that prove the bytes on a clinic Mac are the bytes that were
--                          built. An EMPTY TABLE IS THE FEATURE GATE: with no row, the fleet card
--                          reads "No release published yet" and every install button is off.
--
--   room_bootstrap_token   the single-use credential inside the pasted one-liner. Bound to one
--                          room and to one server-minted install_id, 30-minute TTL.
--
--   room_install           one row per install attempt; at most one ENROLLED and un-retired row
--                          per room, enforced below by a partial unique index rather than by the
--                          discipline of the code that writes it.
--
-- ─── WHY THE TOKEN IS A TABLE AND NOT A SIGNED STRING ────────────────────────────────────
-- A signed token carrying room_id and install_id would need no table at all, and it would be
-- wrong here for one reason: it could not be SPENT. §4.2 requires that the second exchange of a
-- token fails, and "already used" is a fact about the past that no self-contained string can
-- carry. `used_at` is that fact. The enrol exchange claims the row and sets it in the same
-- statement, so two simultaneous exchanges of one token cannot both win — the loser re-reads
-- `used_at IS NULL` after the row lock and matches nothing.
--
-- ─── WHY sha256 AND size_bytes ARE COLUMNS AND NOT A FORM FIELD ──────────────────────────
-- Both are written by `POST /api/admin/releases` from ITS OWN recomputation over the Blob object,
-- after checking them against the packaging manifest. The route refuses with SHA_MISMATCH on any
-- difference. The value here is therefore the server's answer, not the publisher's claim, and the
-- bootstrap script hands that same answer to `shasum -a 256` on the clinic Mac. Three parties
-- have to agree — packaging, server, Mac — before any bundle runs in a room.
--
-- ─── THREE COLUMNS ON room_install THAT §4.1 DOES NOT LIST ───────────────────────────────
-- Flagged, not smuggled. §6 asks for state the §4.1 column list cannot hold:
--
--   first_seen_at        §6 step 2 renders "started by launchd, <time>". `last_seen_at` moves on
--                        every poll and cannot answer "when did it start"; `enrolled_at` is the
--                        token exchange, which happens a moment EARLIER, inside the script, and
--                        would put a time on the screen that is not the time the app came up.
--
--   tape_poll_streak     §6 step 4 turns done on TWO CONSECUTIVE polls reporting tape_advancing.
--                        A single boolean has no memory of the previous poll, so the rule cannot
--                        be evaluated from it at all. The streak is incremented by the poll and
--                        reset to 0 by any poll reporting false, so "two in a row" is `>= 2` and
--                        one true surrounded by falses never reaches it.
--
--   tape_advancing_since the instant the current run of trues began, for the same step's "audio
--                        arriving since <time>" line. NULLed whenever the streak resets, so it
--                        can never show the start of a run that has already broken.
--
-- All three are written ONLY by the poll, from what the Mac reported. None is typed by a person,
-- and none changes a decision — they carry the evidence §6 already asked to be displayed.
--
-- ADDITIVE AND IDEMPOTENT. Three CREATE TABLE IF NOT EXISTS, one partial unique index, indexes
-- and comments. Re-running changes nothing. No row of any existing table is read or rewritten.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The release store (D7).
--
-- UNIQUE (version, channel) IS THE VERSION_EXISTS ERROR. §4.2 requires 409 VERSION_EXISTS, and
-- putting it in the index rather than in a pre-flight SELECT means two publishers racing the same
-- version get one release and one honest 409 — not two rows that a later self-update would have
-- to choose between.
--
-- blob_url IS UNIQUE for the same reason in the other direction: registering the same object
-- twice under two versions would make `sha256` ambiguous for that object.
--
-- withdrawn_at IS A COLUMN AND NOT A DELETE because withdraw is the R3 ROLLBACK (D12). The
-- release route returns the newest release that is not withdrawn, so marking one withdrawn makes
-- every Mac see a different version at its next check and walk itself backwards. A deleted row
-- could not do that, and could not explain afterwards what had been published.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_release (
  id            text PRIMARY KEY,
  version       text        NOT NULL,
  build_sha     text        NOT NULL,
  sha256        text        NOT NULL,
  size_bytes    bigint      NOT NULL,
  blob_url      text        NOT NULL UNIQUE,
  channel       text        NOT NULL,
  published_at  timestamptz NOT NULL DEFAULT now(),
  published_by  text        NOT NULL,
  withdrawn_at  timestamptz,
  notes         text,
  min_macos     text        NOT NULL DEFAULT '15.0',
  CONSTRAINT app_release_channel_chk CHECK (channel IN ('stable', 'test')),
  CONSTRAINT app_release_sha256_chk  CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT app_release_size_chk    CHECK (size_bytes > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_release_version_channel
  ON app_release (version, channel);

CREATE INDEX IF NOT EXISTS idx_app_release_channel_published
  ON app_release (channel, published_at DESC);

COMMENT ON TABLE app_release IS
  'One row per published Room Recorder bundle. An EMPTY TABLE IS THE FEATURE GATE: with no row the fleet card reads "No release published yet" and no Mac can be given an install command. There is no flag beside it.';
COMMENT ON COLUMN app_release.sha256 IS
  'Computed by the server over the Blob object, checked against the packaging manifest, and refused with SHA_MISMATCH on any difference. Never typed. The bootstrap script hands this same value to shasum on the clinic Mac.';
COMMENT ON COLUMN app_release.withdrawn_at IS
  'Withdraw is the R3 rollback, not a delete: the release route returns the newest non-withdrawn row, so marking one withdrawn walks every Mac back to the previous bundle at its next check.';

-- ---------------------------------------------------------------------
-- 2. The single-use bootstrap token (D9).
--
-- THE TOKEN IS THE CREDENTIAL. `GET /api/room-recorder/bootstrap/{token}` and
-- `POST /api/room-recorder/enrol` have no other auth, by design — the operator pastes one line
-- into a Terminal on a Mac that has never heard of this system, and there is nothing else on that
-- Mac to authenticate with. The TTL is 30 minutes and the row is spent on first enrol.
--
-- install_id IS SET AT MINT, NOT AT ENROL. The row in room_install exists before the script runs,
-- so the checklist has something to poll for from the moment the command is copied, and so the
-- app's very first poll — which carries install_id — lands on a row that is already there.
--
-- FETCHING THE SCRIPT DOES NOT SPEND THE TOKEN. The script needs the same token a few seconds
-- later for the enrol call, so only the enrol exchange sets used_at.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_bootstrap_token (
  token       text PRIMARY KEY,
  room_id     text        NOT NULL REFERENCES room(id),
  install_id  text        NOT NULL,
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_room_bootstrap_token_install ON room_bootstrap_token (install_id);
CREATE INDEX IF NOT EXISTS idx_room_bootstrap_token_expiry  ON room_bootstrap_token (expires_at);

COMMENT ON TABLE room_bootstrap_token IS
  'The single-use credential inside the pasted one-liner. 30-minute TTL, bound to one room and one install_id. Fetching the script does NOT spend it — the script needs the same token for the enrol call moments later; only the enrol exchange sets used_at.';
COMMENT ON COLUMN room_bootstrap_token.used_at IS
  'Spent by the enrol exchange, in the same statement that claims the row. Two simultaneous exchanges cannot both win: the loser re-evaluates used_at IS NULL after the row lock and matches nothing.';

-- ---------------------------------------------------------------------
-- 3. The install registry (D8).
--
-- ONE ACTIVE ENROLLED INSTALL PER ROOM, ENFORCED BY THE INDEX. Every other approach — a check in
-- the enrol route, a flag the app sets — leaves the three-way tab_id drift that D8 exists to
-- close. The predicate is deliberately narrow: rows that were minted and never enrolled do not
-- occupy the room (an operator may copy the command twice before pasting once), and retired rows
-- stay for the audit trail. Only a LIVE enrolment is unique.
--
-- WHY retired ROWS ARE KEPT. Retire "marks a row, it does not remove software from a Mac"
-- (§10.6). The row is the only record that a Mac was ever bound to a room, and §4.5 rule 3 needs
-- it: a poll from a retired install must be answered 409 RETIRED so the app stops polling. A
-- deleted row would answer 404 and the app would have no idea it had been superseded.
--
-- launch_agent_loaded IS DERIVED, NOT REPORTED. §4.3 fixes the poll's additions at seven fields
-- and launch_agent_loaded is not among them; §9.2 nonetheless expects it true once launchd owns
-- the process. The poll sets it from `launched_by = 'launchd'`, which is what the column means.
-- Flagged in the build report rather than resolved by inventing an eighth poll field.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_install (
  install_id           text PRIMARY KEY,
  room_id              text        NOT NULL REFERENCES room(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  enrolled_at          timestamptz,
  enrolled_by          text        NOT NULL,
  session_expires_at   timestamptz,
  launched_by          text,
  hostname             text,
  hardware_model       text,
  os_version           text,
  app_version          text,
  build_sha            text,
  first_seen_at        timestamptz,
  last_seen_at         timestamptz,
  mic_state            text        NOT NULL DEFAULT 'unknown',
  launch_agent_loaded  boolean     NOT NULL DEFAULT false,
  tape_advancing       boolean     NOT NULL DEFAULT false,
  tape_poll_streak     integer     NOT NULL DEFAULT 0,
  tape_advancing_since timestamptz,
  never_sleep          boolean,
  retired_at           timestamptz,
  CONSTRAINT room_install_mic_state_chk
    CHECK (mic_state IN ('authorized', 'denied', 'not_determined', 'unknown')),
  CONSTRAINT room_install_launched_by_chk
    CHECK (launched_by IS NULL OR launched_by IN ('launchd', 'user'))
);

-- THE ONE-ACTIVE-INSTALL RULE. Partial, so unenrolled and retired rows are outside it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_install_active_room
  ON room_install (room_id)
  WHERE retired_at IS NULL AND enrolled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_room_install_room     ON room_install (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_install_unenrolled
  ON room_install (created_at)
  WHERE enrolled_at IS NULL;

COMMENT ON TABLE room_install IS
  'One row per install attempt. At most one enrolled, un-retired row per room, enforced by uq_room_install_active_room. Retired rows are kept: they are the only record that a Mac was bound to a room, and §4.5 needs them to answer a retired install''s poll with 409 RETIRED rather than 404.';
COMMENT ON COLUMN room_install.first_seen_at IS
  'The first poll that carried this install_id. Not in the PRD §4.1 column list; added because §6 step 2 renders "started by launchd, <time>" and last_seen_at moves on every poll. Flagged in the build report.';
COMMENT ON COLUMN room_install.tape_poll_streak IS
  'Consecutive polls reporting tape_advancing = true; reset to 0 by any poll reporting false. §6 step 4 turns done at >= 2, a rule a single boolean has no memory to evaluate. Not in the PRD §4.1 column list; flagged in the build report.';
COMMENT ON COLUMN room_install.tape_advancing_since IS
  'When the current run of tape_advancing = true began; NULLed whenever the streak resets, so it can never show the start of a run that has already broken. Not in the PRD §4.1 column list; flagged in the build report.';
COMMENT ON COLUMN room_install.launch_agent_loaded IS
  'DERIVED by the poll from launched_by = ''launchd'', not reported separately: §4.3 fixes the poll''s additions at seven fields and this is not one of them.';
COMMENT ON COLUMN room_install.mic_state IS
  'authorized | denied | not_determined | unknown. Default unknown, never "denied" — a Mac that has not reported yet has not refused anything, and colouring it red would send an operator to System Settings for no reason.';

-- ---------------------------------------------------------------------
-- 4. Grants — saying no out loud (the 0053 / 0066 / 0071 / 0072 / 0074 convention).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc') THEN
    -- brain_svc is the one pullable credential and it is correctly locked out of the spine. It
    -- gets nothing here either. These three tables carry a signing-verified download address, a
    -- live enrolment credential and the fleet's machine facts; the operator's read path is the
    -- admin JSON route, as it has been since Build 2.
    RAISE NOTICE '0075: brain_svc exists and is deliberately granted nothing on app_release, room_bootstrap_token or room_install';
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (75, '0075_room_install')
ON CONFLICT DO NOTHING;
