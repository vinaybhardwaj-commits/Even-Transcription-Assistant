# scribe — Builder: move Jev's English translation off qwen (Fable, 22 Sep 08:20 IST)

GOAL
qwen2.5:14b is retired (V, 22 Sep). A Scout found that the Jev English path still calls it directly, bypassing the router, and it reloaded qwen (11.55 GB) at 08:12 IST:
- chain: lib/jobs/kinds/jev-english.ts:175 → lib/jev/translate.ts:87,100 → lib/qwen.ts qwenJson() (model hard-coded at lib/qwen.ts:24);
- endpoint: ${LLM_BASE_URL}/chat/completions, default localhost:11434.

The overnight-translate bundle (~/overnight-translate/overnight-translate.mjs) carries this code.

FIRST: establish where jev_english actually executes — the Mini bundle, Vercel, or both — and state it in your report. Then build accordingly.

BUILD (worktree off the production branch vinay/s1-auto-drain; don't use Even-Transcription-Assistant-ot while scribe3 owns it)
1. Give lib/jev/translate.ts an OpenRouter backend matching the router's contract:
   - model from env JEV_TRANSLATE_MODEL (default google/gemini-2.5-flash-lite), fallback JEV_TRANSLATE_FALLBACK (default openai/gpt-5-nano);
   - `provider: {zdr:true, data_collection:"deny"}`, temperature 0;
   - the same system prompt as ~/eta-router router_server.py (faithful, English unchanged, drugs/doses/numbers exact, no summarising);
   - the same verified-English skip rule (≥90% ASCII letters AND ≥20% English function words, label never decides);
   - key from OPENROUTER_API_KEY (Vercel) or a key-file env (Mini). Never logged, never in argv or errors.
2. Record the label from the response (`model` field), not a constant. On total failure the English is null with an error set; never pass source text off as English.
3. No qwen in any default or fallback path. Leave lib/qwen.ts for other callers, but list any other live callers you find.
4. Tests: dispatch, fallback, ZDR fields, key-not-logged, the skip rule, and the label. Run the full suite (PATH needs /opt/homebrew/bin; don't run while another pane's npm test is running; check `pgrep -f vitest`).
5. Commit and push the branch. Report the hash. Fable handles env vars (OPENROUTER_API_KEY on Vercel) and the prod deploy, and rebuilds the overnight bundle.

DON'T
- Deploy, touch Vercel env, restart the overnight driver, or edit ~/overnight-translate.

REPORT (at most 8 lines): where jev_english executes, commit, test count, any other qwen callers.
