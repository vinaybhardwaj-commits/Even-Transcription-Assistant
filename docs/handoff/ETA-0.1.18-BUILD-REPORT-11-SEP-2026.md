# ETA 0.1.18 BUILD REPORT — drop `anchor trusted` — 11 Sep 2026

**Commit.** `964e426` room-recorder: 0.1.18 — the self-update verifier pins the leaf alone. Local on `vinay/release-b1`; origin is still `5a36727`.

**Gate.** `swift test`: `Test run with 544 tests in 44 suites passed` (543 at `5a36727`, plus one new test). `npm test`: `Tests 1572 passed`. `typecheck` and `build`: exit 0.

**Files.** `VERSION`, `build-bundle.sh` (the two `-R` lines only), `RoomSelfUpdate.swift`, `RoomSelfUpdateTests.swift`, a new `CHANGELOG.md`, and the R3-5 addendum. Nothing else moved.

**Fail → pass.** With the modified test file on `5a36727`, `theSignatureCheckPins…` fails at `:565`–`:566` and the new `theRenderedSwapScriptVerifiesAgainstTheLeafOnlyRequirement` at `:579`/`:582`. Both pass at HEAD.

**Room 4.1** (EHRC-DISCUSSION, macOS 15.7.9; V ran it in Terminal at 13:10). The zip's sha256 matched; step-6b command on the `ditto`-unpacked copy:
```
== NEW requirement (leaf only)      … explicit requirement satisfied   exit=0
== OLD requirement (anchor trusted) … test-requirement: code failed to satisfy specified code requirement(s)   exit=3
cleanup: /tmp/rr-0118 and /tmp/rr-0118.zip are gone
```

**Artifact.** `apps/room-recorder/.build/release-bundle-0.1.18/EvenScribe-Room-Recorder-0.1.18.zip`
- sha256 `54c24dd5bd561d56c5e4a3211402bacdb2cb1ba6c04a0e234fca4c6d869784c9`
- CDHash `4dbb2359de98abf87fc391071bccf95d05b98212`
- DR identical to 0.1.13/0.1.17: `identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"`
- No `anchor trusted` string in the binary. Not published.

**Dirty tree.** Built with `ETA_ALLOW_DIRTY_BUILD=1`. Only `CLAUDE.md` and `docs/handoff/` are dirty; nothing under `apps/`.

**Schema assumptions.** None. No SQL.

**Flags.**
- Built by Opus, not Sonnet, in the session that refuted 0.1.17. The Refuter must be a fresh session.
- `CHANGELOG.md` is new; no release-note file existed under the app.
- Class-level R3-5 comment kept; the new reasoning is on `pinnedRequirement`.
- `build-bundle.sh:231` still says "pinned to our anchor"; left per the script rule.
- `set-key-partition-list` refused the passphrase; signing worked anyway.
- Room 4.1 got the zip plus `ditto`, not the `.app`.

**Manual steps.** None. **Subagents.** None.
