# Phase L, batch-2 rule v2 (ruling 275). FROZEN before any 16-17 Sep embedding or result exists. Reviewed by vj-refuter (refute/28: APPROVE WITH R1-R4; all four folded in below).

vj-link, 25 Sep 2026. Ruling 275: drop exclusivity as a HIGH gate; **HIGH = anchored identity**; the group vote is shown as a **label, never a gate**; known-voice cards for Poornima g034 and Dibyendu g017; hist-miner's H04/H05 as candidate anchors after vj-refuter checks them; extend the cross-day span to 16-17 Sep.

**FREEZE STATEMENT.** This rule was written and frozen on 25 Sep 2026 before any 16-17 Sep embedding, cluster, group or anchor match exists. State of the 16-17 Sep run at the time of freezing: the windows are being rebuilt from R2 chunks and diarized (no embeddings, no voicelink, nothing looked at). Every threshold below was set from the 9-15 and 18-24 Sep data and the stored prints' own enrolment records; none was tuned on 16-17 Sep. The sha256 of this file at the freeze is in the bus post that announces it. Any later change is a new version with its own hash and is reported.

## 1. Data and groups
70 room-days 9-24 Sep now, plus 16-17 Sep (14 room-days) when done. Voice = a top cluster of one room-day (dense ECAPA, cut cos 0.30, core 0.45). **Group = voices of different room-days, complete linkage, every pair cos >= 0.85** (voice-only, independent of any doctor label; never overridden by a doctor label).

## 2. Tiers
- **HIGH = ANCHORED IDENTITY.** A group counts as anchored to doctor D when **>= 2 member voices, on >= 2 distinct room-days that are NOT enrolment sessions of D, each have cos >= 0.60 to one of D's stored, V-verified prints AND (R1) a margin of at least 0.15 over the best OTHER stored print** (member's own-print cos minus its highest cos to any other doctor's print). Only members meeting both conditions count toward the >= 2 days. Prints: room/mic prints compared with room audio (source-conditioned); ankit-pwa is excluded (vj-refuter L2); a Meet-source print (Dibyendu) is allowed and the card says so. Strength shown on the card: strong (>= 0.85) or moderate (0.60-0.85), with the number of days and the cos range.
- **MED = a NON-anchored cross-day group with a passing strict vote**: >= 2 room-days, >= 5 core turns of the voice inside the labelled doctor's consults, and the strict vote passes (>= 3 of >= 4 voted days name the same doctor, share >= 40%, binomial tail vs 12.5% chance < 0.01). Empty on the 70 room-days; kept defined.
- **LOW = everything else.**
- **Exclusivity is not a gate anywhere.**
- **(R2) The doctor-count criterion is dropped.** "Number of doctors named by timing" reflects timing noise, not the voice. The only voice-based card flag is **"heard on > 10 room-days"**, shown as text on the card and never a demotion: an anchored group is never made LOW by it.
- **The vote label** (not a gate), on every non-anchored card: "Timing guess: on k of n days where this voice is heard, the best timing match is Dr X (a random pick would give about 1 in 8)", plus the uniform caveat that timing labels are right about half the time. The k/n and the placebo p go in the key and the report. Anchored cards carry the known-voice text instead of a timing guess.

## 3. Known-voice stratum and scoring
- **Own stratum**, scored blind-first (refute/26), never counted as link agreement or toward any auto-accept. Members: the 3 batch-1b anchors (Salanki g071, Banerjee g008, Ankit g013), plus Poornima g034 and Dibyendu g017; g077 (Ankit, 2 days) is a separate card. **Ankit's two groups g013 + g077 stay two cards (the grouping is voice-only) but are scored as ONE known-answer unit: Ankit counts correct only if V is right on both** (refute/28, item 2).
- The HIGH set is small by construction (5 stored-print doctors): the 30-HIGH auto-accept can never be reached and none is proposed.
- Enrolment sessions of D are never evidence or minting audio for D. Minting still needs V's agreement + the ruling-182 controls on a held-out non-enrolment day.
- **(R3)** The room-days vj-refuter used to check candidate anchors (12 Sep Dietary Room, 13 Sep OPD 7, 23 Sep OPD 5 and OPD 7) are neither evidence nor minting audio for the doctor concerned.

## 4. H04 / H05 (hist-miner candidates), pre-registered
- **H04** (Prathik, 12 Sep Dietary Room, booked Left RIRS): NOT a known-answer control. hist-miner (#1474) now reads it as a probable dietician session; identity is not established. It may appear only as an ORDINARY card (timing label), and becomes an anchor only if V names Prathik blind. 12 Sep Dietary is excluded from scored cards.
- **H05** (Manoj, 16 Sep OPD 4, booked right knee arthroscopy): test frozen by vj-refuter BEFORE 16 Sep is embedded (refute/28 amendment). H05 PASSES only if the dominant cluster of the encounter (most seconds, cos >= 0.5) has **cos >= 0.60 to OPD 4 19 Sep c40 AND cos >= 0.60 to at least one of {OPD 5 23 Sep c62, OPD 7 23 Sep c200}**. Otherwise it is dropped, no retry. On PASS it is a known-voice card (V confirms blind) and 16 Sep OPD 4 is excluded from scored cards. I run it exactly once, when 16 Sep is embedded, and report the numbers whatever they are. Encounter window: hist-stage1b items.json called/completed (15:30:12-15:35:09 IST on 16 Sep, clamped bounds flagged by hist-miner).

## 5. Placebos and reporting (R4)
The 14 placebo seeds (hour shifts +-4..+-7, date offsets 1..6) are re-run on the EXTENDED set (9-24 Sep incl. 16-17 Sep) and reported with the batch, together with the vote-precision test against the anchors under the same placebos.

## 6. Proposal for Fable, not adopted (vj-refuter P1)
A voice with >= 30 s of simultaneous core speech in two rooms on the same day is flagged "two places at once" and is not HIGH (physical-possibility check, unlike exclusivity). Evidence so far: Ankit g013 has 0 s overlap across OPD 7 / OPD 1 (a genuine room move); Manoj's candidate family on 23 Sep has 228 s. I will compute the flag for every group and report the counts; it is NOT applied unless Fable adopts it.

## 7. Not built yet
No card, no seed. Order: (1) 16-17 Sep embeddings and voicelink; (2) H05 test (once); (3) anchored groups on the extended set under this frozen rule; (4) placebos on the extended set; (5) batch 2 = known-voice stratum (g071, g008, g013 + g077, g034, g017, H05 if it passes) + H04 ordinary + LOW controls, same card rules (per-turn, single-speaker, seeded, non-enrolment days, key with session per clip), sent to vj-refuter before surg-page.
