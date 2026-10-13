# CI debt

Tests skipped in CI so main stays green. Each line: file, why it fails, owner. Remove the `--exclude` in `.github/workflows/ci.yml` when fixed.

Failing on main since 1 Oct 2026 (last green: 22 Sep 2026). Owner: gating-lead (no individual author identified).

| File | Failure (one line) |
|---|---|
| tests/unit/diarize-dispatch.test.ts | source-scan guard: "no bare 300000 literal anywhere else in the source" |
| tests/unit/e18-silence-is-evidence.test.ts | source-scan guard: WRITE-scope tool "and nothing schedules it" |
| tests/unit/encounter-shadow.test.ts | source-scan guard: readers of encounter_hypothesis_run must go through the helper |
| tests/unit/no-identity-literals.test.ts | tree-wide scan finds a hard-coded person in a test-like file |
| tests/unit/room-install-update.test.ts | 2 tests: failed-update sentence not rendered in the App cell |
| tests/unit/voice-console-pg.test.ts | needs real postgres (docker); environment-bound |
