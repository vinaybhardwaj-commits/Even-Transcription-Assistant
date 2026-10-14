# Round 7 (22 Sep ~22:10 IST) — from Fable

Infra map from now on:
- **Mini** = production only (router, diarizer, whisper, night-drain). Full suites/builds still use `lockf -k /tmp/eta-heavy.lock` until scribe3's Yoga CI lands; then they move to `~/dev/_fable/yoga-test.sh`.
- **Yoga** = test runner (coming) + CPU mirror diarizer at https://yoga-diarize.llmvinayminihome.uk (bit-identical to the Mini on window 1, but 28× slower: 1589 s vs 56.6 s per 15-min window). Use it for correctness checks and ECAPA embeddings, never bulk diarization.
- **Air** (M2, MPS) = burst diarization. Fable drives it directly (panes can't reach it). Set up at ~/eta-air/diarize.

## lx
1. Report: router number follow-up sha (~/eta-router vinay/router-numbers) and the status/sha of the DB segments route (vinay/segments-route, ~/dev/eta-wt-segments). Push both if not pushed. ≤6 lines.
2. Nothing else until I send the next order.

## yoga-drain — E-3 kit (ready for V's labels tomorrow), read-only on prod
Good parity work — the finding is logged; the 19 Sep ruling gets a second look later, not tonight.
Build `~/dev/_fable/e3kit/` (plain Python, runs on the Yoga or the Mini):
- `pull_turns.py <session_id>`: pulls the stored Mini diarization for a session (segment timings + speaker idx, NO text) and the chunk audio refs; writes turns.json.
- `embed_turns.py`: for each turn ≥1.5 s, extracts the audio span (original chunks, exact sample offsets — split-speaker's E-1 finding) and gets an ECAPA embedding from the Yoga diarizer's embedding endpoint (or local speechbrain on the Yoga CPU if the server has no embed route). Caches embeddings by (chunk sha256, start, end).
- `score.py --labels labels.csv`: given V's labels (window/time → doctor|patient|other), builds per-clinician room_primary centroids (leave-one-out), reports cosine distributions, and the best threshold (ROC / EER) — replaces the unreproducible 0.735/0.842 targets with real ones.
- Dry-run on bs_gkzmch9p with a fake 5-row labels file to prove the pipeline end to end. No writes to the DB or the voiceprint store. Report ≤10 lines + usage in ~/dev/_fable/e3kit/README.md.
