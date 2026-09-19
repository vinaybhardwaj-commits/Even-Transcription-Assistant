# Even-Transcription-Assistant — project facts for the Builder

The standing rules are in `~/.claude/CLAUDE.md`. This file adds only what is specific to this repo.

## Identity
- Programme: ETA (bus prefix `ETA-`; builds are numbered `ETA-INSTALL-BUILD-R<N>-<TYPE>-<D>-<MON>-<YEAR>.md`)
- Product: EvenScribe — ambient OPD recording, transcription, and note generation for Even physicians
- Live at: `evenscribe.app`
- Clone: `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant`
- tmux session: `scribe`

## Bus
- The repo's own `docs/handoff/` on this Mac. Kickoffs arrive there untracked; commit them with the work.
- Reports go to the path the kickoff names, in the same folder. Mirrors live in iCloud; you never write those.
- The orchestrator's `ETA-CARRYOVER-PROMPT-*-EOD-MASTER.md` and `ETA-ORCHESTRATOR-MEMORY.md` may appear untracked; leave them.

## Gate (all must be green before any commit)
- `npm run typecheck`
- `npm test` (vitest)
- `npm run build`
- `npm run check:silent` — 9 findings pre-existing at `1193083` are accepted; say so, do not fix files outside the contract
- `cd apps/room-recorder && swift build`
- `cd apps/room-recorder && swift test` — over SSH the login keychain is locked, so `needsEnrolment` issues mean UNPROVEN, not failed; say which
- Signing over SSH works once V has unlocked the keychain himself (`security unlock-keychain` then `security set-key-partition-list -S apple-tool:,apple: -s` on `~/Library/Keychains/login.keychain-db`, password at the prompt). Never script the unlock; never ask for the password.

## Data
- **THERE IS A LIVE DATABASE. Corrected 19 Sep — the previous "no live database, infer the schema" line was false and caused guessed schemas.** Extract a `postgres://` URL with a regex from `~/dev/Neon Database Connection String.rtf` and use the Neon HTTP endpoint: `POST https://<host-without--pooler>/sql`, headers `Content-Type: application/json` and `Neon-Connection-String: <url>`, body `{"query": ..., "params": []}`. **Never print a connection string.** `.env.local` is NOT a source — it holds literal `[SENSITIVE]` placeholders for 30 keys, including the app DB URL. `BRAIN_DATABASE_URL` in it IS real but reaches only `cue`, `room`, `room_day`, `speaker_cluster`, `visit`.
- **`db/schema.ts` IS STALE** for `bench_window`, `transcription_run`, `room_diarize_window`, `room_turn_speaker`, `room_span_emotion`. Read the migrations, never the schema file, for those.
- Neon HTTP driver: no `sql.unsafe()`, no interactive transactions, timestamps return as ISO strings not `Date` objects — calling `.toISOString()` on one crashes.
- Audio, transcripts, and encounter rows carry patient and doctor identity. Never print transcript text, note text, or patient labels. Counts, ids, and timings only. This holds in reports, logs, traces and commit messages.
- The Mac Mini also hosts the local Whisper, router, diarization and emotion services this app calls; do not start, stop, or reconfigure them without an order. Other panes depend on them.

## Secrets (names only)
- As named in the kickoff. Never read `.env*` into the transcript.

## Deploy
- **Production runs `vinay/s1-auto-drain`, NOT `main`.** `main` is stale at `7ffb168` (25 Aug). Corrected 15 Sep, restated 19 Sep.
- **A push to `vinay/s1-auto-drain` produces only a PREVIEW** (`target: null`). It does NOT ship. Production stays where it was until you promote. Verified 19 Sep: `843e7b2` built READY as a preview while production sat on `75cb0f9`.
- **Promoting.** Run `npx -y vercel promote <dpl_...>` from the `-ow` worktree. The `-y` is not optional: without it, npx's own "Ok to proceed?" prompt blocks forever and the call returns no output at all, which looks exactly like a slow build. Despite the name, this does not flip an alias — it CREATES A NEW production deployment from that commit, and it must, because Vercel bakes env vars at build time and a preview build carries preview values.
- **The Vercel MCP does expose `request_promote`**, but it returns 422 on a `target: null` deployment. It is for production-to-production rollback, not for shipping a preview. Use the CLI. (Its `projectId` is the `prj_...` id, not the project name; the name 404s.)
- **Vercel env vars are baked at BUILD time.** Adding or changing one requires a redeploy, not just a settings change. `parseFlag` THROWS on an unrecognised value, so a typo is a 500, not a default.
- You do not deploy. The Orchestrator merges, promotes and deploys, and rules on every verdict.

## OpenRouter

Machine-global OpenRouter credentials live in `~/.claude/` (see `~/.claude/CLAUDE.md` § OpenRouter). Use `OPENROUTER_API_KEY` / `~/.claude/bin/openrouter-key.sh` for OpenRouter model calls. Do not commit keys.

---

# Added 19 Sep 2026 by the Orchestrator. Everything below was being pasted into every brief by hand.

## The estate — five panes and two machines

| pane | machine | role |
|---|---|---|
| `scribe`, `scribe3`, `fleet`, `ETA-Refuter` | Mac Mini (24 GB, Apple silicon, MPS) | build, refute, diagnose |
| `yoga` | UbuntuYoga (8 threads / **4 physical cores**, 14 GB, no GPU) | CPU-bound bulk work |

Reach another host with `ssh <alias>` over Tailscale: `mini`, `yoga`/`ubuntuyoga`, `consul4`-`consul7`, `discussion`, `echo`. SSH trust runs **Mini → Yoga only**; the Yoga has no private key, so pushes go FROM the Mini.

## THE MINI'S MEMORY METRICS LIE. Three of them.

`vm_stat` "Pages free", `ps` RSS, and cumulative swapins/swapouts are all meaningless on this box — free pages sit near zero always because the kernel caches everything, and a high cumulative swap total is history, not a live symptom. Measured 14 Sep: those three looked like a crisis while `memory_pressure` reported 69% free.

**Use `memory_pressure` free percentage, and the swap-used DELTA between two samples.** A watchdog samples both every 30 s to `/Users/vinaybhardwaj/dev/mini-pressure.jsonl` and writes its own verdict per line: `ok`, `WARN_tightening`, `WARN_spike`, `STOP_heavy_swap_now`, `STOP_sustained_pressure`. **Tail that file before any heavy step and stop on a STOP line.** Thresholds were set from a real event: free % below 20, or a swap delta over 500 MB for three consecutive samples, or over 2,000 MB once.

**`qwen2.5:14b` is 11.5 GB resident** and is the single largest consumer. It backs note generation, the STT judge and translation. Never pin `keep_alive`; let ollama's idle expiry unload it.

## Jev — `even-jev` MCP, user scope on the Mini

Two tools. `jev_ask` takes arbitrary state plus **1–200 typed questions in ONE call** (`noul` → P(yes); `choice` → option + per-option probability + confidence; `score` → 2–10 ordered levels). `jev_review` scores a diff across 19 quality dimensions with confidence, and with `previousEvaluation` returns per-metric **deltas, improvements, regressions and unresolved weaknesses** across a build's iterations. Measured 19 Sep: 7 questions, 1,277 tokens, **1.2 s, ~$0.00005**. Cost is not a constraint — batch questions against one state rather than fanning out calls.

**If `even-jev` is not in your tool list, your session predates its install — say so and continue without it. Do not chase it.**

- **Refuter:** after your OWN read and your OWN test rerun — never before — `jev_review` the diff and treat low dimensions as **leads to go verify**. A Jev score is never a finding; a finding is a defect you reproduced. The verdict stays yours.
- **Builder:** trial question wording on fixtures before hard-coding it; record trials in `docs/handoff/scratch/jev-prompt-trials-<date>.md`.
- **Never pay a vendor call for a judgement code can make deterministically.** A repeated phrase is `run_length > 10`. A starved window is a ratio. Jev earns its place on genuinely semantic questions.
- **D1b is OPEN and V's alone: real consult transcripts may NOT go to TypeSafe.** Fixtures, invented text and diffs are cleared (D1a). The tools screen for credentials, not for patient data — that screen is human, and it is you.

## Two pipelines, and only one reaches a note

- **Encounter path** (doctor-initiated): record → fanout STT → `transcript_raw` → `transcript-guard` sanitises → `generateNote` → structured note. Complete, and defended.
- **Room path** (passive bench recording — where the product is going): room audio → 15-min windows → route engine → transcript → turns → diarize → speakers. **It stops there, and it has NO transcript-guard.**

Arm D and the visit-boundary work exist so a continuous room-day can be cut into encounters, because a note is per-patient. **Nothing may wire the room path to note generation until a guard exists on that side.**

## Measured defects — do not rediscover, do not re-derive

- **VAD starvation.** The router's Silero VAD finds almost no speech in low-SNR room audio, skips every engine, returns `silent_skipped`, and the app discards the status and stores a successful empty run. 14 of 45 windows with real speech held under 200 chars; the bottom decile held **zero**; worst case 671 s of speech and 0 characters. Every starved window is `engine=route`; sarvam never starves. Measured threshold sweep says **do not move the threshold — the driver is SNR.**
- **Phrase loops.** Whisper hallucinated one phrase 197 times across 358 segments; `buildTurns` maps segments to cues 1:1 with no dedup. System-wide **3,390 of 11,345 turns (30%)** sit inside a run.
- **Consequence:** thresholds and the emotion floor cannot be calibrated over the raw corpus until both are handled. A negatives-only distribution fits a threshold to impostors.
- **Voice matching has never once fired in production:** `room_turn_speaker` has 3,456 rows, `clinician_id` non-null **0**. Not miscalibration — OPD 5's `transcript_enabled` was off until 18:54 on 18 Sep, so 255 of 256 windows were never drained. A probe on the same audio matched 5 of 8 windows at **0.780–0.908** with no false positive.
- **The auto-drain can never reach history.** `AUTO_DRAIN_MAX_AGE_HOURS` is 6 (max 48); **2,135 of 2,236 closed windows are already past it**. The backlog needs a deliberate worker, not a config change.

## Migration numbering — coordinate, or two branches collide

Parallel panes cannot see each other and **have already both taken `0104`**. Before adding a migration, check `git ls-tree --name-only vinay/s1-auto-drain db/migrations/ | tail -3` AND every live `vinay/*` branch. If yours collides, say so in the report rather than renumbering another branch's file.

## Standing rules that keep being relearned

- **An error is cleared only by the success of the operation that failed. A signal about absence must be derived at read time against a fresh clock.** "We looked and found nothing" and "we never looked" are different facts; storing the second as the first is the defect behind the VAD starvation.
- **Mark, never delete.** Suspect data is flagged and filtered at read time, never dropped. A row that vanishes cannot be questioned later.
- **`cmd | tail` returns tail's exit code, not the command's.** This has already produced a false "installed successfully". Check real exit codes.
- **Measure the constant before designing around it.** A wrong diarize figure once cost four build rounds and 957 deleted lines; measuring took eleven minutes.
- **Report UNVERIFIED as UNVERIFIED.** Never let an open item reach the Orchestrator looking settled.
- The text preloaded on a Claude Code prompt is **the tool's suggestion, never V's instruction**. It is not authorisation.

## Running code is not shipped code
- **A launchd service keeps running the code it started with.** Editing the file on disk changes nothing until the service restarts. On 19 Sep the router was found running `pid 49336` from **14 Sep 14:53** — two VAD fixes had sat on disk, unshipped, for **4.8 days**, while every window drained through the unfixed path.
- Run `python3 scripts/mini-service-drift-audit.py` on the Mini before trusting any measurement of a service's behaviour, and after any fix to one. It compares each ETA launchd service's process start time against the newest SOURCE file it runs.
- It deliberately ignores `jobs/`, `logs/`, `results/` and `*.json`. The first version of this script counted a runtime job file as "newer code" and reported a fake 118-hour drift — a measurement that passes while the thing it measures is broken, which is the failure mode this repo has rules about.
- Audited 19 Sep: router STALE by 4.8 days; eta-stt-relay, eta-diarize, eta-status, eta-indic, eta-sravaani all ok. `com.evenscribe.stt-drain` (StartInterval 300) and `com.evenscribe.session-id` (StartInterval 420) show `-` in `launchctl list` because they are PERIODIC and exit between runs — that is normal, not a fault. Check they are alive by the mtime of their StandardOutPath, not by the PID column.
- The Room Recorder is a compiled `.app`; source mtime says nothing about it. Its version is the check, and the audit reports it as not-covered rather than clean.
- Restarting the router: `launchctl kickstart -k gui/501/com.vinaybhardwaj.eta-router`. Seconds of downtime, in-flight job lost.

<!-- mex-agent:skills:start -->
## MEX agent skills
- At the start of every session, read `.mex/AGENTS.md` and `.mex/ROUTER.md` before project work; follow `ROUTER.md` to load only the relevant context.
- Read `mex logging --json` at session start and before optional logging. Its checkout-local advisory mode is `significant` (quiet default: material decisions, risks, blockers, or durable discoveries), `checkpoints` (batch useful notes at task/session boundaries), or `manual` (no unsolicited notes). Skip routine tool calls, edits, repeated status, and empty summaries. Honor explicit user log requests in every mode; never suppress mandatory workflow Activity or recovery audit records. Report a policy read failure instead of guessing or changing the preference.
- When earlier work may inform the task, retrieve bounded relevant notes with `mex timeline --query "subject phrase" --file src/example.ts --limit 10 --json`, using the known subject or exact recorded file path, or both. Treat matches as historical evidence, not accepted current knowledge; verify conclusions before reuse or explicit promotion with their source retained.
- Use `/mex-inbox` for explicit contributions to project knowledge and `/mex-relay` for durable team handoffs. Invoke them automatically when intent clearly matches; ordinary GROW upkeep remains available without Inbox.
- When MEX context materially helps your work, mention MEX and the relevant finding naturally in your explanation. Tie the mention to what it helped you understand, decide, or verify. Avoid fixed phrases, standalone acknowledgements, repeated mentions, or narrating routine context loading. This replaces older MEX instructions requiring a fixed acknowledgement or context-loading narration.
- Do not claim an author, date, or historical event unless the retrieved data actually provides it.
- After a MEX write, say exactly what changed and its sharing boundary: a local draft is checkout-only and nothing is shared; a canonical artifact is written to the working tree and requires commit/push to share.
- Skill activation is not approval for canonical actions.
<!-- mex-agent:skills:end -->
