# Ruling 389 part 3: Mini vs Hugging Face behavioural parity (defined by eta-refuter-2; checked by eta-refuter)

Frozen golden set: `GOLDEN-389.json`, sha256 `d7964897189dba9d6dc78390a2c9e26269ad75e560173ef05b49f26710b408d1`. It has 48 windows plus 15 ordered reserves, drawn by `golden389_draw.py` with seed 389 from index `view-202609251212.jsonl`, sha256 `9aaf462682ef437d0829c1a50ac5224c1923100dda32ae8be8b2df0e05268b63`. The script takes the index by name and sha, and refuses any other (eta-refuter #2325 fix 1). Reproduce with: `golden389_draw.py plan_frozen.json out.json view-202609251212.jsonl 9aaf4626…`. The output is byte-identical (checked). The file holds ids, keys and counts only, no text.

| stratum | n | how it was chosen |
|---|---|---|
| refused | 12 | index status "refused". 11 of the 12 are from r333/337d's 30 all-refused windows. |
| loop | 10 | a repeated identical segment x>=5, OR a consecutive run >=3, OR a 1-3 word phrase repeated >=8 times in one segment. There are 17 candidates in the index. |
| indic | 12 | 4 with index language hi, 4 kn, 4 code-mixed (>=2 Indic plus >=2 English segments). |
| silence | 6 | 4 NO_SIGNAL, plus 2 near_silence or transcribed_unconfirmed. |
| english | 8 | English, >=20 lines, 0 refused, no repetition. |

The selection flags come from the HIST-twin records. The REFERENCE is the Mini production stack run on the same audio.

## Mini reference manifest
`MINI-STT-MANIFEST.v2.json` (sha256 `c85d1e6ec0a3ab5caa3f9f1e5abb2bf7242ea399d5819257bdd02bf80bb79bf0`) plus its collector `mini_stt_manifest.py` (`8354025608c7…`), on main at 5f81d9f. It was confirmed against the running Mini by eta-refuter (#2330, #2336). Ruling 391 named v1 (`8c7a55be…`). v2 is leaf-identical to v1 on every stack leaf; only collected_at, the collector sha and the added scope/version block differ (eta-refuter #2337). Ruling 398 settles it: v2 `c85d1e6e` is canonical (eta-refuter #2358).

## Third comparison point: direct whisper (eta-refuter #2365)
The production ROOM path also calls whisper-server DIRECTLY, not through the router: lib/stt/room-drain.ts:857 (the 30-s language probe) and :924 (the full window, forced to the probe's language). It goes via the WHISPER_BULK_URLS pool, and lib/whisper.ts then applies the app's no-speech drop (speech-gate.ts, ETA_WHISPER_NOSPEECH_DROP, default ON) to whisper's per-segment no_speech_prob. Therefore:
- (c) RAW WHISPER: on every golden window, each side sends the app's exact two requests (the probe, then the full window forced to the probe's language, same response format) to its own whisper-server: Mini :8080, and HF whisper platform-rebuilt from e0fd1f67 with the Mini's argv. Compared per window: segment count identical; start and end within +-0.5 s; language identical; the per-segment no_speech_prob difference reported (max and p95).
- PROBE LANGUAGE RULE (eta-refuter #2373): the two probes' languages must be IDENTICAL, which is itself a PASS condition, and a disagreement FAILS that window. Each side forces its full-window request to its OWN probe's answer, so after a disagreement both sides ALSO run a controlled full request forced to the MINI's probe language, and (c) compares those two. The window stays FAILED on the probe; the controlled pair only shows whether the full-window decode also differs.
- The POST-GUARD run (b) adds the app's no-speech drop (whisper.ts plus speech-gate.ts at their a92ebae blob shas) over (c). The kept or dropped segment set must be IDENTICAL on every window. Any segment whose no_speech_prob lies within 0.02 of the drop threshold (on either side) is listed for Fable, because a CUDA vs Metal float difference could flip it.

## Which production pools HF may join
- Router pool only, and only after (a) and (b) pass on every golden window.
- WHISPER_BULK_URLS (direct whisper) only after (c) and its no-speech post-guard also pass. Until then an HF whisper node must NOT be added to WHISPER_BULK_URLS.

## App guard code actually applied (scribe #2361, verified by eta-refuter #2365)
- Room path text guard: ONE function, collapseAssembled in lib/stt/assembled-collapse.ts (blob 793ae11a…, lexicon number-words.json de635ba9…). It is called unconditionally on the assembled original and on the assembled English (room-drain.ts:1251/:1254; :1108 shadow). All its constants are in code.
- No-speech drop: speech-gate.ts (eb60e78e…) plus whisper.ts. ENV ETA_WHISPER_NOSPEECH_DROP is not readable: the Vercel connector returns 403. The run ASSUMES the code default (ON) and says so in its report. DIARIZE_SPEECH_GATE affects diarization only, so it is out. Reading the two env names is PARKED FOR FABLE.
- transcript-guard.ts is encounter path only, so out. hallucination-collapse.ts has no importer at a92ebae, so out. english_hallucination_guard is router-side, covered by (a).

## Harness I/O (for the builder, scribe proposed; the assignment is conductor's/Fable's; eta-refuter refutes before it runs)
Box only, under ~/eta-data/hf-parity-389/ (dirs 0700, files 0600, never pushed anywhere):
- <side>/audio/<window_id>.sha256: sha256 of the assembled window audio. side = mini | hf.
- <side>/router/<window_id>.json: the router's response body exactly as returned to its caller (segments with start_s, end_s, text, lang, engine, refused, refused_reason, plus any status field), plus a small sidecar <window_id>.meta.json {stack_sha, eta_env_names, started_at, audio_sha256}.
- <side>/whisper/<window_id>.probe.json and .full.json: whisper-server's raw responses to the app's two requests, plus <window_id>.request.json holding the exact request parameters (no audio).
- results/: the harness writes only per-window and per-stratum COUNTS, decisions, timings, probability differences and edit rates (Levenshtein computed in memory). It writes no text and prints no text. The harness imports the app modules at the blob shas above and refuses on any mismatch.

## Run rules
1. Each side assembles every window's audio from the record's `audio_keys` and posts the sha256 of the assembled bytes. The two shas must be equal per window; a mismatch voids that window.
2. A window whose audio cannot be fetched on BOTH sides is replaced by the next reserve of the same stratum, in order. Every replacement is reported.
3. Nothing is changed or retried selectively. Each side runs every window once, with the stack named in minibot's manifest (Mini) or the manifest-identical image (HF). The run's stack sha goes in each record.

## Scope (eta-refuter #2325 fix 2, #2330)
- IN: the Mini-side STT path that the HF machine replaces. That is the router (english_hallucination_guard, collapse_phrase_loops, segment dedupe, Silero VAD and its fallbacks, language routing), the whisper shim (loop collapse, number exemption), whisper-server, IndicConformer and SraVaani, as named in minibot's MINI-STT-MANIFEST.
- ALSO IN (ruling 391, Fable 14:05, which supersedes my first scope line): the app's own guard code, i.e. the loop-guard 035c5b7 path as in production a92ebae. It is the modules minibot's manifest lists under app_side_guards_NOT_ON_THE_MINI, pinned by their git blob shas at a92ebae. That code runs OFFLINE over BOTH sides' router outputs, and the post-guard results must be identical. The offline harness is new code, so it is reviewed before it runs. It must import those modules at their manifest blob shas (checked), must not change them, and must print no text.
- OUT: the diarizer (:8001) and stt-relay.mjs. HF diarization is NOT covered by r389.
- There are TWO comparison points: (a) the ROUTER OUTPUT (segments with text, timing, language, engine, refused flag and reason); (b) the POST-GUARD result of the app guard code at a92ebae run offline over (a). Both must be identical under the rules below.

## How the loop decision is observed (and its limit)
The router trims phrase loops BEFORE it returns segments and does not report that it did so. The loop stratum was drawn from STORED outputs, so it holds loops that SURVIVED the collapse. The router-side loop decision is therefore compared through its output:
- on every window, the same segment count and boundaries;
- per segment, the same repetition metrics: the top identical-segment count, the longest run, and the longest in-segment phrase repeat, computed on the box and never printed;
- the edit rate.
LIMIT, stated and not hidden: a window where collapse fired on one side and not the other shows up only as a text or segment difference, not as a named "trim" field. No router code is changed to expose it, because that would break identity.

## PASS (all must hold on every window; otherwise FAIL, and HF is not used for that engine)
- **Guard decision identical, at the router output:**
  - window status: text / refused / no_text / no_signal / failed;
  - the refused flag of every segment;
  - the loop or repetition trim (applied or not, and the segments trimmed);
  - the language route / engine per segment;
  - the hallucination-guard and loop-guard reason codes.
- **Post-guard identical (r391):** after the app guard code at a92ebae runs over each side's router output: the same kept or dropped decision per segment, the same collapse or loop-guard events (count and which segments), the same guard reason codes, and the same assembled segment count. The assembled-text edit rate is reported like the router text.
- **Segment count identical**, and every segment's start and end within +-0.5 s, matched by order.
- **Text:** the per-window edit rate (Levenshtein / reference length) is computed on the box and reported, with the text never printed. Any window above 5% is listed for Fable with its stratum.
- The stack sha on both sides matches the manifest (minibot); the only allowed difference is whisper.cpp "platform-rebuilt" from the same commit and flags.
- **Environment identity** (eta-refuter #2325 fix 3): the set of ETA_* variable NAMES in the HF router's process environment equals the manifest's `router.eta_env_names_exact` (7 names today). The decision-knob values are equal (ETA_DEFAULT_CANDIDATES, ETA_TRANSLATE_ENGINE, ETA_TRANSLATE_FALLBACK, ETA_MAX_INFLIGHT). There is no extra ETA_* variable, even at a default value. Read from the running process (names only for secrets and paths).

The report gives counts per stratum: windows equal, decisions differing (named field), boundary misses, and the edit-rate distribution. No text.
