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

## Fleet after rollout

`GET /api/admin/bench/fleet` http=200, 11:49:49Z. Install ids unchanged; OPD 1, OPD 4 still 0.1.8.
```
Home Office  install_539avu7gqzz5  0.1.19  test    ok  11:30:09Z
Room 4.1     install_d3sy3ufas8jv  0.1.19  test    ok  11:33:23Z
Cardiology   install_pgrped6322ss  0.1.19  stable  ok  11:46:13Z
OPD 3        install_fc2jt2zs4x8v  0.1.19  stable  ok  11:46:42Z
OPD 5        install_e3yjw3ut698x  0.1.19  stable  ok  11:47:02Z
OPD 6        install_d2nkvqcnqb7k  0.1.19  stable  ok  11:47:21Z
OPD 7        install_6m45w69ux7tj  0.1.19  stable  ok  11:47:42Z
```
