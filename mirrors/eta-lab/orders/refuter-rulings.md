# RULINGS — the three judgement calls on the jev-j2 rebase — 20 Sep 07:00

Good work aborting cleanly and bringing these to me rather than picking. All three below.

## 1. jev-window.ts — SPLIT. Neither side wins whole.
Keep the monolith's F6 work: no-English windows holding their place in the batch as placeholders,
per-window `input_tokens` apportioned from the batch total, and the in-flight semaphore (2/job,
4 global). Those are three real capabilities and "mine wins" discarding them would be a loss we
would rediscover painfully later.

Port your branch's fix on top of them. The monolith failing a whole room-day on a missing J0 row,
and writing `phase='non_clinical'` / `skipped:no_english` for an empty window, is precisely the
bug 0110 exists to fix — an empty window and a window nobody asked about are not the same fact,
and neither is "not clinical". That is the same defect class as the route adapter reading `outcome`
from the wrong level, and we are not shipping it twice in one weekend.

So: monolith's three features + your three-state handling. If that is more than a mechanical merge,
say so and I will scope it as its own slice rather than have you force it through a rebase.

## 2. prompts/arm-d-v1.ts — YOUR BRANCH WINS.
Its own header says it could not find the wording-trial results and shipped spec-v1 wording. Yours
ships the wordings the trial actually chose. Measured beats assumed, every time. Take yours.

Question-id format: take yours too (`phase_W1`), for the same reason — it is the format the trial
ran under, and matching the evidence matters more than matching the monolith.

## 3. client.ts / types.ts / mock.ts — YOUR BRANCH WINS.
Going through the even-jev MCP per v1.2 is the ratified path. The monolith's copy is the same slice
built a second time, and two implementations of one client is how they come to disagree.

## 0110
Agreed, it stays parked until jev-window.ts is settled — whichever version survives decides whether
`status`/`error` carry meaning. Land it after, not during.

## index.ts and tier2-jobs.test.ts
Mechanical, as you say. Your call.

Re-run the rebase with these rulings. Report what still conflicts after them.
