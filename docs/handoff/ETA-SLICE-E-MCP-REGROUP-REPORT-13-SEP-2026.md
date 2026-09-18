# ETA Slice E — MCP regroup: report (13 Sep 2026)

Branch `vinay/tier2-e`, in worktree `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-slice-e`. Not pushed. The shared checkout was never switched.
Evidence: `docs/handoff/ETA-SLICE-E-MCP-REGROUP-EVIDENCE-13-SEP-2026.md`. §1–5 cover commit 1; §6–8 cover the rebase, the proof and commit 2.
Proposal as first written: `docs/handoff/scratch/SLICE-E-MCP-REGROUP-PROPOSAL-13-SEP-2026.md`.

## 1. Commits

Rebased onto `origin/vinay/release-b1` `0f27b8c`, the C2 merge commit (parents `6b2347e` and `fedec4b`). That is the version the live door reports.

- `aa92e2e` — commit 1: groups, aliases, the 6b2347e fixture, the alias test. Was `3c5db97` before the rebase.
- `80db700` — commit 1b: reused-name openings, TOOL-NOTES.md. Was `ea533c2`.
- `aeedf40` — commit 1c: Ruling A (behaviour, not wording) and Ruling B (generated descriptions, 150-word cap). Was `4edd2e9`.
- `cadc00d` — commit 1d: `scribe_ops_log` removed by ruling. Was `d961d83`.
- **`fee5822` — commit 2:** stt.ts and voice.ts fold in, the 0f27b8c fixture, the D3 accepted change. `tools/list` serves 27.

## 2. Gate (run at fee5822)

- `npm run typecheck`: exit 0.
- `npm test`: `Test Files  102 passed (102)`, `Tests  2468 passed (2468)`, none skipped. The alias test file has 357 tests.
- `npm run build`: exit 0.
- `npm run check:silent`: `Found 9 silent-failure handler(s)`, the same 9 under `app/`; none is in a changed file.
- `swift build`: `Build complete!`.
- `swift test`, with the 0.1.8 runbook's plugin flags: `✔ Test run with 600 tests in 48 suites passed`, no `needsEnrolment`.
- **C2's one-writer proof.** Run at `cadc00d` before any commit-2 code, and again inside `npm test` at `fee5822`. Docker was up and `ETA_ALLOW_SKIP_E2E` unset, so it ran.
  - `✓ … room-diarize-job.test.ts > the enqueue > it WRITES NOTHING — every table has its one writer on the job`
  - `✓ … c2-e2e-runner.test.ts > C2 Ruling 2 — one writer per table, and the live reader is still fed > ONE WRITER, BEHAVIOURALLY: break the job's write and nothing else writes those tables` (1438 ms at cadc00d, 1429 ms at fee5822)
  - The block's three other tests and `REQUIRED PROOF … ran, or was skipped deliberately` passed as well. At cadc00d: `Tests  57 passed (57)` across the two files.
- **Mutation checks on commit 2.** Each change was reverted afterwards.
  - Removing the D3 exception: 2 tests failed.
  - An exception excusing a value that is still published: 2 failed.
  - Dropping the `scribe_window_speakers` alias: 3 failed.
  - A probe that routes to the wrong tool: the module refuses to load.
  - `encounter_id` no longer routing to `scribe_get_stt_run`: 1 failed.
- **Curl.**
  - The live door at 0f27b8c returned 52 tools, identical to this tree's registry.
  - The local build of fee5822 lists 27.
  - The 11 new variants, called through their groups, each reached their tool; an unknown view got `unknown_view`.
  - All 52 names, each called with a token holding exactly its scope, answered HTTP 200 with `_meta.tool` equal to the name called.

## 3. Files changed

Across all five commits, relative to `0f27b8c`:

- `fixtures/mcp/live-tools-list-6b2347e.json`: the 51-name floor, never edited.
- `fixtures/mcp/live-tools-list-0f27b8c.json`: 52 names.
- `fixtures/mcp/tool-scopes-6b2347e.json` and `fixtures/mcp/tool-scopes-0f27b8c.json`.
- `lib/mcp/surface.ts`, `lib/mcp/handler.ts`, `lib/mcp/registry.ts` and `lib/mcp/audit.ts`.
- `tests/unit/mcp-surface-aliases.test.ts` and `docs/operator-mcp/TOOL-NOTES.md`.

`git diff --stat origin/vinay/release-b1 HEAD -- lib/stt lib/jobs db lib/mcp/tools app services` is empty. No Slice E commit touches `stt.ts`, `voice.ts`, `jobs.ts` or `lib/stt/**`.

## 4. SQL and external-schema assumptions

None written. No SQL string was added or changed.

Two outside facts are relied on:
- The door's `tools/list` shape.
- The `SCRIBE_MCP_TOKENS` shape, as `lib/mcp/auth.ts` parses it.

## 5. Result, deviations and flags

**Count: 27 listed = 10 groups + 17 tools.** `tools/call` accepts 60 names: the 52 published plus 8 new group names. Every description is under 150 words.

| Group | Scope | Tools it runs | Words |
|---|---|---|---|
| `scribe_health` | read | health, stt_health, voice_health, llm_health, kb_probe | 70 |
| `scribe_system` | read | system_map, store_stats, list_stt_engines, stt_routing, route_tripwires | 63 |
| `scribe_rooms` | read | list_rooms, diff_room, fleet, day_report, get_clusters | 63 |
| `scribe_sessions` | read | list_sessions, replay_session | 52 |
| `scribe_session_tape` | read | get_session, get_recording | 71 |
| `scribe_encounter` | read | get_encounter, get_trace | 57 |
| `scribe_stt_runs` | read | list_stt_runs, get_stt_run (routed by subject_id / encounter_id) | 63 |
| `scribe_voice` | read | list_voiceprints, list_voice_samples, window_speakers | 64 |
| `scribe_room_command` | write | 7 tools, 9 kinds | 134 |
| `scribe_scratch` | write | replay_write, fuse_run | 57 |

**Listed on their own (17):**
- `get_state`, `list_cues`, `post_cue`, `pin_visit`, `mark_consult`, `extract_audio`, `transcribe_range`, `list_encounters`, `list_traces`, `set_visit_clinician`, `fuse_report`, `list_commands`;
- the `jobs.ts` tools `job_submit`, `job_status`, `job_list`, `job_cancel`, `audit_recent` (ruling: no group absorbs a `jobs.ts` tool).

**The fold was mechanical.** All eleven stt.ts and voice.ts members are `read` on the merged code, and none has an argument named like its group's selector. `scribe_get_clusters` still returns ids only. Every `scribe_voice` member can quote: clinician names, audio links with `include_urls`, a matched clinician id. Both `scribe_stt_runs` members accept `include_identity`.

**The accepted contract change (ruling (a)).**
- What changed: `scribe_job_submit.kind` and `scribe_job_list.kind` lost `diarize_clip`, under C2 decision D3.
- How the test records it: in `ACCEPTED_CONTRACT_CHANGES`, naming the tool, the argument, the value, the capture it was last published in, and the decision.
- A second test proves each entry is real: the value was published in the older capture and is absent from the newer. So a stale entry cannot excuse any other narrowing.
- The stub is not restored.

**Test structure for commit 2.** Both captures are enumerated, 52 names in all.
- The 0f27b8c capture must contain every one of the floor's 51 names, with the same scope.
- Each name's argument contract is checked against every capture that published it, so the floor's contract is kept, not only the latest.
- `buildGroup` now routes every variant's probe at load. The generated value list therefore cannot claim a routing the code does not do; this matters for the id-routed groups `scribe_encounter` and `scribe_stt_runs`.

**Flags:**
1. **No conflicts on the rebase.** The expected `voice.ts` conflict did not occur, because no Slice E commit touches that file. The merged `scribe_list_voiceprints`, with `clinician_status`, `deleted`, `matchable` and the summary, is taken whole, and `scribe_voice view=prints` runs it unchanged.
2. **Correction to the hazard's premise.** The pre-rebase tree (on 6b2347e) had zero INSERTs into `room_diarize_window`, `room_turn_speaker`, `speaker_cluster` or `room_speaker_cluster_member`. Those writers were added and removed within C2's history. After the rebase, the first two tables have one writer each, both in `lib/stt/diarize-window.ts`, and the last two have none. The proof confirms this behaviourally.
3. **The ops_log ruling's stated reason did not match the tree** (reported at 1d). `scribe_ops_log` held three read tools, never submit or cancel. The ruling stands; it is why the count is 27.
4. **Detail no longer shown to fresh clients.** Under Ruling B, grouped tools' long member descriptions are not in `tools/list`. TOOL-NOTES says where they live.
5. **Secrets.** The live curls used `SCRIBE_MCP_TOKEN` from the main clone's `.env.local`, read by key name and passed through stdin, never printed. Local curls used throwaway tokens and had no database.
6. **Swift and dependencies.** The worktree has its own gitignored `node_modules` (an APFS clone; `package.json` is unchanged by C2) and its own `.build`. The e2e container `eta-c2-e2e` was removed after each run.

## 6. Manual steps for V

Push, if you choose:

```
git -C /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-slice-e push -u origin vinay/tier2-e
```

The branch is new on origin, so this is not a force-push.

After deploy, check with curl, never a connector:
- `tools/list` returns 27;
- each of the 52 names still answers.

## 7. Subagents

None.
