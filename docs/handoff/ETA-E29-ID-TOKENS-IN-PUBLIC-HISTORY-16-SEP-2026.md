# ETA-E29 — Clinician-id-shaped tokens in this repository's public history · 16 Sep 2026 · Builder

Facts only. **No token appears in this document**, and none should ever be copied into one. Counts, paths, commit
shas and dates are enough to act on, and they are all that is recorded here.

## 1. What was found, and how

While running the gate on a merge, `tests/unit/no-real-clinician-ids.test.ts` failed on three documents that a
docs-only commit had just tracked. Investigating that failure, the whole of the branch's reachable history was
scanned — every blob reachable from `origin/vinay/s1-auto-drain`, not just the current tree — using the guard's own
id shape and the guard's own allowlist, read out of the test file so there is one source of truth.

**Six paths carry id-shaped tokens in commits that are already on the public remote:**

| Path (historical blob) | distinct tokens | blob versions | first added |
|---|---|---|---|
| `docs/ETA-CARRYOVER-PROMPT-31-MAY-2026.md` | 1 | 1 | `27c5af8`, 2026-06-09 |
| `docs/ETA-NEXT-THREAD-BOOT-PROMPT.md` | 1 | 1 | `27c5af8`, 2026-06-09 |
| `docs/ETA-OPEN-ITEMS.md` | 1 | 1 | `27c5af8`, 2026-06-09 |
| `docs/ETA-VOICEPRINT-PASSIVE-CAPTURE-MAC-MINI-TASK.md` | 1 | 1 | `27c5af8`, 2026-06-09 |
| `docs/handoff/ETA-S1-FIX2-REPORT-14-SEP-2026.md` | 1 | 1 | `8ac9e24`, 2026-09-14 |
| `tests/unit/c2-e2e-runner.test.ts` | 6 | 2 | `3b70642`, 2026-09-12 |

Two commits introduce the bulk: **`27c5af8` (2026-06-09)** for the four `docs/` files, and **`3b70642`
(2026-09-12)** for the test file. The exposure is therefore about three months old for the documents.

**None of the tokens is `doc_fake…`.** Every one is opaque — the shape of a real clinician id, not a synthetic one.

## 2. What is already true, and cannot be undone by editing files

- **The repository is public** (`githubRepoVisibility: "public"`, confirmed from the Vercel API by the
  Orchestrator).
- **The branch is pushed.** `origin/vinay/s1-auto-drain` is at `109ce4c`; every commit at or below it is on the
  remote. The six paths above are all at or below that line.
- **Every current version of those six files is clean**: 0 unlisted tokens today. They were redacted at the time,
  which is why nothing has flagged them since. **The tokens survive only in history — which is what gets cloned.**
- `tests/unit/c2-e2e-runner.test.ts` carrying six of them means **real clinician ids were once used as test
  fixtures**. That is a different fact from a document quoting one, and it is the one worth acting on first: a
  fixture is copied, adapted and re-used, and the current file's synthetic ids show somebody already noticed.

## 3. What exists now that did not then

- `tests/unit/no-real-clinician-ids.test.ts` (added `ea07744`, 2026-09-13) scans the tree for the id shape against
  an explicit synthetic allowlist. **It is what caught this.**
- It scans TRACKED content: an untracked bus document is exempt, and the same document is scanned the moment it is
  staged. That is the correct boundary and it is the reason the three documents in the docs-only commit were
  caught before they reached the remote.
- **The current tree is clean.** The only tokens that remain are in history at or below `109ce4c`.

## 4. The three options, with their real costs

1. **Leave history; treat it as a disclosed exposure.** Cost: the tokens stay publicly reachable by anyone who
   clones or who knows a commit sha. Benefit: no broken clones, no force-push of the production channel, and the
   incident is recorded rather than quietly half-fixed. This is the status quo plus honesty.
2. **Rewrite the full branch history and force-push.** Cost: every clone and fork breaks; the production channel is
   force-pushed; CI and any deploy pinned to a sha is invalidated; and it is **not sufficient on its own** —
   GitHub keeps unreachable objects fetchable by sha until they are purged, so it needs a support request to mean
   anything. Benefit: future clones do not carry the tokens.
3. **Rewrite only above the pushed line.** Cost: none — nothing above `109ce4c` is published. Benefit: the 19
   tokens from the 16 Sep docs-only commit never enter history at all. **This is what was done today** (R45); it
   fixes only what was free to fix and touches none of the six paths above.

Option 3 is complete as of this document. Options 1 and 2 remain open and are **V's decision with whoever owns
security at Even** — not the Builder's, and not the Orchestrator's.

## 5. What can be proved, and what cannot

Absence can be proved for a named ref: enumerate every object reachable from it, read every blob, and match the
guard's shape against the guard's allowlist. That was done for the rewrite: **no id-shaped token exists in any blob
reachable from the branch tip but not from `109ce4c`.**

**That proves absence ABOVE `109ce4c` only. It says nothing about the six older paths, which remain in the pushed
history.** And it cannot be extended to the outside world: **I cannot determine whether those blobs persist in
anyone's clone, in a fork, or in GitHub's unreachable-object storage.** A rewrite and a force-push would not
establish it either. Once a public remote has had an object for three months, the honest position is that it is
out, and the only questions left are who is told and what is rotated — not whether it can be recalled.

## 6. Suggested next steps, for the people who own the decision

- Decide between options 1 and 2 above, explicitly, and record the decision on this bus.
- Independently of that decision: confirm whether the ids in `tests/unit/c2-e2e-runner.test.ts`'s history belong to
  real clinicians and, if so, treat this as an identifier disclosure under whatever process Even uses — the
  document and fixture questions are separable and the fixture one is the sharper.
- Keep the guard. It is the only reason this was found at all, and it found it from a docs-only change that had
  been told it was not worth testing.
