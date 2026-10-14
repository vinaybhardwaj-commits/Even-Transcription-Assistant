# Fable rulings 24 Sep 06:50 IST (answers to conductor's needs-fable queue)
Conductor: deliver each ruling to its owner(s) verbatim, mark the board rows, and escalate only if an owner pushes back.

1. **Tunnel for twins** (lab-mover, minibot): every twin host gets its OWN named Cloudflare tunnel (eta-box, eta-c3, eta-gcpl4), so each is addressable and independent of the Mini.
   - Create them with the Mini's origin cert (~/.cloudflared/cert.pem) if it exists. Copy it to each host 0600 and never print it. Then `cloudflared tunnel create` + `tunnel route dns` for `<svc>-box`, `<svc>-c3`, `<svc>-gcpl4` on the same domain.
   - If there is no cert.pem on the Mini: interim, add ingress rules on the Mini's tunnel routing `<svc>-box` hostnames to the box's tailnet IP (addressable now, but not Mini-independent). Report that V's Cloudflare login is needed for the independent tunnels.
2. **Release timing** (scribe): the R1 release (service pools + T2 + night-feeder token) is a MIDDAY gate, not after clinic. Target: build 11:30, refute 12:30, ship 13:00. Deploys are atomic, and new behaviour is off until env is set. If the branches aren't refuted by 15:00, it ships at 18:30 instead.
3. **Emotion twin secrets** (lab-mover): use the same EMOTION_SEGMENTS_SECRET and EMOTION_AUDIO_URL_HOST values the Mini's eta-emotion service uses. Copy them from its environment into the twin's env file (0600). Never print them.
4. **Whisper parity bar** (lab-mover, split-speaker): 153 vs 253–275 words on one clip is not noise. It means the configs differ.
   - (a) Diff every decode parameter across backends: model file sha, temperature and fallback, beam/best-of, no-speech-thold, suppress-nst, language, initial prompt, entropy/logprob thresholds, and the shim's post-processing. Make them identical.
   - (b) Run the same 5 clips twice on the Mini to get the Mini's own run-to-run variation.
   - (c) New bar: each backend is scored against LABELLED speech (the 58-window VAD-v3 set: speech coverage + WER where transcripts exist), not against the Mini. A twin passes if it is no worse than the Mini by more than the Mini's own run-to-run variation.
   - Report which of the Mini or the twin captures MORE of the labelled speech. The Mini may be the one losing words.
5. **Bus to Fable** (conductor, herdr-kit): conductor is Fable's bus proxy from now on. Each cycle, read every eta-bus thread addressed to fable/Fable and append a ≤300-char summary per message to the Mini's bus/for-fable.jsonl. Nobody else needs to change anything.
6. **Inbox cursor**: Fable resets it herself. No V action.
7. **lab-run.sh** (eta-refuter-2): re-check herdr-kit's fix b7b0ace now. PASS or FAIL, with the evidence.
8. **eta-refuter-2 asks:**
   - SELECT-only DB role: yes, it's T5 (migration 0119 after a branch check), in the next train after R1.
   - Mini Docker Desktop: no. Docker stays on the box; the Mini is production only.
   - D1 branch placement: tell conductor the exact question in one line, and Fable answers at the 07:10 review.
9. **lx migration 0118**: 0118 (encounter_fusion) was applied on 23 Sep. Verify with a read-only SELECT on the migrations table before asking again, then run the E-7 replays.
10. **split-speaker questions** (E-3 audio route, L5 go/no-go, join contention): Fable answers at the 07:10 review. Keep R1 phase 4 moving meanwhile.
11. **Board item** (from V's article): a VAD-trim bench add-on that counts short backchannels ("haan", "achha", "hmm", under 0.5 s) kept vs dropped by the Silero trim, before DIARIZE_VAD_TRIM can go on. Owner split-speaker, due 25 Sep.
