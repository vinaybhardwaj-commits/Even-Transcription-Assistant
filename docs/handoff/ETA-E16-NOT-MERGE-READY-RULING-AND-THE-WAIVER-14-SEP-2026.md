# ETA — E16 is not merge-ready, my waiver was wrong, and Docker is shared · 14 Sep 2026, 22:35

## 1. I reverse myself on the `segments_json` hazard, as promised

I ruled it out of scope and told the Refuter: *"if you can show it is reachable, this blocks the merge
and I will reverse myself."* It showed it.

> **MCP `scribe_job_submit` offers `diarize_window` as "operator-submitted by design", and the diarize
> kind never checks for an existing `ok` row.** On a re-run the new speaker numbers meet the old
> intervals, and `speech_ms` goes silently wrong or silently to zero.

Not a theoretical race — **a door built for exactly that use**, which an operator is expected to walk
through. **Reversed. The stale-segments guard is mandatory before merge**, and it must be a *named
failure*, not a silent skip, because a silent skip is how a wrong `speech_ms` would look identical to a
right one.

The Refuter's framing of why it matters is the part to keep:

> *"One table is kept after a re-run (`segments_json`) while another is rewritten (turns). Together
> with speaker numbers that are only a ranking, a harmless-looking re-run produces a confident wrong
> number."*

## 2. My Docker waiver was wrong, and the general lesson is mine

With Docker up, **`c2-e2e-runner` is red, 9 of 48, on E16's own emotion path.** So "the 4 guards are
the only reds" was not true, and I approved a commit on that basis.

I granted that waiver for **E11**, where the Refuter checked each of the four suites and confirmed none
drives the changed code. That check was sound. **I then carried the same waiver into E16 without
re-checking it against a round that changes the emotion path — and `c2-e2e-runner` *is* the emotion
path.**

> **A waiver is granted against a specific diff. It does not transfer to the next one.**
> The Refuter put it better: *"A waiver hides whatever it covers, not just what the Builder expected.
> Here the skipped suites also held the only end-to-end run of E16's emotion path, which is where the
> real failures were."*

That is the second time tonight a decision of mine concealed something — the first being the
three-path sweep I substituted for the classifier. Both had the same shape: I accepted a cheaper
proxy and did not re-ask whether it still covered the new thing.

### And the harness itself hides E16

The deeper finding is not the red count. Even with 0097 and `min_speech_s` added, **7 still fail,
because the suite seeds `segments_json '[]'` beside speaker-attributed turns.** Every span then
measures 0 ms, nothing is sent, and the window ends `done` — **including its own "SERVICE DOWN →
failed" case.**

**A harness that seeds empty segments makes E16 silently do nothing and still go green.** That is the
exact failure E16 exists to prevent, living inside the test that was supposed to prove it. It also
means **E16 has never run end to end through the job runner on Postgres.**

## 3. The rollback path is now a trap — this goes in the runbook

**All five `app.py.bak-*` lack `min_speech_s`.** Restoring any of them after E16 deploys makes every
window fail `health_min_speech_unreadable` and **spend an attempt**, so windows exhaust in three ticks
where pre-E16 code would have scored.

Restart is safe — `health()` returns the constants whether or not the model is loaded. **Rollback is
not.** That belongs in 0097's runbook in bold, because the person reaching for a backup will be
someone having a bad night.

## 4. Docker is shared infrastructure and our container names are not unique

The Refuter started Docker; another pane ran a full suite in the `-e20` worktree; **both use the same
fixed container names (`eta-c2-e2e`, `eta-s1-emotion`), so the two suites could have destroyed each
other's databases.**

- The Refuter discarded its two overlapping runs and waited before its last — correct handling.
- **`-e20`'s Docker-suite results from ~22:25 IST are not trustworthy and must be rerun.**
- The rest of its Postgres results were internally consistent but cannot be proven not to have
  overlapped an earlier e20 run.

**Ruled: container names become unique per worktree.** Small, and it makes the collision impossible
rather than a thing three panes have to remember. Until it lands, **one Docker suite at a time across
all worktrees** — and the "never two suites at once" rule now has a real reason behind it rather than a
theoretical one.

`scribe` also flagged that its own gate ran while another session had `npm test` going in `-e16`. With
Docker down those runs could not collide. **With Docker up tonight, they could have.** Same defect,
noticed twice, from opposite ends.

## 5. E11 is ready

**24 of 25 mutations caught, and the survivor is proven equivalent, not a gap.**
`counts.turn_write_error` can never behave differently: the real function sets that field exactly when
`complete !== true`, so no input separates the two conditions. The Builder's reasoning is the right
refinement of the discipline:

> *"A surviving mutant isn't automatically a gap. The question was whether any real return value
> separates the two conditions. None does, so it can be recorded as equivalent instead of chasing a
> test that can't exist."*

Both rewrites the Refuter found now fail (1 test and 2 tests). The sweep covers every file git knows,
with `ADAPTERS` as a sixth signal, `.swift` included, exclusions named in the file with reasons, and
the remaining blind spots written in the header for E19. **Commit it, then a final Refuter pass on the
sha, then merge.**

## 6. E20 is accepted on its merits, pending a rerun

11 of 11 mutations killed, including writing the losing score into the named path. The greedy case —
two speakers, one centroid — is tested explicitly. Two first-pass survivors, both fixed, one of which
was *a test comparing a constant against itself*, which is worth noticing: that test proved nothing and
looked fine.

Two findings to carry:

- **The control's resolution is 3 dp, not bit-for-bit.** The recomputation lands within 0.00044 of the
  service **because the service rounds to 3 dp**. So the shadow is proven to agree *to that contract* —
  and **that is the precision any threshold set from these scores inherits.** Write it down now; it
  will matter when someone argues about the third decimal of 0.65.
- **The runtime disagreement check is empty and will stay empty** until room diarization names someone.
  Trust currently rests on the live 13/0 run. Do not read an empty check as a passing one.

**Its Docker-dependent results must be rerun once container names are unique.**

## 7. Work order

| pane | work |
|---|---|
| `scribe` | commit E11's two files; **then** E16 items (i) stale-segments guard as a named failure, (ii) fix the `c2-e2e-runner` harness and seed and rerun it with Docker up, (iii) derive `speech_basis` from `speech_ms` presence, treat unflagged empty labels as a model fault, add the rollback hazard to 0097's runbook |
| `ETA-Refuter` | final pass on E11's commit sha, then merge decision |
| `scribe3` | unique Docker container names per worktree; then rerun `-e20`'s Docker suites |

**One Docker suite at a time until the names are unique.** That is the binding constraint on all three.

Orchestrator.
