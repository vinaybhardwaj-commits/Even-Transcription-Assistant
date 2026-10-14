# READABLE TRANSCRIPTS 337b: addendum A2 (linker, 25 Sep 2026; the git commit time is the timestamp): T1's input is the viewer's LIVE view index, not the morning index; frozen BEFORE the code change and before any real call

Addendum to `PREREG-337b.md` (e3f921b) and `PREREG-337b-A1.md` (20dec29). Reason: eta-refuter-2 #1917 must-fix 1 (the morning index `windows-20260925.jsonl`, 2,235 windows, predates last night's HIST output; by his count it misses 8,549 in-scope segments) and lab-viewer #1926 (the viewer's index is what V reads). Ruling 337b says "all indexed windows"; the window set V can open is the viewer's index. **Only T1's input and the resolve order change; the language list, route, output format (A1), resume rule and the checks stand.** conductor to confirm with Fable that 337b's "all indexed windows" means the live view index (a morning count of 2,235 was a snapshot).

## A2.1 Input (replaces T1's index and roots)
- **The index is the newest `~/eta-data/lab-vault/staged/index/view-*.jsonl`** (file names sort by time), read afresh at the start of every run; its file name is written into each annotation file's provenance as `index_file`. Fields used: `key`, `ist_date`, `room_id`, `start`. Each row names one best record per window.
- **Roots, in this order (first that exists):** `~/eta-data/hist-mining/`, `~/eta-data/hist/`, `~/eta-data/lab-vault/staged/` (lab-viewer #1926). A key that resolves under none is reported as unresolved, never skipped silently.
- **Counts at freeze (from the box, no text read by me, index `view-202609250812.jsonl`):** 4,927 windows; all resolve (4,655 under hist, 241 under the vault, 31 under hist-mining); 900 have no segments; **2,624 windows hold in-scope segments: 13,901 segments in the 8 listed languages.** This replaces T1's 5,251 (the morning index) and A1.3's numbers; the rule "8 listed tags only; `und` and `pa` counted, not sent" is unchanged.
- A later run reads the then-newest view index, so windows indexed after this freeze are picked up by the resume rule (A1.2); nothing is translated twice.

## A2.2 Order (T4's wording made exact)
Newest date first (**24 Sep, then 23, then 22, then 21 and backwards**), within a date by window start. Nothing else about the order changes.

## A2.3 Checks (T5 applies to the new commit)
The tests gain: a window that is only in the view index (not in the morning index) is selected; the newest view file is chosen and its name is written to `provenance.index_file`; the resolve order (hist-mining before hist before the vault). Mutants with a control run. eta-refuter-2's review and PASS, then Fable's OK for the `annotations/` vault key kind (lab-viewer's uploader holds it until then; HOLD file present), then the invented-line preflight, then at most 5 windows, then the full run.
