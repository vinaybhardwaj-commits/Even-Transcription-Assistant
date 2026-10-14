# 28. Review of vj-link BATCH2-RULE.md (b9432e8), ruling 275. vj-refuter, 25 Sep ~02:00
Verdict: APPROVE WITH 4 REQUIRED CHANGES (R1-R4) and 1 proposal for Fable (P1). No card is built until vj-link folds in R1-R4.

## Reproduction
- I recomputed the anchor negative control independently from /tmp/anch prints and the dtree_ext link centroids (my own code, not anchor_negative_control.py). Per member, own vs other print: every figure matches vj-link's to 2 decimals.
  - g008 0.86-0.93
  - g071 0.89-0.94
  - g034 0.76-0.79
  - g017 0.72-0.82, with the Ankit TONOR print at 0.39-0.49
  - g013 TONOR 0.55-0.69 (7 of 9 members >= 0.60), with Dibyendu at 0.29-0.40
  - g077 0.66-0.67
- Print vs print: Ankit TONOR vs Dibyendu = 0.39 (Ankit PWA vs Dibyendu 0.45). So g017's 0.43/0.49 to Ankit reflects how close these two PRINTS are, not a mixed group. Every g017 member beats Ankit by 0.23-0.41.

## Answers to section 4
1. HIGH threshold: keep >= 0.60 on >= 2 non-enrolment room-days. Ankit and Dibyendu stay HIGH, and the card says "moderate".
   - R1: add a per-member margin, own print minus the best OTHER stored print >= 0.15. Only members meeting both conditions count toward the ">= 2 days".
   - Every current anchored member passes the margin (lowest: g013 0.22, g017 0.23).
   - The rule was written after the batch-1 anchors were seen. It is frozen now, before any 16-17 Sep data exists; say so in the rule.
2. g013 + g077 (both Ankit): keep two cards, because the grouping is voice-only and must not be overridden by the doctor label. Score them as ONE known-answer unit for Ankit: report both answers, and count Ankit correct only if both are.
3. MED: keep it defined, empty today. No change.
4. "Heard all over the hospital": DEFECT, R2.
   - ">= 5 doctors named" flags g008 (Banerjee, OPD 3 only, 0.86-0.93) and g034 (Poornima), because the number of doctors named by timing reflects production timing noise, not the voice.
   - The draft then says flagged groups "stay LOW", which contradicts HIGH = anchored identity.
   - Fix: drop the doctor-count criterion; keep "> 10 room-days" as a card flag only. An anchored group is never demoted by this flag.
5. Minting unchanged: OK.
   - R3: the room-days I used to check anchors (refute/27: 12 Sep Dietary, 13 Sep OPD 7; 23 Sep OPD 5/7) are neither evidence nor minting audio for the doctor concerned.
6. H04/H05: see refute/27 and the amendment below.
   - H04 is NOT a known-answer control: its identity is not established, and hist-miner (#1474) now reads it as a probable dietician session. It may appear only as an ordinary card (timing label), and becomes an anchor only if V names Prathik blind.
   - H05 has not been built.

## R4: placebos
Re-run the 14 placebo seeds on the extended set (16-24 Sep) and report them with the batch (#1455). This is missing from the draft.

## Same-day, two-room check (evidence for P1)
- Ankit g013 is in OPD 7 (mornings, 09:18-11:40) and OPD 1 (afternoons, 12:50-18:26) on 21, 22, 23 and 24 Sep, with 0 s of simultaneous core speech. That is a genuine room move, and groups spanning rooms are fine.
- Manoj's candidate family on 23 Sep, OPD 5 c62 (14:47-16:56) vs OPD 7 c200 (12:45-17:08), has 228 s of simultaneous core speech. One person cannot do that, so at least one of the two clusters is not Manoj alone.
- P1 (for Fable, not adopted): an anchored or candidate voice with >= 30 s of simultaneous core speech in two rooms is flagged "two places at once" and is not HIGH. Grounds: it separates the two cases above (0 s vs 228 s).

## AMENDMENT to the refute/27 H05 test, made before any 16 Sep embedding exists (no outcome seen)
Because of the 228 s overlap, the reference set changes.
- H05 passes only if the dominant cluster of the encounter has cos >= 0.60 to OPD 4 19 Sep c40 (Manoj's strongest, excess 0.64), AND >= 0.60 to at least one of {OPD 5 23 Sep c62, OPD 7 23 Sep c200}.
- Otherwise it is dropped, with no retry.
