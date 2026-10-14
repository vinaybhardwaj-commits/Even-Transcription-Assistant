# SURGICAL-CHAIN-LINKER P1: pre-registration v7.2 (linker, 24 Sep 2026; the git commit time is the timestamp): the three conditions on v7 C2 (eta-refuter-2 #686)

Addendum to `P1-PREREG-v7.md`; nothing earlier is edited. **No link-3 score exists.** The refuter accepted C2 (maturity protects absence, not presence) on the logic and attached three conditions, all before link-3 scoring.

## D1. The link-3 comparison is positives against N2 from the same weeks; N1 is descriptive only (era confound)
The relaxation of C2 puts positives in September while N1 stays in August (mature only). September audio went through a different transcription pipeline (whisper voice-activity gate off from 24 Sep 04:39, other stack changes) and a different booking era (auto-created cases from 14 Sep). A positive-versus-N1 comparison would confound class with era. **Pre-registered:** the link-3 comparison of class is **positives versus N2 (no procedure advised) from the same ISO weeks** (N2 takes any date, so a same-era set exists: 15 on tape today). **N1 (advised, no evidence of done in our records) is reported descriptively** (2 on tape today) and enters no comparison. Matched draws are unchanged (same doctor and ISO week, adjacent week flagged).

## D2. Fast-surgery selection: the procedure mix is shown beside every link-3 result
Immature positives are the ones operated on within days. Every link-3 table carries the procedure-type mix (`ptype`) of mature positives, immature positives, and the positives on tape. Descriptive table on today's frozen data (a positive can carry more than one type):

| Group | n | Most frequent types |
|---|---|---|
| Mature (Rx on or before 22 Aug) | 50 | hysterectomy 6, myomectomy 5, hemorrhoidopexy 4, endometriosis 4, untyped 4, circumcision 3, sphincterotomy 3, cholecystectomy 3 |
| Immature (23 Aug on) | 42 | circumcision 5, myomectomy 4, endometriosis 3, hysterectomy 3, untyped 3, hysteroscopy 3, LSCS 3, cystoscopy 2, Mirena 2 |
| On tape (link-3 set) | 20 | septoplasty 2, endometriosis 2, hysterectomy 2, replacement 2, circumcision 2, then singles |

The immature group has more day-care procedures (circumcision, LSCS, Mirena, cystoscopy, hysteroscopy); the mix is otherwise similar. Time from prescription to done evidence is not measured here (done evidence is a flag, not a date).

## D3. Transcription pipeline state is recorded per audio item
For every audio item used in link 3 the item record carries the transcription engine and flags version and whether the audio was transcribed **before or after the 24 Sep 04:39 voice-activity-gate change**. An item with no recorded pipeline state is excluded from link-3 comparisons and counted.

## D4. Open, needs a ruling before link-3 scoring: which judge scores the content link
Link 3 scores a transcript against a prescription (complaint and medications). Both are patient text. The `even-jev` tool description forbids sending patient data to its endpoint, so it cannot be used for this. The route for the content score (a local model on the box, or the surgery-review judge that V's page already uses) and its 0-1 scale check on synthetic pairs must be named by Fable before any scoring. Until then link 3 is blocked on this, not on the linker.
