# SURGICAL-CHAIN-LINKER P1: pre-registration v7.9 (linker, 24 Sep 2026): non-English speech in HIST windows: score the English text, count the rest, name the limit

Addendum to v7.8; nothing earlier is edited. **No link-3 HIST window has been read; nothing scored.** Code: `p1/link3_run.py`, committed with this file. Reason: a test of the HIST-window reader on 40 existing research-pipeline outputs (not link-3 windows) found **106 of 433 turns (24%) non-English**. The v7.4 wording and my first scorer treated any non-English turn as making a room incomplete; on real windows that would discard most items for a reason unrelated to whether the visit is there.

## M1. The rule, fixed now
1. **Only English turns are scored.** Turns whose recognised language is not English are never sent to Jev (the de-identification model finds no names in Indic script, and the gate refuses untranslated text); they are left out of the scored text and **counted**. No translation step is added here.
2. **Per room window, the share of non-English turns is recorded.** A room window with **more than half its turns non-English** is `LANGUAGE_LIMITED`. An item with any `LANGUAGE_LIMITED` shortlisted room is reported as **`LANGUAGE_LIMITED`, neither accepted nor rejected**, in its own count: a below-floor score there may be untranslated talk, not an absent visit (the same reasoning as `INCOMPLETE`). An item whose rooms are each at most half non-English is scored normally, with the share printed beside the score.
3. **The residual-identifier gate runs on the English turns that will be sent.** Non-English turns (whose original-script text the de-identification tool omits) are excluded from the gate and from Jev alike.
4. `INCOMPLETE` keeps its meaning: a shortlisted room with no transcript at all (zero turns), no HIST output, or no turns inside the consult plus or minus 2 minutes.

## M2. What this makes visible
Every link-3 table carries the `LANGUAGE_LIMITED` count next to `INCOMPLETE`, `SINGLE` and the ambiguous ties, so the yield lost to language is a stated number and not a hidden one. Whether a translation step is worth building is a decision for Fable once that number is known; nothing in P1 assumes it.
