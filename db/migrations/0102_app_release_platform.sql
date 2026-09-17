-- =====================================================================
-- Migration 0102 — app_release.platform: a Mac is only ever offered a Mac build.
--
-- !!! THE ORDER IS LOAD-BEARING. FOUR STEPS, EACH ONE VERIFIED BEFORE THE NEXT BEGINS: !!!
--
--   1. Apply THIS migration. Safe under the code that is live today: every existing row becomes 'macos',
--      the live code never names the column, and its INSERT takes the default.
--   2. Deploy the code that filters EVERY release read by platform (`latestRelease(channel, platform)`).
--      Reversed, that code fails on a missing column — so 1 comes first.
--   3. Verify on production, querying exactly as the Mac rooms do, that each still resolves to its stable
--      release.
--   4. ONLY THEN may a row with platform = 'linux' exist — by publish, by hand, or by any other means.
--
-- WHY STEP 4 IS LAST AND NOT MERELY LATER. Before the filter, "the latest release" is the newest
-- non-withdrawn row on a channel, full stop, and ONE query answers three callers: the Mac self-update route
-- (GET /api/room-recorder/release), the install-command mint, and the bootstrap script. A Linux row that
-- exists while that query is unfiltered IS the latest stable for every Mac. Every live room would be offered
-- a Linux tarball on its next update tick (the Mac's pinned signer should refuse it, and then fail again on
-- every tick after), and the next Mac paste would download it. This migration therefore writes no Linux row,
-- and the change that ships with it gives the publish route no way to create one.
--
-- WHY THE UNIQUE INDEX MOVES. (version, channel) was unique because one platform existed. A Linux build and
-- a Mac build may carry the same version string on the same channel; they are different artifacts.
-- `blob_url` stays UNIQUE on its own, so one uploaded object still cannot be registered twice.
--
-- min_macos IS UNTOUCHED. It stays NOT NULL DEFAULT '15.0' and means nothing on a Linux row; no reader
-- consults it for Linux.
-- =====================================================================

ALTER TABLE app_release ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'macos';

DO $$
BEGIN
  ALTER TABLE app_release ADD CONSTRAINT app_release_platform_chk CHECK (platform IN ('macos', 'linux'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- The new unique index exists BEFORE the old one is dropped, so there is no moment with neither.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_release_platform_version_channel ON app_release (platform, version, channel);
DROP INDEX IF EXISTS uq_app_release_version_channel;

CREATE INDEX IF NOT EXISTS idx_app_release_platform_channel_published ON app_release (platform, channel, published_at DESC);

INSERT INTO schema_migrations (version, name)
VALUES (102, '0102_app_release_platform')
ON CONFLICT DO NOTHING;
