# ETA 0.1.19 BUILD REPORT — first clinic self-update — 11 Sep 2026

**Commit.** `da58a4c` room-recorder: 0.1.19 — first clinic self-update. Local on `vinay/release-b1`; not pushed.

**`git diff 964e426..HEAD --stat`:** `CHANGELOG.md` +1, `VERSION` 1/1, `build-bundle.sh` 1/1 (`:231` heading, 95 chars both sides), 0.1.19 kickoff +116, 0.1.18 verdict +15 (`faafd04`, already local). Nothing else.

**Gate.** `swift test` (CLT flags): `Test run with 544 tests in 44 suites passed`. `npm test`: `Tests 1572 passed`. `typecheck`, `build`: exit 0.

**Artifact** `apps/room-recorder/.build/release-bundle-0.1.19/EvenScribe-Room-Recorder-0.1.19.zip`
```
codesign --verify … -R '= certificate leaf = H"187dd424…8edb"'  explicit requirement satisfied   exit=0
codesign -dr -   identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"   exit=0  (= 0.1.18)
CDHash=6bdbbb2b91d073211cfdf6e378d54046823c59a7   exit=0
CFBundleShortVersionString 0.1.19   exit=0
strings … | grep -c 'anchor trusted'   0   exit=1 (no match)
shasum 727fe4ac0e9f53a4206d70b04b39f0c9650156d58cc3bfc42eb6fb696a21056e = release.json   exit=0
```
`size_bytes` 3964651; `release.json.version` 0.1.19, `build_sha` da58a4c. Not published.

**Dirty tree.** `ETA_ALLOW_DIRTY_BUILD=1`; `git status --short` shows only `CLAUDE.md` and `docs/handoff/`; nothing under `apps/`.

**Deviations.**
- Committed kickoff only; this report and the verdict postdate the commit.
- Built by Opus (the 0.1.18 Refuter session), not Sonnet.

**SQL / manual steps / subagents.** None.
