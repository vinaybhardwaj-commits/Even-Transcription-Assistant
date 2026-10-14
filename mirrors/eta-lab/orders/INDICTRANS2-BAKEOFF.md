# IndicTrans2 vs Gemini bake-off (owner: indic-mt) — 23 Sep 2026

Goal: decide whether ETA's Indic->English translation should use the local IndicTrans2 service on the Yoga, Gemini 3.8 Flash via OpenRouter (current), or IndicTrans2 with Gemini as fallback.

Data: 100 real non-English room turns from ETA (Hindi, Kannada and any other Indic language present, in proportion to production), from 20-23 Sep, spread across at least 4 rooms. Use the existing J-E harness and the router's translate path (ETA_INDICTRANS2_URL). Skip turns under 20 characters.

Arms: A = IndicTrans2 dist-200M (Yoga service). B = google/gemini-3.8-flash via OpenRouter (ZDR, data_collection deny — the current production settings).

Measure per arm:
1. Number preservation: every number in the source (digits or number words, using the 772-word lexicon ~/dev/_fable/for-minibot/eta_number_words.py) must appear in the English. Rate and list of misses (turn ids only).
2. Drug/dose terms kept: source tokens that look like drug names or units (mg, ml, tablet, times daily) present in English.
3. Blind pairwise judgement: a judge model via OpenRouter ZDR (google/gemini-3.8-pro or the strongest ZDR model available) sees the source and both translations in random order, answers which is more faithful to clinical meaning, or tie. Record A/B/tie counts and the order seed.
4. Empty or looped output (same phrase 3+ times) rate.
5. Latency p50/p95 and cost per 100 turns.

Also: save 20 randomly chosen turns with both translations to ~/dev/_fable/scratch/bakeoff-native-check.jsonl for a later native-speaker check by V's team (not now).

Limits: nice 19 on the Yoga, batch <= 16; no local LLM; do not change the router's production env; no transcript text in the report or in the chat; the OpenRouter key never printed.

Report (8 lines max): arm-by-arm numbers for 1-5, your recommendation with the one number that drives it, and whether the 1B model is worth trying. End with WAITING ON Fable.
