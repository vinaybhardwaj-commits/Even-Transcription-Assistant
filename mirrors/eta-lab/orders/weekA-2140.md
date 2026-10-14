# Week A — round 2 (22 Sep ~21:40 IST) — from Fable

Plan: ~/dev/_fable/orders/PLAN-v2.1.md (read §0–§3 first). Production branch on Vercel is now `vinay/s1-auto-drain`. Prod migration = 112; **113 is reserved for voice_centroid** (only the pane named below may create it). Standing rules: no transcript/patient text, keys or tokens in any output; secrets via files/stdin only; never edit the MiniBot whisper-shim; do not start any drainer; do not push to `main`; do not deploy (Fable deploys after Refuter PASS). Commit on your branch, push the branch, report short (≤15 lines) in the pane. One pane per worktree; never edit another pane's worktree.

## ETA-Refuter
Order of review (one at a time): 1) lx `~/eta-router` branch `vinay/router-stt-hygiene` @ d4cc9ca (live tests on a spare port only, never :8083). 2) scribe3's driver fix once scribe3 reports DONE. 3) scribe `vinay/stt-hygiene` once scribe reports DONE. Verdict PASS / FAIL with findings, ≤15 lines each, plus a note in docs/handoff/.

## lx — DB segments route (doctor-ID feed; plan §D)
Worktree: `git -C ~/dev/Even-Transcription-Assistant worktree add ~/dev/eta-wt-segments -b vinay/segments-route origin/vinay/s1-auto-drain`. Work only there.
Goal: a read-only operator/MCP-token route that returns speaker timings for a session or window WITHOUT text: [{start_ms,end_ms,speaker_label,source(diarize provider),confidence?}] + ids. No transcript text in the payload, ever (add a test that asserts no text fields). Reuse existing diarize segment storage; no migration (if one seems required, stop and report). Unit tests + typecheck green. Then add a Scribe MCP read selector for it only if the MCP code lives in this repo and the change is small; otherwise report where it would go.

## fleet — level-log ops (plan §2)
Worktree: `~/dev/eta-wt-levels` on `vinay/level-log-ops` off origin/vinay/s1-auto-drain.
1) Retention without a migration: a cron route (or extend an existing cron) that deletes `bench_level_sample` rows older than 7 IST days, batched, idempotent, dry-run flag. Do NOT enable it in vercel.json yet — write the entry commented / behind env `BENCH_LEVEL_RETENTION=on`.
2) Read-only MCP operator tool for levels: room_id + ist_date → the same 15 s buckets as /api/admin/bench/levels (reuse `readRoomLevelDay`), MCP-token auth, no admin cookie.
Files you may touch: lib/bench-levels.ts, the new cron route, the MCP tool registration file. Do not touch lib/bench-commands.ts or any UI (designer owns). Tests green.

## split-speaker — E-1 contract + E-2 on a transcript day
You couldn't find the plan: it's now at ~/dev/_fable/orders/PLAN-v2.1.md. Your gate definitions are fine as provisional.
1) Pick the most recent Cardiology (or any OPD) room-day that HAS stored transcripts post 15:32 IST 22 Sep cut, or if none, the best pre-cut day with transcripts (flag it as pre-cut). Compute the E-2 transcript half (unique chars/s ≥0.15) and the combined gate. 2) E-1 extract contract: round-trip checksum test (extract → store → re-read → same sha256) on 5 probes. Output to ~/dev/_fable/scratch/e12/ ; report ≤15 lines. Read-only against prod DB; no code in the ETA repo yet.

## yoga-drain
Yes — check `tc-corpus/centroids` and any `*dibyendu*` / `*cardiology*` centroid json/npy on the Yoga. If found, run the ±0.02 reproduction per the prior order. If not found anywhere, say so and stop.

## scribe, scribe3
Carry on with the current order (weekA-2110). Report DONE with commit sha when the gate is green. scribe: if Docker is hung, say so in one line and I'll handle it — don't restart Docker yourself.
