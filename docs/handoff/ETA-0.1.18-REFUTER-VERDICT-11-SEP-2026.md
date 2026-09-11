# ETA 0.1.18 REFUTER VERDICT — 11 Sep 2026

**ACCEPT `964e426`.** Fresh Opus session; I did not build it.

**Scope.** `5a36727..964e426`: six files — `RoomSelfUpdate.swift`, `RoomSelfUpdateTests.swift`, `build-bundle.sh` (two `-R` lines), `VERSION`, `CHANGELOG.md`, the R3-5 addendum. Nothing else.

**Suite.** `Test run with 544 tests in 44 suites passed`, exit 0 (CLT plugin flags; bare `swift test` cannot load `TestingMacros` here). HEAD's test file on `5a36727` source fails at `:565`, `:566`, `:579`, `:582`.

**Artifact.** sha256 `54c24dd5…84c9`, CDHash `4dbb2359…8212`, DR identical to 0.1.17. `strings`: `= certificate leaf = H"187dd424…8edb"`; `anchor trusted` absent from every file in the bundle. The swap script's `REQUIREMENT` renders from the same constant (`:1014`, `:1066`); render test passes.

**Room 4.1** (13:21 IST, `/tmp` only, cleaned up): sha256 and CDHash match. New: `explicit requirement satisfied`, `exit=0`. Old: `code failed to satisfy specified code requirement(s)`, `exit=3`.

**Adversarial.** Only `codesign` at `:885` and `:1162`; no `spctl`, `SecStaticCode*`, `SecTrust*` in `Sources/`. Not sandboxed, no quarantine key, relaunch via `launchctl bootstrap`. Helper DRs leaf-only.

**Flag.** Room 4.1's System keychain now holds the Even cert (kickoff: absent) — likely residue of the refused `add-trusted-cert`. Untrusted, harmless; removal is V's call.
