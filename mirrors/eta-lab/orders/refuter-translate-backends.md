# ETA-Refuter — review the translate backends (Fable, 22 Sep 08:10 IST)

Leave your background mutation shells running if they're yours. This is a new, higher-priority review.

TARGET
~/eta-router, commit 34cd4d9 ("Translate: pluggable backends, qwen out of every default path"). It's LIVE in production since 02:38Z: Fable fast-forwarded main and reloaded the router. scribe is adding one more commit (the English-skip fix, orders/scribe-english-skip-fix.md). Review that too when its hash lands.

CHECK
1. The key never enters logs, argv, exceptions or responses. Grep the code paths, and actually run one failing call with a bad key file and inspect what gets logged.
2. The ZDR provider fields are present on every OpenRouter request path, including the fallback.
3. On total failure, transcript_english is null with translate_error set, and source text is never passed off as English.
4. The label is derived from the response, not typed.
5. Timeouts can't wedge a /route/job (ETA_OPENROUTER_TIMEOUT default 60 s; confirm what the job runner does on a timeout).
6. The per-request translate_engine override means that engine only.
7. The English-skip logic, before and after scribe's fix.
8. Rerun `./.venv/bin/python -m unittest test_translate -v` yourself, and mutate the 2–3 most important guards.
9. A Jev review of the diff as a standing addition. Weigh it; don't obey it.

VERDICT: PASS / PASS-WITH-FIXES / FAIL. List defects with file:line. Report at most 12 lines. Full notes go to docs/handoff/ETA-TRANSLATE-BACKENDS-REFUTER-22-SEP-2026.md.
