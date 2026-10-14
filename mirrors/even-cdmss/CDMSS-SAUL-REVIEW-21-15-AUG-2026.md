# Saul review 21

**Recorded 15 August 2026, verbatim, from V's transcript. Not edited.**

Governs: commit D and the governance repair. Recorded in addendum v10.

---

**Ruling 1**
The correction is accepted. My earlier remedy named the wrong transport mechanism.

The deterministic fallback already delivers the latest handle through `onLifecycleHandleUpdated`; only the role-keyed defect map is lost. Do not wrap line 1723 with `withHandle`.

Approve commit D with these requirements:

- Add a trailing optional `manifestDefectsByRole` argument to `onLifecycleHandleUpdated`.
- Declaration publications pass no map.
- Terminal publications pass shallow snapshots of the map known at that moment.
- Owners prefer the final attached map, then the callback-captured map.
- If neither exists, preserve `undefined`; remove every owner-side `?? {}`.
- A provided map missing the run's own key settles a linkable clean run as partial.
- No map remains backward-compatible and clean.
- An explicit own-role `[]` remains clean.
- Revision-zero roles continue through `stateForUnwrittenRun` and are never linked by this rule.
- Use own-property checks so inherited keys do not count.
- Keep the deterministic fallback return and its three source pins unchanged.

Sections 5.1 and 5.2 should land in one commit. Callback plumbing could technically land first, but the missing-key rule must never be deployable or cherry-pickable without the plumbing.

The file contract may include a comment-only correction in `lib/retrieval-telemetry-store.ts`; its current statement that a missing key and `[]` both settle clean becomes false.

**Ruling 2**
The grouped form stands.

Keep all DROPs followed by all ADDs within one `ALTER TABLE` per table. PostgreSQL executes ALTER subcommands in internal passes, with constraint drops before additions regardless of textual interleaving. The grouped form reflects that behavior more accurately.

The valid claim remains:

> Each table's constraint replacement is atomic.

Do not claim that the entire 23-statement migration route is transactional.

**Ruling 3**
The third test file belongs in commit C.

`lib/__tests__/retrieval-telemetry-core.test.ts` had to change because collapsing three constraints into one statement invalidated its semicolon-based extraction boundary. The balanced-parenthesis replacement preserves the original assertion and strengthens it against sibling-constraint leakage.

Do not remove it, split it out, or rewrite commit C. Record a narrow erratum stating that v9 section 8 omitted this induced test adaptation.

**Ruling 4**
Do not edit or sign v9 after the fact. Use a signed v10.

V9 must remain byte-identical, explicitly unsigned, at:

```text
commit  9e04cf1052a8373102374068f691826eb204e09e
SHA-256 08ab334d434084cfa3259f38babe2a8d5bc0b3b6cbf94b3790ad58d5a989efbb
```

V10 should:

1. Preserve v9's unsigned chronology.
2. State that v9's text preceded B and C but was not prospectively signed.
3. Retrospectively ratify B `f21dd7e` and C `f8b7c13` without backdating them.
4. Record the grouped-SQL ruling and the section 8 test-file erratum.
5. Record the callback and missing-key rulings above.
6. Prospectively authorize commit D only.
7. Authorize no deploy, migration, canary, ranking change, or Cohere change.
8. Carry an exact V acceptance timestamp and a normal `.gitignore` exception.
9. Record v9's unchanged hash/blob and v10's final SHA-256 in the governance commit message.

**Sequence**
1. Write and have V sign v10.
2. Commit v10 and its `.gitignore` exception only.
3. Begin commit D only after that governance commit.
4. Land all callback delivery, owner selection, missing-key semantics, comments, and tests together.
5. Run the complete gate.
6. Continue to the twenty hard proofs and four executable explicit-judge proofs.

Commits B and C stand unchanged. Current verified HEAD is clean and synchronized at `f8b7c13`. No files were modified during this review.
