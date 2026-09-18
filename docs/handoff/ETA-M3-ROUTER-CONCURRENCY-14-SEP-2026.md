# ETA — M3: IS THE THREE-ENGINE RACE WORTH IT? — REPORT
**14 September 2026 · Builder · read-only · no edit, no env change, no restart, no git, no commit**

## Clip
I used M2's clip, unchanged: `/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/a79b3568-383e-4a61-bb69-55bcb32f49fb/scratchpad/m2/clip900.wav`. It is 900.000 s, sha256 `c2816bc751a5a71a89738d292d5406b724f494d111b252942ed00661405639e2`.

## Runs (09:47–10:05, one after another, nothing else of mine running)
| Run | HTTP | wall | `sec` | **RTF (wall ÷ 900)** | chars | segments / engines |
|---|---|---|---|---|---|---|
| 1. whisper alone, `POST localhost:8081/inference` with `response_format=json`, `temperature=0.0` | 200 | 41.38 s | — | **0.046** | 15,168 | — |
| 2. route, `translate=false` | 200 | 343.49 s | 343.40 | **0.382** | 14,202 | 32; whisper 30, sravaani 2 |
| 4a. route, sent together with 4b | 200 | 324.18 s | 324.09 | **0.360** | 14,202 | same |
| 4b. route, sent together with 4a | 200 | 683.61 s | 683.52 | **0.760** | 14,202 | same |

M2's 0.326 did not reproduce. Run 2 is 17% above it. M2's own range was 0.326–0.358. I did not look for the cause.

For route, chars means `transcript_native`. Per the access logs, each route run made 62 whisper `POST /inference` calls, and step 4 made exactly 124. The whisper-alone run made 1.

## Whisper-alone vs route
- **Wall time:** route took 8.30× as long as whisper alone (343.49 ÷ 41.38).
- **Text:** whisper alone produced 966 more characters than route (15,168 vs 14,202). Quality was not judged.

## Concurrency, at the current settings
- **Order:** 4a and 4b were fired 1 ms apart. 4b ran after 4a.
- **Queue wait:** 4b's `sec` of 683.52 is about **324.1 s of waiting**, plus about 359.4 s of its own work.
- **Throughput:** both calls together took 683.61 s. Two solo runs at step 2's time would take 686.98 s. That 0.5% difference is smaller than the run-to-run spread, so running two at once gave no throughput gain.

## Memory headroom during run 2 (one route running)
Physical footprint from `top`, sampled every 3 s (106 samples). Peaks:
- **indic:** 2754 MB
- **sravaani:** 2569 MB
- **whisper-server:** 2177 MB
- **ollama-runner:** 1765 MB. Already loaded before M3; not used by these runs.
- **router:** 271 MB
- **whisper-shim:** 134 MB
- **ollama:** 96 MB

System: 24 GB RAM.
- **Trough:** free plus speculative pages **95 MB**; free plus speculative plus inactive **2027 MB**.
- **Swap:** up to **20,230 MB used of 21,504 MB**.
- **Memory level:** `kern.memorystatus_level` fell to **16%**.
- **Idle baseline before run 1:** 143 MB, 2501 MB, 20,589 MB swap, 20%.
- **Wired memory:** one reading at 09:46, 12.85 GB.

## Live settings (none changed)
- **`ETA_MAX_INFLIGHT` = 1.** Read from the running router's environment (`ps -E`, PID 95935). It matches the plist. The code default is 3 (`router_server.py:72`).
- **`ETA_MAX_WINDOWS_INFLIGHT` = 1.** Not set in the process environment, so the code default at `router_server.py:74` applies. The in-memory value itself was not read.
- **`SEG_SEC` = 30.** `ETA_SEG_SEC` is not set, so the code default at `router_server.py:60` applies. Every live `/route` response confirms it with `segmentation.max_window_s: 30.0`.

## Not checked
- **Transcript quality**, including whether whisper alone got any non-English right.
- **Indic and SraVaani calls:** how many were made per route; their logs were not read.
- **Direct traffic to indic, sravaani or ollama** during the runs.
- **GPU memory** not counted in the footprint figures.
- **Why run 2 was slower than M2.**
- **Wired memory** during the runs.
