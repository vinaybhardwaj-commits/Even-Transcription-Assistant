# SURGICAL-CHAIN-LINKER P1: pre-registration v6 (linker, 24 Sep 2026): RXWIN window rule, proc_match v6, policy pending

Adds to v1 to v5; nothing earlier is edited. **No label and no link-3 score exists.** Rule changes below are the code in `p1/procmatch.py` and `p1/build_chains.py` (stage W), committed with this file; stages F and W are run only after this commit. eta-refuter-2 asked for the window rule (#634) and the subset condition (#628).

## B1. RXWIN window rule (refuter #634)
The `RXWIN` window (v2 A4) had a p90 of 100 minutes (median 8.9), so some windows would run past the real consult. From v6 the window is
`end = min( Rx updated_at, start + 30 minutes, start of the same doctor's next visit )`
where a doctor's next visit is the doctor's next queue `called_at` or next hospital-type Rx `timestamp` (an Rx opens at the consult start) that begins more than 60 seconds after this window's start. The 30-minute cap is near the p95 of queue consult duration (38 minutes) and was chosen before this rule was run on the windows. **Reported before any link-3 scoring:** how many windows each rule truncates (the cap alone, the cut alone, either, both, and which binds tighter) and the window distribution before and after. The rule applies to `RXWIN` windows only; queue windows are unchanged.

## B2. proc_match v6 (two changes to v5; refuter #628)
1. **"Implant" is a content word, not an action noun.** Then a subset advice with a shared distinctive word ("implant removal" against "implant removal of large bones - ortho pkg") matches through the ordinary shared-content rule, and no separate subset rule is added. **A bare action noun stays `unknown`:** "excision" or "removal" alone never matches any excision or removal (self-tests: "excision" / "lipoma excision", "removal" / "implant removal", "wide local excision" / "lipoma excision - multiple" all give `unknown`).
2. **Spelling:** British "-our" forms are normalised to "-or" ("tumour" to "tumor").
40 self-tests pass (35 from v5 plus 5 for these changes). The refuter's 20 pairs from #605 and the v5 fresh 20 (posted in #610) all shaped or tested earlier versions; **the check for v6 is a fresh 20, seed 26, excluding every pair graded before, deduplicated per (patient, advised name).** Threshold unchanged (18 of 20; below that, no label and a v7 first). Grading readings as before: same operation fully, and advised operation performed possibly with more.

## B3. Policy: still pending
"Proposed-and-done" = (A) the same operation, fully; (A+) the advised operation performed, possibly with more or with part of a multi-item advice list; (B) the same indication, any technique. Asked of Fable and V (#619); linker and eta-refuter-2 recommend A+. **Until ruled, positives are the full-only stratum and partial, extended, technique_changed, mismatch and unknown are reported as their own strata.** The ruling is recorded as an addendum to this file when it arrives; it does not change any rule above.
