# L0 annotate-only: pre-registration + E6 plan (lid-debug, designer, 7 Oct 2026; herdr-lead CLARITY-4 §4)
Status: DRAFT r2 for eta-refuter-2 (r1 0bfb079f; #9010 B1, B2, N1, N2 applied). Approved for design and BUILD only, NOT for deploy (CLARITY-4 §4). Nothing built or run for L0 yet.

## 0. What L0 is
An instrumentation flag on the router's English path. Production routes romanised Indic speech (forced-English Whisper's
transliteration, e.g. nightly dlg_ta_2) as English because looks_real_english() never asks whether the words are English (#7707, #8811,
RC-EMPTY-DESIGN.md). L0 does NOT change routing, text, label, timeline, dominant_language or translation input. It only ADDS two keys
to such a segment: {"romanised_indic_suspect": true, "suspect_lang": X}. Its value is measurement (how often real consults hit this)
and a signal the web owner may later use. Arms L (relabel) and T (reroute) are not pursued (CLARITY-4 §4).

## 1. Base
Current production router: router_server.py a876b3bd + eta_number_words.py ae6f83e4 (R-C-LEX, router-fix/rclex 5766a583). L0 is a new
branch off that commit (router-fix builds; eta-refuter-2 reviews). The comparison arm P in every gate below is that production code.

## 2. The rule (deterministic, router side, fixed here)
For a segment that production emits on the English path (lang "en", engine "whisper", non-empty text, not refused):
 - tokens = [A-Za-z']+ of the lowercased text, keeping tokens of >= 2 letters; n = len(tokens).
 - coverage = share of tokens in EN_WORDS.
 - Annotate iff n >= 4 AND coverage < 0.40 AND an Indic hypothesis existed for this segment (the hyps list was non-empty, or SraVaani
   returned >= SRAVAANI_MIN_CHARS of text).
 - suspect_lang = guess_indic_lang(sra_text) when SraVaani's text is in an Indic script (production's own script-based function); else
   the lang of production's best Indic hyp; if neither exists, do not annotate.
 - EN_WORDS = wordfreq 3.1.1 top_n_list("en", 20000), lowercased, VENDORED as a data file (en_words_20k.txt, sha256 pinned in code and
   asserted at import). No runtime wordfreq dependency.
 - The two keys appear on the segment in run_job's segments list (router-fix #8955: the reply is built from fixed keys, so the carry-
   through is explicit). They are NOT added to language_timeline.
DISCLOSED: theta = 0.40, n >= 4 and the 20k list were chosen from data already seen (clinical1, the diag-rig nightlies, and E4, which is
dev-only for L0 per CLARITY-4 §4). E4 dev check with P's outputs at theta 0.40: flagged / Whisper-path segments per mode: en 0/74,
hi 1/43, hi-en 0/42, kn 25/40, kn-en 38/47, ml 8/24, ta 2/20, te 3/23. (Coverage on real English: clinical1 min 0.83, nightly 0.96.)

## 3. Gates (all must PASS; stated before E6 exists)
 SHARED-ENGINE HARNESS (refuter-2 #9010 B1): production keeps Whisper's temperature fallback (M4), so two separate runs differ for
   reasons unrelated to L0 (dlg_hi_2 flipped en/42 -> hi/161 between two live calls, #8966/#8968). Every identity comparison below therefore
   runs P and L0 in ONE process on SHARED engine responses, using run_s2.py's wrap pattern: whisper / indic / sravaani calls cached by
   (engine, wav sha256, args); the first router to ask fills the cache and both routers read it. The cache file's sha256 and entry count are
   recorded in the header. Identity then tests L0's code, not engine noise.
 Gate 1 IDENTITY (build): for the E1 diag-rig suite (15 stimuli, manifest canonical 836ef736) and 20 E4 windows (seeded list committed in
   the test), on the shared-engine harness, L0's reply JSON with the two keys removed == production's reply JSON, compared canonically
   (sorted keys) and byte for byte.
   Committed test + recorded run. Unit tests: a romanised-Tamil line with an Indic hyp -> annotated with suspect_lang ta; an English
   sentence -> not; < 4 tokens -> not; no Indic hyp -> not; the vendored list's sha mismatch -> import refuses.
 Gate 2 CONSUMERS (before any deploy, not part of this PASS): the gating thread confirms on a web preview that a segment carrying the two
   keys renders and processes unchanged (CLARITY-4 §4); static checks #8955/#8956 found no strict consumer.
 Gate 3 PRECISION on the fresh set E6 (§4), unit = a Whisper-path segment (engine whisper, lang en, n >= 4) in L0's E6 output:
   GATED on the MONO modes only (refuter-2 #9010 B2): truth POSITIVE = window truth mode in {hi, kn, ta, te, ml}; NEGATIVE = truth mode en.
   hi-en and kn-en windows contain real English clauses, so their flags are REPORTED separately (flag rate per mode, per segment and per
   window) and enter no gate.
   (a) English false flags: flagged negatives / negatives <= 2% AND Wilson 95% upper <= 5%, with >= 50 negatives (else NOT EVALUABLE = FAIL).
   (b) Precision: flagged positives / all flagged >= 0.95, with >= 30 flagged (else NOT EVALUABLE = FAIL).
   (c) suspect_lang accuracy among flagged positives (suspect_lang == truth mode) >= 0.80.
   (d) Identity on all of E6, on the shared-engine harness: L0 minus the two keys == production on every E6 window (byte-identical,
       canonical); cache sha recorded.
   N1 declared: segments in one window are correlated, so the segment-level Wilson bound overstates n. Every rate is ALSO reported per
   window (a window counts as flagged if any of its Whisper-path segments is flagged). The gates stay segment-level as written.
   N2: on E4 dev the mono modes give 39 flags at theta 0.40 (kn 25, ml 8, te 3, ta 2, hi 1), above the >= 30 needed for (b); E6 may give
   fewer, in which case (b) is NOT EVALUABLE = FAIL, as stated.
   REPORTED, not gated: recall per mode (L0 targets transliteration, not fluent pseudo-translation; hi recall is expected near 0).
 Scoring: aggregates only; script sha posted before it runs; eta-refuter-2 re-derives byte-identical (as r8 A1.3). One run.

## 4. E6: the fresh set (generated and sha-sealed BEFORE any L0 read of it)
Size 384 windows = 8 modes (en hi kn ta te ml hi-en kn-en) x 48, as E4.
 Plan B (AS RULED, default): fresh generation. Pinned generator e6971bc8 (as fv2e), cap's frames 2c146f28 (PASSed #8200/#8191), a NEW
   seed by commit-reveal (herdr-lead commits sha256(seed) before the draw), a mechanical draw of 16 cases (16 x 8 modes x 3 conditions
   clean/fan10/babble5 = 384), dx/inv from dfe18256 with replacement, drugs from the Pulse lexicon (use >= 10) excluding every drug drawn
   for clinical1, confirm1-3, fv2e and fv3. Author of the draw script: cap (not lid-debug, not router-fix). TTS: separate ledger; dry
   count first (deduped basis); hard cap 50,000 chars (expected well under: fv3 was 270 chars/dialogue naive). router-fix generates on
   the box, posts suite + per-file sha list; eta-refuter-2 checks before any run. Then P (a876b3bd) and L0 run in ONE process on the
   shared-engine harness (Gate 1 note), headers + SIDE files as r8 A1.4/A1.5.
 Plan A (OPTION for herdr-lead, zero TTS): a seeded draw of 384 windows (48 per mode, all three conditions balanced) from the sealed
   FUSER v3 suite (suite 90e5710d, 2,640 windows, cases 995c31c6). Nobody has read fv3's per-window outputs (FUSER aggregate-only rule;
   router-fix and eta-refuter-2 to confirm). Caveat: fv3 frames are cap's v3 frames and its windows are ~20 s (E4: 34-61 s). Same seed
   commit-reveal and sealing; P and L0 are re-run on the drawn windows (fv3's 400710ee P outputs are not used: production is now
   a876b3bd). herdr-lead picks A or B.

## 5. Order
L0 pre-reg PASS (eta-refuter-2) -> router-fix builds L0 + Gate 1 (refuter-2 witnesses) -> E6 per §4 sealed (refuter-2 checks) ->
P and L0 on E6 (headers PASS) -> scoring script sha -> one scoring run -> refuter-2 re-derives. Deploy is out of scope (Gate 2 + a
separate herdr-lead/fable decision).

## A1 — amendment, dated 2026-10-07 (herdr-lead CLARITY-5 #9034 item 6), before E6 exists
 A1.1 E6 = PLAN B (fresh generation: generator e6971bc8, frames 2c146f28, new commit-reveal seed, 16 cases x 8 modes x 3 conditions =
      384, cap writes the draw script, TTS hard cap 50,000 chars). Plan A is withdrawn: fv3 (90e5710d) stays SEALED and unread as the holdout
      for the next arm that changes production output.
 A1.2 The frames' reuse of one instruction per drug (what tripped looks_real_english clause_repeat on E4, CLARITY-5 item 1) does NOT
      affect L0's gates' validity, because:
      - L0 only examines segments production KEEPS on the English path (lang en, engine whisper). A segment that clause_repeat rejects is
        routed to the Indic side by production itself and is never an L0 unit; L0 cannot change that routing (Gate 1 identity proves it).
      - So the reuse can only lower the COUNTS: fewer English-path negatives (gate (a) needs >= 50; E4 dev had 74 after its 22 rejects)
        and fewer flags (gate (b) needs >= 30; E4 dev had 39 mono flags, already counted on post-rejection output). Both already have a
        NOT EVALUABLE = FAIL rule; no bar moves.
      - Precision/recall are judged against the window's truth mode, not the text, so the repeated instruction does not enter the truth.
      Reported with the E6 result: the count of clause_repeat rejects per mode on E6's P output (from the shared-engine trace, if router-fix
      runs L0 with R-EN's instrumentation; otherwise "not measured"), so a low n can be traced to this cause.
 A1.3 E6 draw facts (answers cap #9038; before any draw):
      - Layout: 16 cases, each rendered by the generator in ALL 8 modes (order: en, hi, kn, ta, te, ml, hi-en, kn-en), x 3 conditions
        (clean, fan10, babble5) = 384 windows, 48 per mode. A case is not tied to one language.
      - Drugs: the v3 Pulse pool pins (rx_history cd012faed4bc597a, lexicon 8191774c2ed5dee4, use >= 10); 3 per case = 1 mid + 2 long;
        distinct within a case, with replacement across cases. Exclusions: clinical1 + confirm1-3 (excl_names eed2dcbb) and the 30 Sep
        cases (a85b8eb873a8b060) ONLY. CORRECTION to §4 Plan B: the fv3 exclusion is DROPPED, so fv3 (sealed, CLARITY-5) is not read at all.
        Drug identity enters no L0 gate, so overlap with fv3 is harmless.
      - dx/inv from dfe18256 with replacement; duration/follow-up day sets as v3 A1.
      - Frames: the generator applies frames 2c146f28 per mode; the draw does not choose frames.
      - Seed: commit-reveal by herdr-lead (the CLARITY orchestrator since CLARITY-4); cap hard-codes the commitment.
      - TTS: the draw script asserts a NAIVE projection (every turn counted) <= 50,000 chars; router-fix's deduped real-draw dry count,
        second-read by eta-refuter-2, stays the spend gate before any TTS.
 A1.4 E6 SIZE (refuter-2 #9043 B1; dated 7 Oct, before any draw): frames 2c146f28 give ~20 s windows (fv3: median 20.0 s, max 28.6 s,
      #8502), i.e. about ONE Whisper-path segment per window instead of E4's ~2, so 48 en windows would leave gate (a) (>= 50 negatives)
      and likely gate (b) (>= 30 mono flags) NOT EVALUABLE by construction. E6 is therefore ENLARGED: 32 cases x 8 modes x 3 conditions =
      768 windows, 96 per mode; drug slots 96 = 32 mid + 64 long (1 mid + 2 long per case, as A1.3). Gates and bars UNCHANGED.
      TTS: A1.3's NAIVE <= 50,000 assert is REPLACED (at 32 cases the naive count, ~256 dialogues x ~273 chars = ~70k, exceeds it by
      construction while the billed amount does not): the draw script asserts the DEDUPED projection (unique (lang, speaker, text), the
      basis calibrated exactly on the 30 Sep ledger, #8185) <= 45,000; fv3's measured rate (98,524 chars / 880 dialogues = ~112) puts
      256 dialogues at ~29k. router-fix's real-draw deduped dry count, second-read by eta-refuter-2, stays the spend gate (<= 50,000).
 A1.5 TTS assert corrected (cap #9049; dated 7 Oct, before any draw): my A1.4 "~29k" used fv3's ~112 chars/dialogue, which came from
      heavy drug reuse across fv3's 110 cases; at 32 cases there is almost no reuse (~186 chars/dialogue). cap measured the deduped
      projection on 100 random seeds: 45,991 min / 47,660 median / 49,445 max, so the 45,000 assert refused every seed. My error.
      CHOSEN (cap's option a): the draw script asserts its deduped projection <= 50,000 (= the spend gate). cap's basis (unique mode + turn
      key + rendered text) is an UPPER bound of the billed basis (unique lang + speaker + text; the 30 Sep ledger matched the deduped count
      of Unicode characters exactly, #8185), so a pass is conservative. Rejected: (b) 28 cases (shrinks the gate n), (c) shorter frames
      (breaks the 2c146f28 pin).
      Pre-registered FALLBACK (mechanical, decided now): if router-fix's real-draw deduped dry count exceeds 50,000, drop drawn cases from
      the END of the drawn case list, one at a time, until it is <= 50,000; post the number dropped and the resulting windows per mode.
      Gates and NOT EVALUABLE rules are unchanged.
