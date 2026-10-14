# Refute: vj-link Phase L overnight 18-24 Sep (adf1c29, REPORT-OVERNIGHT.md): page batch 1 = 1 HIGH / 2 MED / 57 LOW

## Confirmed from vj-link's own placebo arm (my P1 was right)
- Count level: real HIGH 1 / MED 2; placebo +4 h HIGH 1 / MED 2; placebo -4 h HIGH 0 / MED 4. vj-link says so itself: "the tiering does not beat chance at the count level".
- Both real MEDs are placebo-robust voice groups whose NAMED DOCTOR changes with the time shift:
  - g032 (rd_aeeu5u4j c12 + rd_kp4c7pp6 c75): real names doctor mjAB4A; placebo +4 h names aQS6zt, and it is MED there too (g026, identical members).
  - g000 (rd_364sjn85 c31 + rd_qjw6srbs c20): real names R3IEiN; placebo -4 h names Rs06m6 (MED there too).
  - So these voices recur (real signal), but WHICH doctor they are linked to is set by timing noise. The MED doctor labels are not credible.
- The placebo +4 h HIGH (g027) links a voice from Salanki's OPD 5 room-days (rd_ed8endsg, rd_yck5kdc2) to doctor oJfsVS, not Salanki (MFTZnX). HIGH can name the WRONG doctor by chance.

## The one real HIGH (g043: rd_djmbtzph c93 + rd_tcqaam5c c24, Cardiology 22/23 Sep, doctor JKJxJj): NOT refuted, plausible
- Production voice attribution on rd_djmbtzph (vj-link's own turn list joined to room_turn_speaker by source_ref/time):
  - production credits 1,364 turns to Dr Dibyendu Majumdar (the room's voiceprinted doctor);
  - the largest cluster c216 (1,679 core turns) is 49% production-clinician, so c216 = Dibyendu;
  - the HIGH voice c93 (171 core turns) is 0% production-clinician. It is NOT Dibyendu.
- The HIGH names JKJxJj (not Dibyendu, whose uid is bKr81B), so it is consistent with a SECOND doctor who consults in Cardiology and has no production voiceprint.
- Its excess is 0.72, vs 0.36 for the runner-up doctor on c93 (well above the run median 0.29). Under the placebos the same voice names oJfsVS (+4 h) / z04sk8 (-4 h) at lower excess.
- The HIGH is therefore plausible, not proven. Check for V: the card should state that the linked voice is NOT the room's voiceprinted doctor. If V knows JKJxJj consults in Cardiology on 22/23 Sep, it is a real find.

## Recommendations (Fable)
- R1: auto-accept of HIGH must stay OFF while real tier counts are at placebo level. The ">= 95% on >= 30 HIGH" gate cannot be reached this batch anyway (1 HIGH). Say it explicitly for later batches: tiers must beat the placebo (e.g. real xday+excl+n5 count > the placebo 95th percentile over >= 10 random shifts) before any auto-accept.
- R2: MED cards: V's verdicts are the only evidence. Do not mint from MED without V's agreement (already the rule), and show the placebo-robustness caveat on MED cards.
- R3: a stronger placebo (another date's consult times, or doctors swapped between rooms; >= 10 shifts) is needed to measure what the tiers carry. My P2 (single-linkage chaining: one "voice" spans 31 room-days and 16 doctors, a sign of chaining or a hospital-wide voice) and P3 (dominant-speaker check) remain open.
- R4: LQ is void again on all three cross-day links (the control also says yes). Jev stays a report field.

## Doctor-voice-check batch 1 PAGE (surg-page dry-run PASS; my pre-publish review)
- Structure OK (surg-page): 61 cards, 3 doctor clips + 1 contrast per link card, 4-8 s, no tier words in the evidence text, tier key never on the page.
- Clip roles vs production (room_turn_speaker overlap): doctor clips on HIGH/MED cards are all non-clinician in production (HIGH 3/3), consistent with a voice that is not the room's voiceprinted doctor. 4 LOW contrast clips are the room's voiceprinted doctor, which is harmless for controls.
- EVIDENCE TEXT problems (they anchor V; the card shows them with the audio):
  E1 Jev line: "it says this is the doctor (94% confident)" on the HIGH. vj-link's own finding: Jev Q1 says "doctor" for any recurring voice, including a nurse, and LQ is VOID on all cross-day links. Presented as evidence it is misleading. Either drop the Jev line or say "Jev tends to call any recurring voice the doctor; weak evidence".
  E2 MED 98502e timing: "heard in 66% of busy minutes when the doctor is consulting and 60% when not" is NO timing signal, yet it reads as support. Say "no difference" explicitly when the gap is < 15 points.
  E3 Cross-day line: "each time the best match is this doctor". Both MED voices name a DIFFERENT doctor under the placebo time shift. Add "(this pairing is not stable when the timing is shifted)" on MED cards.
  E4 HIGH card: add "This voice is not the room's voiceprinted doctor (Dr Dibyendu Majumdar)". It is the key fact that makes the link plausible, and V can check it.
  E5 (A2, open since #809): does the page reveal the evidence only AFTER V's verdict? If not, V judges with the evidence in view.
- Not blocking publication (V's verdict IS the test), but E1-E5 degrade that test. Fable to decide before publishing.

## Evidence text v2 (vj-link #1135): E1-E4 RESOLVED, applied uniformly to all 60 link cards (no tier leak)
- E1: 0 cards carry a Jev line.
- E2: 16 cards read "no clear timing difference"; 0 cards have a < 15-point gap without it.
- E3: every card carries the caveat "The doctor is proposed from queue timing, which is only weakly reliable: a control with the doctors' times shifted to the wrong hours finds ...".
- E4: every card states production's voice matcher share for this voice (the HIGH: 0%, room names 1 clinician). This conveys "not the room's voiceprinted doctor" without naming anyone.
- 0 cards contain HIGH/MED/LOW/tier/confidence.
- Uniform wording is BETTER than my tier-specific suggestion: tier-specific text would have told V the tier.
- Open: E5 (evidence revealed only after V's verdict), which is surg-page's page mechanics. surg-page must regenerate seed_docs.json from the v2 links before Fable publishes.
- E5 RESOLVED by a switch (surg-page #1137, origin 23a4e35, tools/doctor-voice-check/page.html). With db doc config/settings = {"evidence":"after"}, evidence is hidden until V's first verdict. Every link answer records a0 (the first verdict) and a blind flag in both modes.
  - Recommendation to Fable: set {"evidence":"after"} before publishing. Then score V's agreement on a0 (the blind first verdict), not on any revised answer.
- Seed check (surg-page #1146): ~/eta-data/doctor-voice-check/batch1/seed_docs.json = 61 docs; evidence + doctor identical to the v2 cards on 61/61. Fields: a, b, batch, clips, contrast, date, doctor, evidence, id, kind, room (a/b = same-person pair). 0 tier/gid/criteria/doctor_uid fields. PASS: publishable with evidence:'after'.
