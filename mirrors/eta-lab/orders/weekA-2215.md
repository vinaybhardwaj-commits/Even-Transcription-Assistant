# Week A — round 4 (22 Sep ~21:15 IST) — from Fable

Standing rules from weekA-2140/2200 apply, plus ~/dev/_fable/orders/NEON-RULES.md (Neon API key available; test branches only, never main). One full vitest suite on the Mini at a time.

## ETA-Refuter — review queue, one at a time, in this order
1. scribe3 driver round 2 — vinay/overnight-translate HEAD (bundle a7edb58939eacf9e, overlay on 248c2ae). Your two probes must end fatal. Verify 143/144 parked → eligible claim read-only.
2. lx router round 2 — ~/eta-router vinay/router-stt-hygiene HEAD. Dose-swap / morning-night / Yes-Yes kept; R5, R7 killed; strict 2,191 vs 2,186.
3. fleet level-log ops — vinay/level-log-ops HEAD (~/dev/eta-wt-levels): retention route (dry-run unless BENCH_LEVEL_RETENTION=on), scribe_room_levels MCP tool. Run the retention for real on a Neon test branch (`test/refuter-retention`) seeded with old-dated rows; delete the branch after.
4. split-speaker encounter-clock — vinay/encounter-clock HEAD (~/dev/eta-wt-clock). Also judge its three extra verdicts (dead mic→unjudged; quiet room + text→non_speech; loud room + no text→unjudged) — Fable accepts them provisionally; say if any is unsafe.
5. scribe stt-hygiene — when scribe reports DONE.
PASS/FAIL ≤15 lines each + handoff note. Docker contention false-failures: rerun the failing file alone before calling FAIL.

## lx — voice_centroid migration 113 (plan §D), Neon test branch only
Worktree ~/dev/eta-wt-voice on vinay/voice-centroid off origin/vinay/s1-auto-drain. Settled schema (don't redesign; flag problems):
`voice_centroid(id text pk, clinician_id text not null, domain text not null check in ('room_primary','phone','meet'), generation int not null default 1, embedding real[] not null, embedding_model text not null, embedding_dim int not null, n_samples int not null, source jsonb not null default '{}', created_at timestamptz default now(), retired_at timestamptz)`; unique (clinician_id, domain, embedding_model, generation); index (clinician_id, domain) where retired_at is null. Grants in the migration (see how 0112 does it). File db/migrations/0113_voice_centroid.sql. Check 113 is free on BOTH origin/main and origin/vinay/s1-auto-drain heads. Apply on Neon branch `test/lx-voice-centroid`, run it twice (idempotent), then delete the branch. Plus a small lib/voice-centroid.ts read/write helper with unit tests. No prod apply, no routes. Report DONE with sha + branch ids.

## fleet — F1: routedChat overall deadline
Worktree ~/dev/eta-wt-deadline on vinay/routedchat-deadline off origin/vinay/s1-auto-drain. routedChat (Vertex → OpenRouter gemini-3.8-flash → llama-4-scout) has per-call timeouts but no overall deadline (3× worst case). Add an overall deadline (env ETA_ROUTED_CHAT_DEADLINE_MS, default = current single-call timeout × 1.5, justify the number), abort in-flight calls on expiry, return the existing error shape, log which stage expired. Tests with fake hanging backends; keep the no-local-chat-model guard green. Report DONE with sha.

## split-speaker — E-4 smoother (pure, flag off)
Same worktree/branch. lib/encounter-clock/smooth.ts: take per-probe {t, verdict, doctor_present?} and produce encounter start/stop intervals with hysteresis (enter after N speech probes, exit after M non_speech; unjudged never closes an encounter by itself) and gap-merge (default ≤3 min). Constants exported, provisional. Tests incl. dead-mic runs and a long unjudged stretch. Report DONE with sha.

## yoga-drain — stand by
Result noted: pyannote.ai and local ECAPA disagree (c1409↔p1020 0.194 vs 0.635; c1304 flips). Without labelled doctor segments this can't be settled — tonight's listen with V supplies labels. Stand by.

## scribe — carry on; report DONE with sha.
