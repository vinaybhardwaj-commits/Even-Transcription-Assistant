# ETA — W2: `--max-context` — REPORT
**14 Sep 2026 · Builder · whisper arm only, 13:52:28–13:53:32 IST · no server config written · no git, no commit**

**Pooled whisper repeat_ratio (M5 rule A) fell from 0.370 to 0.107. Total characters fell from 18,875 to 15,740 (−16.6%).**

## §2.1 — the lever, established read-only
1. **Plist**, `uk.llmvinayminihome.whisper.plist` (mtime 30 May, sha256 `5c0b3fd3…`, not changed), `ProgramArguments` verbatim:
   `whisper-server -m …/ggml-large-v3-turbo.bin --vad --vad-model …/for-tests-silero-v6.2.0-ggml.bin --no-speech-thold 0.7 --suppress-nst --port 8080`
2. **`--help`** gives only `-mc N, --max-context N [-1] maximum number of text context tokens to store`. That does not define 0 or −1, so I read the source (build of 26 May, whisper.cpp `e0fd1f67`):
   - `server.cpp:928`: `n_max_text_ctx = max_context >= 0 ? max_context : <library default>`. The library default is 16384 (`whisper.cpp:5920`), capped to `n_text_ctx/2` = 224 tokens (`:6913`). **So −1 means full context.**
   - `whisper.cpp:7097`: past text is used as prompt only `if (params.n_max_text_ctx > 0 && t_cur < 0.5)`. **So 0 means no context.**
   - Past text builds up **within one request**: `prompt_past1` gains each decoded window's tokens (`:7598–7606`).
   - The server's own `no_context = true` (`server.cpp:109`; no per-request field for it) only clears context at the **start** of each call (`:6907`). It stops carry-over between requests, not between windows inside one 300 s request.
3. **Per request: yes.** `server.cpp:494` parses a `max_context` form field. The shim forwards every form field to `:8080`.
4. **Callers, all through `:8081`:**
   - the tunnel (`/etc/cloudflared/config.yml`: `whisper.llmvinayminihome.uk → localhost:8081`, used by the app via `WHISPER_BASE_URL`: `lib/whisper.ts`, `lib/stt/adapters/whisper.ts`, `lib/health/whisper-probe.ts`, `lib/admin/dashboard.ts`);
   - `eta-router`, `even-scribe-stt-drain/stt_drain.py`, `eta-probe`, `eta-status`.
   - **None sends `max_context`** (grep), so a per-request field affects none of them.

## §2.2 — the exact change
**One per-request form field, `max_context=0`**, added to M7's request: `POST localhost:8081/inference`, `response_format=verbose_json`, `temperature=0.0`. Nothing else changed. No plist edit, no restart; language, VAD, `no_speech_thold`, `suppress_nst`, best-of, beam, temperature and the router untouched.

## §2.3 — per window, M7 baseline → `max_context=0`
Same ten windows, same order. Log deltas: 1 whisper POST and 0 route POSTs per window. All 200, all `language: english`.

| Win | speech | chars | segs | A loops | repeat_ratio A | B runs / chars | M4 fraction | wall s (RTF) |
|---|---|---|---|---|---|---|---|---|
| W01 | 0.006 | 14 → 14 | 1 → 1 | 0 → 0 | 0.000 → 0.000 | 0/0 → 0/0 | 0.000 → 0.000 | 3.11 → 3.04 (0.010) |
| W02 | 0.047 | 259 → 259 | 19 → 19 | 1 → 1 | 0.413 → 0.413 | 2/31 → 2/31 | 0.571 → 0.571 | 3.44 → 3.45 (0.012) |
| W03 | 0.136 | 743 → 739 | 26 → 25 | 1 → 1 | 0.031 → 0.031 | 1/48 → 1/48 | 0.062 → 0.062 | 3.95 → 3.90 (0.013) |
| W04 | 0.208 | 826 → 814 | 38 → 35 | **1 → 0** | 0.032 → 0.000 | 6/160 → 2/43 | 0.205 → 0.027 | 5.58 → 5.47 (0.018) |
| W05 | 0.312 | 1542 → 1259 | 73 → 53 | 3 → 1 | 0.147 → 0.033 | 8/319 → 2/129 | 0.235 → 0.063 | 7.63 → 5.51 (0.018) |
| W06 | 0.338 | 2049 → 1493 | 61 → 58 | 5 → 5 | 0.626 → 0.259 | 7/1267 → 10/438 | 0.664 → 0.330 | 7.43 → 6.27 (0.021) |
| W07 | 0.364 | 3436 → 1963 | 91 → 64 | 2 → 3 | 0.962 → 0.325 | 2/3306 → 8/768 | 0.988 → 0.408 | 8.67 → 9.20 (0.031) |
| W08 | 0.512 | 2637 → 2041 | 79 → 102 | 3 → 3 | 0.765 → 0.241 | 4/2120 → 11/681 | 0.808 → 0.327 | 10.27 → 7.76 (0.026) |
| W09 | 0.627 | 3619 → 3369 | 125 → 90 | 0 → 0 | 0.000 → 0.000 | 1/6 → 0/0 | 0.002 → 0.000 | 11.21 → 8.58 (0.029) |
| W10 | 0.726 | 3750 → 3789 | 75 → 111 | 0 → 0 | 0.000 → 0.000 | 0/0 → 0/0 | 0.000 → 0.000 | 9.70 → 9.46 (0.032) |

**Pooled, 10 windows, before → after:**
- **Repeat ratio (A):** **0.370 → 0.107**; redundant characters 6,987 → 1,687.
- **Loops:** 16 → 14. **Windows with a loop: 7 → 6** (W04 dropped out; W02, W03 and W05–W08 still loop).
- **Rule B:** runs **31 → 36**; characters **7,257 → 2,138**.
- **M4 collapse fraction:** 0.404 → 0.143.
- **Characters (the trap check):** **18,875 → 15,740 (−3,135)**. Characters left after removing A-redundant text: 11,888 → **14,053 (+2,165)**. Left after M4 collapse: 11,258 → **13,484 (+2,226)**. Raw characters fell by less than the redundant characters did. Whether the added non-redundant text is real speech was not judged.
- **Time:** wall 70.99 → 62.64 s; realtime factor 0.0237 → 0.0209.

## Restore state
**Nothing to restore.** No server configuration was written. whisper-server is still PID 1813 (up since 10 Sep) with the plist above unchanged. Every other caller still gets `--max-context -1`, full context. `max_context=0` existed only in my ten requests.

## Flags
1. **Not uniform.**
   - **W01–W03 barely moved:** W01 and W02 are character-identical, W03 lost 4 characters.
   - **The loop band persists:** W06–W08 still loop (A ratios 0.24–0.33), and rule B's run count went *up* in W06–W08.
   - So context carry-over explains most redundant characters, but not all looping.
2. **Two things I did not verify:**
   - whether whisper.cpp's `--vad` joins speech islands into one decode buffer, which is the mechanism the kickoff proposes;
   - how often temperature fallback (t ≥ 0.5, which ignores context anyway) fired in either run.
3. **One room, one day, 300 s windows, as M7.** Repeatability was not tested: one run per setting.
4. **Files.** `scratch/W2-MEASURE-14-SEP-2026.py.txt` asserts that its baseline equals `M7-W03-ADDENDUM-OUT` for every window before measuring. `scratch/W2-MEASURE-OUT-14-SEP-2026.json` is numbers only, checked free of transcript text. Raw outputs are private, in the session scratchpad.
