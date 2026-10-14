# vj-refuter: VOICE-LINKAGE (ruling 183) order review, before vj-link builds

## Tiering
- K1 RECURRING VOICE != DOCTOR. "The cluster present in most consults while patients change" also describes a nurse, attendant or scribe who sits in every consult. Such a person also reads out prescriptions (Rx spoken >= 1), and Jev text may call them doctor. A staff voice can reach HIGH.
  - Need a discriminator: the cluster holds the most speech time in the consults, AND it is still the top cluster on a day when the staff differ, or V's "Same person?" pairs anchor it.
- K2 DOUBLE-COUNTED EVIDENCE: step 3 (Rx items spoken) and step 4's LQ ("contains the prescription items") measure the same thing. HIGH should count them as one criterion, not two.
- K3 WEAK BARS: "Rx items spoken >= 1" can be met by a patient repeating a drug name. Use a share, e.g. >= 50% of the spoken Rx items attributed to the cluster.
  - PQM "matched >= 3 consults" needs a separation from the runner-up doctor, because PQM has no room dimension: two doctors with parallel consult timings in adjacent rooms would both "match". Require the runner-up doctor to match <= half as many consults.
- K4 CROSS-DAY CIRCULARITY: step 5 compares with "D's clusters on other room-days", which are themselves unverified links. A wrong binding that repeats (same staff voice, same room) confirms itself. Cross-day agreement should count only against already-agreed links or the V-verified clips.

## LQ freeze
- L1: freeze the LQ text AND the rendering of the per-card item list (format, order, max items). The list is card data, so the hash covers only the template.
- L2: LQ adds nothing independent of step 3 (see K2). Keep it as a report field, not a tier criterion, or drop step 3's count.

## Clip selection (no patient-only clips as "doctor")
- C1: production clusters are IMPURE. My ruling 182 test found cluster embeddings diluted even where per-turn scores reach 0.8. A random turn from the "doctor" cluster can be the patient.
  - Choose clips per TURN: single non-overlap turn (diarizer overlap flag false), 4-8 s, per-turn ECAPA cosine to the cluster's clean core >= 0.6.
  - Choose the contrast clip from a different cluster with cosine to that core < 0.3.
- C2: pick the eligible clips randomly with a seed, not the builder's "best" ones. Cherry-picking inflates agreement.

## HIGH auto-accept (>= 95% of the 20 HIGH sample)
- A1: 19/20 agreement has a 95% lower bound of about 75%. Auto-accepting the rest could still carry about 25% wrong links. Use >= 30 HIGH with <= 1 disagreement, or 20/20.
- A2: ANCHORING. The card shows V the evidence ("PQM 9 of 11, Jev doctor 0.86") before he listens, so V can agree with the evidence rather than the voice. For the HIGH audit sample, show audio first and reveal the evidence after the verdict.
- A3: auto-accepted HIGH links must never enter VJ truth. Only human-agreed links may.

## Minting controls
- M1: exclude ALL VJ test room-days (the refute/06 list, plus the test windows' room-days) from minting audio. Otherwise the VJ margin is scored against centroids built from the test audio (circular).
- M2: add ruling 182's NEGATIVE control (< 0.40 against other doctors' minted centroids), not only the >= 0.70 positive control on the held-out day. Also check the held-out day is a different day, not the same session.
- M3: "Disagreed links become negatives in the VJ truth" is not valid as stated. A disagreed link says "this cluster is not doctor D", not "this is not a doctor". It is only a not-doctor negative if V answers "who is it?" with a non-doctor. Otherwise it is excluded.

## Addendum 18:50 (V): 60-card first batch (30 HIGH / 18 MED / 12 LOW); HIGH auto-accept needs >= 95% on >= 30 rated HIGH
- A1 largely RESOLVED. At n = 30 the rule allows at most 1 disagreement (29/30 = 96.7%).
  - One-sided 95% lower bounds on the true agreement: 29/30 -> 0.851, 30/30 -> 0.905, 57/60 -> 0.876. The old rule (19/20) gave 0.784.
- A1b (new): "Not sure" must count in the denominator as not-agree, or be capped (e.g. <= 2 of 30). If it is dropped, a batch where V is unsure on the hard cards can still pass at 95%.
- A2 (anchoring: audio before evidence) and A3 (auto-accepted links never become VJ truth) are still open.
