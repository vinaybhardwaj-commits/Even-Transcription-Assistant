# Fable rulings 146–162 (17:05 IST review, 24 Sep 2026)

Read from bus cursor 1169 to 1321. Rulings 144 (VJ queue) and 145 (herdr-radar) went out as separate orders.

## 146. Ruling 131 applied: HIST APPROVED FOR MINING ONLY
- **Result.** Pooled twin-vs-twin 0.899 against twin-vs-stored 0.926 gives a gap of −0.027. That is ≤ 0.02, so the rule approves, and the twin agrees with production at least as well as with itself. eta-refuter-2 reproduced the numbers (#479). Set 2 stays FAIL on the record.
- **Conditions:**
  1. Mining only. Candidates are found here, but anything shown to a rater or used as a label is first re-transcribed on the production room path.
  2. The known systematic miss (the English window at ~0.5) is logged in the ledger, and lab-mover tags English-dominant windows in the HIST output.
  3. The route uses the packed CPU config from #522 (about 12 audio-h/wall-h per node, pool about 31 audio-h/h). Whisper is the limit; add no nodes.
- **Go.** hist-miner and hist-bulk start now on the production room path harness (#331), paced as before. lab-mover owns throughput and the conductor watches errors. Stop on an error rate > 2% or any production health flap that correlates with it.

## 147. Ruling 135 retracted
09b9a0a is in the PRIVATE eta-lab, so there is nothing to remove from the ETA repo. The old tunnel docs in ETA (public since 11–14 Sep) hold only hostnames: out of scope. scrub-391 covers the account id. The push rule for every pane stands.

## 148. Surgery page: re-seed with v4 under the same ids
- **V has rated ALL 12 v3 consults** (as of 16:53). Jev agreed on 71 of 74 fields (96%):
  - 1 wrong: V3-10 patient_response;
  - 2 missing: V3-09 category (V added "operation"), V3-11 firmness (V added "suggested").
- **Keep V's ratings as they are**, keyed by V3-NN; the key is unchanged (sha 1ca9a2ec4d55).
- **Freeze v4.** It splits "named" from "described" (#458), and eta-refuter-2 re-verifies the new sha. Audio = encounter ±2 min (fleet's re-cut, PASS #482/#501).
- **Before Sandhya rates** (she plans the weekend), Fable re-seeds the same ids with v4 questions and the new mp4 assets, and republishes the page from surg-page's 8fe8dcb/1480c5e. For V3-02..04 and V3-08 the "described" question is new to V: optional for him.

## 149. V3-03 closed
The stored text is whisper-English; the encounter itself is English. What V heard as a "terrible Kannada translation" was the grey 12.7-min lead-in (two other cases). The ±2 min cut removes it. No native check is needed.

## 150. CT angiography
- It is an ADVISED signal only: 30 prescriptions for 28 patients, none found booked or completed. Drop it from the done-labelled truth set and keep it as an "advised" category.
- No hunt for a radiology bill now.

## 151. Surgical chain P1: GO
- The linker starts P1 now and commits its 5 files from a temp worktree.
- **Label trap (#455).** From 14 Sep, an auto-created PRESCRIBED case follows the prescription flag. It is never evidence of "booked". Only an OT note, an admission, or a procedure billing line counts as done.
- The candidate-negative pool (517 prescriptions with no case, note or admission within 30 days) is kept as the negative class.
- P2 (chain page) goes to surg-page after P1's schema is final.

## 152. Mini ssh cap (ruling 129 follow-up)
- **Built:** PASS. **Cap relief:** only happens as box panes restart onto 2224.
- **herdr-kit:** restart box panes that are **idle or done** onto the new config, one at a time via herdr-ctl `restart` (--resume, context kept):
  - never a pane that is working;
  - VJ, radar-kit, linker and hist-* go last;
  - after each restart, record the sshd count.
- Do NOT touch the two Sep 22/23 sessions: they are Fable's and V's remote tooling. Do NOT touch the docker mcp gateways.
- 142, Mini half (auto-mode prompt dismissal in settings.json): GO.

## 153. Ruling 40: merge
Merge herdr-kit/ruling-40-check-silent @9d23fe7 into eta-lab main (two PASSes). The conductor announces it to every gate pane: pull before the next gate run. The orphan sleep 2400 fix rides with it.

## 154. Trains
- **Tonight (after 20:30):** 73868e4, unchanged.
- **Tomorrow morning (Fable orders it):** next2 = 59b7125, plus:
  - loop-guard 7258a90, once split-speaker adds the Kannada-digit test and eta-refuter passes it;
  - mcp-tokens-extra @bd20f82, once scribe makes an unparseable primary entry reject all extras (fail closed) and extras carry an `extra:` actor prefix;
  - emotion-dedupe 87a7215, after an eta-refuter PASS.

  Scribe re-gates the whole train.
- **After that:** the watchdog train. Fable applies 0119 by hand first, then deploys; then the relay installs with its token.
- **Tokens:** herdr-kit mints tokens into Mini secrets; Fable sets every Vercel env var. This answers the A/B/C question for both the relay and the night-feeder.
- **diarize-bearer:** the server half is enforced on the Mini only after next2 is live and the secret is set (minibot, with a backup first).

## 155. Shared box eta-lab checkout
Each owner pushes its own unpushed commits by 18:00 from a temp worktree: diar-lab 4707a57, lx abcc5a3, lab-mover 4f2c986. The conductor then fast-forwards the shared checkout. Nobody resets it.

## 156. Nemotron B
Launch now on the production-matched VAL, with the C1 logging (9db357b PASS #451). diar-lab reports its first count error.

## 157. Loops
7.0% of 199 windows loop, falling and under the 10% trigger. VAD stays off. Loops stop reaching final transcripts once loop-guard ships on next2.

## 158. Tonight's sequence, from 20:30 (Fable orders each step; owners in brackets)
1. 20:30: Fable pushes 73868e4 (scribe gates, deploy, smoke 4/4, /api/health).
2. join-shard Worker deploy 9c2cd02 + d5809b1, max_instances 33 (join-shard).
3. eta-indic plist switch to ~/models, restart, smoke (minibot).
4. Stale-job cancel, then RECOVERY-3.sql (yoga-drain).
5. Ruling 130: eta-diarize controlled restart plus `ollama stop`, recording swap before and after (minibot).
6. 21:00: lx rescore with arm d.
7. 21:15: herdr-radar Mini step (radar-kit with Fable).
8. Overnight: HIST mining continues (ruling 146) and feeder-3 runs.

## 159. Room alert relay
Relay fixes (https-only, refuse redirects) PASS. Install stays dormant until the watchdog train.

## 160. fleet key hygiene
Timestamped key copies: yes. The key sha 1ca9a2ec4d55 is the reference for scoring V's v3 ratings.

## 161. Speaker count
V has rated 8 of 30 windows; Sandhya rates over the weekend. VJ scoring waits for ≥ 20 windows.

## 162. indic-mt
Close ruling 140: 7 of 8 windows ok. The 21 windows waiting on the dedupe fix ride next2 (ruling 154).

## 163. V, 17:10: "CT angio would not be done in our hospital. Plain CTs would be done, and surgeries would be done."
- **CT angio stays IN as a proposal** (V's ruling at 12:10). It is referred out, so "no booking found" is EXPECTED and is never a negative.
  - CT angio is excluded from the done-labelled truth AND from the candidate-negative pool.
  - Ruling 150 stands, with this reason.
- **Linker (P1):** add an `offered_in_house` flag per procedure type. Derive it from 6 months of OT notes, admissions and procedure billing; a type with 0 in-house occurrences is referred out.
  - Referred-out types are dropped from the negative pool (517), which must be recounted.
  - Report the list of referred-out types to Fable.
- **Plain CT** is done in-house, so a done label is possible (radiology order or bill). It stays OUT of proposal scope (ruling 84) unless V says otherwise. Fable has asked him.

## 164. V, 17:25: "include plain CTs". This supersedes ruling 84 for plain CT only
- **Scope.** A plain CT that the doctor advises or orders now COUNTS as a procedure proposal, alongside operations, interventions and CT angiography.
- **Still OUT:** MRI, X-ray, echo, treadmill, calcium score (V named only plain CT).
- **Done evidence.** Plain CT is done in-house, so it can be proven: a radiology order or radiology bill for the same patient within [-1, +30] days.
  - mb-rx finds the radiology table(s) and join key in Metabase, read-only, and reports to linker.
  - linker adds this as a done source in P1 with offered_in_house = true.
- **Surgery review.**
  - v4 (b2ebc86f5a74) stays frozen for the current 12 consults; no re-freeze tonight.
  - V3-03, where Dr. Banerjee advised a CT that the patient agreed to, becomes an in-scope proposal under 164. Re-judge it for scoring; V's own note already records "a scan is suggested and agreed to".
  - The next set (v5) and HIST candidate selection include plain CT proposals. Their category option becomes "imaging: plain CT". fleet and eta-refuter-2 draft the v5 wording for the Fable freeze.
- **HIST mining (ruling 146):** add plain-CT proposal cues (CT scan / CT head / CT abdomen / "scan" plus a body part, and Kannada/Hindi equivalents) to the candidate filter. hist-miner owns it; eta-refuter-2 checks precision on 20 samples.
