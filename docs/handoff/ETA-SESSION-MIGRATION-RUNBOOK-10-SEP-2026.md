# ETA — room session migration runbook (Release B1.5, B1.5-D5)

**10 September 2026.** One command per room, run **by V over SSH as the room user**, **before 0.1.13 is offered to that
room**. It copies the session out of the login keychain into `room-session.json`, which is what 0.1.13 and everything
after it reads. Rooms without sshd get this at the next visit.

## Why it has to happen before the update, not after

The keychain item's partition list is keyed by **cdhash**, so a new build is a stranger to it and securityd asks a human
for permission. Every clinic Mac's list holds `[0.1.8]` only. A room that updates before it is migrated launches a build
that cannot read its own session; 0.1.13 will say `needs_enrol` and stop rather than hang (that is B1.5-D2), but the room
is then down until somebody runs this anyway. **Migrate first.**

## The command

Paste as one block. It prompts for the **login-keychain password of that room's user** — `security` asks, not this
script, and nothing here reads or stores it. The session token is never printed; only its length.

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

## What it does, and what it deliberately does not

- Reads the item with `security find-generic-password … -w`. The stored blob **is** the JSON of `RoomKeychainRecord`, so
  the only transformation needed is the rename of `session` to §15.2's `session_token`, plus the two metadata fields.
- **Nothing but `security`, `sed`, `chmod`, `plutil`, `awk` and `mv`** — all present on a bare clinic Mac. No `python3`:
  `/usr/bin/python3` is a stub that demands the Command Line Tools, which a clinic Mac does not have.
- Writes to a temporary name in the same directory, `chmod 600` **before** the rename, then renames over the
  destination — the same atomicity `RoomSessionStore.save` uses, so no reader can see a partial or 0644 file.
- **Aborts without touching `room-session.json`** when the read fails: a wrong password produces an empty pipe, the
  token-length gate refuses it, and the existing file (if any) is left exactly as it was. `set -e` is deliberately not
  relied on — its behaviour differs between bash and zsh, and this must be safe under either.
- **Never deletes the keychain item** (B1.5-D4). Cleanup is a separate, optional step, later.
- The token is never echoed, never put in a variable, and never written anywhere but the 0600 file.

## Fields, exactly as they exist today

`RoomKeychainRecord` carries **`session`, `install_id`, `room_slug`, `room_name`, `origin`** — those five and no others,
since R2. §15.2 also names `room_id` and `expires_at`: **neither exists.** There is no room id anywhere in the app (the
room is identified by `room_slug`), and `expires_at` arrives in the enrolment response and is dropped at the point of
saving. A migration cannot invent them, so the file carries the five real fields plus `written_by` and `written_at`.

## Per-room checklist

1. `ssh <room-user>@<room-host>` (Tailscale name; Remote Login is off on all rooms but ECHO — see the R3 acceptance
   verdict for the two commands that enable it).
2. Paste the block. Type that room's login password at `security`'s prompt.
3. Expect one line: `room-session.json written: install_id=…, room_slug=…, token length …`. Check the ids against the
   room's row on the fleet card **before** moving to the next room.
4. `ls -l "$ROOT/room-session.json"` shows `-rw-------`.
5. Only when every room a release will reach has been migrated: publish 0.1.13.
