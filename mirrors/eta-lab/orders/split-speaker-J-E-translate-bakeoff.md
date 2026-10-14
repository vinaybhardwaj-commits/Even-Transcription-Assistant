# split-speaker — J-E: translation bake-off, scored with Jev and more (Fable, 22 Sep 07:50 IST)

GOAL
Pick the engine that replaces qwen2.5:14b for room-transcript translation. V approved OpenRouter for patient text (ZDR, special account). This takes priority over J-B; lx takes J-B (English-only sessions).

ENGINES (9)
- OpenRouter, each with provider {"zdr":true,"data_collection":"deny"}:
  - google/gemini-2.5-flash-lite
  - openai/gpt-5-nano
  - meta-llama/llama-4-scout
  - deepseek/deepseek-v3.2
  - qwen/qwen3-30b-a3b
  - google/gemini-2.5-flash (quality ceiling)
  - plus any Sarvam model OpenRouter lists (check /api/v1/models)
- Local on the Yoga: indictrans2 200m, indictrans2 1b.
- Baseline: the existing qwen2.5:14b `transcript_english` already stored for those windows. Don't re-run qwen.

HOW
- Run engines through the router's translate path with the per-request `translate_engine` override, so the real prompt and code are tested. scribe is building this now (orders/scribe-translate-backends.md), and yoga-drain is building IndicTrans2 at :8086. Prep now; run when both report done.
- Windows: 20 windows whose ASR output is mostly non-English, or code-mixed. Mix languages (Hindi, Kannada, Tamil, Telugu, Malayalam where available) and include 3 heavily code-mixed and 2 mostly-English controls. Read source text read-only (your Neon RO pattern).

SCORES (per engine, per window)
1. English preservation: English sentences in the source must come back byte-identical. Report the % preserved. Exact and cheap, the strongest objective check.
2. Numbers and drugs: tokens that are digits, doses or units in the source must appear in the output. Report the % kept.
3. Length ratio (output/input chars): flag < 0.6 (dropping content) or > 1.6 (adding).
4. Jev (via even-jev MCP, English text only): clinical coherence and completeness of the English output. Frame the question per your J-A learning: Jev rewards volume, so compare length-normalised or ask pairwise (engine A vs baseline: which is the more faithful clinical record?).
5. Bilingual judge: google/gemini-2.5-pro via OpenRouter (ZDR) sees source plus translation and scores adequacy 1–5, flagging omissions and additions. Blind the engine names.
6. Latency (ms), cost (tokens × list price), and failure/empty/refusal rate.
7. Pick 5 windows for V's spot-check (the widest disagreement). Present them as side-by-side labels only in the report. Text goes to a file under _fable/scratch, not the report.

RULES
Don't print patient text in the pane or report. Full outputs go to _fable/scratch/je-bakeoff/ (0600). No writes to production tables.

REPORT (at most 15 lines): a table of engine × (preserve %, numbers %, judge mean, Jev, ms p50, $/1000 windows, fail %), the winner, and the runner-up for the fallback slot.
