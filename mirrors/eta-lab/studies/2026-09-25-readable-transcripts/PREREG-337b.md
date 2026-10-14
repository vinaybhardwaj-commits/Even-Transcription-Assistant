# READABLE TRANSCRIPTS 337b: pre-registration v1 (linker, 25 Sep 2026; the git commit time is the timestamp): English for every listed Indic segment of the indexed windows, frozen BEFORE the code and BEFORE any real call

Authority: Fable ruling 337b (TOP PRIORITY; V: "If we can't do proper speech to text and make it human readable, we have failed"). Verifier: eta-refuter-2. Route, key handling, line isolation and check rules are those of link-3's translated stratum (P1-PREREG-v7.15 to v7.16a), which Fable approved for this use in 337b. **Doctor-only path: NO de-identification step, and NOTHING from this path goes to Jev, to any model reader other than the translation call itself, or into git.** Access to the output is V and Sandhya only (PHI-cleared).

## T1. Input (fixed now)
- **The index:** `~/eta-data/lab-vault/staged/index/windows-20260925.jsonl` (2,235 windows) and its `key` per window, resolved to a run file under `~/eta-data/hist/` or `~/eta-data/lab-vault/staged/` (first that exists). Segments are `payload.segments` (or `segments`) with `lang`, `text`, `start_s`, `end_s`, `engine`, `refused`, `refused_reason`.
- **A segment is translated iff** its `lang` is one of `kn hi ta ml bn gu te mr` and its `text` is not empty after strip. `refused` does not matter for these (in the resolved windows only `en` segments are refused). **Not translated, counted and reported:** `und` (1,694), `pa` (8), `en`, and any language outside the eight; they are handed to 337c. If Fable adds `und` or `pa`, that is a dated addendum before any send.
- **Counts at freeze (from the box, no text):** 2,205 windows resolve; 163 have no segments; 30 hist-miner windows do not resolve on this box (reported as missing, never skipped silently); **5,251 segments in scope**, 955,936 characters, longest 640, none empty; 20 dates from 4 Aug to 24 Sep.

## T2. Route (unchanged from link-3; nothing new is chosen here)
`google/gemini-3.8-flash`, temperature 0, provider `{"zdr": true, "data_collection": "deny", "allow_fallbacks": false}`, the link-3 prompt (sha256 `3de3b0cb…`, unchanged), key only inside `get_key()` from `OPENROUTER_KEY_FILE` (never printed, logged or stored), the returned model must equal the requested one, the returned provider must be reported and identical across every call of a window (`Google` is ZDR Vertex, checked by eta-refuter-2 against OpenRouter's ZDR list), 25 lines per call, 429/5xx backoff, a malformed reply repeated once. **Line isolation always on** (v7.16a F3): a batch malformed twice is re-sent one line per call; a line that fails twice is stored as isolated-failed with no text.

## T3. Output (a sidecar; the records are never touched)
- Per window one file `~/eta-data/translate-337b/<the window's key path, .json replaced by .en.json>` (directories `0700`, files `0600`; box only, **never in git**).
- Content: `key`, `run_sha256` (sha256 of the run file read), `model`, `provider`, `prompt_sha256`, `script_commit`, `translated_at` (UTC), and `segments`: a map from the segment's index in the run file's segment list to `{"lang", "text_en", "q"}` where `q` is `ok`, `garbled`, `untranslatable` or `mt_failed` (`mt_failed` has `text_en` `""`). **`text_en` is stored for every returned line whatever its `q`** (doctors read it; a `garbled` flag is shown, not hidden). The native text is not copied and the run file and the index are never written.
- This is the "segment.text_en with model/provider/time" of ruling 337b, held apart from the records so that the vault's hashes and checker are untouched; **lab-viewer reads the sidecar** by the same key path. If Fable orders it inside the records instead, that is a dated addendum.

## T4. Order, resume, counts
- **Order: 22, 23, 24 Sep first (54 windows, 399 segments), then 21 Sep and backwards by date** (within a date, by window start). A window whose sidecar exists and whose `run_sha256` equals the run file's is skipped, so a run can stop and resume and no window is translated twice.
- **A window that fails** (route mismatch, HTTP failure twice, every line isolated-failed) writes no sidecar, is listed in `failed.jsonl` with its reason (no text), and is retried by the next run. A window with a mix of good and isolated-failed lines keeps its good lines.
- **Hourly counts posted** to the bus while a run goes on: windows done / failed / remaining, segments translated by `q`, isolated-failed lines, calls, retries, by date. Counts only.

## T5. Checks before any real call (review first, then run)
1. This file, committed first. 2. `translate_segments.py` with tests on invented data (fake transport), including: only the eight languages are sent; native text and run files byte-identical after a run; sidecar schema; resume skips done windows and re-does a changed run file; a failed window leaves no sidecar and is retried; `mt_failed` lines keep no text; provider changes fail the window; the key never appears in any output or log; the order is 24, 23, 22, 21, ... 3. Mutants with a control run, each killed. 4. **eta-refuter-2's review and PASS.** 5. The invented-line preflight for the script's commit (exact returned model, provider ZDR-checked by eta-refuter-2). 6. The run; counts posted hourly.

## T6. Verification for eta-refuter-2 (his choice of method; my proposal)
A random sample of translated segments per language, read by him against the native line where his permission allows, and counts of: sidecar files vs windows, model/provider on every call log line, the unique provider value, every in-scope segment either translated or listed as failed, zero segments of any other language sent (from the call log's line counts and the tests).

## T7. What this changes and what it does not
No link-3 result, table or verdict changes. No de-identification is applied and none is claimed: the text sent is the patients' and doctors' own words, to a ZDR provider, on Fable's ruling. The translation is machine output: **it can be wrong**; `garbled` and `untranslatable` flags are the model's own and are not a quality measure (337c and 337f measure readability). A translation is never used as evidence for anything without a doctor's read.

## T8. Disclosures
Written after the counts at T1 were taken (counts only, no text read by me). `und` and `pa` are left out by the ruling's literal list; `und` may hold romanised Indic speech. Storage as a sidecar is my choice, disclosed for Fable to overrule. The 30 unresolved hist-miner windows may hold segments that are not counted here.
