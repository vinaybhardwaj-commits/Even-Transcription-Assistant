# FUSER v2-E — short pre-registration (dated 2026-09-29, lid-debug, designer; Fable #7635 item 2)
Status: DRAFT r3 for eta-refuter-2 (r1 b03a9263; r2 9490820f §4 draw reference; r3 #7646/#7650 R1b, R2, nit). Supersedes nothing: v2-D's FAIL (FUSER-V2-PREREG.md r3 1f754d01; result #7616, confirmed #7617)
stands and is reported beside any v2-E result. LAST ITERATION: if v2-E fails the fresh set, FUSER stops (Fable #7635).

## 0. What v2-E changes (and nothing else)
v2-E = v2-D (D1-D6, leading-block placement, G1-G4, attributed S1, blind rule, no scorer import: all unchanged) with the three
defects found on DEV fixed:
 F1 false drugs: 45/50 false inserts were ordinary English words whose consonant skeleton equals a short lexicon entry
    (urea <- "these are", iron <- "we are", coal tar <- "culture", min <- "tell me", omni gel <- "Mingal"), all at skeleton sim 1.0.
 F2 lost P items: D4 missed P's split Tamil-script drug names ("மெட் ஃபார்மின்", "பாண்டோ பிரசோல்"), so v2 re-inserted them and the
    insert became S1's first mention (G3m, #7622).
 F3 wrong doses: 15/87 D-any dose inserts wrong (Whisper's own value wrong, e.g. 50 for 40).
DISCLOSED: every rule below was written AFTER reading the DEV failure, and the letter-similarity threshold was chosen knowing DEV
misspellings (telmosartin 0.82, ottervastatin 0.77, domperdone 0.91 vs collisions <= 0.43). That is why the gate is a FRESH set.

## 1. Matcher (replaces D1's candidate rule; lexicon, T_WHISPER 0.9 and T_MARGIN 0.1 unchanged)
 M1 Letter check: a candidate must pass BOTH the v1 consonant-skeleton similarity >= 0.9 AND letter-level similarity (1 - edit
    distance / longer length, lowercase a-z only) >= 0.65; the uniqueness margin stays on the skeleton.
 M2 Token count: a one-word lexicon name matches ONE Whisper token. A two-token join is allowed only if NEITHER token is in the
    English list (M4) and each has >= 3 letters. A multi-word lexicon name matches the same number of tokens, word by word, each
    word passing M1.
 M3 Name length: lexicon names with < 5 letters are excluded from inserts.
 M4 English list: wordfreq (pinned version, recorded in the run header) top_n_list("en", 20000), lowercase. (a) A Whisper token in
    the list is never a candidate; (b) a lexicon name that is itself in the list (e.g. iron) is excluded from inserts. Recall cost of
    (b) is declared, not measured on DEV.
 M5 Decoy sweep (no DEV, no fresh-set content), run once the matcher is built, before the fresh set is drawn: run D1+M1-M4 over
    (i) wordfreq top_n_list("en", 50000) as single tokens and (ii) all ordered pairs of the top 500 words as joins. PASS = 0
    candidates. If > 0: every lexicon entry that produced a hit is excluded (mechanically, the list is published with its sha), and
    the sweep re-runs until 0. The final exclusion list is frozen before the fresh set is seen.

## 2. P-coverage (replaces D4's native check)
 D4-E: romanise P's Indic text with mic_selftest.indic_to_latin, loaded from the PINNED blob 3b5b3c047bfd (kit/mic-selftest/
    mic_selftest.py @ befea6ac, hash-checked on load). It is the romaniser S1 itself uses to credit P's native mentions (refuter-2
    #7646 R2), so D4-E cannot miss a mention for script reasons that S1 credits; mic_selftest is neither clinical_score nor
    cap_scorer, so the no-scorer-import rule holds (the test enforces both names). Over 1-3 token joins of the Latin result, P holds
    the drug if consonant-skeleton similarity >= 0.72. (Over-detecting "P already has it" only costs an insert, never an item P gets.)
    Latin tokens of P: unchanged from v2-D (skeleton >= 0.9 over 1-2 token joins).
    Property test (synthetic renderings of lexicon names in the 5 Indic scripts, split and unsplit): whenever S1's _find (0.72) credits
    P's native name, D4-E also detects it. The test may import the scorer; fuserv2 code may not.
 Unit tests on SYNTHETIC strings (the two DEV Tamil renderings may be used as fixtures, disclosed): P holding "மெட் ஃபார்மின்" or
    "பாண்டோ பிரசோல்" -> no insert.

## 3. Dose (replaces D2's value source for the insert; the scan itself is unchanged)
 E-D: an insert carries a dose only if >= 2 of the 3 Whisper tracks give the SAME value (and the same unit when both carry one)
    after that drug; else the insert is drug-only. Applies to both D-any and D-two.
 If G4's dose bound fails, doses are switched OFF and G1/G3m are computed on the drug-only output (stated in the report, not re-run).

## 4. Evaluation
 PRIMARY = the FRESH DEV set, drawn exactly per eta-refuter-2's rule /home/eta/oc/eta-refuter-2/FRESH-DEV-DRAW-v2E.md
 (sha16 360d0f47f871d2b6, #7638): new frames by an author who is neither designer nor builder, Fable's seed commitment, mechanical
 case table from the Pulse lexicon excluding clinical1/confirm1-3 drugs, stratified by name length, 8 cases x 8 modes x 3 conditions
 = 192 windows, P = old router 400710ee S1 run, Whisper tracks at DEV's config hashes. Nobody reads it before the one run.
 Declared interactions with this pre-reg: (a) lexicon overlap is 100% by construction, so insert RECALL is optimistic; G4 is the
 honest test; (b) drawn drugs that M3/M4(b)/M5 exclude (short names, English-word entries, sweep exclusions) can never be inserted:
 their items stay as P has them. That is a real recall cost of the safety rules and counts against G1; it is not avoided.
 < 50 inserts = NOT EVALUABLE = FAIL. Gates G1 (attributed), G2, G3m, G4: exactly as FUSER-V2-PREREG.md r3 §4, including the minimum-n rules.
 SECONDARY (reported, never gating, labelled post hoc): v2-E on clinical1, beside v2-D's FAIL.
 One run on the fresh set, no tuning. Blind rule unchanged (R3/W51 room-days, L041/L057/L139/L182; guard before any content read).

## 5. Build
 Builder router-fix, reviewer eta-refuter-2 (reviews each step; does NOT draw), USD 0. Order, each step posted with a sha:
 1 matcher + D4-E + E-D + tests built, witnessed; M5 decoy sweep run and its exclusion list frozen; code sha frozen (freeze post).
 2 Fable commits sha256(seed).  3 the AUTHOR (neither lid-debug nor router-fix; Fable names) posts new frames + dx/inv list + draw script.
 4 seed reveal; the case table is drawn MECHANICALLY by that script (360d0f47 rules).  5 generation (pinned generate.py), sha list.
 6 P (old router 400710ee S1 run) and the 3 Whisper tracks at DEV's config hashes.  7 ONE v2-E run; gates; refuter-2 re-derives.

## A1 — amendment, dated 2026-09-29 23:45 IST (after router-fix built 24e4a88a, #7669; BEFORE Fable's seed and before any fresh-set step)
 A1.1 D4-E widened (router-fix's disclosed deviation), ACCEPTED: P holds the drug if the whole-name skeleton >= 0.72 (as §2) OR an
      S1-mirror coarse key >= 0.72 (whole name or first word), romanised with the pinned mic_selftest. Reason: §2's rule alone failed
      the pre-registered property test (DEV Tamil rendering at 0.71). It is a superset, so it can only REMOVE inserts (recall cost),
      never lose an item P gets. The code's docstring must say this (24e4a88a's docstring still says "first word: none").
 A1.2 M5 identity hits: the sweep's 18 hits were ALL identity hits (the English token spelled exactly like the lexicon name, e.g.
      "ibuprofen"); there were ZERO collisions from a different word. M5 exists to catch different words collapsing onto a name, so:
      an identity hit is not a collision. Of the 18, the 12 drug substances are RESTORED (codeine, estradiol, glutathione, heparin,
      ibuprofen, manganese, melatonin, menthol, paracetamol, progesterone, salicylic, turpentine). The 6 that are disease names or
      nutrient classes, not a prescribed substance, stay EXCLUDED (antioxidants, carbohydrate, diphtheria, electrolytes, mumps,
      tetanus), because in a consult they are said as ordinary clinical words. The list is fixed here by name, not re-derived; the new
      exclusion file (6 names) gets a sha in the freeze post. Any non-identity hit in a re-run sweep is still excluded as in §1 M5.
 A1.3 Evaluability, disclosed: router-fix's DEV count smoke gave D-any 36 inserts (v2-D had 148, of which 98 were correct). Fewer than
      50 fresh inserts = NOT EVALUABLE = FAIL, unchanged. router-fix posts, BEFORE the freeze, the DEV breakdown of v2-D's 98 correct
      D-any inserts by the first v2-E rule that removes each (M1, M2, M3, M4, M5, D4-E, E-D n/a). COUNTS ONLY, no thresholds change
      from it; it is for the record, so a NOT EVALUABLE fresh result can be read.
 A1.4 Ruled by Fable #7675 (23:40): M5 option (c) exactly as A1.2 (12 kept, 6 excluded, named); D4-E deviation accepted as A1.1.
      Fresh-set AUTHOR = cap (per 360d0f47 step 3); Fable posts the seed commitment after the freeze post.

## A2 — citation-only amendment, dated 2026-09-30 00:0x IST (before Fable's seed commitment; no fresh content exists)
 §4's draw rule is now eta-refuter-2's rule v2, FRESH-DEV-DRAW-v2E.md sha16 1d16e2368515c894 (#7690; v1 360d0f47 kept as
 .v1.360d0f47.md): 16 cases x 8 modes x 3 conditions = 384 windows, length strata doubled; nothing else changed. Requested by lid-debug
 #7688 on evaluability grounds (A1.3 / router-fix #7687: DEV smoke D-any 46 inserts, 26 with a dose, at 192 windows). No threshold,
 rule or gate moves; "< 50 inserts = NOT EVALUABLE = FAIL" and "< 30 dose inserts -> doses OFF" stand. Frozen code: router-fix/v2e
 2eccd9dd (tag fuserv2e-freeze-2eccd9dd, #7689), M5 list sha256 42501e65.
