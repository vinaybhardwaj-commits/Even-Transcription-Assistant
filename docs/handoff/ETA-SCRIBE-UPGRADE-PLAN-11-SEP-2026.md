# ETA / Scribe — Upgrade Plan and MCP Redesign (11 Sep 2026)

Orchestrator synthesis of three researcher passes (A core system, B audio/STT/tunnel, C MCP) over the live clone `/Volumes/MiniDev/Even-Transcription-Assistant` @ `5dff406`. Reports: `scribe-audit-11-sep/A-core-system.md`, `B-audio-stt-tunnel.md`, `C-mcp-audit.md`. Load-bearing claims re-verified by Fable in `lib/mcp/tools/bench.ts` and `lib/bench-bus-constants.ts`.

## 1. Headline

The three capabilities V asked for — download raw chunks, stitch, Whisper on demand — **already exist in the MCP**: `scribe_get_recording mode=manifest|chunk` returns presigned R2 URLs per chunk (bench.ts:367-392); `scribe_extract_audio` stitches across chunks through the Cloudflare Containers `audio-join` service and returns a presigned clip (bench.ts:893); `scribe_transcribe_range` joins then runs Mini Whisper (bench.ts:1739). The MCP's real defects are elsewhere:

| Complaint | Root cause (cited) | Fix class |
|---|---|---|
| Wrong tool surface | 39 tools named by table, not by operator job; the wants above are buried inside `extract_audio`/`transcribe_range` with a `dry_run` default; PRD-promised `scribe_watch_rooms`, `scribe_explain_state`, `scribe_run_stt_fanout`, `scribe_diarize_clip` never built (C §4) | Rename/regroup + build the missing six |
| Poor output | `include_*` flags exist only on the privacy axis; the three bulky tools (`diff_room` ~2,400-word description, `day_report`, `system_map`) have **no** volume flag (C §6) | `detail: summary\|full` on every tool |
| Unreliable / slow | A hung downstream call (Whisper, pyannote, join) silently burns the whole 55 s / 115 s budget before any answer (handler.ts:224-229); control verbs are floored at kiosk poll (1.5 s) + 8 s ack (`ACK_WAIT_MS`) | Async job model for invoke tools; downstream timeouts shorter than tool budget |
| Read-only, no leverage | Kiosk command vocabulary is exactly `start_day\|pause_day\|resume_day\|end_day` (BenchClient.swift:172-176, bench-commands.ts:23). Mic, update channel, force-update, enrol all local-only **by design** (RoomConfiguration.swift:169-178, 211-234, 502-518) | Extend the kiosk verb set — a product decision, not a patch |
| LLM tunnel unused | Only `scribe_llm_health` (one-word probe). No ask/embed/diarize tool. Tunnel serves `chat/completions`, `embeddings`, `models`, `/diarize`, `/enroll`, `/inference` ×2 (B inventory). No emotion endpoint in client code | Add `scribe_ask_llm`, `scribe_embed`, `scribe_diarize_clip` |

Second structural finding (confirms the 9 Sep shape): the only automated content-aware check is nightly `measure-windows` (90 s Whisper clip). Self-update canary, reap-stuck, listener freshness all test plumbing (A §6). `ENDED_DISAGREES` (6 h of undetected recording) is the canonical failure.

## 2. Ranked plan

### Tier 1 — Remote operability (kiosk side; unblocks everything else)

1. **Extend the kiosk command bus** — same 1.5 s poll, same `bench_command` table, new kinds: `check_update_now`, `set_update_channel`, `list_input_devices`, `set_input_device`, `report_diag` (logs tail, device list, config sans secrets), `restart_engine`. Each is an ordinary audited verb through `POST /api/admin/bench/command` and an MCP `scribe_room_command`. Ships as room-recorder 0.1.17+ via the proven self-update path — the one change that needs no walk. **Reverses the "no verb for channel, deliberately so" rule (RoomConfiguration.swift:301-305) — V must rule.** Mitigation: kiosk accepts `set_update_channel` only from a command row carrying a server signature over (room_id, kind, nonce), so a compromised DB row alone cannot steer a room.
2. **Content-aware heartbeat** — kiosk includes in every poll body: input RMS over the last slice, clipping count, device UID, encoder state, disk free. Server surfaces `SILENT_WHILE_RECORDING` and `DEVICE_CHANGED` as named states beside `ENDED_DISAGREES`. This is the cheapest way to make "every check passed while 3 of 4 rooms were faulty" impossible.
3. **Enrol stays walk-required** — accept it; fold "sshd + Tailscale on all four Macs" into the one OPD visit already scheduled. With sshd everywhere, item 1 becomes optional for emergencies but still the right daily path.

### Tier 2 — MCP redesign (server side)

4. **Regroup by operator job, not by table.** Target ≤ 25 tools in five groups: Rooms (state, command, watch), Tape (recording manifest, stitch, transcribe, measure), Brain (cues, visits, fuse), Lab (STT runs, engines, routing, fanout), Health (one composite + per-service). Keep the 39 names as aliases for one release.
5. **New tools**: `scribe_stitch` (standalone, returns presigned clip; loops >30 min into ≤30 min pieces server-side and returns a piece list), `scribe_transcribe_range` gains `engine` from `lib/stt/registry.ts` instead of hard-pinned `whisperAdapter` (bench.ts:1473), `scribe_audio_measure` (ffmpeg `astats`/`silencedetect` on a clip via the join container — levels, silence spans, clipping), `scribe_ask_llm` (arbitrary prompt through `routedChat`, surface + model selectable, JSON mode optional), `scribe_embed`, `scribe_diarize_clip`, `scribe_run_stt_fanout` (N engines on one clip → `transcription_run` rows so the leaderboard sees them), `scribe_watch_rooms` (digest of named states across rooms; the push half stays out until a channel exists).
6. **Async job model for invoke-scope tools** — `scribe_*` returns `{job_id}` in < 2 s; `scribe_job_status` polls; results land in `transcription_run`/`clips/`. Removes the 115 s silent stall and the 300 s Vercel ceiling as user-visible failures.
7. **`detail: summary|full` on every tool**; cut `diff_room`'s description to ≤ 150 words; default `dry_run=false` on read-only-safe paths.
8. **Downstream timeouts named fast** — Whisper/pyannote/join fetches get a budget strictly below the tool budget and return `{error: "<service>_timeout", elapsed_ms}` rather than a shape-only degrade.
9. **Per-token scopes** — `SCRIBE_MCP_TOKENS` map {token → scopes, actor_id}; audit log gets a real actor (auth.ts:36-37 today: one token, all scopes, `mcp:operator-v1`).
10. **Fleet read for agents** — `/api/admin/bench/fleet` is proxy-blocked from Cowork shells; expose the same read-only payload as `scribe_fleet` through the MCP door (the MCP door itself is reachable).

### Tier 3 — Note quality

11. **Whisper-only auto-drain cron** — PRD §1.6 forbids unattended *paid* runs; `measure-windows` already runs free local Whisper nightly, so a `drain-free` cron (Mini Whisper only, Transcript switch respected) is consistent with the rule and closes "no drain cron → no automatic room transcription".
12. **Feed speaker-tagged transcript into note-gen** — `generateNote(transcript: string)` takes only `transcript_raw`; `room_turn_speaker` is never consulted. Add a `TaggedEntry[]` input path behind a flag and evaluate on the gold windows.
13. **Wire `resolveRouting("room")` into the range path** so the Sarvam-vs-Gemini bake-off (S1–S8) can run through the same tool the operator uses.

## 3. Decisions needed from V

| # | Decision | Default if silent |
|---|---|---|
| D1 | Extend kiosk verbs (incl. `set_update_channel`, `set_input_device`) — reverses the local-only valve | Yes, with server-signed command rows |
| D2 | Async job model for invoke tools | Yes |
| D3 | Whisper-only auto-drain cron | Yes, Transcript switch respected |
| D4 | Per-token scopes / multiple tokens | Yes |
| D5 | Extend `audio-join` container to run `astats`/`silencedetect` | Yes |
| D6 | Regroup + rename tools (aliases kept one release) | Yes |

## 4. Build order (after D1–D6)

1. Spec + Builder: kiosk verb extension + heartbeat (Swift + `bench-commands.ts` + migration) → Refuter → 0.1.17 to `test` → Cardiology → `stable` (after the six partition steps).
2. Spec + Builder: MCP async jobs + timeouts + `detail` flag (no new tools yet) → Refuter.
3. Spec + Builder: new tools in the order `scribe_stitch`, `scribe_audio_measure`, `scribe_ask_llm`, `scribe_transcribe_range engine=`, `scribe_run_stt_fanout`, `scribe_watch_rooms` → Refuter.
4. Tier 3 items behind flags, evaluated on `stt_gold` windows.

## 5. Open items carried

`services/audio-join` concat semantics for index gaps (UNVERIFIED); whether `scribe_transcribe_range` persists to `transcription_run` (UNVERIFIED — job model makes it explicit); cause of the fleet-route proxy block; `docs/DATA-MODEL.md` stale at migration 0027 (bus/window/release tables undocumented); `resume-processing`/`diarize-windows` cron bodies unread.
