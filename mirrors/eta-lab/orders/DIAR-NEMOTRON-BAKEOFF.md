# DIAR-NEMOTRON-BAKEOFF (V asked, 24 Sep 07:00). Owner: diar-lab

## Why
nvidia/Nemotron-3-Diarization was released 23 Sep 2026:
- 100M-parameter Sortformer (NeMo 3.0); up to 8 speakers; overlap-aware.
- Trained on meeting and far-field data. Languages listed: English, Hindi, Kannada, Telugu, Bengali, Mandarin.
- Offline DIHARD III DER 12.73 (vs 19.09 for the previous Sortformer).
- Licence: OpenMDW 1.1, commercial use allowed.
- Outputs speaker activity only, with NO embeddings. It would slot exactly where pyannote.ai sits in our hybrid: its turns plus our own ECAPA voiceprint attribution.

If it matches pyannote.ai, we stop paying pyannote.ai, and the local-diarizer training programme may be unnecessary.

## Do
1. Install it on **gcp-l4** (L4 is Ada, a supported GPU): `nemo-toolkit[asr]` in its own venv, pinned. Don't disturb your running fine-tune job. The model is tiny, so it can share the GPU.
   - Also try the box T4 (Turing isn't on NVIDIA's supported list) and report whether it runs.
2. Run it offline (30.4 s latency setting) on exactly the sets used for the pyannote.ai decision: V's 5 windows plus the 20 bench windows.
3. Score four arms with the same harness and collar as the diar-lab phase-1 arms:
   - Nemotron-3
   - pyannote.ai (teacher)
   - current local diarizer
   - your 04:00 fine-tune, if it has finished

   Metrics: DER, missed speech, false alarm, confusion; speaker-count error; and per-window DER on V's 5.
4. Also run it through the hybrid: Nemotron turns → Mini /embed_speakers (or the box twin) → doctor attribution. Report attribution agreement with the pyannote.ai hybrid.
5. Measure speed: wall time per window-hour on L4.

## Report (≤12 lines)
- One table with the four arms.
- Speed.
- Whether it runs on the T4.
- Your recommendation: replace pyannote.ai / keep as fallback / reject.

Also list the 3 windows where Nemotron and pyannote.ai disagree most, so V can listen if needed.

## Don't
- Touch production, or change DIARIZE_ENGINE.
- Stop your fine-tune.
- Upload audio anywhere new. Local GPU only.
