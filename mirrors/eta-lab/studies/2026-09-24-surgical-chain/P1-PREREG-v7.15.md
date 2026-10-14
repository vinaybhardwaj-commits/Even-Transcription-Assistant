# SURGICAL-CHAIN-LINKER P1: pre-registration v7.15 (linker, 24 Sep 2026; the git commit time is the timestamp): the translated stratum for the LANGUAGE_LIMITED items, frozen BEFORE any text is sent anywhere

Addendum to v7.14; nothing earlier is edited. This file **replaces section S3 of v7.14** (translation route "pending"). **Class key sealed, no class join.** Authority: ruling 200(B), ruling 211 (MT, then de-identify, then name-leak check and intelligibility screen), ruling 222 (route approved: OpenRouter `google/gemini-3.8-flash`, zero data retention, `data_collection` deny, temperature 0; the route is recorded in provenance), ruling 239 (Fable authorised writing this file). Refuter checklist: eta-refuter-2 #973. No transcript text has been sent to any external model before this commit; the git time is the evidence. The script (`p1/link3_translate.py`) is committed after this file and before any run.

Data handling: every record, text and ledger stays in `~/eta-data/surgical-chain/p1/mt/` (dir 0700, files 0600). Git carries this file, code and counts only. Nothing here uses the class key.

## M1. What is translated (selection, fixed now)
- **Items:** the 8 LANGUAGE_LIMITED items of ruling 200: `c004, c006, c011, c013, c014, c016, c023, c026`.
- **Rooms:** for each item, the shortlisted HIST rooms whose non-English turn share is **above 0.50** (the share definition already used by `link3_run.py`, v7.10). Rooms at or below 0.50 keep their existing native-text scores unchanged. At selection time this is 11 rooms and 134 turns to translate; **the script's own recount governs and is reported**, and a difference from these numbers is disclosed, not hidden.
- **Turns:** every turn of a selected room goes to the MT step (the prompt tells the model to leave English as it is). This keeps one uniform record shape and makes the intelligibility screen apply to every turn.
- **Interim four** (`c004, c006, c011, c013`): their non-English text shaped how this route was chosen (leakage rule). They are scored and reported, but **excluded from every accuracy claim** for this stratum.

## M2. The MT route (frozen)
- Endpoint `https://openrouter.ai/api/v1/chat/completions`. Request body, exactly: model `google/gemini-3.8-flash`; `temperature` 0; `provider` = `{"zdr": true, "data_collection": "deny", "allow_fallbacks": false}`; no `models` list, no `order`, no `only`; `response_format` json_object. A ZDR miss must fail the batch, never route elsewhere.
- **Key:** read from the environment variable `OPENROUTER_API_KEY`, or from a file whose path is given in `OPENROUTER_KEY_FILE`. Never an argument, never printed, never logged, never written to any output. The author does not open or inspect key files to find one; the run is started with the key supplied by its owner.
- **Returned-route check:** the response `model` must equal the requested model exactly; if not, that item FAILS (`MT_ROUTE_MISMATCH`) and none of its text is used. The returned `provider` is recorded for every batch; no provider is requested, so the check on it is that it is recorded and that all batches of an item agree (a change mid-item is flagged and the item FAILS). eta-refuter-2 checks the provider against the ZDR list from the one logged request.
- **Batches:** 25 numbered lines per call, JSON in and out, keyed by line number. Retries only for HTTP 429/500/502/503/504 with backoff 4, 12, 30, 60 s; any other failure, or a reply that is not JSON, misses a line, or has a `t` that is not a non-empty string or a `q` outside the three values, makes the batch fail once more at the same settings; a second failure FAILS the item (`MT_FAILED`). A failed item is counted and reported, never scored, never partially used.
- **Prompt (frozen, verbatim; its sha256 goes into provenance):**
  - System: `You translate a clinic conversation transcript into English, faithfully.\n- Leave English words and English sentences exactly as they are.\n- Keep drug names, doses, numbers and units exact.\n- Never summarise, and never add or drop any content.\n- If the input is already English, return it unchanged.\n- If a line is too garbled to translate faithfully, give your best literal rendering and mark it garbled. If a line has no recoverable words (noise, a fragment), mark it untranslatable.\n- Output only the JSON object requested: no preamble, no notes.`
  - User: `Translate each numbered line to English. Reply with a JSON object {"1": {"t": "...", "q": "ok"}, "2": {"t": "...", "q": "garbled"}, ...} keyed by the line numbers, where q is one of ok, garbled, untranslatable, and nothing else.` followed by the numbered lines.
- **Log:** one line per batch, no transcript text: item, batch index, lines in, HTTP status, requested and returned model, returned provider, temperature, the provider settings, and the sha256 of the system prompt.

## M3. Provenance record (`mt/provenance.json`, written by the translate step only)
Model requested and returned; provider returned (per batch); temperature; `zdr`, `data_collection`, `allow_fallbacks`; prompt sha256 (system and user template); the git sha of `link3_translate.py` and of this file; the sha256 of `mt/translated.json`; counts per item (rooms, turns in, turns returned, batches, failures). A run whose script sha is not a committed sha is refused.

## M4. Order, enforced in code, and the gates
1. MT (raw native text goes to Gemini only, under the route above).
2. De-identification of the **English** output (`deid.py` by surg-deid, GPU under `flock ~/gpu.lock`, nice 15, 4 threads), writing `mt/deid.json`: the same records plus `en_deid`.
3. **Name-leak check (ruling 211a)** on 20 real translated turns, drawn by `link3_nameleak.py` (seed 27, over turns with `q == "ok"`). The first reader (linker) lists missed transliterated names as counts per turn; eta-refuter-2 labels the same 20 independently and locks his labels first; the summary compares both. **Any miss in either count fails the gate:** the redactor is fixed and the check is repeated on a new draw (seed 28) before any Jev call. Jev is not called until the gate is clean.
4. **Intelligibility screen (ruling 211b)** by `link3_screen.py`: a turn is kept only if Gemini's own flag is `ok`; `garbled`, `untranslatable` and a missing or unknown flag are dropped and counted per item and by reason. No length cut. An item with no kept turn is `INCOMPLETE`. A kept turn without `en_deid` or without `at` stops the run.
5. Jev on the kept `en_deid` turns only. **Jev input is only ever the de-identified output of the English translation.** Test (in `tests/test_order.py`): with the de-identification stubbed to raise, the number of Jev calls is 0.

## M5. Scoring and reporting
- Same rules as the native run, unchanged: question `LINK_QUESTION_V2`, floor 0.50, margin 0.15 (room margin and the localized own-versus-decoy margin on consult plus or minus 2 minutes, which uses `at`), silence scores 0, verdict names as before. No constant is changed and none is introduced (no minimum-turns rule is added; kept counts are reported beside every verdict).
- Per item, the translated-stratum verdict is computed over all shortlisted rooms: translated rooms use their kept `en_deid` turns, the other rooms reuse their existing native-text scores.
- **The translated stratum is reported apart and never pooled** with the native strata, in any table, count or accuracy claim. Its records carry `stratum = "translated"`, and a pooled input containing one fails.
- Reports on the bus carry counts only (per item: MT status, turns sent, dropped by reason, kept; name-leak counts; verdict counts). The class key stays sealed; it is unsealed only by `link3_tables.py` with eta-refuter-2 present.

## M6. Disclosures made now
- This file was first attempted earlier the same night and was blocked by a permission control; it was written only after ruling 239 authorised it. No text was sent in between.
- The room and turn counts in M1 come from the pre-run selection; the script recounts.
- The provenance check on the returned provider is by recording and agreement across batches, because no provider is requested; eta-refuter-2 may require a stricter rule, which would be a new dated version.
- A change to any rule above is a new dated version with its reason; results already produced are kept and reported under the version that governed them.
