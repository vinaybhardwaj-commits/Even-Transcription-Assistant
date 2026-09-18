# ETA FLEET C3 — why OPD 1 and OPD 4 cannot self-update — 16 Sep 2026

Lane 2, fleet cluster 3. Researcher, read-only. No code changed, no commit, no Mini touched, no Swift build or test run.
Read at `vinay/s1-auto-drain` HEAD `64ce357`. This file is uncommitted.

## 1. Where `signature_mismatch` is produced

`apps/room-recorder/Sources/RoomRecorderCore/RoomSelfUpdate.swift:922`, the step-6b guard:

```swift
let verified = runner.run("/usr/bin/codesign",
  ["--verify", "--strict", "--deep", "--verbose=4", "-R", RoomSelfUpdate.pinnedRequirement, stagedApp.path])   // :915–:920
guard verified == 0 else { return stop(.signatureMismatch, "the downloaded app was not signed by Even") }        // :921–:922
```

The raw value is at `:215` (`case signatureMismatch = "signature_mismatch"`). What gets compared: the code signature of the
downloaded, `ditto`-expanded bundle, checked against **the requirement string compiled into the RUNNING app**.
Nothing on the server takes part in this check. The release route serves only the blob URL, size and sha256 (R3-5, `:27–:31`).

## 2. Why 0.1.8 refuses 0.1.21: CONFIRMED cause

**The 0.1.8 binary compiles in `= anchor trusted and certificate leaf = H"187dd424…8edb"`. Every build from 0.1.18
onward is signed by that same leaf, but the leaf is a self-signed certificate that OPD 1's and OPD 4's trust settings do not
trust. So the `anchor trusted` clause fails on those Macs, and `codesign` exits non-zero (exit 3 when reproduced).**

The evidence, all read from git:
- `pinnedRequirement` at every VERSION bump (`git show <sha>:…/RoomSelfUpdate.swift`):
  0.1.8 `b11518d` through 0.1.17 `5a36727` → `= anchor trusted and certificate leaf = H"\(pinnedLeafSHA1)"`;
  0.1.18 `964e426` through 0.1.22 `40ab2bd` → `= certificate leaf = H"\(pinnedLeafSHA1)"`.
  Three commits carry VERSION 0.1.8 (`b11518d`, `4a782a1`, `7d21f5e`; `bf984a8` bumps to 0.1.9). All three have the
  `anchor trusted` form, so whichever one OPD 1 and OPD 4 were built from, the result is the same.
- The requirement is a `static let` in each of those trees. No served value reaches it, so the server cannot change what a
  0.1.8 install demands.
- The failure is at step 6b, so the earlier steps passed on those Macs: the release row parsed, the size matched (`:869`),
  the sha256 matched (`:888`), and `ditto` expanded the bundle (`:896`). That rules out a changed manifest format and a
  corrupted archive.
- 0.1.18's own report (`ETA-0.1.18-BUILD-REPORT-11-SEP-2026.md`) reproduced the split on Room 4.1, which was then
  running 0.1.8: the leaf-only requirement gave `exit=0`; `anchor trusted and …` gave
  `code failed to satisfy specified code requirement(s)`, `exit=3`.
  Room 4.1 also refused the 0.1.17 offer with this exact string at 12:45 IST on 11 Sep.

Candidates ELIMINATED:

| Candidate | Verdict | How I know |
|---|---|---|
| Signing identity or team changed | No | `pinnedLeafSHA1 = "187dd424fb866204111113d60c6f88a21d098edb"` is the same in every tree from `b11518d` to HEAD. `build-bundle.sh:35` `SIGNING_IDENTITY` is the same hash at 0.1.21 `5af9075`. There is no team id: the certificate is self-signed. The 0.1.18 and 0.1.19 reports record the designated requirement as identical to 0.1.13/0.1.17. |
| Public key pinned in 0.1.8 and later rotated | No | Same as above: the leaf was never rotated. |
| Manifest/appcast signed with a key the client lacks | No | Nothing signs the manifest. `release.json` carries sha256, size and `identity_sha1` (`build-bundle.sh:280–:288`), and the client never reads a signer from the server (R3-5). |
| Manifest format changed | No | Step 6b is reached only after the release parsed, downloaded, size-checked, hash-checked and expanded. |
| Archive signed but manifest not, or the reverse | Not a cause | That split is by design and has held since 0.1.8. It does not explain a 0.1.8-only refusal. |
| **`anchor trusted` evaluated against this Mac's trust store** | **YES** | See above. It was removed in 0.1.18, which is why 0.1.18+ clinic Macs update and 0.1.8 Macs do not. |

UNVERIFIED on OPD 1 and OPD 4 themselves: I could not read their `update.log` or run `codesign` there (no SSH, by order). The
mechanism follows from source that cannot vary between Macs, plus the Room 4.1 reproduction on the same 0.1.8 build.
Confirming it on the room needs the two Room 4.1 commands run there by hand (§4).

## 3. Does 0.1.21 refuse 0.1.22 the same way? No. The break is specific to 0.1.8–0.1.17.

- 0.1.21 (`5af9075`) compiles in the leaf-only requirement. That requirement asks no question of the Mac's trust store.
- `build-bundle.sh` signs with `SIGNING_IDENTITY` = the pinned leaf and verifies the packaged zip against the same
  leaf-only string, `--deep` (`:235–:236`, `:272–:273`). If that fails, no zip and no `release.json` are produced. So any 0.1.22+
  built by this script satisfies a 0.1.18+ verifier.
- Field proof that the leaf-only verifier works on untrusting clinic Macs:
  - Room 4.1 self-updated 0.1.18 → 0.1.19 unattended, 11 Sep 11:33:23Z (0.1.19 report).
  - Six clinic Macs went to 0.1.20 with install ids unchanged (B2-A report). A re-enrol would have minted new ids.
  - Room 4.1, OPD 3, 5, 6 and 7 went to 0.1.21 between 15:27 and 15:30Z (R4-A report).
- Two things could still break it for every version, not only for 0.1.8: rotating the signing certificate, or its expiry on
  4 Sep 2036 (`RoomSelfUpdate.swift:37–:38`). A leaf pin cannot survive a new leaf; the code comment prices that at one
  re-paste per Mac.

## 4. The minimal unblock

**(a) Pipeline side: nothing can unblock 0.1.8.** The 0.1.8 check is `anchor trusted AND leaf = 187dd…`, both at once.
A bundle whose leaf is 187dd… has itself as its anchor, because the certificate is self-signed, so its anchor is trusted only
if that Mac trusts the certificate. Signing with an Apple-rooted certificate would satisfy `anchor trusted`, but then the leaf
clause fails. No signing choice, manifest change or server response satisfies both clauses on a Mac that does not trust
the certificate. Holding stable, withdrawing, or re-publishing changes nothing for these two rooms.

**(b) Per room: 2 rooms, OPD 1 and OPD 4.** Every other room (Room 4.1, Cardiology, OPD 3, 5, 6, 7, Home Office) is already on
the leaf-only line and needs no hands. For those rooms this is a pipeline problem, not a site-visit problem. Pick one action
per room:

- **Option 1: the bootstrap re-paste.** This is the path the 0.1.18 kickoff already ruled for these two rooms ("OPD 7 /
  OPD 4 / OPD 1 at their walks: the walk paste is the bootstrap paste").
  1. Mint a token on the room's card.
  2. On the Mac, as the logged-in user, run `curl -fsSL "<origin>/api/room-recorder/bootstrap/<token>" | bash`
     (`lib/room-install.ts:172`).
  3. The script (`lib/room-install.ts:540–:589`) checks the sha256, runs `launchctl bootout`, replaces
     `~/Applications/EvenScribe Room Recorder.app` with current `stable`, runs `enrol`, `install-launch-agent`, and
     `launchctl bootstrap`.
  4. The script does not run `codesign -R`, so `anchor trusted` never comes into it. Since 0.1.17, `enrol` writes
     `room-session.json` only, so no keychain unlock is needed.
  5. It needs a shell on the Mac: SSH, or Terminal at the console.

  **OPD 4 needs a site visit**: no Tailscale, SSH closed (S5). **OPD 1: whether it can be done remotely is UNDETERMINED**:
  the bug list does not say whether OPD 1 has SSH, and I was ordered not to try. The 11 Sep carryover lists both rooms as walks.
- **Option 2: trust the certificate at the console, then let the updater run.** Trust changes cannot be made over SSH ("no user
  interaction was possible", 0.1.18 kickoff). This keeps the install id. It is a policy choice (flag 2).

Before either option, the confirming check on the room (hands, read-only):
`codesign --verify --strict --deep -R '= anchor trusted and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"' "$HOME/Applications/EvenScribe Room Recorder.app"; echo exit=$?`
→ expect non-zero. Then the same command with `= certificate leaf = H"…"` → expect `exit=0`.

## 5. Flags: policy choices for V, not decided here

1. **The bootstrap paste is the weaker channel.** It runs `curl | bash` from our origin and checks only a sha256 that the same
   origin serves. No signer pin runs, and `curl` sets no quarantine attribute, so Gatekeeper does not check it either. It is
   already the ruled walk path. Using it means trusting the server and the TLS session for those two installs, once.
2. **Option 2 (console trust) reverses the 0.1.18 ruling** that the fleet "never again depends on per-Mac trust settings". It
   also marks a self-signed code-signing certificate as trusted on that Mac. Any code signed by that key would then pass
   `anchor trusted` checks there, not only ours.
3. **Any "skip the signature check" switch is not available for 0.1.8.** The requirement is compiled in, so a server flag
   cannot reach it. Adding such a switch to future builds would undo R3-5: a compromised publish or server could run
   arbitrary code on every clinic Mac that records patient audio. I recommend against it; the ruling is V's.
4. **Re-enrol mints a new install id.** The old row is retired, so OPD 1's and OPD 4's fleet history splits at the re-paste.
   That was already accepted for the other five SSH rooms on 11 Sep.

## 6. Adjacent facts found on the way that bear on delivering PR #3 (not asked, not acted on)

- PR #3 is `origin/cursor/piece-pipeline-pipe-close-6a9c`. It touches `MachineFacts.swift`, `PiecePipeline.swift`,
  `RoomEngine.swift`, the new `RoomSubprocess.swift` and `CHANGELOG.md`. It does not touch the verifier or packaging, so it
  does not reopen this break.
- **PR #3 still says `VERSION` 0.1.22**, the same string as the leaky Home Office build. The updater offers when
  `running != offered` (`RoomSelfUpdate.swift:590–:596`). A PR #3 build stamped 0.1.22 would therefore never be offered to
  Home Office, which already runs 0.1.22. It needs a VERSION bump before release.
- `ETA-TIER1-ROLLOUT-12-SEP-2026.md:62`: a 0.1.21 app applies only `stable`. Assigning `test` requires ≥0.1.22 on the Mac.
  So PR #3 can reach the 0.1.21 clinic rooms remotely only through `stable`, not through a `test` assignment.

## What I could not determine
- OPD 1's remote reachability (SSH/Tailscale) and the exact 0.1.8 commit on each room: both need the Mac.
- `update.log` / `update-result.json` on OPD 1 and OPD 4. The mechanism is inferred from source plus the Room 4.1 reproduction,
  not read off those Macs.
- Whether user-domain trust (not `-d`) can be set without a console prompt. I believe it cannot, but that is UNVERIFIED.

## Subagents
None.
