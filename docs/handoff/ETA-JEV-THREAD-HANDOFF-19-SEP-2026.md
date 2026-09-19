# Jev / ETA thread handoff — 18–19 Sep 2026

From: Fable (orchestrator, Cowork thread session_01TqJL9cNusj2Yfp9KeoqPRe)
To: the next Builder (Claude Code on the Mini) and any Refuter
Status of the repo: `vinaybhardwaj-commits/Even-Transcription-Assistant`, branch `vinay/s1-auto-drain` at `bbaba3b`, pushed. Working tree in `~/dev/Even-Transcription-Assistant-ow` clean apart from three untracked fleet docs that are not ours.

---

## 1. What Jev is and why it is in ETA

TypeSafe Jev (jev-1.13) is a text-only "System One" model: send a JSON state plus typed questions (`noul` yes/no probability, `choice` with per-option probabilities and confidence, `score` over 2–10 ordered levels) and get calibrated numbers, not prose. Limits that shape everything: text only, English-primary, 32k tokens of state, bad at arithmetic and dates, related answers not guaranteed consistent. Price $42 per billion input tokens, output free.

Where it fits ETA (from the three-researcher survey on 18 Sep): the visit brain has no signal derived from what was said. Boundaries come only from typed cues (`lib/brain/fuse/rules.ts`), confidences are constants (0.9/0.65/0.6/0.45/0.3), the 45-minute mark window is the only fallback closer, and silence gaps were tried and rejected (73% of inter-turn gaps are zero). Roles for non-clinician speakers come from talk-time order on the Mini plus a two-hit first-person regex. Jev supplies the missing text-derived signal: per-window consultation phase, consult start, consult end, clinician present, and a per-cluster role from what the speaker says. It cannot do voiceprint matching, threshold calibration, language ID, silence floors or timing; those stay where they are.

Full design: `docs/handoff/ETA-JEV-ARM-D-SPEC-v1.0-18-SEP-2026.md`. Programme rules: `docs/handoff/ETA-JEV-INTEGRATION.md`. Skill for every thread: `jev-decisions` (Cowork account skill).

---

## 2. What was done, in order

### 2.1 Governance
- D1 (vendor egress of real consult transcripts to TypeSafe) was CLEARED by V on 18 Sep in Cowork, in his words: "I'm in a special trial and they've promised that they do not train off of our data and there is Zero data retention." Recorded as a dated citation in spec §0 ("D1b clearance record") and as a "Clearance record" row in ETA-JEV-INTEGRATION.md §1, with the standing rule restored: sending real transcript text to any vendor without V saying so in words is a data-governance breach. If the trial terms change, D1b closes and J4 stops.
- D1a (development-time use on diffs and synthetic fixtures) is in force.
- Still open: V says "run J4" at the moment it runs; the non-English flag decision (§4.1); D3 role labels (§4.2).

### 2.2 Tooling installed (all verified live)
- `even-jev-mcp` (fork of NiazMorshed2007/jev-review, hardened): `~/dev/even-jev-mcp` on the Mini (git-initialised locally, 42 tests) and `~/.local/even-jev-mcp` on the Air. Registered user-scope in Claude Code on both machines as `even-jev`, and as a Cowork connector on the Air. Key at `~/.config/even-jev/key` (600) on both; the launcher `run.sh` reads it so it never sits in config. Tools: `jev_ask` (arbitrary state + questions, raw API answer, `model` enum jev-latest|jev-preview) and `jev_review` (diff quality scores). Both refuse bodies over 256 KB and screen the whole outbound body for eight secret patterns, fail closed; stderr gets one metadata-only audit line per call including refusals. Upstream defects fixed before adoption: no size cap, no secret screen, "call on every task" nudge; six further defects found by an Opus Refuter in two rounds, all fixed and re-verified.
- `tailscale-shell` v2 at `~/.local/tailscale-shell-mcp-v2` on the Air, desktop config switched (v1 kept; config backed up). Fixes the root defect of v1 (remote command was space-joined by ssh so only the first `;`-segment reached `zsh -lc`; variables lost; PATH lacked Homebrew and nvm). Adds `cwd`, `stdin`, per-host preamble, `copy_to`/`copy_from` (base64 over ssh, 5 MB cap, local paths confined to home and /tmp with `.ssh` and the Jev key dir refused), `ping_peer`, `mcp_call` (drives a stdio MCP server on a remote host), `tailscale_status --json`. 35 tests; seven Refuter findings fixed including a `mode` command injection and a path-guard bypass, plus one found only on the live Mini (the fake-ssh tests exec'd the last argv instead of emulating sshd's flatten-and-reparse; the harness now emulates sshd). NOTE: this session's Cowork connector is still v1 until the desktop app restarts; the Builder in Claude Code is not affected.
- MEX 0.8.2 on the ETA repo (merge `bbaba3b`): telemetry disabled, Claude Code skills `/mex-inbox` and `/mex-relay`, code graph built (585/585 files parsed; Swift under apps/room-recorder is out of scope for Tree-sitter, not an error), `runArm` found in one graph query. Wiki synthesis NOT run: `mex wiki build` wants to spawn its own approving Claude session; run it interactively once. Decision note logged via `mex log --type decision`.

### 2.3 Code shipped (merge `b5c29fe`, branch `vinay/jev-arm-d` at `5a6fa45`)
Built on Slice J0 (English window text, `jev_window_text`, migration 0105, merged by the fleet 19 Sep 19:35).
- J1 `lib/jev/{types,client,mock}.ts`: raw-fetch client to `POST /v1/systemone`, `ETA_JEV_ENABLED` kill switch that makes fetch unreachable (tested), `ETA_JEV_MOCK`, state-size guard, retry 429/529 only, trace via `openTrace({surface:"jev"})` with token counts and no state text, finalised on every exit path.
- J2 `lib/jobs/kinds/jev-window.ts` → `jev_window_signal` (migration 0106): reads `jev_window_text`, batches 20 windows plus 2 context, keeps no-English windows in the batch as `{text:null}` placeholders so ordinals stay consecutive, five questions per window (`phase` choice, `start`/`end`/`clinician`/`clinical` nouls), prompt version `jev-arm-d-v1` in `lib/jev/prompts/arm-d-v1.ts`, per-row token split, semaphore 2 per job / 4 global.
- Arm D `lib/brain/fuse/jev-arm.ts`, pure function, `ARMS` now `["rules","hybrid","flash","jev"]`, dispatched from `runArm` with a `no_jev_signals` fail-closed guard. Rules: explicit start (`p_start ≥ ETA_JEV_T_START` 0.70) before gap; phase-streak open at the first of two arrival/history windows with `phase_confidence ≥ ETA_JEV_T_PHASE_CONF` 0.6 and `p_clinical ≥ ETA_JEV_T_CLINICAL` 0.60; close on `p_end ≥ ETA_JEV_T_END` 0.70, then gap of `ETA_JEV_MAX_GAP_WINDOWS` 6 non-clinical windows (gap windows do not count toward length), then next opener, then `session_end` (visits never cross sessions), then `day_end`; `ETA_JEV_MIN_VISIT_WINDOWS` 3; start-and-end in one window → close-then-open. Emits `DraftVisit` with `arm='jev'`, `opened_by=<window id>`, `opened_by_kind='jev_window'`, never a clinician; adopts `individual_uid` from a `consult_mark`/`pstart`/`pqm_called` cue inside the span, else `state:'unknown'` as rules.ts does for mark-only visits. `writeVisits` nulls `end_reason`/`ended_at` for non-ended states; the firing rule is kept in `reasons` and `tape_end_ms` is written.
- J3 `lib/jobs/kinds/jev-role.ts` → `jev_role_signal` (migration 0107, `prompt_version NOT NULL`, UNIQUE (window_id, speaker_idx, prompt_version)): per-speaker `choice` over clinician/patient/attendant/nurse_or_staff/other, off-menu answers mapped to `other` with a `note`; `lib/jev/role-composite.ts` never assigns a clinician_id from text and takes the highest-confidence acoustic match. KNOWN LIMITATION: per-turn English does not exist (J0 supplies window-level English only; `stt_turn.payload.text` is original language), so the role job skips windows whose `jev_window_text.source` is not `run_english`/`native_en` unless `ETA_JEV_ROLE_ALLOW_NON_ENGLISH=1`. With the flag off, the role bench returns zero rows on Kannada/Hindi days.
- MCP tools in `lib/mcp/tools/jev.ts`: `scribe_jev_window_run`, `scribe_jev_signals`, and `scribe_fuse_run` accepts `arm=jev`; surface counts updated in `lib/mcp/surface.ts` and `docs/operator-mcp/TOOL-NOTES.md`.
- Tests: 3,113 passing, 1 skipped, 0 failed, including the REQUIRED PROOF suites on postgres:16 (Docker CLI is at `/usr/local/bin/docker`; put `/usr/local/bin` on PATH or the proofs report NOT RUN) and `tests/unit/jev-migrations-0106-0107.test.ts`.
- Reports: `docs/handoff/ETA-JEV-J1-J3-BUILD-REPORT-19-SEP-2026.md`; log `docs/handoff/scratch/jev-build-19-SEP-2026.log` (uncommitted, on the Mini).
- Refutation history: first commit `47bd689` FAILED on eight findings (next-opener swallowed by the gap branch; visits spanning sessions; off-menu role aborting the job; trace leaks on throw/timeout; batch placeholders and token accounting; missing semaphore; missing non-English gate; four minor). All fixed in `2485243`, re-verified by the Refuter rerunning its own counterexamples; F1 (how the D1 clearance was recorded) resolved in `5a6fa45`. Final verdict PASS.

---

## 3. Findings about the codebase worth keeping (from the 18 Sep survey)

- Voice ID: ECAPA 192-d embeddings, one averaged centroid per clinician, three uncalibrated cosine thresholds (0.78 live `app/[slug]/api/voice/identify/route.ts:62`; 0.65 batch `lib/stt/diarize-window.ts:36` vs 0.70 service default in `eta-diarize/server.py:294`; 0.80–0.82 passive gate), greedy first match with no runner-up margin (`server.py:190-198`), no patient voiceprints, room-day clustering built but never run (`SPEAKER_MATCH_THRESHOLD` unset by design). No frozen EER; `/api/admin/diarization-eer` needs ≥3 labelled pairs of each kind. One voiceprint measured 0.55–0.62 against room audio for its own owner (phone vs room mic).
- Boundaries: cue grammar only (`rules.ts`), constants listed above, silence closer explicitly rejected (`rules.ts:456-462`), `encounter` and `visit` are separate models joined at read time.
- Other decision points now candidates for Jev, not built: transcript garbage/hallucination (`lib/transcript-guard.ts` regex blocklist), STT judge 1–10 with no probability (`lib/stt/scoring.ts:126-176`), Sarvam-vs-IndicConformer pick (`lib/stt/indic-note-assist.ts`), NABH coverage keyword regex (`lib/notegen/coverage.ts`), CDMSS retrieval gate (`lib/cdmss-pipeline.ts:340-380`, similarity computed but not gated). Emotion service already returns full softmax probabilities; nothing downstream reads more than top-1.
- Known unfixed bug: the router's `whisper_infer` never reads back a language code, so `detected_language` is NULL everywhere; do not gate on it.

---

## 4. What needs to be done next

### 4.1 Promote and run J4 (the live bench) — needs V's "run J4" in his own words at run time
1. Promote `vinay/s1-auto-drain` (`bbaba3b`) through the fleet's normal promote path; this applies 0106 and 0107. Set on the deployed app: `TYPESAFE_API_KEY` (from `~/.config/even-jev/key` on the Mini, never in chat or repo), `ETA_JEV_ENABLED=1`, `ETA_JEV_MODEL=jev-latest`, and V's choice for `ETA_JEV_ROLE_ALLOW_NON_ENGLISH` (orchestrator's recommendation: on for the trial, since an English-only bench does not answer whether Jev holds up on translated Indic consults).
2. Pick ≥10 room-days with kiosk `consult_mark` cues, complete window coverage (`scribe_fuse_report` turn_tape windows_complete == windows_asked), across ≥3 clinicians and ≥2 rooms, `room_day.scratch = false`. Confirm J0 has English text for them (`jev_window_text` rows); run `jev_english` first where missing.
3. Per room-day: `scribe_job_submit {kind:"jev_window", args:{room_day_id}}`, then `{kind:"jev_role", ...}`, then `scribe_fuse_run {room_day_id, arm:"jev", dry_run:false}`.
4. Build `scripts/jev-bench.ts` per spec §7 (not yet written): per-arm open/close recall and precision at ±180 s, median and p90 open error, visit count vs truth, reliability bins and ECE for `p_start` and `p_end`, role accuracy on labelled speakers, cost and latency. Output JSON + markdown to `docs/handoff/scratch/jev-bench-<date>.*`. Note that `ambiguityOf(v.reasons)` filters what reaches `visit.ambiguity`; read the firing rule from `reasons` in the JSON, not from the DB column.
5. Acceptance (proposed, adjustable after the first run): open recall ≥ 0.80 and precision ≥ 0.80 at ±180 s; median open error ≤ 90 s; ECE ≤ 0.10 on `p_start`; role accuracy ≥ 0.85; cost ≤ $0.05 per room-day. Report whether Arm D beats Arm A on the same days; say so plainly if it does not.

### 4.2 D3 — role labels
Generate `docs/handoff/scratch/jev-role-labels.csv` with columns `window_id,speaker_idx,role` for ~60 speaker-windows drawn from the bench room-days (mix of clusters with and without an acoustic clinician match); an admin fills `role`. Until it exists the bench reports role accuracy as UNVERIFIED and only agreement with the acoustic clinician flag.

### 4.3 Wiring, only if J4 passes
Per-room switch beside Visits in `lib/room-switches.ts`, Arm D output feeding `runLiveFuse` as an additional opener/closer with Jev confidence replacing the 0.65/0.45 inferred constants; `rules.ts` untouched. If J4 misses, keep J1 and J3 and drop Arm D.

### 4.4 Housekeeping
- Run `mex wiki build` once in an interactive Claude Code session in the repo; then `.mex/context/*.md` stop being empty templates.
- Restart the Claude desktop app on the Air when convenient to activate `tailscale-shell` v2 and the `even-jev` Cowork connector.
- Follow-up Jev uses (not started, in priority order): transcript garbage Noul; STT judge Score; note-assist Choice; NABH per-field Noul; CDMSS passage Score. Each is a prompt trial via `jev_ask` on fixtures first, then a bench, then a flag.

---

## 5. How to reach things

- Mini repo worktrees: `~/dev/Even-Transcription-Assistant-ow` (s1-auto-drain), `-jev1` (jev-arm-d), `-mex` (mex-setup), `-jevtrial` (fleet's wording trial, `scripts/jev-trial/`).
- From Cowork: read/edit via the SMB mount `/Volumes/MiniDev` (= `~/dev` on the Mini); run git, tsc, vitest only over `tailscale-shell run_on` on the Mini. With v1 of the connector: start commands with `true;`, absolute paths, no `$VARS`, and `export PATH=/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.20.0/bin:$HOME/.local/bin:/usr/bin:/bin` written out literally.
- Jev prompt trials: `jev_ask` in any Claude Code session on the Mini or Air; from Cowork, delegate to a Sonnet agent.
- Refuter second opinion on a diff: `jev_review` (diff + task), cited as leads, never as the verdict.
