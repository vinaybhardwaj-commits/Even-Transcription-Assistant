> OBSOLETE as of 11 Sep 2026 — applied only to the 0.1.8/0.1.13 keychain line; 0.1.17+ enrol writes room-session.json only (carryover 11 Sep, orchestrator rule 26). Kept as history.
# ETA — room session migration runbook, v2 (Release B1.5, B1.5-D5)

**10 September 2026, 19:35 IST. Replaces v1 of the same date.** v1 read the keychain with
`security find-generic-password -w`; that command returns `exit=36` (errSecAuthFailed) silently over SSH, because the
item's ACL — by designated requirement — trusts only our signed app and cannot admit the `security` tool without a GUI
click. **Nothing in v2 reads the token.** Proven on Home Office 10 Sep 18:25 IST (verdict: B1-B1.5 acceptance, §15.3 item 2).

## What actually migrates a room

`RoomSessionStore.load` reads `room-session.json` first; when it is absent it reads the keychain **once** and, on success,
writes the file itself (`RoomSessionStore.swift:138`). The keychain read succeeds only if the launching build's **cdhash is
on the item's partition list**; every clinic Mac's list is `[0.1.8]` (the version that enrolled it). So the migration is:

1. over SSH, add the new build's cdhash to the partition list (login-keychain password typed at the prompt);
2. offer the build; its first launch reads the keychain, writes `room-session.json` (0600), and never uses the keychain again.

**Once per room, for the first 0.1.13-line build it receives.** Later builds read the file; the partition list is then
irrelevant. Order matters: a build offered *before* step 1 fails clean (0.2 s), rolls back at 180 s, retries once, and
holds that version 6 h — clearing the hold means withdrawing that version, so **a wrong-order rollout burns a version.**

## The cdhash of the build being offered

Read it on the Mini from the bundle `build-bundle.sh` produced — the swap installs the same bytes, so the cdhash is the same:

```bash
codesign -dvvv "apps/room-recorder/.build/release-bundle/stage/EvenScribe Room Recorder.app" 2>&1 | awk -F= '/^CDHash=/{print $2}'
```

0.1.13 (`5cc6931`): `c95246f0c7fb0ab41ec3784ad3836be0d98ef61a`. Any new version has a new cdhash; read it, never reuse.

## The per-room command

`ssh <room-user>@<tailscale-ip>` as the room's own user, then paste as one line, replacing `NEW` with the cdhash above. It
prompts for **that room's login-keychain password** — `security` asks; nothing here stores it. Keeps the resident 0.1.8's
own cdhash on the list so a rollback still launches clean.

```bash
NEW=c95246f0c7fb0ab41ec3784ad3836be0d98ef61a; CD=$(codesign -dvvv "$HOME/Applications/EvenScribe Room Recorder.app" 2>&1 | awk -F= '/^CDHash=/{print $2}'); echo "resident cdhash=$CD"; [ -n "$CD" ] && security set-generic-password-partition-list -S "apple-tool:,apple:,cdhash:$CD,cdhash:$NEW" -s com.evenscribe.room-recorder.room-token -a room-session ~/Library/Keychains/login.keychain-db >/dev/null && echo "partition list: resident + $NEW admitted"
```

Expect `resident cdhash=<40 hex>` then `partition list: resident + … admitted`. If the first line is empty, stop — the
resident bundle is not where the runbook expects it.

`-S` **replaces** the list; the entries are `apple-tool:` (lets this command itself be re-run), `apple:`, the resident's
cdhash, the new cdhash. It does not touch the item's data or ACL (B1.5-D4: the keychain item is never deleted).

## After the offer — what "migrated" looks like

```bash
tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"; ls -l "$HOME/Library/Application Support/EvenScribe/RoomRecorder/room-session.json"
```

Want `room session read from the keychain; writing room-session.json` on the first launch of the new build, then
`room session read from room-session.json`, and a `-rw-------` file. On the fleet card the row shows the new version.
If instead the log says `keychain error -25293` / `cannot authenticate and will not poll`, the cdhash on the list is not
the one that launched — re-read it from the bundle and repeat step 1 before the ledger's retry (about 30 s after rollback).

## Rooms without sshd (OPD 3, OPD 5, OPD 6, OPD 7, Room 4.1 as of 10 Sep)

Same command in Terminal at the console; or first enable Remote Login from the console so the rest is remote:

```bash
sudo launchctl enable system/com.openssh.sshd; sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist; sudo launchctl kickstart -k system/com.openssh.sshd
```

(`systemsetup -setremotelogin on` fails without Full Disk Access; the three-liner does not.) Cardiology (ECHO,
`100.74.103.103`) already has sshd.

## Order of a clinic rollout

1. Partition step on every room the channel reaches (all six for `stable`), checking each fleet row's install id.
2. Publish the build to `stable` (same `release.json`, second blob key — rule 11).
3. Each room takes it at its next check (first poll after launch, session end, or 6 h); watch `last_update_result` per row.
4. A room that shows `swap_failed`: read its `update.log` and `launchd.log` over SSH before doing anything else.
