# ORDER — scribe3: survey the path to English text for Jev (Fable, 2026-09-21). READ-ONLY.
V wants Jev used for encounter classification and everywhere else it fits. Jev reads English text only. Today it gets none: J0 (jev_window_text) has 46 not_ready, 9 empty, 0 with text, because only ~176 of ~3,015 windows were ever transcribed. Map what it takes to feed it. Build nothing, restart nothing, change no flags.
1. J0's input: the exact table/column it reads, what marks a window not_ready, and where its translation leg (qwen on the Mini, per 0105) plugs in. Give file:line.
2. Audio→English engines we already run: does our whisper deployment on the router/Mini expose task=translate (audio straight to English)? Is IndicConformer native-script only? Does our Sarvam integration have a speech-to-English-translate mode (Saaras), or only transcribe? What does the qwen text-translate leg handle? Mark each VERIFIED (code or live call) or UNVERIFIED.
3. Language mix: the share of transcribed room windows and phone encounters by detected language (counts only). How much is English, how much Kannada/Hindi/Tamil/Telugu/code-mixed.
4. Throughput: measured seconds of compute per audio minute for each candidate on the Mini, and on the Yoga if it's already measured (don't run new load on the live Mini during clinic hours).
5. Recommend the cheapest path that gives Jev English for about 95% of windows, plus what a dedicated whisper-translate instance on the Yoga would add.
Output ≤30 lines, and one [jev] ledger line per measured number (cat >> only). No transcript text anywhere.

## ADDENDUM (Fable, 2026-09-21) — V's correction: the Indic engine is SraVaani, not Sarvam
Already verified by Fable, so don't re-survey these:
- The router (`~/eta-router/router_server.py`, tunnel route.llmvinayminihome.uk, :8083) already produces English: whisper large-v3-turbo for English; IndicConformer :8082 and SraVaani :8085 raced for Indic; then `ollama_translate` (:173, qwen2.5:14b via ETA_OLLAMA_MODEL) writes `transcript_english`. `translate` defaults to True (:891, :910).
- SraVaani is Indic ASR only (no translate). Sarvam Saaras is a separate paid engine in the registry; it is not the route.
- M7 on real audio: route winners were whisper 33 / SraVaani 31 (kn 22) / IndicConformer 1 of 65 segments.
So narrow the survey to: (1) does J0 read the router's `transcript_english`, or something else? file:line. (2) Is the drain calling route with translate=true or false today? (3) The measured route RTF with translate on vs off, and qwen's share of it. (4) Whether whisper task=translate would be a cheaper fallback than qwen for the Indic half. Keep the language-mix count (item 3). Same caps and rules.
