# Room diarization -> pyannote.ai (owner: split-speaker) — V's decision 23 Sep 2026 13:20 IST

Why: V listened to the 5 windows where local and pyannote.ai disagreed most (scratch/bake3/v-listen.json): pyannote.ai closer on 5 of 5; his speaker counts 4, 7, 5, 3, 4. V chose "switch now" (not shadow). Cost ~EUR 0.11 per audio-hour (precision-3), accepted. This supersedes the 22 Sep evening "diarization stays local".

Target (revised 14:05 by V): HYBRID first - pyannote.ai turns + our own embeddings + pre-call silence filter; review tomorrow morning, switch tomorrow night. Not tonight.

Build (ETA repo, new branch vinay/diarize-pyannoteai off current production):
1. diarize_window jobs call pyannote.ai precision-3 when env DIARIZE_ENGINE=pyannoteai (parseFlag-style strict parser; unknown value throws). Unset = today's local behaviour, unchanged.
2. Audio reaches pyannote.ai by a short-lived presigned R2 URL (or pyannote.ai media upload) — never through the Mini tunnel. Poll the pyannote.ai job inside the job system's step/poll pattern (no long blocking request; respect Vercel limits incl. the 4.5 MB body limit).
3. Store the result in the SAME diarization tables/shape the local diarizer writes, so voice_centroid, the encounter clock and every reader work unchanged. Engine/model label DERIVED from the pyannote.ai response (never a typed constant). Store the pyannote.ai job id.
4. Fallback: if pyannote.ai errors, times out, or returns no segments, fall back to the local diarizer for that window and record which engine produced it. Count fallbacks in the job progress.
5. Key: PYANNOTEAI_API_KEY as a Vercel production env var (type sensitive). Fable adds it from ~/.claude/secrets/pyannote_api_key — you never print it, never put it in argv or logs. Tests use a fake.
6. Cost guard: skip windows the level log marks silent / no speech (same test the local path uses); log audio seconds sent per job.
7. Tests: engine switch parsing, URL/poll flow with a fake server, mapping into the existing shape (speaker count, segment times), fallback path, label derived from response, key never logged (grep captured logs). Yoga gate.

Deliver: push the branch, send the sha to ETA-Refuter for review, and tell Fable. Fable sets PYANNOTEAI_API_KEY + DIARIZE_ENGINE=pyannoteai and deploys after PASS. Report in 8 lines. End with WAITING ON ETA-Refuter.

Do not: re-diarize history (a backfill is a separate decision), change voice_centroid or the encounter clock, touch the Mini's diarizer service (it stays as fallback), print audio, text or the key.

## Purpose clarified by V (23 Sep ~14:15)
pyannote.ai is a TEACHER, not the permanent diarizer: "I don't mind spending some money to upgrade access for a while as long as the goal is to train the local diarizer to eventually match pyannote.ai." So the hybrid must also:
- store pyannote.ai's raw speaker turns per window as TRAINING LABELS (window id, engine label from /v2/jobs, job id, created_at) — never overwritten by the local diarizer's output, so every window has both a teacher label and our local output;
- keep the local diarizer running alongside on the same windows while pyannote.ai is on (Mini/Yoga CPU only), so the lab can measure the gap night by night;
- expose a daily count: windows labelled by pyannote.ai, audio-hours, EUR spent (audio seconds x rate).

## Rulings, 23 Sep ~14:20 (Fable, after V)
- Training permission: V states he has WRITTEN permission from pyannote.ai to train on its outputs (overrides ToU s9.1 for us). Teacher plan is ON. V holds the permission document himself (23 Sep: "I will keep the pdf"); we do not file it.
- Production DOES consume pyannote.ai turns: build the HYBRID (V's 14:05 choice) AND store teacher labels.
- Embeddings: computed on the Mini by the existing eta-diarize service's embedding code (same model as today, so centroids stay comparable). An additive HTTP endpoint on that service is allowed if none exists; do not change its diarize path. No Yoga for this.
- Teacher-label table: migration 0117 (0116 belongs to fleet's jev-core). Fable applies migrations, not V.
- Flag stays DIARIZE_ENGINE=pyannoteai (it does choose production's segmentation under the hybrid). Add DIARIZE_TEACHER_LABELS (strict parser) for the label write.
- Pre-call silence filter from the level log, independent of DIARIZE_SPEECH_GATE.
