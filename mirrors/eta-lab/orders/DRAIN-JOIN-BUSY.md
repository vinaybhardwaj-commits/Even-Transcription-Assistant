# Order — drain throughput: join_already_running is a wait, not a failure (23 Sep 18:40, Fable → yoga-drain, Builder)

## Measured (prod, Neon, 12:58–13:05 UTC)
Each drain tick enqueues 5 room_window jobs at once. The audio join service (AUDIO_JOIN_URL: Cloudflare Worker + Durable Object, one mutex) runs ONE join at a time. Result per tick: 1 job done (a join takes ~1–2 min), 4 jobs `failed` within 3 s with `room_window_failed: join_failed: join_already_running`, attempts=1. Those 4 windows then sit out AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES=5 and are re-enqueued next tick. Net throughput ≈ 1 window per tick. Tonight's backlog needs several times that.

## Goal
A `join_already_running` answer makes the room_window job WAIT and retry (bounded), not fail. Five enqueued windows then complete serially inside the same few minutes.

## Scope / allowed changes
- Branch `vinay/drain-join-busy` off production `d519d7b` (vinay/s1-auto-drain) in the ETA repo.
- lib/stt/join-only.ts, lib/stt/room-drain.ts, the room_window job kind, lib/jobs/errors.ts: classify `join_already_running` (and only it) as retryable-busy. Use the job system's existing retry/requeue path (look at how a job with attempts>1 got to `done` — e.g. the 12:58:47 job ended done with attempts=5). Backoff 30–60 s with jitter; cap total wait (e.g. 15 min or N attempts) → then fail exactly as today.
- A busy retry must not count against the per-window 3-attempt failure bound in the diarize/drain accounting, and must not trigger the refusal cooldown.
- Tests: unit tests for the classification + a job-level test with a fake join returning busy twice then ok → job done, attempts recorded, no cooldown row. Mutation control: flip the classification back → test fails.

## Not allowed
No change to the join service (Cloudflare Worker), no env/flag changes, no deploy, no migration (if you think one is needed, stop and report). No change to diarize code (split-speaker is in lib/diarize for VAD trim). No transcript text in logs or reports.

## Verify
CI gate on the E2E box (`yoga-test.sh`, default host = box) with ETA_CI_HARD_TIMEOUT_S=1200; full suite green. Report PASS/FAIL with the SHA.

## Output (≤12 lines, via the bus)
SHA, files touched, test counts, the backoff/cap chosen, anything UNVERIFIED. ETA-Refuter reviews next; Fable deploys.
