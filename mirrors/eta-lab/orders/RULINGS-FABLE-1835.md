# Fable rulings 167–178 (18:35 IST review, 24 Sep)

Read from bus cursor 1321 to 1479.

## VJ
**167. R165-1.** The runner-up is the best OTHER cluster in the same window.
- If the window has only one cluster, the runner-up is the best other stored doctor centroid for that room.
- If neither exists, the margin is missing and the turn is DOUBTFUL.

**168. R165-2 (blinding across panes).** On voice-lab-1, create a unix user `vjscore` owning `/srv/vj-truth` (mode 700). The truth, the human counts and key.json live there.
- Only vj-refuter runs the scorer, via `sudo -u vjscore`.
- Builders never invoke vjscore; vj-refuter audits auth.log for any other use.
- vj-data sets up the user; vj-refuter verifies it.

**169. X1 (confident sample).** The confident sample = the 40 confident items on the "Who is speaking" page, because they have human truth.
- F4 is judged on the confident human-labelled turns. It needs ≥ 30; below 30, F4 = INSUFFICIENT, and the arm cannot be adopted for production, only continued.
- vj-data fixes the classify.py rounding bug.

**170. V's existing labels (split-speaker #report 17:58)** are thin:
- 216 clip answers exist, but v1 is "is this your voice" (all "not me"), v4–v5 are mostly "can't tell", and v6 are pairs;
- the voice counts are 5 windows (listen5, bake3/v-listen.json);
- the E-3 Cardiology doctor/patient/other labels (83 of 104 clips, 23 Sep) are NOT located. Fable asks V which machine holds them.

Decision: use every usable existing label (v4–v5 "me"/"not me" and v6 pairs) as truth, and PUBLISH the "Who is speaking" page (915e457) for the 150 items minus any turn already carrying a usable V label (vj-data dedupes by turn id).
- surg-page seeds the files; Fable publishes tonight; V and Sandhya rate over the weekend.
- surg-page's proposal to record the Jev wording sha per rating is ACCEPTED (surgery page too).

## Surgery and chain (ruling 164 bundle, refuter-2 #614, linker #610/#631/#640)
**171. Contrast CT (non-angio): IN.**
- V's intent is imaging done in-house. Plain CT and contrast CT are both done here; CT angiography is referred out (ruling 163).
- Fable tells V, and he can overrule.

**172. Conditional imaging or surgery** ("if it persists, we'll do a CT"):
- add a status value `conditional`. It is a proposal type in its own stratum: never a positive, never a negative.
- V3-09 moves to `conditional`. v5 gets a new freeze after this change.

**173. "Proposed-and-done" = A+, PROVISIONAL.**
- A+ = the proposed operation was done, possibly with more.
- **B** (same indication, different technique, e.g. pilonidal laser advised, excision done) is reported as a sensitivity stratum next to every A+ number.
- Labels and link-3 may start now under A+. Fable has asked V to confirm; if V picks B, relabel from the stored B stratum (no re-run).

**174. RXWIN cap:** 30 min plus the next-visit cut, pre-registered before link-3. Report the 23% truncated as its own count.

**175. V3-03 t426 (CT or MRI):** stays "imaging: unspecified" unless V listens. It is on V's optional list, not a blocker.

**176. Plain CT is a thin source** (about 2–4 real proposals in 54 days). No dedicated HIST effort. hist-miner's cheap CT-cue scan of hist-bulk output may run.
- hist-miner stage-1 (truth-anchored): let it finish overnight on its 2 routers.

## Infra
**177. Radar: Option A.**
- The daemon runs on eta-lab-t4 (the only agent host; system node v22). The config blocks go on the Mini at 21:15.
- Test on voice-lab-1 first: node tarball in ~/.local, `herdr --machine voice-lab-1 plugin link <abs path>`, confirm the [[startup]]/[[events]] hooks fire, then unlink.
- Then eta-refuter passes the fork diff, then eta-lab-t4, then the Mini at 21:15 (constraints of HERDR-RADAR.md unchanged).

**178. Shared box checkout.**
- fcdf6f7 (surg-deid deid.py fix): refuter-2 reviews, then fleet pushes via a temp worktree.
- 68d24f4: diar-lab pushes its own run record.
- Then the conductor checks that `git status` shows NO modified tracked files, stashing any with a named stash, and fast-forwards/resets the shared checkout to origin/main. Untracked files are untouched.

## Also
- **Nemotron variant C:** GO for launch with hard vs soft count logging (refuter-2 #609).
- **Tomorrow's train:** a92ebae with loop-guard head 035c5b7. emotion-runkey-unique stays OUT. Fable orders it in the morning.
- **v5 wording:** no freeze tonight. It is frozen after 172 lands, and scored on a fresh set.

## 179. V, 18:10: "go with your instinct". Proposed-and-done = A+ is FINAL (no longer provisional). B stays a reported sensitivity stratum.
## 180. E-3 Cardiology labels (83 of 104 clips, 23 Sep): V says they are on the Mini or in Cloudflare R2 (Cardiology room). split-speaker searches both, read-only: the Mini (~/, ~/dev, ~/Documents, the Air-Drive SSDs; look for e3kit, answers.jsonl and label json) and R2 with the box read key (list only). Report the path + n + label meaning by 19:15.

## 181. V, 18:15: V3-03 turn 426 is an MRI. MRI is NOT done at EHRC and is not traceable in Metabase.
- V3-03 t426 = imaging: MRI, which is OUT of proposal scope (ruling 84 still holds for MRI).
- MRI joins CT angio as REFERRED OUT: never a negative, never a done label, and offered_in_house = false (ruling 163 logic). linker hard-codes MRI as referred out whatever the 6-month derivation says.
- V3-03 scoring: the CT-advised turn stays in scope under 164 if the CT was plain or contrast; the MRI turn does not count.

## 182. vj-refuter finding: stored centroids barely match the test audio (median best 0.22 vs holdouts 0.71-0.88 at enrolment)
The page selection stays on HOLD (vj-data) until step 3 below reports. Stored centroids are NOT used for any confident/doubtful call until they pass.
1. **Doctor per window comes from the day's records, not room -> one centroid.** Use production's clinician assignment for that room-day (e.g. Poornima in OPD 5 on 20-22 Sep and in OPD 7 on 23 Sep). Use a stored centroid only when THAT doctor has one.
2. **Positive control (vj-data, on voice-lab-1).** Re-embed each centroid's own enrolment clip and holdout clips with the exact pipeline used on the test windows: same model build, 16 kHz mono, same VAD/segment length, L2-normalised. It must reproduce >= 0.70 against its own centroid.
   **Negative control:** doctor A's centroid against doctor B's enrolment must stay < 0.40.
   - If the positive control fails, it is a PIPELINE mismatch (resampling, normalisation, model version, cluster-mean vs segment embeddings). Fix it and re-run.
3. **Then re-score the 15 windows** with (1) + (2). A centroid is usable for margin only if matched-doctor windows give a median best-match >= 0.50.
   - If still below, it is mic/room drift, and margin = MISSING, so every turn is DOUBTFUL. The confident class then comes only from turns with human labels.
4. **Roles.** vj-data runs 1-3; vj-refuter reproduces. If the controls pass but test windows still fail, an Opus debugger (eta-refuter) takes root cause.
5. **No production impact.** Production attribution does not use these centroids (voice_centroid has 0 rows).
Report by 20:00.
