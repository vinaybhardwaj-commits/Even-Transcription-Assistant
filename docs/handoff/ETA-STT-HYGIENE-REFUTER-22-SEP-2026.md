# ETA — STT hygiene in the app (A-ETA-1, A-ETA-3, kill switch). REFUTER VERDICT. 22 Sep 2026

`vinay/stt-hygiene` **@ `b63f209`** (builder scribe), 2 commits on `248c2ae` (`461433a`, `b63f209`). Files: `lib/whisper.ts`, `lib/stt/speech-gate.ts`, `lib/health/whisper-probe.ts`, and `tests/unit/stt-hygiene.test.ts`. Reviewed in my own detached worktree `/tmp/refute-sth`. I sent three synthetic clips (4 s digital silence, 4 s low noise, one `say`-generated English sentence) once each to the local shim `:8081` and to whisper-server `:8080`. I did not start, stop or reconfigure either service. Output: field presence and numbers only.

## PASS

### A-ETA-1 — max_context=0 on every whisper.cpp POST: PASS
There are two POSTs to whisper.cpp `/inference` in the app: `lib/whisper.ts` and the health probe. Both now send it (S1, S2 killed). The other `/inference` hits are a GET health check (`lib/admin/dashboard.ts`, `lib/stt/adapters/whisper.ts`) or IndicConformer, which is not whisper.cpp. Room windows go through the router, which lx fixed separately (live at `fe2fca3`).

### A-ETA-3 — the no-speech drop: PASS
- **The rule** is Whisper's default, `no_speech_prob >= 0.6 AND avg_logprob < -1.0`. Missing either number means the segment is unjudged and kept. Every boundary is pinned (S3–S6 killed).
- **The fields exist live.** Both the shim and whisper-server return `no_speech_prob` and `avg_logprob` on every segment, and the shim keeps them through its collapse. Silence and low noise return **no segments at all** (text empty). So on this build a silent clip is already empty before the gate; the gate is for invented text on real room audio.
- **One gate:** the Whisper rule sits in `lib/stt/speech-gate.ts` beside the existing VAD-against-diarizer gate. Those two are separate functions with separate switches (`DIARIZE_SPEECH_GATE` off; this one default on). It is one module and one vocabulary (`speech` / `non_speech` / `unjudged`), not one combined decision. That matches scribe's description of how they were integrated.
- **The transcript** is rebuilt from the kept segments only when something was dropped (S8, S9 killed), so a dropped segment's text cannot come back through the server's top-level `text`.

### Kill switch `ETA_WHISPER_NOSPEECH_DROP`: PASS
Unset, blank or truthy means ON. `off`/`0`/`false`/`no` means OFF and restores the old path exactly. An unknown value stays ON and logs only its length; it never throws. S10–S12 are killed.

### lib/ has no word-set dedupe: CONFIRMED
No Jaccard rule and no word-set comparison of transcript lines. `lib/stt/scoring.ts` `tokenSimilarity` scores engines against each other and drops nothing.

## Findings (low; none blocks)
1. **`no_speech_prob` seems to come only on the first segment of a decode.** On the speech clip, the second segment's value was exactly `0.0` from both services. whisper.cpp appears to compute it once per 30 s decode window. If so, the rule can only ever drop the **first** segment of each window. That under-drops, which is the safe direction. Invented text in later segments of a window is still passed through.
2. **The real drop rate is unmeasured.** `no_speech_prob` and `avg_logprob` are not persisted anywhere in production (no column, no JSON). The only signal after deploy is the `[whisper] speech gate dropped N of M` log line. Worth watching in the first days.
3. **When a segment is dropped, the transcript format changes.** It becomes the kept segments joined with single spaces, not the server's own `text`. Segments that `parseWhisperSegments` rejects (bad timings) are also lost from the transcript in that case. This is rare and cosmetic.
4. The phrase-loop test cleans text using the guard's marks inside the test itself. In production the guard (`47a648e`) only **marks** a loop; it does not delete. The test proves distinct lines are never marked, which is what matters.

## Gate
- `npm run typecheck`: clean.
- Full suite, run alone once the other pane's suite had finished: **163 files, 3,658 passed, 1 skipped**. The Postgres e2e tests ran (docker-exec lines in the log).
- Mutations **13 of 13** killed.
- I did not run `swift` or `check:silent`: the diff touches no Swift and no silent-check surface.

## Jev — condensed diff, none of my findings in its context
Scores 7.1–8.2, all "strong".
- **correctness 7.8**, "risk of breaking existing behaviour" — **confirmed, low**: Finding 3. The OFF path is byte-identical (S10 killed).
- **observability 7.1** — **consistent** with Finding 2: a log line is the only signal of how often the drop fires.
- **documentation 7.2** — **partly rejected**: the switch's semantics are documented in `speech-gate.ts`. The env var is not in any `.env.example`; I did not check whether the repo keeps one.
