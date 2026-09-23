# ETA — Jev English on OpenRouter. REFUTER VERDICT. 22 Sep 2026

Even-Transcription-Assistant **`7e54307`** (builder scribe, `vinay/jev-translate-openrouter`, pushed), base `bec66c6` (prod). `lib/openrouter.ts` (new), `lib/jev/translate.ts` (rewritten), two test files. Own detached worktrees `/tmp/refute-jt`, `/tmp/refute-jt-mut`; scribe's worktree never written to, nothing pushed or deployed. **This Mini's shell carries a real `OPENROUTER_API_KEY`**, so every test and probe ran with it and `OPENROUTER_API_KEY_FILE` / `OPENROUTER_API_URL` unset, against a **local fake** on a random port: no request left the Mini. Real-data measurement printed counts only.

## PASS-WITH-FIXES

Key, ZDR, total failure and the label are all correct. Two findings: **the timeout does not bound the response body** (the D2 analogue), and **D4 applies here — yes, it needs the romanised-Hindi blocklist**, more so than the router, because this path decides a whole window at once.

| check | result |
|---|---|
| key never in logs or errors | **PASS** — canary key through 401, timeout and bad bodies; absent from all captured `console.*` output and every result |
| ZDR on every path | **PASS** — `provider {zdr:true, data_collection:"deny"}` on **9 of 9** requests observed, the fallback model's included; one body builder |
| total failure → null English + error | **PASS** — `status:"failed"` with a closed code; source text never returned |
| label derived from the response | **PASS** — `prim/m-REPORTED` recorded, not the requested id; requested id only when the response omits `model`, same rule as the router |
| skip rule matches the router | **matches `ad4a7d8`, NOT `cd62569`** — no veto (F2) |
| timeout wall-clock bounded | **FAIL for the body** (F1) |
| targeted tests | **68 passed** (`jev-translate`, `jev-english`) |

## F1 — the timeout bounds the headers, not the body (D2 analogue)

`openrouterChat` arms `setTimeout(() => controller.abort(), timeoutMs)` and clears it in the `finally` of the `fetch` call. `fetch` resolves as soon as **headers** arrive; the body is then read by `await res.json()` **after** the timer is gone. Measured against a local fake, `timeoutMs = 1000`:

```
silent server (no headers for 3 s)   -> 2.01 s  "openrouter_timeout"   (1 s x 2 models — works)
headers at once, body trickled       -> 8.02 s  status "ok"            (never bounded)
openrouterChat alone, same trickle   -> 8.01 s  SUCCEEDED
```

This is the router's D2 in a new form, and it looks bounded when it is not. On Vercel the function's own `maxDuration` would eventually kill the step, so it fails there rather than on the configured timeout. **The timeout is also untested:** mutation A8 (timer effectively infinite) survives. **Fix:** keep the timer armed until after `res.json()` — `controller.signal` already aborts the body stream, so moving `clearTimeout` past the body read is enough — and add the trickle test.

## F2 — D4: yes, this path needs the blocklist

`verifiedEnglish` is the `ad4a7d8` rule, word for word, with **no veto**. And the unit here is not a segment: `translateToEnglish` receives a window's whole joined `transcript_original`, so one decision skips an entire 900 s window.

**Measured on real windows** (365 with text; counts only, text never printed):

| | all windows | windows with no English yet (what J0 translates) |
|---|---|---|
| skipped whole as English by the app's rule | 152 (41.6%) | **91** (37.4%) |
| of those, containing ≥1 veto token | 26 | **17** |
| of those, containing **≥3 distinct** veto tokens | 12 | **9** |

Nine windows J0 would handle carry three or more different romanised-Hindi words, and each would be stored **whole** as English. **Fix:** port `cd62569`'s `ROMANISED_INDIC_VETO` into `verifiedEnglish`. At window level a false veto costs one call that returns mostly-English text unchanged, so the trade-off is even cheaper than per segment. Better still, since the router joins segments with `\n`, split and decide per segment, so a mostly-English window with one Hindi line is not all-or-nothing.

**Root cause, from Jev's duplication/changeability lead:** `EN_FUNCTION_WORDS` and `TRANSLATE_SYSTEM_PROMPT` are copied by hand from the router. The router's copy gained the veto in `cd62569` and this copy did not follow — "the same rule in two places" is exactly how this diverged. Worth one shared source, or a test that fails when the two lists differ.

## Mutations — 6 of 8 killed

| id | guard | result |
|---|---|---|
| A1 | ZDR in every body | RED |
| A2 | non-string `content` refused (`typeof !== "string"` → `== null`) | **GREEN** — no test sends non-string content; `translateToEnglish`'s catch-all still makes it fail safe |
| A3 | fetch error keeps the exception **class** only | RED |
| A4 | label from the response | RED |
| A5 | total failure is `failed`, never the source | RED |
| A6 | skip rule's function-word half | RED |
| A7 | fallback tried after a failure | RED |
| A8 | the timer bounds the call | **GREEN** — the timeout has no test (F1) |

## Jev — on the diff, none of my findings in its context

Scores **5.7–7.3**, all `low`, confidence 0.32–0.56.

- **duplication 6.2 / changeability 6.5** ("the same rule in multiple places") — **independent and confirmed**: it is the root cause of F2 (above).
- **security 6.4** ("secret-handling exposure") — **chased, low**: `OPENROUTER_API_URL` decides where the bearer key is sent. That env var is set on this Mini for Claude tooling, pointing at the real OpenRouter, so no leak today; but an env var should not be able to steer a production secret. Worth pinning the URL in production.
- **correctness 5.7 (lowest)** — generic ("an edge case insufficiently handled"); consistent with F1, not independent evidence of it.
- **observability 6.3** — **accepted, minor**: a trickled call is recorded only as a large `latency_ms`; the module logs nothing by design.
- **compatibility 6.2** — **rejected as unevidenced**; the only visible change is the new `skip:english` value in the `model` column, which is the intended label.

## Deploy note

Fable's planned env (`JEV_TRANSLATE_MODEL=google/gemini-2.5-flash`, `JEV_TRANSLATE_FALLBACK=meta-llama/llama-4-scout`) is compatible: `translateChain` reads both, dedupes, and falls back to the coded defaults only when a variable is absent or empty. **F1 and F2 should land before it goes to production**; neither needs a migration.
