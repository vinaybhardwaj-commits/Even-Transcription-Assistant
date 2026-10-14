# IndicTrans2 vs Gemini translation bake-off

**Question:** should ETA's Indic→English translation use the local IndicTrans2 service on the Yoga, Gemini 3.8 Flash via OpenRouter (current production), or IndicTrans2 with Gemini fallback? See `orders/INDICTRANS2-BAKEOFF.md` and `orders/INDICTRANS2-YOGA.md`.

**Owner:** indic-mt / Builder (Mini + Yoga)
**Date:** 2026-09-23 (this round); `je-bakeoff-22sep/` is the prior day's J-E harness round on the same question.
**Status:** CLOSED — V rejected IndicTrans2 after the 20-pair native check (23 Sep); Gemini 3.8 Flash primary; GPU successor bake-off in `orders/GPU-TRANSLATE-BAKEOFF-2.md`

`candidates_meta.json` / `probe_meta.json` / `23sep-bakeoff-*` are window/session metadata only (ids, language, char counts — no verbatim text). `je-bakeoff-22sep/` holds that round's scores/judge/report metrics (also metadata-only).

Verbatim source/translation text from real room turns (`*-fixture.json`, `*-translations.json`, `*-spotcheck-for-V.md`) is **not in this repo** — it lives at `/Volumes/Air Drive/eta-data/2026-09-23-indictrans2-bakeoff/` per the three-homes rule, since it carries real patient-turn content.
