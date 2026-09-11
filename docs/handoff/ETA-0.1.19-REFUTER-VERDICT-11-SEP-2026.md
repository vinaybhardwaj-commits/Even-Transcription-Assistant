# ETA 0.1.19 REFUTER VERDICT — ACCEPT `da58a4c` — 11 Sep 2026

**Diff.** `git show --stat da58a4c`: `CHANGELOG.md` +1, `VERSION` 1/1, `build-bundle.sh` 1/1, 0.1.19 kickoff +116. `964e426..HEAD` adds only `faafd04`'s 0.1.18 verdict. `build-bundle.sh` has one `-`/`+` pair at `:231`, both starting `# ───`, 95 chars each side.

**Suite (mine).** `Test run with 544 tests in 44 suites passed`, exit 0 (CLT plugin flags).

**Artifact** (zip unpacked with `ditto -x -k`, temp dir deleted):
- leaf-only `codesign --verify --strict --deep -R …`: `explicit requirement satisfied`, exit=0
- `codesign -dr -`: `identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"`, exit=0
- `CDHash=6bdbbb2b91d073211cfdf6e378d54046823c59a7`, exit=0
- `CFBundleShortVersionString` `0.1.19`, exit=0
- `anchor trusted` in room-recorder, tapewriter, ffmpeg: 0 each, `/usr/bin/grep` exit=1
- zip sha256 `727fe4ac…056e` = `release.json`; version `0.1.19`, build_sha `da58a4c`, size 3964651

**Flags.** Kickoff said 96 columns; both sides are 95, width unchanged. Report and verdict uncommitted, as declared.
