# ETA-E11 — two more items before merge, and why the first one matters · 14 Sep 2026, 21:20

Rules on the Refuter's pre-merge verdict. **E11 does not merge tonight.** Queued for the first pane
that frees up; nothing is blocked by the wait, because the drain is off.

## 1. No collision. The tree is fine.

The Refuter reported someone else's uncommitted changes in the main working tree and was right to stop
and say so. The answer is benign: **`scribe` created its own worktree** —
`/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-e16` on `vinay/e16-emotion-speech-fraction` —
so `scribe3` owns the main tree alone with its three E17 files. One agent, one tree, as the rule says.

Worth keeping: three live worktrees now share one repo (`-e16`, `-slice-e`, and the main). **Any future
round that edits files must say which worktree it works in**, and I should have said it in the dispatch
order rather than leaving `scribe` to invent the right answer. It invented the right answer.

## 2. Gap (b) is NOT closed — and the reason is the interesting part

Item (b) was ordered to pin the silent branch's cue-write failure. The test exists and R3 dies against
it. But the Refuter found **two tidy rewrites of the check that survive every E11 test**:
`!counts.window_recorded`, and `counts.failed > 1`.

On the real shape, each of those finishes the silent window `transcribed` and `done` **with no record
in the day**. That is precisely the failure (b) was written to prevent.

Why the test missed it, in the Refuter's own words:

> *"A test built on a fake dependency proves only as much as the fake's answers are realistic. Here the
> fake returned a shape the real function can't produce for a silence, so the test showed the guard
> exists and never exercised its real failure."*

**This is a new shape of testing rule 3 and it deserves recording as such.** The fake was not wrong
about the *algorithm* — it was wrong about the *shape of the data*. For a silence, the real
`writeWindowCues` can only return `failed: 1`, and its likeliest real failure is the batch refused with
the marker accepted, which gives `window_recorded: true`. The fake handed back a shape production
cannot produce, so every rewrite that keys off a different field passed.

**Item (e) — MANDATORY.** Test (b) against the **real** brain shapes, both of them: either give the
fake the shape `writeWindowCues` actually returns, or drive the real function through a faked `fetch`
as the Refuter's probe does. **Both surviving rewrites must then fail.** Report the mutation result for
each by name.

## 3. Item (f) — MANDATORY. The sweep needs `ADAPTERS` and every tracked file.

The Refuter's second finding: `ADAPTERS[key]` is an ordinary lookup that evades a sweep searching for
known names. Add `ADAPTERS` as a **sixth signal**, and sweep **every tracked file** rather than a list
of source roots.

And note where this lands, because it is the third independent argument for the same thing tonight:

> *"A sweep that searches for known names only catches readers written the expected way... That is the
> case for the shared-classifier round: have every Whisper result go through one classifier, and check
> that, rather than hunting for names."*

`scribe` reached it from F3, I reached it from the dispatch addendum, and the Refuter has now reached it
from an evasion it actually built. **E19 is no longer a tidy-up; it is the only durable answer**, and
its priority rises accordingly.

## 4. Optional, and I am declining it for now

Renaming the capture test to what it actually checks. Correct, and not worth a round of its own —
fold it into (e) if it costs nothing, skip it otherwise.

## 5. Sequence

(e) and (f) go to **the first pane that frees up**, in the **main working tree**, and only **after
`scribe3` has committed its three E17 files** — the main tree is its until then. Then a final Refuter
pass, then merge.

Orchestrator.
