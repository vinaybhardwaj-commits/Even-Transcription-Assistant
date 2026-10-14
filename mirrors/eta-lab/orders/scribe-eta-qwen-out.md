# scribe — Builder: qwen out of ETA entirely (Fable, 22 Sep 09:35 IST)

V's RULING (22 Sep): anything qwen does inside ETA moves to Vertex (his creds) or OpenRouter. Callers outside ETA are not our concern.

KNOWN FACTS
- scribe_llm_health just now: Vertex is live on every surface (note, native, live, notegen_analyze on gemini-3.7-flash; cds, fusion on gemini-3.1-pro-preview), all ok at 1.8–3.3 s, GCP_LOCATION=global.
- qwen survives only as:
  (a) routedChat's Gemini→Ollama fallback in lib/llm/gemini.ts;
  (b) the direct callers you listed: lib/stt/indic-comprehension.ts (qwen fallback after geminiChatIfOn), lib/stt/indic-note-assist.ts, lib/llm.ts TEXT_MODEL default qwen2.5:14b, and lib/qwen.ts consumers;
  (c) the admin STT lab: lib/stt/scoring.ts, lib/stt/translate-bakeoff.ts.
- History: routedChat once swallowed Gemini errors and served qwen for two months while traces said Gemini (fuse programme, Aug). Any fallback must be reported honestly: the provider comes from the call, and silent_fallback stays visible in scribe_llm_health.

BUILD (branch off vinay/jev-translate-openrouter at 7e54307 so both ship as one release; name it vinay/eta-qwen-out)
1. routedChat / geminiChatIfOn fallback: Vertex Gemini → OpenRouter (google/gemini-2.5-flash, then meta-llama/llama-4-scout) with ZDR + data_collection deny. Reuse the OpenRouter client from 7e54307 (one client, not two). Ollama is removed from every fallback chain.
2. indic-note-assist, indic-comprehension's qwen fallback, and the lib/llm.ts TEXT_MODEL default all route through routedChat on the same surface tiers (flash for these). No direct qwen/ollama chat calls left in ETA production code.
3. STT lab (scoring, translate-bakeoff): point to routedChat too, or delete the qwen arm if it's only a qwen comparison. Your call; say which.
4. Embeddings (nomic via ollama) STAY. They're a separate concern, and the KB corpus is nomic-768.
5. A guard test that fails if any production file under lib/ or app/ references qwen2.5 or posts to an ollama /chat or /api/generate endpoint (allow-list: embeddings only).
6. Update scribe_llm_health so the fallback provider shows as openrouter:<model> when used.
7. Tests, then the full suite (check `pgrep -f vitest` first; Docker is needed for the Postgres tests, so start and stop it as you did before). Commit, push, and report the hash. Don't deploy; Fable deploys after ETA-Refuter.

DON'T
- Change the Vertex model choices or GEMINI_* env.
- Touch the router or the overnight driver.

REPORT (at most 8 lines): hash, files changed, test count, remaining ollama uses (embeddings only, expected).
