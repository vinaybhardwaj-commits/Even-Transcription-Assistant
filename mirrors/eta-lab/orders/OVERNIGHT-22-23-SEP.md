# Overnight plan, 22→23 Sep 2026 — from Fable

V's direction: keep building until ~06:00 IST or until the only thing left is the listening session (his labels, ~13:00 IST). Token rotation is OFF the list — don't do it, don't ask.

Rules that stay: one heavy job at a time (`lockf -k /tmp/eta-heavy.lock`, moving to the Yoga runner when scribe3 lands it); no drainer except eta-night-drain tonight; nothing pushed to `main`; Fable deploys after a Refuter PASS; no transcript text, keys or tokens in any report.

## Pipeline (each item: build → Refuter → Fable deploys)
1. **scribe** — ship-2210 (stt-hygiene + level-log-ops merged) → push to `vinay/s1-auto-drain`. After that: stand by for Refuter fixes, then take the next unclaimed item below.
2. **scribe3** — yoga-ci. When it works, post the usage line; every pane switches full suites to `~/dev/_fable/yoga-test.sh`. Then: the driver's 3 low test gaps if any remain, then the next unclaimed item.
3. **lx** — 3 branches in review (segments route, router numbers, voice_centroid). While waiting: **E-5 store** — a `encounter_hypothesis` table (migration 114, same rules as 113: check both branch heads, test on a Neon test branch, delete the branch) + a read-only MCP tool to fetch a room-day's hypotheses. Design first, 8 lines to Fable, then build.
4. **fleet** — after the deadline verdict: **level-log retention enable path** — wire the cron entry behind `BENCH_LEVEL_RETENTION`, plus a dry-run report route so we can see what it would delete before it deletes anything. Then the two follow-ups it flagged (AbortSignal on getVertexAccessToken; all_failed vs aborted).
5. **split-speaker** — after clock r5 passes: **E-4 eval harness** — run the gate + smoother over 3 full room-days (read-only), report encounter count, mean start/stop error against the level log's session_open as a proxy, and the unjudged fraction. This is the dry run for V's labelled day.
6. **yoga-drain** — e3kit is ready. Next: a no-labels sanity pass — cluster purity on 2 days (how often the dominant speaker cluster per turn is stable), and confirm the Yoga /enroll embeddings match the Mini's for 20 random turns (parity, counts only). Stop by 02:00 IST; leave the Yoga free for CI.
7. **eta-refuter** — review queue as posted; between reviews, nothing.

## Not tonight
A-OPS-1 re-drain (needs the drainer agreement), the `main` fleet-board reconciliation, pyannote.ai (dropped), token rotation (V's call), and anything that changes production LLM routing.

## Stop condition
If your queue is empty and the only remaining work needs V's labels or a decision, say so in one line and stand by. Don't invent scope.
