# VOICE-JEV-BUILD: Jev evidence cards for voice attribution (separate build queue "VJ")

V APPROVED on 24 Sep 2026 (16:10 IST). The proposal is in the claude.ai ETA project: claude/ETA-JEV-VOICE-PROPOSAL-24-SEP-2026.md. Fable owns every design decision and verdict. This is ruling 144.

This queue is SEPARATE from HIST, the surgical chain, trains and Nemotron training. Take no shared GPU locks. Do not touch production, room tables or production env. The VJ queue never waits on other queues and never takes their resources.

## Machines and sessions
- **Compute:** GCP `voice-lab-1` (asia-south1-b, n2-standard-16, 62 GB, 194 GB disk, Ubuntu 22.04, cloud-platform scope for Vertex). ssh alias `voice-lab-1` works from both the box and the Mini.
- **Sessions** (box panes; each runs its heavy work on voice-lab-1 over ssh):

| Pane | Model | Role | Owns (writes only here) |
|---|---|---|---|
| vj-data | sonnet | Builder: truth inventory, doubtful-turn selector, voice descriptors, evidence cards | eta-lab `studies/2026-09-24-voice-jev/data/`, voice-lab-1 `~/vj/data/` |
| vj-arms | sonnet | Builder: four arm runners, scoring harness | eta-lab `studies/2026-09-24-voice-jev/arms/`, voice-lab-1 `~/vj/arms/` |
| vj-refuter | opus | Refuter: reviews each deliverable and re-runs the scoring itself; never edits builder files | eta-lab `studies/2026-09-24-voice-jev/refute/` |

Never edit another pane's directory. Any hand-off goes through a file in your own directory plus a bus note to the conductor.

## Data rules
- PHI is fine inside this lab: the box, voice-lab-1, and eta-lab (private).
- Nothing goes into the public ETA repo. Never print secrets or put them on argv.
- **Jev:** HTTP API `https://api.typesafe.ai/v1/systemone`. The key is on the box at `~/.config/even-jev/key`. scp it to voice-lab-1 `~/.config/even-jev/key` with mode 600, and read it from the file only.
  - Do not use the even-jev MCP: the Mini's ssh is at its session cap (ruling 129).
- **Audio:** R2 read key at box `~/.claude/secrets/r2_audio_read`; the 30 speaker-count clips are at box `~/eta-data/speaker-count-30/` (key.json holds the hidden counts).
  - **Blinding:** key.json may be read by vj-arms' scorer and vj-refuter only. vj-data and every arm runner must never see it.
- **Neon:** read-only via `kit/neon-select.mjs`.
- **Gemini (arm 4):** Vertex on project clinical-infra from voice-lab-1's service account. If Vertex refuses, report; do not work around it.

## Phase 0: frozen by Fable (do NOT edit; hash it)
Compute sha256 over the text between the two FREEZE markers. Put that hash in every result file. Any change to the wording = a new sha = a new run.

<!-- FREEZE-BEGIN -->
EVIDENCE CARD TEMPLATE (one per doubtful turn; plain text; fields in this order; omit a line only if its data is missing and say "not available"):
Turn: <start>-<end> s (<duration> s) in a <room type> consultation.
Voice match: best candidate <Dr X / speaker cluster> <score>; runner-up <candidate> <score>; margin <m>.
Diarizers: Nemotron hears <n> speakers in this window; pyannote hears <n>.
Overlap: <yes/no> (<seconds> s overlapping another voice).
Voice descriptors vs <Dr X>'s usual profile:
- Pitch range: this turn <lo>-<hi> Hz; usual <lo>-<hi> Hz.
- Loudness vs this room's baseline: this turn <quiet/typical/loud> (<dB> dB); usual <...>.
- Speaking rate: this turn <slow/typical/fast> (<syll/s>); usual <...>.
Transcript (guarded; English alongside Kannada/Hindi where available):
[previous turn, <speaker label>] "<text>"
[THIS TURN] "<text>"
[next turn, <speaker label>] "<text>"

Q1 (choice): Who is most likely speaking in THIS TURN? Options: "the doctor (<Dr X>)", "the patient", "a companion or relative", "staff", "cannot tell".
Q2 (yes/no): Is THIS TURN spoken by the same person as the previous turn?
Q3 (yes/no): Is there evidence of a third person taking part in this window (for example someone addressed by name, or "your son said...")?

ARM 2 CONTROL PROMPT (raw numbers): same Q1-Q3, but the card is replaced by: the turn's raw speaker-embedding vector (as text, all dimensions, 4 decimals) and the same-length centroid vector of each candidate. No transcript, no descriptors.

ARM 4 LISTENING PROMPT (audio clip = THIS TURN with 5 s context either side; plus the whole 20-30 s window for Q-count):
L1: "Which voice in this clip is the doctor? Answer: the speaker of the marked middle section, or not." 
L2: "How many different people speak in this clip? Answer with a number."

PASS RULE (per arm, vs arm 1): adopt only if it beats arm 1 on doctor-attribution accuracy over DOUBTFUL turns AND makes zero CONFIDENT turns worse; speaker count scored as exact match per window on the human-rated windows. A win that the Opus refuter cannot reproduce by re-running is not a win.
DOUBTFUL TURN = voice-match margin < 0.10, OR speaker_basis = "diarization_only", OR Nemotron and pyannote disagree on the window's speaker count. CONFIDENT = everything else.
<!-- FREEZE-END -->

## Phase 1 (vj-data): report at each checkpoint, with a 10-line cap per report
1. **Truth inventory. Checkpoint A, report by 18:30 IST, then STOP for Fable.**
   - List every human-labelled source for (a) who spoke (doctor or not) per turn and (b) speakers per window: V5, the speaker-count 30, the labelled 58-window set, and anything else.
   - For each: file path, n windows, n turns, which label, who labelled it.
   - Count doubtful vs confident turns on each, using production's stored outputs (arm 1 = what production already produced).
   - Fable decides the test sets. If doctor-turn truth is too thin, Fable orders a turn-label page for V and Sandhya.
2. **Doubtful-turn selector.** Implement the frozen definition. Unit-test it on 5 hand-checked turns.
3. **Voice descriptors.**
   - Pitch: pYIN or parselmouth.
   - Loudness vs room baseline: use the level log if it is in Neon; else compute the per-window median RMS.
   - Speaking rate: from word timings; if there are none, syllables from the transcript over the duration.
   - Overlap: from diarizer segments.
   - Doctor profile = the same measures over that doctor's CONFIDENT turns only, with the test windows excluded.
4. **Cards.** Render the frozen template for every doubtful turn in the chosen test sets. Also render the arm 2 raw-number variant. Write JSONL and give Fable 3 sample cards.

## Phase 2 (vj-arms): starts now against a fixture; switches to real cards at Phase 1 step 4
- **Arm 1:** production's stored labels (no new model runs).
- **Arms 2 and 3:** Jev runs Q1-Q3 on the raw-number variant (arm 2) and on the cards (arm 3). Record the calibrated answer and the confidence.
- **Combine rule for arm 3.** It is written before scoring and hashed like Phase 0:
  - If arm 1 is confident, keep it.
  - If doubtful, take Jev's Q1 answer when its confidence is ≥ 0.70; otherwise "unsure".
  - "unsure" counts as wrong for accuracy and is reported separately.
- **Arm 4:** Gemini on Vertex with the L1/L2 prompts on audio clips.
- **Scorer:** per arm, report:
  - accuracy on doubtful and on confident turns;
  - speaker-count exact match;
  - share of turns escalated;
  - cost and wall time per consult-hour.

  Write results.json and a 15-line summary.
- **Human counts.** Fable exports V's and Sandhya's counts from the speaker-count page to `studies/2026-09-24-voice-jev/truth/human-counts.json`. Score counts only on windows with ≥ 1 human count, and report n.

## Phase 3 (vj-refuter)
- Review Phase 0 sha integrity, the selector tests, descriptor sanity (spot-check 5 pitch values by ear or plot), blinding, and the combine rule being hashed before results.
- Re-run the scorer yourself from raw outputs.
- Verdict per arm: PASS / FAIL / NOT-REPRODUCED.

## Phase 4: only on Fable's written go after Phase 3
Silver labels for Nemotron from windows where arm 3 or 4 and the voice models agree with high confidence. Human-labelled windows are never used for training. Owner is diar-lab, as a separate order.

## Reporting
Post to the bus through the conductor with the "VJ" tag. The conductor boards VJ as its own column. Blockers go to Fable immediately; everything else goes in the hourly digest.

Freeze sha256 (first 12, computed by Fable at 16:15 IST): **b961291ae64c**
