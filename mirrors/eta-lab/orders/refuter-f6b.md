# RULINGS — F6(b) and the qid underscore — 20 Sep 07:15

## 1. The qid underscore — my typo, take yours
`phase__W1`, double underscore. My ruling said "take yours" and then wrote the literal wrong.
The intent was and is: take the format the wording trial actually ran under. Flip the one line.

## 2. F6(b) — FIX THE TEST, NOT THE CODE. The invariant is the thing that is wrong.
You found that `summary === share × 2` holds only for an even total, and that the trialled
wordings give 961, so 481 × 2 = 962 ≠ 961. Your read is right and so was your refusal to touch
either side without a ruling: that test was passing on parity luck, not on correctness.

The two quantities are not the same kind of thing, and the invariant pretends they are:
- the **summary total** is a measured fact — the tokens the call actually consumed;
- the **per-row share** is an apportionment we invent to attribute cost across rows.

An apportionment of an odd total into equal parts cannot sum to that total. No arithmetic fixes
that, so any code change would be choosing which lie to tell: either the summary stops being the
real total, or one row silently absorbs a remainder and stops being an equal share.

So:
- The summary keeps the **raw total, exactly**. It is the billed number and it stays truthful.
- Per-row shares stay `Math.round(total / n)`.
- Replace the assertion. Assert that the summary equals the raw total exactly, and that the sum
  of the rows differs from the total by at most `n / 2` — which is the true bound for rounding
  `n` values. Assert it for an ODD total explicitly, since that is the case the old test could
  never have caught.
- Put one line in the code saying the column is an apportionment, not a measurement. The next
  person will otherwise sum the rows, find 962 against a total of 961, and open a bug.

If you think a remainder-to-last-row scheme is better, say so with your reasoning and I will
reconsider — but do not implement it without coming back, because it changes what that column
means and that is my call, not a refactor.

## 3. jev-window three-state — agreed, deferred as its own slice
Right call, and thank you for preserving the test at `a23281d` rather than dropping it. 0110
stays parked until that slice lands. Do not let it drift: it is on the queue, not shelved.

## 4. Your gate is accepted
typecheck 0 · jev-client 9/9 · jev-role 16/16 · tier2 37/37 · fuse-arms 62/62 · build clean ·
check:silent 9 accepted · full suite 3147 passed / 1 skipped. Good.
