# ETA KICKOFF — 0.1.18 "The verifier must not need the Mac's trust store" — 11 Sep 2026, 13:10 IST

Builder brief for Claude Code on the Mini (Sonnet). Refuter (Opus, a fresh session) runs after. Orchestrator: Fable (Cowork).
V ratified option A at 13:05 IST. Nothing publishes to any channel without V.

## Goal
A clinic Mac must accept a self-update signed with the Even certificate without anyone clicking a trust dialog on its screen.
After 0.1.18, the fleet never again depends on per-Mac trust settings, the login keychain, or a partition step.

## Known facts (verified 11 Sep, 12:30–13:00 IST)
- `RoomSelfUpdate.pinnedRequirement` (`RoomSelfUpdate.swift:50`) is
  `= anchor trusted and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"`. It is used by the app's step 6b verify
  (`:874`) and rendered into the swap script (`:1000`). `RoomSelfUpdateTests.swift:563` asserts the `= anchor trusted` prefix.
  `Packaging/build-bundle.sh:236` and `:273` carry the same literal for the packaging-time verify.
- The certificate is SELF-SIGNED: `CN=EvenScribe Room Recorder Code Signing 1, C=IN`, subject = issuer, SHA-1 `18:7D:D4:24:…:9E:DB`
  (extracted from the resident bundle on the Mini, 12:51 IST). The leaf therefore IS the anchor; the leaf-hash clause already pins
  the exact certificate.
- On Room 4.1 (CONSUL-DISCUSSION, 0.1.8 resident): `codesign --verify --strict --deep -R "<full requirement>"` on its OWN bundle →
  `code failed to satisfy specified code requirement(s)`; the same with the `anchor trusted` clause removed → pass; Even cert not in
  the System keychain. The live 0.1.17 offer on `test` failed there at 12:45 IST with
  `update to 0.1.17 stopped: signature_mismatch: the downloaded app was not signed by Even` (ledger: 1 failure on that Mac).
- `sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain` over SSH →
  `SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible.` Not fixable remotely.
- 0.1.17's `enrol` writes `room-session.json` only (`RoomEnrolment.swift:79` → `RoomSessionStore.save`, which never touches the
  keychain, B1.5-D4). A bootstrap that ships a 0.1.17-line build therefore enrols over SSH with no keychain unlock and needs no
  partition step. Bootstrap ships `latestRelease("stable")` (`lib/room-install.ts` ~567).
- HEAD `5a36727` (0.1.17, ACCEPTED by the Refuter 11:49 IST, on origin). `apps/room-recorder/Packaging/VERSION` = 0.1.17.
  Next version string: **0.1.18**. Releases: `test` 0.1.17 `rel_7be2fv7s62x9`; `stable` 0.1.8 `rel_nz8d8uh5q9pj`.
- Signing over SSH: `security unlock-keychain ~/Library/Keychains/login.keychain-db` then
  `security set-key-partition-list -S apple-tool:,apple: -s ~/Library/Keychains/login.keychain-db`, password at the prompt (rule 4).
  V unlocks; never put a password in a transcript.

## Exact scope (four edits, app + packaging only)
1. `RoomSelfUpdate.pinnedRequirement` → `= certificate leaf = H"\(pinnedLeafSHA1)"`. Rewrite the doc comment above it: keep the
   "leading `= ` is load-bearing" paragraph; replace the R3-5 paragraph's reasoning with why `anchor trusted` is gone (self-signed
   leaf = anchor; trust settings cannot be set without a console click; 11 Sep evidence above). The R3-5 property — the expected
   signer is compiled in, never served — is unchanged and must still be stated.
2. `Packaging/build-bundle.sh:236` and `:273` → the same leaf-only literal, so the packaging verify and the app verify are one
   string. Do not change anything else in the script.
3. `RoomSelfUpdateTests.swift:563` → assert `hasPrefix("= certificate leaf")` and, new, assert the string does NOT contain
   `anchor trusted`. Add one test that the rendered swap script embeds the leaf-only requirement (find the existing swap-script
   render test and extend it, or add beside it).
4. `apps/room-recorder/Packaging/VERSION` → `0.1.18`. Release note under the app: "0.1.18 — self-update verifier no longer requires
   the Mac to trust the signing certificate; leaf pin unchanged."
Also write `docs/handoff/ETA-INSTALL-AND-FLEET-PRD-R3-5-ADDENDUM-11-SEP-2026.md` (≤ 200 words): R3-5 amended — the pinned
requirement is the leaf hash alone; rationale = the three facts above; what is unchanged (sha256, size, `--strict --deep`, DR).

Out of scope: any other change to the update, swap, canary, hold, enrol or session code; server routes; the bench card.

## Allowed changes
The four files above, the release note, the addendum. Nothing else.

## What to verify (Builder runs; Refuter reruns)
- Full app suite passes; report the count (543 at `5a36727`).
- The modified test fails at `5a36727` (prefix assertion) and passes at HEAD.
- Build + sign with `Packaging/build-bundle.sh` (V unlocks the keychain first; if the tree is dirty only in `CLAUDE.md` /
  `docs/handoff/`, `ETA_ALLOW_DIRTY_BUILD=1` is acceptable — say so). Then, on the produced bundle:
  `codesign --verify --strict --deep -R '= certificate leaf = H"187dd…"'` → pass;
  `codesign -dr -` designated requirement identical to 0.1.13/0.1.17; print the CDHash and sha256.
- **The decisive test, on a clinic Mac, without offering anything:** copy the built bundle to Room 4.1 (`ehrc-discussion@100.109.240.30`,
  `scp` to `/tmp/rr-0118/`) and run the app's exact step-6b command there against that copy:
  `codesign --verify --strict --deep --verbose=4 -R '= certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"' "/tmp/rr-0118/EvenScribe Room Recorder.app"; echo exit=$?`
  → `exit=0`. Then the same with the OLD requirement (`= anchor trusted and …`) → non-zero. Delete `/tmp/rr-0118` afterwards. This
  is the proof that the new verifier passes where the old one failed, on the Mac that failed at 12:45.
- Home Office: do NOT publish. Stage the artifact and stop.

## Do not
- Do not publish 0.1.18 to any channel; V orders it after the Refuter.
- Do not touch Room 4.1's resident app, LaunchAgent, config or session file; `/tmp` only.
- Do not push; commit locally on `vinay/release-b1`.
- Do not widen the requirement further (no `anchor apple generic`, no team id) and do not remove the sha256/size/`--strict --deep` steps.

## Output
`docs/handoff/ETA-0.1.18-BUILD-REPORT-11-SEP-2026.md`, cap 300 words: commit sha + one line; test counts before/after; the
fail→pass evidence for the modified test; the Room 4.1 exit codes (new requirement 0, old non-zero); codesign DR, CDHash, sha256,
artifact path; dirty-tree finding. Chat reply: commit sha, test count, CDHash, artifact path, deviations only.

## Refuter brief (fresh Opus session, after the Builder)
Read the diff only (`git diff 5a36727..HEAD`). Confirm exactly the four files + note + addendum moved. Rerun the suite. Rebuild
nothing; verify the staged artifact: DR unchanged, CDHash matches the report, `strings` shows the leaf-only requirement and NOT
`anchor trusted` in the binary AND in the rendered swap script (run the render test, or grep the test output). Repeat the Room 4.1
`/tmp` verify yourself (both requirements, exit codes). Adversarial read: is there any other place a trust-store lookup can occur
in the update path (`spctl`, `SecStaticCodeCheckValidity` with `kSecCSCheckAllArchitectures`… anything that consults trust)?
Quote lines. Verdict ACCEPT / REJECT + failing line, cap 200 words, to `ETA-0.1.18-REFUTER-VERDICT-11-SEP-2026.md`.

## Rollout after ACCEPT (V orders each step; written here so the Builder knows what it must not do)
1. Publish 0.1.18 to `test` → Home Office takes it (proves the swap path on the trusting Mac; nothing about anchor).
2. Publish 0.1.18 to `stable` (second blob key). The 0.1.8 fleet will attempt it, fail on `anchor trusted` in THEIR verifier,
   roll back and hold — expected, harmless; they are replaced in step 3.
3. Re-enrol each SSH room from the desk with a fresh bootstrap paste from its card (bootstrap now ships 0.1.18; enrol writes the
   session file only; no keychain unlock, no partition step). Order: Room 4.1, OPD 6, OPD 5, OPD 3, Cardiology. Verify each:
   `launchd.log` `microphone authorized`, `config.json` new install id, `scribe_diff_room` listening, app 0.1.18.
4. OPD 7 / OPD 4 / OPD 1 at their walks: the walk paste is the bootstrap paste; nothing else.
5. The next release after 0.1.18 is the first true clinic self-update. Its acceptance = one clinic Mac swapping unattended.
