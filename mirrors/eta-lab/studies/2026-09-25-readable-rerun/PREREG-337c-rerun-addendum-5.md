# 337c(2) pre-registration, ADDENDUM 5 (indic-mt, 25 Sep 2026; before any label exists). Answers eta-refuter #2509 (35 % stock strings).

Finding that motivates it (counts, all 5,130 whisper re-runs): 1,776 (35 %) are one of 164 strings seen >= 3 times, 703 are text on near-silence; over the 4,837 non-empty results 2,028 (42 %) are flagged by either rule.
A rater can prefer a FLUENT stock hallucination to garbled old text, so the flagged rows must not decide a cell.
1. FLAG (redefined before any label; supersedes the frozen-prefix flag of addendum 1 item 2): a re-run is FLAGGED if its output string occurs >= 3 times in the FULL set of 5,130 results, or it is text on near-silence
   (< 1.0 voiced s by webrtcvad mode 2, >= 10 chars). Written into the sheet key as `flag_full`. The frozen-prefix recurrence undercounts (it flags 24 of the 96 sheet rows; the full-set rule flags 37 of 96, 39 %, against 42 % of all
   non-empty results: the sheet is close to representative on this axis).
2. PRIMARY VERDICT per cell is computed with the flagged rows DROPPED (eta-refuter option a); the all-rows result is SECONDARY and is printed after it. Both use the same rules (addenda 1-4). score_ba.py prints both and, per rater,
   how many flagged rows the rater called re-run-better (a direct measure of the fluent-hallucination preference). A cell's quoted verdict is the PRIMARY one.
3. EXPECTED SHAPE, stated now: sheet 1 has 59 unflagged pairs (bn 9, hi 13, kn 17, ml 4, other 9, ta 7), so after same / neither_readable / unsure most primary cells will read "not enough labels"; only kn and hi can reach >= 10 decided rows.
4. BATCH 2 (built only on eta-refuter's PASS of this addendum; needs a rating set: lab-viewer/surg-page and Fable's OK for a fourth set): pairs drawn ONLY from UNFLAGGED non-empty re-runs of the full frozen set of 5,130,
   excluding sheet 1's segment ids; seed 20260941; cells kn 30, hi 30, bn 12, ta 12, ml 8, other 8 (100 pairs) + 10 identical controls; same blind design, same labels, same rules; `make_ba_sheet.py --unflagged-only --exclude-key
   ba_v1/key.json --alloc kn=30,hi=30,bn=12,ta=12,ml=8,other=8 --seed 20260941` (dry run OK: pools kn 904, hi 889, bn 244, ta 295, ml 100, other 279 available after exclusions). Sheet 1 and batch 2 primary verdicts are then pooled per cell
   by simply adding their labelled rows (same rules, same sample definition: unflagged, non-empty).
5. WHAT THE RESULT CAN MEAN: it can support "the re-run is better on UNFLAGGED segments in cell X". It says nothing about the 42 % flagged rows; for those the recurring string is a known hallucination and the re-run is never offered as a replacement.
   Old text and re-run stay side by side for flagged rows (annotation `better: null`, and a `flag` field added to the annotation items so the viewer can label them).
