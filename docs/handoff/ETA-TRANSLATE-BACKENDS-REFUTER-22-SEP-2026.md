# ETA — translate backends. REFUTER VERDICT. 22 Sep 2026

`~/eta-router` **`34cd4d9`** ("Translate: pluggable backends, qwen out of every default path") — **LIVE in production** since 02:38Z — and scribe's follow-up **`ad4a7d8`** ("English skip: verified English only"), on `vinay/translate-backends`, **not deployed**. Own detached worktrees `/tmp/refute-tb`, `/tmp/refute-tb-mut`, `/tmp/refute-tb2`, `/tmp/refute-tb2-mut`. Production `:8083`, its env and its engines were never touched; every probe ran in-process against a **local fake OpenRouter** on a random port, so no request or text left this machine. All test text is synthetic and written by me — none is patient data.

## PASS-WITH-FIXES

The security-critical items pass cleanly: **the key never leaks and ZDR is on every OpenRouter request, fallback included.** Four defects, none of them a key or ZDR leak.

| # | defect | where | live? |
|---|---|---|---|
| D1 | a non-string `message.content` raises `AttributeError`, which escapes `translate()`, **skips the fallback** and fails the whole job | `router_server.py:299-300` (both commits) | yes |
| D2 | `ETA_OPENROUTER_TIMEOUT` is **per socket read, not a total bound** | `:286` (both) | yes |
| D3 | `lang_code == "en"` returns native-script text **as English** | `:341` at 34cd4d9 | **yes — fixed by ad4a7d8** |
| D4 | the function-word list admits romanised Hindi via homographs and code-mix: **6 of 10** synthetic non-English cases still skip | `:338-367` at ad4a7d8 | no |

**Recommended order:** deploy `ad4a7d8` — it is a **strict improvement** on what is live (it never skips anything `34cd4d9` translated, and closes D3) — then fix D1 and D4 together. D2 is hardening.

## The nine checks

### 1. The key never enters logs, argv, exceptions or responses — CONFIRMED, by running it

In-process, with a **canary** key in a key file, root logging at `DEBUG` (capturing `requests` and `urllib3`) and `stderr` redirected, I drove the real `translate()` through every failure path against a fake OpenRouter:

```
401 (bad key)        -> translate_error "openrouter_http_401"
closed port          -> "openrouter_unreachable:ConnectionError"
server sleeps 3 s    -> "openrouter_timeout"            (1.00 s at a 1 s timeout)
200, body not JSON   -> "openrouter_bad_response"
LEAK SCAN: canary in logging/stderr: False | in any request body: False
```

The fake's 401 body deliberately carried a key prefix; it never surfaced, because a non-200 body is never read. Only the exception **class** is kept on `RequestException`. The key sits in the `Authorization` header and nowhere else, and is read from the file at call time, never cached. Mutation T3 (keep the exception *message* instead of its class) dies.

### 2. ZDR on every OpenRouter path, fallback included — CONFIRMED

There is exactly **one** OpenRouter call site (`:286`), and one function builds the body, so primary and fallback cannot differ. Observed on the wire, primary 500 → fallback:

```
model=primary/model    provider={'zdr': True, 'data_collection': 'deny'}
model=fallback/model   provider={'zdr': True, 'data_collection': 'deny'}
```

A per-request override (`openrouter:<any model>`) goes through the same function, so it carries ZDR too. Mutation T2 (drop `provider`) dies. `indictrans2` is not an OpenRouter call, so ZDR does not apply to it.

### 3. Total failure → `transcript_english` null + `translate_error`, never source-as-English — CONFIRMED, with D1 and D3

All-engines-failed returns `english: None` with `all_engines_failed: …` (short codes only), and never the source text. One failed segment nulls the window's English; one failed sub-window nulls the job's. Mutations T1, T5 and T6 all die.

**D1 — the "never raises" contract has a hole.** `openrouter_translate` catches `(ValueError, KeyError, IndexError, TypeError)` at `:300`, but `(content or "").strip()` at `:299` raises **`AttributeError`** when `content` is a list or a number:

```
list content                  -> escaped=AttributeError: 'list' object has no attribute 'strip'
list content, with fallback   -> escaped=AttributeError   (the fallback is NEVER tried)
```

Because it is not a `TranslateError`, the fallback loop is bypassed; `pool.map` re-raises into `transcribe_norm_wav`, so `/route` returns 500 and `run_job` marks the **whole job failed** (`job["error"] = repr(e)[:300]`). It does not pass source off as English — it fails loudly — but one malformed reply kills a job that the fallback chain exists to save. OpenAI-schema `content` arrays are legal; how often OpenRouter's routed providers emit them I did not measure. **Fix:** add `AttributeError` to the tuple — which is exactly what the sibling `indictrans2_translate` already does at `:326` — or check `isinstance(content, str)`.

**D3 — at `34cd4d9`, live now:** `looks_english` returns `True` on `lang_code == "en"` before any script check (`:341`), so Kannada script ASR-labelled `en` is returned **as English**, labelled `skip:english`. The code's own caveat covers romanised Indic only, not this. `ad4a7d8` closes it.

### 4. The label is derived from the response — CONFIRMED, one soft edge

With a reported model the label is the response's (`google/gemini-2.5-flash-lite-REPORTED`), not the requested one. **Soft edge:** when the response carries no `model` field, `:304` falls back to the **requested** model — typed, not derived — and the result looks identical to a confirmed one. Three conventions exist for that case (`:304` requested model, `:330` literal `"indictrans2"`, `:389` requested model). Low severity.

### 5. Timeouts cannot wedge a `/route/job` — PARTLY: bounded on outage, unbounded on a slow drip (D2)

**What the runner does on a timeout:** the call raises `TranslateError("openrouter_timeout")`, the next engine is tried, and if all fail that window's English is `None` with `translate_error`; the job moves on and finishes `done` with `transcript_english: null`. It does not hang and does not fail the job. Job files are not reaped mid-run — `_write_job` refreshes mtime each window, well inside the 3,600 s TTL.

**The cost is multiplicative, and measured exactly:** 7 segments, a 2-engine chain, pool width 3, every call timing out at T = 1 s → **6.03 s** (predicted ⌈7/3⌉ × 2 × T = 6 s). At production's 60 s that is **~6 min per 180 s sub-window**, all inside the single global `_WINDOW_SEM`, so every other job queues behind it.

**D2 — 60 s is not a total bound.** A fake that trickled one byte every 0.5 s kept a call alive **8.05 s against a 1 s timeout, and it succeeded**: `requests` times each socket read, not the call. Whether OpenRouter emits keep-alive bytes on non-streaming requests I did **not** verify; if it does, the configured 60 s never fires for a slow model. **Fix:** a wall-clock deadline around the call.

**Deploy note:** production runs `ETA_TRANSLATE_FALLBACK=openrouter:openai/gpt-5-nano` (Fable's ledger line), while the code default is `openrouter:openai/gpt-5-nano,indictrans2`. So the live chain has **no non-OpenRouter tier**: an OpenRouter-wide outage or a bad key nulls every window's English — honestly, but with no fallback.

### 6. A per-request `translate_engine` means that engine only — CONFIRMED

Override set, chain configured with two fallbacks plus `indictrans2`, override fails → exactly **one** request (`override/model`), **0** `indictrans2` calls. Mutation T4 (append the default chain) dies.

**Flag:** the override accepts `ollama:<any model>`, so the qwen V removed is one request field away (11.5 GB back onto the Mini), and `openrouter:<any model>` reaches any ZDR-routable model. The router binds `127.0.0.1` and **has no auth on its own routes**; the app never sends `translate_engine`. A `cloudflared` process is running; whether its tunnel exposes `:8083` I did not verify.

### 7. The English-skip, before and after scribe's fix

Same synthetic cases through both commits' real functions:

| case | 34cd4d9 | ad4a7d8 | should |
|---|---|---|---|
| EN "take paracetamol 500 mg twice a day after food" | skip | skip | skip |
| EN "how many days have you had this fever" | skip | skip | skip |
| HI "aapko kitne din se bukhar hai" (the ruling's case) | skip | **translate** | translate |
| HI "main to ghar ja raha hoon" | skip | **translate** | translate |
| KN script, ASR-labelled `en` | skip | **translate** | translate |
| ML script | translate | translate | translate |
| HI "is ka matlab kya hai" *(what does this mean)* | skip | **skip** | translate |
| HI "vo kal hospital me the" *(they were in hospital)* | skip | **skip** | translate |
| HI "hum wahan the" *(we were there)* | skip | **skip** | translate |
| MIX "mujhe two days se fever hai" | skip | **skip** | translate |
| MIX "subah morning me take karta hoon" | skip | **skip** | translate |
| MIX "haan ok ok theek hai" | skip | **skip** | translate |

**`ad4a7d8` is a strict improvement** — its skip set is a subset of `34cd4d9`'s, true English still skips, and the label no longer decides. **D4 — but 6 of 10 non-English cases still skip.** Two causes:

- **Hindi homographs.** `the` is a Hindi verb form ("were"), `is` means "this", `to` is a particle. The builder's comment excludes `me`, `hai` and `aap` for exactly this reason, but `the`, `is` and `to` are equally Hindi.
- **Borrowed clinical English in code-mix.** The list is not only function words — it holds `two`, `days`, `morning`, `night`, `take`, `times`, `ok`, `yes`, `no`, which are the English words Hinglish borrows. At a 20% threshold a 5-word segment needs one hit.

These are synthetic, so they prove the **mechanism**, not the real leak rate. split-speaker's 789/862 measurement was taken on their labelled set, which may hold few short homograph segments. **Fix options, for Fable to choose:** (a) a romanised-Indic **veto list** (`hai`, `hoon`, `kya`, `mujhe`, `aap`, `se`, `ka`, `ki`, `ke`, `nahi`, `theek`, `haan`, `vo`, `hum`…) — any hit means translate; it catches all six of my cases and cannot hurt true English; (b) a minimum word count or ≥2 distinct function words before skipping; (c) since the ruling says cost is irrelevant, drop the skip and let the prompt return English unchanged. Measuring (a) on split-speaker's labelled set would settle it.

**Observability, found via Jev's lowest dimension:** a wrong skip and a right skip carry the identical label `skip:english`, so stored rows cannot be audited for how many skips were wrong. And the app **never reads** `translate_error` or `translate_engine` from the router (no reference in `lib/` or `app/`), so the reason a window has no English — a 401 all night, or genuinely nothing to translate — is dropped at the app boundary. App-side; out of this commit's scope, but it defeats the derived labels this commit exists to produce.

### 8. The unit tests, rerun, and the guards mutated

`./.venv/bin/python -m unittest test_translate -v`: **34 passed** at `34cd4d9`, **43 passed** at `ad4a7d8`.

Mutations — **10 of 10 killed:**

| id | guard | result |
|---|---|---|
| T1 | window English `None` when any segment failed | RED |
| T2 | ZDR `provider` on every body | RED |
| T3 | exception **class** only, never its message | RED |
| T4 | override = that engine only | RED |
| T5 | a failed sub-window fails the job's English | RED |
| T6 | total failure returns `None`, not the source | RED |
| S1 | ASCII half of the skip rule | RED |
| S2 | function-word half | RED |
| S3 | the 20% threshold | RED |
| S4 | the label never decides | RED |

The guards that were written are well tested. Every defect above sits where the tests do not reach: non-string `content`, a slow-drip response, and non-English text that *looks* English. At `34cd4d9` the two skip-positive tests (`test_language_id_english_skips`, `test_mostly_latin_ascii_skips_even_if_mislabelled`) both use **genuine English** and are correct; what is missing is any skip test on non-English that passes the rule — a native-script segment labelled `en` at `34cd4d9`, a homograph or code-mixed segment at `ad4a7d8`.

### 9. Jev — weighed, not obeyed

Called after my own read, test rerun, probes and mutations. Scores **4.3–5.6**, several `medium`, confidence **~0.55–0.63** — far lower than on the clock-override review. **Caveat I have to state:** I described my own findings in the call's `repositoryContext`, so its low correctness, reliability and security scores are at least partly **echoing me**, not independent corroboration. Next time I will send the diff and task without my findings.

- **observability 4.3 (lowest)** — chased and **confirmed** as a new angle: wrong and right skips share one label, and the app drops `translate_error`. Written up under §7.
- **consistency 5.0** — chased and **confirmed independently of what I told it**: the sibling backends catch different exception tuples (`:300` vs `:326`), and only `indictrans2` catches `AttributeError`. That turns D1 into a copy-the-sibling fix. Three conventions for an unreported model (§4) also fall under it.
- **testQuality 5.0** — **confirmed**: the untested paths are exactly where my probes found D1, D2 and D4.
- **documentation 4.8** — **confirmed, narrowly**: the new env vars are documented only in the code header, and the code-default fallback chain is not the one production runs (§5).
- **correctness 4.7, reliability 4.7, security 4.9** — **not counted** as corroboration (contaminated by my context); my direct evidence stands on its own.
- **performance 4.6** — **rejected**: this commit *removes* an 11.5 GB model from the Mini; per-segment HTTPS calls and a per-call key-file read are negligible beside that.
- **scalability 4.9** — **accepted as part of §5**: translation now runs inside the single global `_WINDOW_SEM`, and its failure mode is the network, not local compute.

## What I did not do

- No call reached the real OpenRouter. The order asked for "one failing call with a bad key file"; I ran it against a local fake that returns 401, which exercises the identical code path and let me inspect every byte sent, without sending a request out.
- Did not restart or reconfigure production, read its env, or touch its engines.
- Did not measure D4's real-world leak rate — that needs labelled real segments, which is split-speaker's data, not mine to pull.
- Did not verify whether `cloudflared` exposes `:8083`, or whether OpenRouter trickles keep-alive bytes (D2's real-world trigger).
