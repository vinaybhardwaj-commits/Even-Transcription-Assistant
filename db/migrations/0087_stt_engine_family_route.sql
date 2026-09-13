-- =====================================================================
-- Migration 0087 — `route` gets its own stt_engine_family.
--
-- WHY ITS OWN. `route` is not a single ASR. Its output is a FUSION: each speech span is dispatched to
-- whisper, IndicConformer or SraVaani by detected language, and the transcript is stitched back
-- from their answers. Filing it under `whisper` would let the scorer treat a partly-IndicConformer,
-- partly-SraVaani transcript as a whisper one, which corrupts any comparison involving either. It
-- is registered as family `route`, a family of one.
--
-- WHAT THIS CHANGES IN SCORING (lib/stt/window-scoring.ts decideScore). Before this row, `route`
-- had no family, and an unregistered engine fails closed as FAMILY_CONTAMINATION against any gold
-- that records a seed family. That default is correct and is NOT touched here. With this row,
-- `route` is refused against a gold seeded by `route` and is eligible against a gold seeded by any
-- other family.
--
-- A LIMIT THIS DOES NOT FIX, recorded rather than hidden. The contamination check is an EQUALITY on
-- family. A `route` transcript contains whisper and IndicConformer spans, so scoring it against a
-- gold seeded by `whisper` or `indicconformer` is partly an engine grading its own output — and
-- equality cannot see that. Refusing those pairs needs a family-overlap rule in the scorer, which
-- is a scoring decision and not a registry one.
--
-- ADDITIVE AND IDEMPOTENT. The table has two columns (engine_key, family); there is no description
-- column, and none is added — this comment is the description.
-- =====================================================================

INSERT INTO stt_engine_family (engine_key, family)
VALUES ('route', 'route')
ON CONFLICT (engine_key) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (87, '0087_stt_engine_family_route')
ON CONFLICT DO NOTHING;
