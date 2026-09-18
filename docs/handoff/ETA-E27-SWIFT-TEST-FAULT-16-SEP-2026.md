# ETA-E27 — Why `swift test` is green in one worktree and unbuildable in another · 16 Sep 2026 · Researcher (Builder pane)

Read-only round. No tracked file was changed, nothing was committed, and neither worktree's `.build` was cleared.
Every experiment ran in throwaway copies of the package under the job scratch directory, including a byte copy of
main's own `.build`. Main was read, never built in place. Process inspection was `pgrep -l` only.

## Item 2 — is "TestingMacros plugin not found" a `.build` product? NO. This closes the class.

- The plugin is a **toolchain file**: `/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib`
  (present, dated 26 Aug). `find` over both worktrees' `.build` trees returns **no** `TestingMacros` binary at all.
  Clearing `.build` cannot destroy it, and **no command regenerates it, because nothing generates it.**
- The failing compile is issued *without* the plugin. The failing `swift-frontend` invocation carries
  `-load-resolved-plugin …/plugins/libObservationMacros.dylib##ObservationMacros`,
  `-load-resolved-plugin …/plugins/libSwiftMacros.dylib##SwiftMacros` and
  `-in-process-plugin-server-path …/libSwiftInProcPluginServer.dylib` — **and no entry for the `testing/`
  subdirectory plugin.** The two top-level plugins resolve; the one in the `testing/` subdirectory is the only one
  missed. So this is a **build-planning failure in Swift Build** (SwiftPM 6.4's default `--build-system swiftbuild`),
  not a missing or stale artifact. UNVERIFIED: why planning drops that one entry; the omission is the observed fact.
- **`swift build` proves nothing about this path.** A clean `swift build` exits 0 and produces **zero** TapeCoreTests
  artifacts and zero macro-plugin use (`find … -iname '*TapeCoreTests*'` → 0). Test targets are only built by
  `swift test` (or `swift build --build-tests`). That is exactly why `swift build` is exit 0 in both worktrees while
  `swift test` differs.
- **It is intermittent, and the remedy is to rerun the same command.** Measured tonight on identical sources:
  - solo runs: **4 of 4 passed** (clean `.build` and incremental).
  - two concurrent runs: **4 of 6 individual runs failed** with this exact error, the other 2 passed.
  - main's own `.build`, copied to scratch and run alone: **fail, fail, pass** — the second failure's first error was
    `RoomSessionStoreTests.swift:14:15`, the same file and column scribe3 reported. Reproduced, then self-cleared.
  - So clearing `.build` is not the cure and never was; it only costs a full rebuild before the next dice roll.
- The deprecated `--build-system native` gives no comparison: it fails 4 of 4 with `no such module 'Testing'`, a
  different and deterministic limitation of that build system with this toolchain.

## Item 3 — the keywrapMismatch crash: environment fault wearing a test's clothes (with one honest caveat)

`RetainedArchiveRecoveryTests.swift:229` is not an assertion. It is a `try!` inside a **fixture accessor**,
`RolloverRecoveryFixture.oldControlJournalURL`, which force-tries `scanIncludingControls()` and then force-unwraps
`.first { … }`. The error it raised cannot identify its own cause: `ArchiveRetainedLaneCatalog.validateKeywrap`
(Sources/TapeCore/ArchiveRetainedLaneCatalog.swift:1356) ends with `catch { throw
ArchiveRetainedLaneCatalogError.keywrapMismatch }` — **every** error, including any I/O error reading `keywrap.eak`,
is relabelled as a keywrap mismatch. The fixture's roots are fresh UUID directories under `$TMPDIR`, and its
security provider is an in-test fake (`RecoverySecurityProvider`, line 632), so neither a leftover fixture at a fixed
path nor the login keychain is in play. The same sources passed 600/600 five times tonight, including from main's own
`.build` on the third run.

**Verdict:** it cannot be called a genuine keywrap defect on this evidence, and it is not a keychain problem. It is a
lossy error surfaced through a `try!` in a fixture. UNVERIFIED: which underlying error actually occurred in
scribe3's run — the error type destroys that information, and the run is gone. If it recurs, the way to learn
anything is to make that `catch` carry its underlying error; that is a fix, and out of scope here.

## Item 1 — what differs between the worktrees: nothing that explains it

- Sources: `diff -rq --exclude=.build` between `-e16` and main's `apps/room-recorder` reports **no differences**.
- Toolchain: one only. `swift-driver 1.168.6, Apple Swift 6.4 (swiftlang-6.4.0.34.1)`, `xcode-select -p` =
  `/Library/Developer/CommandLineTools`, **no Xcode.app installed**, `TOOLCHAINS` and `DEVELOPER_DIR` unset.
- Dependencies: the package declares none. There is **no `Package.resolved`**, so there is no version to differ, and
  swift-testing comes from the toolchain.
- Per-worktree SwiftPM config: none. No `.swiftpm` directory in either worktree; the shared
  `~/Library/org.swift.swiftpm` holds only `configuration` and `security`; `~/Library/Caches/org.swift.swiftpm` holds
  only `manifests`.
- Build system: both default to `swiftbuild` (`swift package --help`: `default: swiftbuild`), and both `.build` trees
  have the Swift Build layout (`out/Products`, `out/Intermediates.noindex`).
- The only difference is `.build` size and contents: 475M in `-e16` (which had run `swift test`, so it holds test
  products) against 388M in main (which had run `swift build` only). That difference is a *consequence* of which
  command last ran, not a cause.
- Not a worktree property at all: the same package at a third path reproduced both outcomes within three runs.

## Item 4 — are the two faults related? No. Two independent problems.

The macro fault is a **build-time planning flake** in Swift Build: the test target compiles without the toolchain's
testing macro plugin, so no test binary exists. The keywrap trap is a **runtime** `try!` in a fixture, reachable only
when the build succeeded. They cannot both be present in one run, which is why clearing `.build` in main "swapped
one fault for another": the clear forced a full re-plan, which lost the dice roll, and the crash simply became
unreachable. The only thing they share is that a rerun made each go away, which is what made them look like one
problem. UNVERIFIED: whether the keywrap trap has a common root with anything else; one occurrence, no artefacts.

## What would close each one (not done here, by order)

- Macro fault: report the Swift Build planning omission upstream with the flag evidence above; in the gate, treat
  `plugin for module 'TestingMacros' not found` as "rerun `swift test`", never as "clear `.build`", and never accept
  a green `swift build` as evidence that the Swift tests build.
- Keywrap trap: make `validateKeywrap`'s final `catch` carry the underlying error, and replace the fixture's `try!`
  with a failure the harness can report. Then the next occurrence names its own cause.
