# ETA — router STT hygiene. REFUTER VERDICT. 22 Sep 2026

`~/eta-router` **`vinay/router-stt-hygiene` @ `d4cc9ca`** (builder lx), base `e81b839` (live `main`). `router_server.py` +152, `test_stt_hygiene.py` +252. Own detached worktrees `/tmp/refute-rsh`, `/tmp/refute-rsh-mut`; production `:8083` never touched. The MiniBot whisper-shim was **read, never edited** — imported read-only to compare rules; its server starts only under `__main__`. Real-data measurements printed counts only.

## FAIL — on one rule, with a one-function fix measured on real data

A-ETA-1 is correct and complete. A-ETA-2 is idempotent and honours the shim flag — but its near-duplicate rule **drops distinct lines**, which the order forbids.

### A-ETA-1 — `max_context=0` on every router→Whisper call: PASS

The router has **one** Whisper call site (`router_server.py:151`, `whisper_infer`); both the auto-language and the forced-English paths go through it. IndicConformer and SraVaani are not whisper.cpp. Mutation R1 (drop the field) dies. The shim also defaults `max_context=0` (`whisper-shim.py:267-272`), so the router no longer depends on it.

### A-ETA-2 — what holds

- **Idempotent:** fuzzed 2,000 random loopy texts and 2,000 segment lists — `collapse_phrase_loops` not idempotent **0/2000**, `collapse_segments` **0/2000**.
- **No-op on shim output:** `whisper_text` returns `raw` untouched when `shim_collapse is True`. The shim sets that flag only after it has actually parsed and collapsed the JSON; on a parse failure it returns the raw body without the flag, so the router's skip is honest. R2 and R3 die.
- **Same rules as the shim:** within-line collapse agrees on **2,000 of 2,000** fuzzed inputs. `near_duplicate` differs only where lx added a punctuation and danda fold.
- **The English guard judges the repaired text:** R8 (guard on the raw text) dies. `repair_applied` reaches the job (R9 dies).

### FINDING 1 (the FAIL) — `near_duplicate` merges distinct lines

`near_duplicate` (`router_server.py`, new) counts two lines as duplicates if their **word sets** have Jaccard > 0.9. A set ignores **order** and **repetition**, so distinct content passes. `collapse_segments` then drops the later line:

```
"Take 2 tablets in the morning and 1 tablet at night."
"Take 1 tablet in the morning and 2 tablets at night."          -> near_duplicate = True  (swapped doses)
21-word instruction, "every morning" vs "every night"            -> near_duplicate = True
"Yes." / "Yes." as consecutive segments (two turns)             -> second dropped
```

The router applies this across a whole window's consecutive VAD segments, from every engine and every speaker. That is a wider scope than the shim, which applies it inside one ≤30 s Whisper call.

**Real data (897 transcription runs, 41,210 lines, 40,313 consecutive line pairs, counts only):**

| | pairs |
|---|---|
| `near_duplicate` = True | 2,199 |
| of which **identical after folding** (true loops — the target) | **2,186 (99.4%)** |
| of which **different words, merged anyway** | **13** |
| — same word set, different order or repetition | 12 |
| — differing in a number token | **0** |

The dose-swap has not happened in real data, and the real rate is low. But the order's requirement is **never**. **Fix:** drop only lines that are **identical after folding**, or use an order-aware comparison (a token-sequence ratio) that also refuses any pair differing in a number. Measured cost of the strict version: it would still catch **2,186 of 2,199** (99.4%) of what the current rule catches. R7 (Jaccard 0.9 → 0.5) **survives**, so the threshold has no test; add the swapped-dose pair as one.

### FINDING 2 (low) — within-line collapse can change a spoken regimen

```
"take one one one after food"   -> "take one after food"      (1-1-1 regimen -> one)
"take two two two tablets"      -> "take two tablets"
"take 1 1 1 after food"         -> unchanged (single characters are exempt)
```

**0** spelled-number triples in all 897 stored runs — though some stored text has already passed through the shim's identical rule. **Fix:** exempt number words from the word-repeat rule. R5 (phrase minimum 8 → 1 characters) survives: short repeated phrases are also unpinned.

### Same rule, live now, in the shim

The shim's `_collapse_phrase_loops` and `_near_dup` carry both behaviours today, on every Whisper call. The shim is MiniBot-owned and out of scope here — flagged so its owner can take the same fix.

## Gate

`python -m unittest test_stt_hygiene test_translate`: **91 passed**. Mutations **7 of 9 killed**; R5 and R7 survive (above).

## Jev — on the diff, none of my findings in its context

Scores 5.0–6.4.
- **correctness 5.0 (lowest, medium)**, "an important edge case insufficiently handled" — **consistent** with Finding 1, but its issue text is generic and my task text stressed "never drop a distinct line", so not independent proof.
- **duplication 5.7 / changeability 5.5** ("the same rule in multiple places") — **confirmed**: router and shim carry the same collapse, so Finding 1 has to be fixed in both.
- **testQuality 5.1** — **confirmed** by R5 and R7.
- **consistency 5.6** ("a second way to solve a standardised problem") — **partly rejected**: re-implementing the shim's collapse is deliberate, so the router does not depend on a shim it does not own.
- performance, observability, compatibility — no specific issue named; not counted.
