# ETA Install Build B1.5 — the session store, report

**10 September 2026.** Branch `vinay/release-b1`, new commit on `51f1ee3`, not amended, not pushed, `main` untouched.
**The sha is the single new commit (`git log --oneline -1`); a commit cannot quote its own.** Pre-flight matched:
`HEAD 51f1ee3`, branch `vinay/release-b1`, only `docs/handoff/*` untracked.

## S1 — `RoomSessionStore`

New `Sources/RoomRecorderCore/RoomSessionStore.swift`: `url(root:)` `:30`, shape `Stored` `:42`,
`load(root:keychainReader:log:)` `:70`, `save(_:root:)` `:116`, `readFile(root:)` `:153`. `load` returns the file if
usable, logs and falls through if it exists and is refused, reads the keychain **once**, and on success writes the file;
every failure returns nil promptly — nothing waits. `save` writes `room-session.json.<uuid>.tmp` and `chmod 0600`
**before** `replaceItemAt`, so no reader sees 0644 and no crash leaves a partial file; the keychain item is never
deleted (D4). One line names the source. §15.2's four rejections are at `:153-180`, plus a fifth: a non-**regular** file
is refused, since mode and owner are read through a symlink.

## S2 — wiring, and the line this build exists for

`RoomKeychain.swift:130`, verbatim: `query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail`

`RoomEngine.startingConfiguration:504` — `enrolmentReader` becomes optional because a Swift default cannot see another
parameter and this one needs `rootURL`: `let enrolment = (enrolmentReader ?? { RoomSessionStore.load(root: rootURL) })()`.
`RoomEngine.load` passes the same optional through. `enrol` writes the file only — `main.swift:108`,
`try RoomSessionStore.save(enrolled.record(origin: origin), root: root)`, mapping at `RoomEnrolment.swift:42`.
**`grep -rn "RoomKeychain.load()" Sources/` now returns exactly one line: the store's own fallback default at
`RoomSessionStore.swift:74`.** `RoomKeychain.save` survives only at `main.swift:161`, in `login` — flag 2.

**A second keychain read was not in the kickoff and would have hung too.** `RoomEngine.init:739` read
`try? RoomKeychain.load()` on every launch for `install_id`, *after* the session had already come from the file. It
reads the store now: D2 says no code path may block on securityd, and that was one of the paths.

## S3 — the message

`RoomEngine.swift:513` / `:518`: `no session in room-session.json or the keychain; this install is not enrolled`, and
the stderr line names both sources and points at the migration command for a room enrolled before 0.1.13.

## S4 — the migration command

`docs/handoff/ETA-SESSION-MIGRATION-RUNBOOK-10-SEP-2026.md`, verbatim:
```bash
ROOT="$HOME/Library/Application Support/EvenScribe/RoomRecorder"
TMP="$(/usr/bin/mktemp "$ROOT/room-session.json.XXXXXX")" || exit 1
trap '/bin/rm -f "$TMP"' EXIT
/usr/bin/security find-generic-password -s com.evenscribe.room-recorder.room-token -a room-session -w \
  | /usr/bin/sed -e 's/"session":/"session_token":/' \
      -e 's/}[[:space:]]*$/,"written_by":"ssh-migration","written_at":"'"$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"'"}/' \
  > "$TMP"
/bin/chmod 600 "$TMP"
LEN="$(/usr/bin/plutil -extract session_token raw -o - "$TMP" 2>/dev/null | /usr/bin/awk '{printf "%d", length($0)}')"
if [ -z "$LEN" ] || [ "$LEN" -lt 20 ]; then
  /bin/echo "MIGRATION ABORTED: no session token was read (wrong password, or no keychain item). Nothing was changed." >&2
  exit 1
fi
/bin/mv -f "$TMP" "$ROOT/room-session.json"
/bin/echo "room-session.json written: install_id=$(/usr/bin/plutil -extract install_id raw -o - "$ROOT/room-session.json"), room_slug=$(/usr/bin/plutil -extract room_slug raw -o - "$ROOT/room-session.json"), token length $LEN"
```

**The fields, exactly as they exist.** `RoomKeychainRecord` carries `session`, `install_id`, `room_slug`, `room_name`,
`origin` — five, since R2 — and the stored blob **is** that JSON, so the only transformation is the rename to §15.2's
`session_token` plus two metadata fields. §15.2 also names `room_id` and `expires_at`: **neither exists** (flag 1).
**No `python3`:** `/usr/bin/python3` without the Command Line Tools is a stub that demands they be installed, and clinic
Macs do not have them — only `security`, `sed`, `chmod`, `plutil`, `awk`, `mv`, `date`, `mktemp`.

**On the Mini.** The real read is blocked from this session, which is the finding itself:
`security find-generic-password … -w` → **exit 36, empty stderr, nothing on stdout**. The item is present and its
*attributes* read fine (`acct room-session`, created `20260909234635Z`); only the data needs decryption, which wants V's
password. So it was proven in halves: the read half by that failure, the transform and write half by running the runbook
block under `bash` against a synthetic blob of the exact shape `RoomKeychain.save` writes —

```
room-session.json written: install_id=install_k54jsz5r4cyz, room_slug=home-office-w8fb, token length 86
-rw-------  room-session.json
```

— after which **the app's own reader read it back**: `RoomSessionStore.load` printed `room session read from
room-session.json` and `READ OK … token_length=86` with the keychain stubbed to throw. **The abort path was tested**:
`security` replaced by a stub exiting 36 gives `MIGRATION ABORTED …`, exit 1, the existing file byte-identical, no temp
left behind. That gate is an explicit `if`, not `set -e` — my first cut relied on `set -e` and overwrote a good file
with rubbish under zsh, which is how I found it.

## Tests and gates

`RoomSessionStoreTests.swift`, ten: the file wins and the keychain spy records **zero** calls; the file is 0600 and
round-trips under §15.2's keys; an unmigrated room falls back once, gets a 0600 file, and its second read does not touch
the keychain; `errSecInteractionNotAllowed` returns nil in under a second having written nothing (the root is left
empty), and `notFound` likewise; a 0644 file is refused with `644` in the reason and the fallback still runs; rubbish
JSON and an empty `session_token` are refused; a missing file is `absent`, not `refused`; and the enrol mapping, decoded
from a real response payload, round-trips with the keychain never consulted. `RoomSessionFromKeychainTests` is unchanged
and green — it injects its own reader.

`npm run typecheck` clean; `npm test` `Test Files  67 passed (67)` / `Tests  1572 passed (1572)`; `npm run build`
completed; `npm run check:silent` `Found 9 silent-failure handler(s)` — the accepted nine, all under `app/`, none in the
contract; `swift build` `Build complete!`; **`swift test` over SSH `✔ Test run with 531 tests in 43 suites passed after
15.510 seconds.`, 0 issues** (ten new). `Packaging/VERSION` → `0.1.13`. No bundle, nothing signed.

## Flags

1. **§15.2 names two fields that do not exist.** `room_id` is nowhere in the app (a room is `room_slug`); `expires_at`
   arrives at enrolment and is dropped at save time. No migration can recover either — the live items lack them. Keeping
   the expiry would be a change to what `enrol` stores, not to the migration.
2. **`login` still writes the keychain, not the file** (`main.swift:161`); the contract said "enrol path only" so I left
   it. It is now incoherent — `login` would refresh a session the app no longer reads. Nothing unattended touches it (it
   needs a terminal), but it is one line and should change before anyone runs it on a room.
3. **`written_by` is `ssh-migration` on a migrated file**, not a version, because no version of the app wrote it. The
   app writes its real `CFBundleShortVersionString`, or `unbundled`. Nothing reads the field.
4. **The foreign-owner rejection is unexercised** — staging it needs `chown` to another uid, so root. The test says so
   and returns rather than passing silently; mode, type, JSON and empty-token rejections are exercised.
5. **`RoomEnrolment.swift` needed only an additive mapping** (`:42`); the keychain write the kickoff expected there was
   in `main.swift`. Nothing else in that file changed.
6. **"Stub the keychain writer and assert it is never called" is not implemented as written** — after D3 there is no
   keychain writer on the enrol path to stub, and a parameter existing only to observe an impossible call is dead code.
   The proof is structural and quoted in S2. Say the word if you want the parameter anyway.
7. **This report is 117 lines against a 100-line cap**, 18 of them the migration command the kickoff asks for verbatim.
   I cut prose rather than evidence or flags.
8. **Not proven here:** that a real room's item returns `errSecInteractionNotAllowed` rather than blocking. That is
   §15.3 item 2 and needs 0.1.13 on a Mac whose partition list lacks its cdhash. The tests prove what the app does with
   the error; producing it is Apple's part.
