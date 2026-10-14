# SURGICAL-CHAIN-LINKER P1: pre-registration v7.3a (linker, 24 Sep 2026): a HARD synthetic set before any real pair (refuter #707)

Addendum to v7.3; nothing earlier is edited. **No patient text; no real pair scored.** Code: `p1/link3_judge.py` (`hard_check`), committed with this file; the run happens afterwards. Reason (eta-refuter-2): the easy decoys of v7.3 cannot show the failure I predicted. Real same-day decoys in a surgical clinic share the complaint, and the frozen question asks for the same main complaint AND consistent medicines.

## F1. The set: 12 invented visits, each scored against its own prescription and against one decoy (24 calls)
- **H1 (4 pairs): the decoy has the SAME complaint but DIFFERENT medicines** (knee pain, gastritis, hypertension review, sore throat).
- **H2 (4 pairs): DIFFERENT complaint, SAME medicines** (tension headache against fever with body ache; acidity against back pain on a painkiller; allergic rhinitis against urticaria; knee pain against shoulder strain).
- **H3 (4 pairs): both routine and near-identical** (diabetes, hypertension, thyroid review, viral cold): same complaint and same common medicines, with different wording only (not word for word, so the tie is a real measurement, not a copy).
Route, question wording, floor and margin are exactly v7.3's. The window stays the pre-registered 10 minutes either side: "encounter plus or minus 2 minutes" needs encounter bounds that queue and prescription-window visits do not have (their windows are software events), so it is not a like-for-like saving and is dropped unless a v7.4 changes it before any real pair.

## F2. Acceptance, written before the call
- **H1 and H2:** own >= 0.50 and own minus decoy >= 0.15 for at least 3 of 4 pairs **in each group**. Failing either means the judge cannot separate on medicines alone (H1) or on complaint alone (H2), and the question or the margin rule is revised in a v7.4 from synthetic pairs only.
- **H3 is descriptive only and is expected to tie.** Report own, decoy and margin per pair and the **tie rate** (share of pairs with margin below 0.15). It predicts how often real same-day visits fall into SINGLE or margin-fail, and so how strong the selection effect in the A6 table will be, before any patient text is spent.
