# ETA qwen-out release: Refuter notes (22 Sep 2026)

Target: `origin/vinay/eta-qwen-out` at `de3e5ab` (7e54307, 51357fc, de3e5ab) on top of `origin/vinay/s1-auto-drain` at `bec66c6`.
Method: read-only. A detached worktree at /tmp/refute-rel (now removed). The network was faked in every probe; nothing called OpenRouter or Vertex. No secrets or patient text were printed.

## Verdict: PASS-WITH-FIXES

Safe to merge. One non-blocking fix (F1) is recommended before or soon after the deploy. Two items are housekeeping.

## Check-by-check

| # | Check | Result |
|---|---|---|
| 1 | Missing `OPENROUTER_API_KEY` | PASS. The import is clean, because the key is read at call time (`lib/openrouter.ts` `readOpenRouterKey`). With Vertex flagged and healthy, the call returns `ok:true, provider:"gemini:gemini-2.5-flash"`. When Vertex returns 503 and there is no key, the call returns `ok:false, provider:"none"`, with error `all_failed: gemini:http_503; openrouter:google/gemini-3.8-flash=openrouter_no_key; openrouter:meta-llama/llama-4-scout=openrouter_no_key` and one fetch in total. `scribe_llm_health` reports that row as `warning:"silent_fallback"`. `npm run build` passed with no OpenRouter env. |
| 2 | Provider truth | PASS. When Vertex returns 500 and OpenRouter serves `google/gemini-3.8-flash`, the provider is `openrouter:google/gemini-3.8-flash`, never `gemini:*`, and `probeLlmSurface` flags it `silent_fallback` (`lib/mcp/tools/llm.ts:139`). Fusion still refuses a non-Gemini answer (`lib/brain/fuse/gemini-arms.ts:80`, `provider_not_gemini`). No other code in app/lib/components compares against the provider string (checked with grep). |
| 3 | Surface and tier per call site vs the merge-base | PASS. These are unchanged: note `note/flash` (`lib/note-generation.ts:544`), CDMSS draft/critique/revise `cds/pro` (`lib/cdmss-pipeline.ts:147`), `notegen_analyze/flash`, fusion, llm-selftest, and the health probe. The only thing removed is `ollamaModel`. Native analysis was `geminiChatIfOn("native","flash")` and is now `routedChatJson` native/flash, the same Vertex model. The following are **new routedChat users** that used to be local-only: cdmss-stub `cds/flash`, hyde `cds/flash`, llm-cleanup `live/flash`, indic-note-assist `native/flash`, and stt_lab judges (scoring, translate-bakeoff, transcribe-compare) `stt_lab/flash`. Under GEMINI_ALL=1 these now spend Vertex Flash. That is intended by "qwen out", but note that live cleanup is now one cloud call per utterance. |
| 4 | Deleted lib/qwen.ts and lib/trace.ts | PASS. No static import, dynamic import, `require` or route references either file (checked with git grep across app/lib/components/scripts). `tsc --noEmit` EXIT=0. `npm run build` EXIT=0. The remaining "qwen" and "Ollama" strings are UI copy only (`components/admin/SystemMap.tsx`, `TracePanel.tsx`, `HealthDetailClient.tsx`), plus embeddings and health, which still use Ollama by design. |
| 5 | D1–D5 | PASS. D1: the previous refuter's three repro cases now return `verifiedEnglish = false`, and true English still returns true. D2: a response whose body never closes fails with `openrouter_timeout` at 304 ms (timeoutMs 300). D3: `bad_response` goes to the fallback and returns ok from the fallback model. D4: per-call 250 ms, total 300 ms, 3-model chain → 301 ms, `translate_deadline_exceeded`. D5: the defaults are gemini-3.8-flash then llama-4-scout, the same in `lib/jev/translate.ts` and `LLM_FALLBACK_DEFAULT`. |
| 6 | Mergeability and build | PASS. The s1-auto-drain tip is an ancestor of the branch, so this is a fast-forward and `git merge-tree` is clean. tsc passes and next build passes. |
| 7 | Tests | PASS. The five targeted files: 117/117. Mutations: M1 (the OpenRouter path labelled `gemini:`) turned 4 tests red. M2 (the romanised veto removed) turned 1 red. M3 (`silent_fallback` only when the provider is `none`) turned 2 red. All three were killed. The full suite was not run because Docker was down or unresponsive. |

## Findings

**F1 (fix, medium): routedChat has no chain-wide deadline. D4 was fixed for Jev translate only.** `lib/llm/gemini.ts` `routedChat` (from :139) passes the full `p.timeoutMs` to Vertex and then again to *each* OpenRouter model. Probe: all three hops hang with timeoutMs 300 → 908 ms. The chain used to be Vertex plus Ollama (2×). It is now 3×. Where this bites:
- CDMSS step (`app/[slug]/api/encounters/[id]/process/route.ts:941`, budgetMs 240 s in a 300 s function): the draft pass is capped at 100 s per call, but that can now become 300 s. `remainingMs()` bounds each *call's* timeout, not the call's actual wall time. The stub fallback is 60 s, which becomes 180 s.
- Note generation: NOTE_TIMEOUT_MS 240 s gives a worst case of 720 s against maxDuration 300. This was already over the limit at 480 s, so it is not a new failure mode.
- `notegen_analyze`: 25 s ×3 against maxDuration 30.
Fix: give routedChat one deadline, `t0 + timeoutMs` (or an explicit `totalMs`), and pass `min(timeoutMs, remaining)` to each hop, the same pattern as `translateToEnglish`. Add a test that pins it. In practice this only happens when Vertex hangs *and* OpenRouter hangs, so it does not block this release.

**H1 (housekeeping):** `docs/handoff/ETA-JEV-TRANSLATE-REFUTER-22-SEP-2026.md`, which de3e5ab cites, is untracked and not in the branch.

**H2 (housekeeping):** the admin UI copy still says qwen and Ollama serve notes and CDS (`components/admin/SystemMap.tsx:45,47,88,125`, `TracePanel.tsx:396`). That is misleading to operators, but it does not affect behaviour.

## Deploy precondition
Set `OPENROUTER_API_KEY` on Vercel for all environments. Without it, any Vertex error fails closed (provider `none`), where previously it would have fallen back to Ollama.
