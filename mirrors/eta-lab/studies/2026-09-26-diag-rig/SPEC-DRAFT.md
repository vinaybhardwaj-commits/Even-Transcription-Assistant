# DIAG-RIG SPEC (draft for Fable's ruling — FABLE 428 item 3, NO BUILD YET; scope CONFIRMED by FABLE 434 item 4)

Owner: diar-lab (audio plumbing: lab-mover). Rig home: Home Office Mac (acoustic) + any non-Google machine (digital).
Rules honoured: no sound in clinic rooms ever; Home Office recordings NEVER enter hist / label / VJ / voiceprint
pipelines (fleet's 428.2 config side is the enforcement; this spec adds none of its data to those paths);
no patient audio anywhere in the rig (synthetic only); no new vendor (428.3e: cost ~0).

## 0. Existing assets (reused, not rebuilt) — the inventory Fable asked for first
| Asset | Where | What it gives the rig |
|---|---|---|
| kit/mic-selftest (W21, radar-kit) | Mini + room Macs | room->Mac table, recorder-session interlock, reference-WAV + matched-filter scoring, JSONL reports, room-Mac hard rules (afplay/tail only). Reuse the DESIGN for the acoustic path; the clinic-room interlock becomes a Home-Office-only config |
| diar-lab leak RCA harness (studies/2026-09-23-diar-lab/diarize-leak-rca.md) | box | proven synthetic two-voice TTS (`say` Samantha/Daniel), 5-180 s clips, batch runner against a diarizer service port — seed of the call-and-response generator |
| Nemotron bakeoff eval (studies/2026-09-24-nemotron-bakeoff, eval/nemo_decode_sweep.py) | box | DER / JER / turn-boundary scoring already written and mutation-tested |
| STT parity harness (studies/2026-09-24-stt-parity + PARITY-389 kit) | Mini/box | WER scoring + golden-window manifest discipline (cut facts: covered_fraction, gap_s, synthesized_s; never a wholly synthetic window) |
| VAD v3 sweep kit (~/vad: sweep.py, calibrate.py, analyze.py) + level-log | box | level/SNR robustness grids, energy-gate calibration (E-12 probes: dead-input signature at ~-100 dBFS) |
| ffmpeg timing probe (studies/2026-09-23-queue001-kit) | box | exact onset/timing assertion (tone-at-t=100 s method) — reused to prove digital injection timing |
| e3kit-voice-id / doctor-voice-check / E-7 map | box, Mini | speaker-verification scoring for the call-and-response turns |
| Indic lexicons + translate studies (translate-337b, indictrans2-bakeoff, lx's number-word tables) | box | phrase-set wording + translation/LID eval references |
| W22 mirror kit (capture_driver.sh pack/ship/run/fetch/cleanup + shipped-bytes contract) | Mini + hosts | THE digital injector transport for any non-Google machine (lab-mover #3419: same script, host arg; assembly once, sha-verified on arrival, io 0700/0600) |
| fleet's full_audio.py (plan/assemble/decode at wall-clock offsets) | box | stimulus MIXER for the noise beds (bed at SNR = wall-clock placement with levels) |

Gap (must be built): one stimulus GENERATOR with machine-readable truth, the DIGITAL injector, the ACOUSTIC
runner for Home Office, one scorer that joins all metrics into one report. None of these exists today as a unit.

## a2. Voice source (FABLE 428b): ElevenLabs TTS, V's key
- KEY: read from ~/.claude/secrets/elevenlabs_key inside the generator process only; never printed, never on
  argv, never copied. (Helper reads are in elevenlabs_check.py in this dir.) STATUS: key NOT yet on the box
  as of ~10:25 IST (V was saving it); subscription quota read pending the key landing - posted when it exists.
- CONTENT: scripted, invented clinical-style lines only; NO patient text, transcripts or names from our data
  go to ElevenLabs (V holds no ZDR with them; none needed for invented text).
- VOICES: stock/library voices only; NO cloning of any real person (incl. V) unless V separately asks.
- PER-LANGUAGE SUPPORT (from elevenlabs.io docs, Multilingual v2 = 29 languages, Flash v2.5 = 32, v3 = "70+"):
  English SUPPORTED (v2/v2.5/v3); Hindi SUPPORTED (v2 list); Tamil SUPPORTED (v2 list); Kannada NOT listed on
  v2/v2.5, UNVERIFIED on v3 (the 70+ list is not enumerated in the docs) - treat as UNSUPPORTED, fallback:
  Google Cloud TTS via V's Vertex creds (allowed by 428b; kn-IN); Telugu same as Kannada (te-IN fallback);
  Hinglish code-mixed: generate as Hindi-voice + English segments per turn (SUPPORTED); Kanglish: Kannada
  base unsupported -> either Google-TTS per Kannada turn + concatenate, or romanised Kannada through an
  EN/HI voice marked APPROXIMATION in truth.json - choice flagged for Fable's ruling.
- REQUEST SHAPE: PCM S16LE 16 kHz output (native format; no mp3 transcode); models carry per-request char
  caps (v3 5k, v2 10k, v2.5 40k); nondeterministic output -> pin the optional `seed` per clip, recorded in
  truth.json (regenerations then comparable; "2 free regenerations" only for identical content).
- BUDGET: first synthesis run < 60,000 characters total; BEFORE any synthesis, GET /v1/user/subscription is
  read and the numbers (tier, character_count, character_limit, reset) posted to the bus; generated files are
  cached under the rig's stimuli dir and never re-synthesised (cache key = sha256(text+voice+model+seed)).
- TRUTH per clip: text, language, voice id, model id, seed, per-turn start/end from the assembled timeline,
  sha256 of the audio. NORMALIZATION AT THE GENERATOR EDGE (lab-mover #3423): every TTS output -> 16 kHz mono
  int16 WAV (C270 convention) ONCE; the manifest freezes the exact audio (sha256 per voice + per file) and runs
  reuse the frozen files - NO per-run re-synthesis (a re-run of the same text is NOT byte-identical: TTS is
  nondeterministic); both paths (digital + acoustic) score against the SAME frozen files; macOS `say` stays in
  the spec as the zero-vendor fallback, flagged.
- Still spec only: nothing is synthesised until Fable rules on the spec (428b).


One generator script emits WAV (16 kHz mono int16, C270 convention) + a truth manifest
(stimulus_id, text, language, speaker(s), exact start/end of every turn, level, sha256):
- Tones: sweeps 100 Hz-8 kHz + fixed tones (250/1000/4000 Hz) at -60/-40/-20/-6 dBFS — level + frequency response.
- Silence/digital-zero blocks: exact-zero and dithered-noise floors — mute/unplug signatures.
- Call-and-response: 2-4 synthetic voices (macOS `say` voices; Hindi/KN/TE/TA voices if present on the Mac, else
  concatenative fallback flagged in truth.json) with KNOWN turn times from the script, 2-30 min durations.
- Phrase set: fixed list incl. "supercalifragilisticexpialidocious", numbers/dose phrases (the router's protected
  cases), EN, HI, KN, TE, TA + code-mixed (EN-HI, EN-KN) — one canonical set, sha-pinned.
- Noise beds: fan, AC hum, crowd babble, door, phone ring — generated/synthesized, mixed at SNRs +20/+10/+5/0/-5 dB.

## b. Two paths
- DIGITAL: injector feeds the WAV straight into the target pipeline (box T4/Nemotron, eta-ci-c3, hf-1/hf-2,
  orbox3, audiometry, Yoga, Air). Deterministic, no mic; ffmpeg-injection timing proven by the queue001 method.
- ACOUSTIC: speaker -> air -> mic -> the REAL Home Office recorder app only. Design copied from mic-selftest:
  interlock (recorder session id verified before playback), afplay at current volume, no settings changed,
  Mac runs only afplay/date/tail/stat/pgrep/scp. NO sound is ever played in a clinic room; the rig's acoustic
  path exists ONLY on Home Office. Per FABLE 428a: Home Office has a MIC and a SPEAKER connected (fleet to
  confirm both BY NAME read-only; if the mic still reports DEVICE_MISSING that contradicts V and goes back to
  Fable), and the acoustic path MAY RUN AT ANY HOUR (not off-hours only).

## b2. Plumbing (lab-mover's lane; his #3419 points verbatim)
1. TRUTH SIDECAR RIDES WITH THE AUDIO. Every generated stimulus gets truth.json NEXT to the wav:
   stimulus_id, exact turn times (speaker, text, language, start_ms/end_ms), level, SNR (noise beds),
   audio sha256. Injection io contract = the parity harness's: <io>/<machine>/<suite>/{audio,truth}/,
   dirs 0700, files 0600, sha-pinned, no text in any report (ids, counts, metrics only). The scorer never
   re-reads a transcript store: truth.json is the ONLY reference.
2. TRANSPORT = THE W22 MIRROR/CAPTURE KIT, PROVEN. The digital injector for a remote machine is
   capture_driver.sh's loop (checker-PASsed, runner+driver PASS #3299): pack (audio + truth + runner + pinned
   lib if the target runs STT) -> ship once (tar over ssh, 0700) -> run --mode capture-equivalent on the
   target against its localhost engines -> fetch the results tree back -> cleanup via a remote script file
   scoped to the run dir (refuses anything outside the run dir, no '..'; parent rmdir'd). DIAG-RIG's runner =
   a diagrig_runner.py variant with the same skeleton (pack/ship/run/fetch/clean); written in the build
   phase; nothing new invented, only the payload differs.
3. TIMING PROOF PER MACHINE TYPE (queue001 method, once per class): injection must place sound at the
   truth's exact offset - tone-at-t=100 s stimulus injected, then silencedetect/ffprobe on the result
   asserting onset within +-50 ms. One suite per class (box, c3, hf container, orbox3/audiometry/Yoga/Air);
   the suite's PASS is that class's ticket for digital runs. The box's proof is free (T4 idle since 337e).
4. ACOUSTIC = HOME OFFICE ONLY: the same driver with the mic-selftest interlock swapped in (recorder session
   verified before playback, afplay at current volume, no settings changed); scoring reuses mic-selftest's
   matched-filter JSONL verbatim; the ONLY add: the reference is the SAME frozen truth.json (not a separate
   reference wav), so digital and acoustic compare against one truth.
ENGINES (agreed with lab-mover): the digital path targets BOTH the STT router shape AND the diarizer (raw
turns via l4_consume.py's FLAC path on the idle T4); the injector gets two engine modes (stt / diarizer);
DER/JER scoring = the bakeoff eval unchanged.

## c. Scoring (one report per run; joined JSON + short md, counts and errors only)
- WER/CER per language + code-mixed (STT parity scorer reused).
- Language-ID accuracy vs truth.
- Diarization: DER, JER, turn-boundary error (bakeoff eval reused); speaker-count error (vs truth).
- Mute/unplug detection: time-to-detect, false-positive count on silence beds.
- Level/noise robustness: metric deltas per SNR/level bin.
- Every report carries: git shas of rig + target, stimulus manifest sha, machine id, UTC timestamps.

## d. Trigger + where results land
- One driver per rig: `diagrig run <suite> --path digital|acoustic` plus a NIGHTLY CRON scored report
  (confirmed IN SCOPE by FABLE 434 item 4, no longer an open question).
- NIGHTLY SCORED REPORT: one run per night on a fixed suite (tones + canary + call-and-response + noise +
  5 languages + diarizer multi-speaker), scored, posted to the bus as counts/scores only ([SELFTEST] tag).
- FLEET DEAD-ROOM SELF-CHECK (434 item 4): the nightly report JOINs fleet-watch's room state (the 08:01-style
  NOT_RECORDING/KIOSK_OFFLINE alerts) with the rig's own latest acoustic proof, so one report answers "is the
  fleet's room-audio chain alive": per room, last rig proof + last fleet-watch state; the rig never runs IN a
  clinic room - the acoustic proof it cites is Home Office's own chain plus fleet-watch's passive checks.
- Runs land in ~/eta-data/diag-rig/runs/<UTCstamp>-<machine>/ (0700) with audio + truth + report; the repo gets
  code + report SUMMARIES only (no audio, no text beyond the fixed phrase set). Outside hist/label/VJ/voiceprint
  dirs by construction; no patient data touched.
- A run is pure additive: nothing in the rig writes to any production path, DB or room Mac.

## e. Placement + cost
- Digital: box (T4 free since 337e closed), eta-ci-c3, hf-1/hf-2, orbox3, audiometry, Yoga, Air — whatever is READY
  per 416.0; no GCP, no Google machines.
- Acoustic: Home Office only (it is the point of the acoustic path: the real recorder + real mic + real room).
- Cost ~0: no new vendor, no cloud GPU (box T4 + existing machines), TTS via macOS `say`, noise beds synthesized.
  Only spend: none planned.

## Open questions for Fable's ruling (residual after 428b/434)
1. Phrase-set wording owner: draft + refuter-2 check (proposed), or V pins the wording?
2. Kanglish: Google-TTS per Kannada turn + concatenate, or romanised-Kannada via EN/HI voice marked
   APPROXIMATION in truth.json? (proposed: the former)
3. Does the digital path also test the PRODUCTION service endpoints read-only (eta-diarize :8012, Mini STT),
   or only offline pipelines? (proposed: offline + eta-diarize only; nothing writes to production state)
RESOLVED by rulings (kept for the record): Indic TTS = ElevenLabs + Google-TTS fallback (428b); nightly cron
= IN SCOPE (434); full SELFTEST list = confirmed in scope (434 item 4), incl. the fleet dead-room self-check.
