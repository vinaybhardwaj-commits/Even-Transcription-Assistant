# ETA orchestrator memory — dateless, updated in place

Workflow rules and lessons for the orchestrating thread. Project facts live in the newest
`ETA-CARRYOVER-PROMPT-*-EOD-MASTER.md`, which is canonical for those. This file is canonical for how
to work the line.

## Where things are

- **The bus is the repo's own `docs/handoff/` on the Mini**, `~/dev/Even-Transcription-Assistant`.
  There is no `eta-handoff` folder on either machine. Mirror to `Daily Dash EHRC/ETA/` on iCloud.
- The Air's clone of the repo is chronically stale. Read `origin/feat/room-recorder` or the Mini.
- `/Volumes/MiniDev` must be requested each thread. `ReadMini` MCP is the fallback when it is down.
- Read git over the share with `--git-dir` and `--work-tree`. **Never run a git command that writes.**

## Rules learned the hard way

1. **Sweep the bus for existing ratified documents BEFORE writing a kickoff.** On 9 Sep a full R3
   kickoff was written from PRD §7 alone while a ratified §13 addendum and an approved mockup delta sat
   in the same folder. The draft contradicted them in eight places. One `ls | grep <topic>` would have
   caught it.
2. **A file on neither the editable list nor the untouched list is a spec gap.** The builder honours
   "edit ONLY these" and leaves it. That is how R3 shipped a route that dropped its own six new poll
   fields. Every kickoff's file contract must be exhaustive along the whole data path: app → route →
   lib → migration → view → component.
3. **Test the wire, not just the layer.** The R3 tests proved `applyInstallPoll` and left the route
   unproven, which is exactly where the break was. Require at least one test that drives the route.
4. **Signing over SSH works once V unlocks the keychain himself.** `security unlock-keychain
   ~/Library/Keychains/login.keychain-db` then `security set-key-partition-list -S apple-tool:,apple: -s
   <same path>`, password typed at the prompt, never in a transcript. The "console only" rule (8 Sep) is
   retired 10 Sep. The 45 `swift test` failures are NOT the keychain: they are `RoomEngine.swift:517`
   `needsEnrolment` — tests that hit the Mini's real keychain, which is not an enrolled room. Fixture bug,
   fixed in B1-5 (535 tests, 0 issues, 10 Sep).
5. **Verify the decisive defect yourself.** Refuters are delegated; verdicts are not. On 9 Sep the
   build-stopper was confirmed by reading the route by hand before the verdict went out.
6. **Re-running gates over the Samba share does not work for `npm test`** — the tree's `node_modules`
   is a macOS install and the review shell is Linux. Say "unverified", never assume the report.
7. **Call `scribe_diff_room` once per room, naming the room.** All-rooms sweeps have misattributed
   values between rooms. Subagent arithmetic on timestamps has also been wrong twice; keep the raw
   fields, discard the derivations.
8. **Kickoff files land untracked in `docs/handoff/` and the builder commits them with the work.** A
   pre-flight that demands a wholly clean tree is wrong; it must expect exactly those files.
9. **Restate normative literals from the source, not from prose.** The kickoff's `codesign -R` literal
   omitted the leading `= ` that `build-bundle.sh` has always used. Without it codesign reads the
   argument as a filename and verifies nothing.
10. **A release on the branch is not a release in production.** Migrations run from the deployed code; a
    migration on an unpushed branch cannot run. Push → preview → `vercel promote` BEFORE publishing an app
    that needs the server side. Missed on 10 Sep, caught at the migration step.
11. **Each re-offer needs a new version string.** `(version, channel)` is unique including withdrawn rows, and
    `blob_url` is unique, so a second channel needs a second upload key. Acceptance burns versions.
12. **The Mac Mini is Home Office.** Room edits "on Home Office" run in the Mini's own shell.
13. **House naming wins over any generic template.** This programme numbers builds
    `ETA-INSTALL-BUILD-R<N>-KICKOFF-<D>-<MON>-<YEAR>.md`. Match the series that already exists.
14. **Two gates guard a login-keychain item: the partition list (cdhash) and the ACL (designated requirement).**
    The partition list is fixable over SSH (`security set-generic-password-partition-list`, password at the
    prompt). The ACL admits only our signed app, never the `security` tool: `find-generic-password -w` fails with a
    silent `exit=36`. Never read the token from outside the app. Migrate by admitting the new build's cdhash and
    letting the build read the keychain once (`RoomSessionStore.swift:138` writes the file). Runbook v2.
15. **The swap script logs to `update.log`; the app logs to `launchd.log`.** A watcher keyed on the wrong file
    armed `break-on-launch` and never disarmed it (10 Sep). `break-on-launch` binds to whatever launches next,
    including the build being restored — remove it on `did not poll within`, before `bootstrap_agent`.
16. **`vercel env pull` hangs over SSH, and `| tail` / `>/dev/null` hide why.** `.env.local` is already on the
    Mini; source it. Never pipe a possibly-interactive command through `tail` or into `/dev/null` in a paste V
    runs blind.
17. **Update checks run on first poll after launch, at session end, and every 6 h — not per poll.** A withdraw
    or a new offer takes effect at the next check; in acceptance, trigger it with `launchctl kickstart -k`.
18. **Print exit codes, not just output.** `security` prints nothing on the path that matters; `echo "exit=$?"`
    is what found the ACL. Every diagnostic paste ends with the status of the command under test.

## The role split V uses

Fable orchestrates: specs, briefs, judgement, integration. Haiku scouts: finds files, symbols and live
states, reports locations not contents. Sonnet researches, builds from a settled spec, and drives
browsers. Opus refutes (reviews a diff it did not write, reruns tests itself) and debugs to root cause.
Verdicts, design decisions and sign-off are never delegated.

## Rules added 11 Sep 2026

19. **Enrolment over SSH needs the login keychain unlocked first.** The bootstrap paste run in an SSH session stops the
    working copy, installs, then fails at `keychain error -25308: User interaction is not allowed` — the room is now down
    (OPD 6, 11 Sep 10:52 IST). `security unlock-keychain ~/Library/Keychains/login.keychain-db` (password at the prompt),
    then the paste, in the same session. Proven on OPD 6 at 10:58 IST (`install_6agt42dn6b5n`). The partition step hits the
    same wall; its prompt already covers it.
20. **In zsh, `set -- $h` does not word-split.** Use `${=h}`. A probe written with `set -- $h` reported every host, the Mini
    included, as closed — the first SSH probe of 11 Sep was void for this reason. Run any paste that loops over "name ip"
    strings with `${=h}`, or under `bash -c`.
21. **Room login users follow `ehrc-<mac>`**: ehrc-echo, ehrc-consul4/5/6, ehrc-discussion. The Tailscale hostname
    (`ehrc-consul6s-mac-mini`) is not the user. `-o PreferredAuthentications=password -o PubkeyAuthentication=no` avoids the
    keyboard-interactive triple prompt.
22. **Every bootstrap paste mints a new install id and retires the old row.** Clinic Macs are on `stable`, so the 0.1.13-line
    stale-session loop cannot fire there, but the §C table and the partition step must use the id that `config.json`
    prints today, never the carryover's. OPD 5 → `install_w2gyy28svnvb`, OPD 7 → `install_qedhc39yj22s`,
    OPD 6 → `install_6agt42dn6b5n` (all 11 Sep).
23. **The fleet route is proxy-blocked from Cowork** (both the cloud shell and the device sandbox get 403 on
    `www.evenscribe.app`). Read fleet state from `scribe_system_map` listeners (tab_id = install id, last_poll_at) or from
    Claude Code on the Mini; never spend a turn on curl from Cowork.

## Rules added 11 Sep 2026, afternoon

24. **Passwords never go through Claude Code's `!` shell.** It has no tty: `ssh`/`scp`/`security` prompts silently get nothing and
    report "wrong password" three times (13:09). Anything that prompts runs in a real Terminal window (tmux Ctrl-b c), and the agent
    reads the log the command writes. `!` must also be the very first character or the line is chat.
25. **A compiled-in code requirement must never consult the Mac's trust store.** `anchor trusted` passed only on the signing Mac.
    Clinic Macs cannot be made to trust a cert remotely (`SecTrustSettingsSetTrustSettings: no user interaction was possible`; a cert
    can be ADDED over SSH but not TRUSTED). Since 0.1.18 the requirement is the leaf hash alone. Any verifier change is accepted only
    by a clinic Mac swapping unattended — the Mini proves nothing about trust.
26. **The bootstrap paste over SSH is the upgrade path, and it needs nothing.** 0.1.17+ `enrol` writes `room-session.json` only;
    bootstrap ships `latestRelease("stable")`. Recipe (proven ×5, 11 Sep): `scribe_stop_recording` → `ssh -t user@ip` → the card's
    fresh `curl … | bash` → `sleep 12` + check line (new install id, `channel=stable`, `app=`, `-rw-------` file, `microphone
    authorized`) → `scribe_start_recording`. Each paste mints a new install id and retires the old row; card hygiene is B2's.
    Rule 19 and the partition-step runbook are obsolete for the 0.1.18 line.
