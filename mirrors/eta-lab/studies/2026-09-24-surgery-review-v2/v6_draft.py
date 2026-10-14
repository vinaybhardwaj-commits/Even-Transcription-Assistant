#!/usr/bin/env python3
"""v6_draft.py — SURGERY-REVIEW-V6 wording DRAFT 1, UNFROZEN (fleet, 24 Sep 2026). Nothing here is scored on a real set: it exists to be trialled on INVENTED fixtures (v6_trial.py) and dev items.
Source of the changes: eta-refuter-2 #1075 F1-F4 on frozen v5 vs judge-K (the 40 are NOT used to tune this; the next fresh set scores it after a freeze).
  F1  v5's category text said 'CT angiography counts as an intervention' yet answered imaging_ct on all 4 angiograms: intervention now NAMES CT angiography, imaging_ct excludes it.
  F3  a CT coronary calcium score (OUT by the list) read as a CT: the exclusion now says a CT used only to count calcium is not a CT scan here.
  F4  mentioned_only precision 0/3 and 'done in this visit' status: NOT addressed in draft 1 (not reproducible on invented fixtures; needs realistic fixtures, not the 40).
The gate (a0) is untouched: its false holds were garbled / looped transcripts, a transcript-quality loss (F2), not a wording problem.
"""
import copy
import v5

WORDING_VERSION = "u9-v6.0-draft1"
FROZEN_SHA256 = None  # UNFROZEN: a freeze record and hash come later; v6 must not score a real set until then
RECALL_CUT, GATE_CUT, A0 = v5.RECALL_CUT, v5.GATE_CUT, v5.A0
CAL = ("A CT scan done only to count calcium in the heart arteries (a coronary calcium score) is NOT a CT scan here and does not count, even when the doctor explains it.")
A = copy.deepcopy(v5.A)
A["named"]["instructions"] = A["named"]["instructions"].replace("a treadmill test, a calcium score or a blood test does NOT count.", "a treadmill test, a calcium score or a blood test does NOT count. " + CAL)
A["described"]["instructions"] = A["described"]["instructions"].replace("a treadmill test, a calcium score, a blood test.", "a treadmill test, a calcium score, a blood test. " + CAL)
assert CAL in A["named"]["instructions"] and CAL in A["described"]["instructions"]
B = copy.deepcopy(v5.B)
B["category"]["criteria"]["intervention"] = ("an intervention such as angiography or angioplasty, CT angiography (a CT scan with dye to show the blood vessels), endoscopy, a biopsy, or an injection procedure done in a procedure room")
B["category"]["criteria"]["imaging_ct"] = ("a plain CT scan, or a CT scan with contrast that is NOT an angiogram, advised, ordered or discussed as the procedure (page label: imaging: CT); a CT ANGIOGRAM is an intervention, not this")
# F4 (mentioned_only precision) and 'done in this visit' status: NOT changed in draft 1. The invented fixtures do not reproduce either failure (v5 already answers them right), so an edit here would be untested wording.
C_PROPOSED, C_DESCRIBED, CATEGORIES = v5.C_PROPOSED, v5.C_DESCRIBED, v5.CATEGORIES
