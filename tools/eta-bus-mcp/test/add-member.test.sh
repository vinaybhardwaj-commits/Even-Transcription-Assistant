#!/bin/sh
# Name/key validation tests for add-member.sh. Uses ONLY temp files (ETA_ADDMEMBER_AK / _MEMBERS / _DB overrides);
# the real authorized_keys, members.txt and bus.db are never touched. Run: sh test/add-member.test.sh
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$HERE/../add-member.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/add-member-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
export ETA_ADDMEMBER_AK=$T/authorized_keys ETA_ADDMEMBER_MEMBERS=$T/members.txt ETA_ADDMEMBER_DB=$T/bus.db
KB1=AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
KB2=AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
KB3=AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
KSUB=AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAA   # substring of KB1, a different key
sqlite3 "$T/bus.db" "CREATE TABLE messages (id INTEGER PRIMARY KEY, sender TEXT, recipients_json TEXT); CREATE TABLE receipts (message_id INTEGER, recipient TEXT); INSERT INTO messages VALUES (1,'bt-used','[]'); INSERT INTO receipts VALUES (1,'bt-seen');"
reset() { printf 'ssh-ed25519 %s seed\n' "$KB1" > "$ETA_ADDMEMBER_AK"; : > "$ETA_ADDMEMBER_MEMBERS"; }
sum() { cksum < "$ETA_ADDMEMBER_AK"; }
key() { printf 'ssh-ed25519 %s' "$1"; }
expect_reject() { # label name key
  reset; before=$(sum)
  if sh "$SCRIPT" "$2" "$3" >/dev/null 2>&1; then echo "FAIL $1: accepted"; FAIL=$((FAIL+1)); return; fi
  if [ "$(sum)" != "$before" ]; then echo "FAIL $1: authorized_keys changed"; FAIL=$((FAIL+1)); return; fi
  if [ -s "$ETA_ADDMEMBER_MEMBERS" ]; then echo "FAIL $1: members.txt written"; FAIL=$((FAIL+1)); return; fi
  echo "PASS $1"; PASS=$((PASS+1))
}
expect_accept() { # label name key
  reset
  if sh "$SCRIPT" "$2" "$3" >/dev/null 2>&1; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1: rejected"; FAIL=$((FAIL+1)); fi
}
K2=$(key "$KB2")
NL=$(printf 'ext-ok\nroot')
expect_reject "newline in name" "$NL" "$K2"
expect_reject "trailing newline-quote" "$(printf 'ext-ok"\nx')" "$K2"
expect_reject "double quote" 'ext-a"b' "$K2"
expect_reject "single quote" "ext-a'b" "$K2"
expect_reject "semicolon" 'ext-a;b' "$K2"
expect_reject "space" 'ext-a b' "$K2"
expect_reject "underscore" 'ext-a_b' "$K2"
expect_reject "no ext- prefix" 'grokbot' "$K2"
expect_reject "reserved fable" 'fable' "$K2"
expect_reject "empty name" '' "$K2"
expect_reject "too short (ext-a)" 'ext-a' "$K2"
expect_reject "too long (37 body chars)" "ext-$(printf 'a%.0s' $(seq 1 37))" "$K2"
sqlite3 "$T/bus.db" "INSERT INTO messages VALUES (2,'ext-xx','[]'); INSERT INTO receipts VALUES (2,'ext-yy');"
expect_reject "name in bus.db as sender (ext-xx)" 'ext-xx' "$K2"
expect_reject "name in bus.db as recipient (ext-yy)" 'ext-yy' "$K2"
expect_reject "key already present (exact body)" 'ext-new' "$(key "$KB1")"
expect_reject "key with two lines" 'ext-new' "$(printf '%s\nssh-ed25519 %s' "$(key "$KB2")" "$KB3")"
expect_accept "valid minimum name (ext-ab)" 'ext-ab' "$K2"
expect_accept "valid 36-char body" "ext-$(printf 'a%.0s' $(seq 1 36))" "$K2"
expect_accept "uppercase folded then validated" 'Ext-Grok-1' "$K2"
expect_accept "substring of an existing key body is not a duplicate" 'ext-sub' "$(key "$KSUB")"
# re-key: name already in members.txt is allowed even if it appears in bus.db
reset; printf 'ext-xx\n' > "$ETA_ADDMEMBER_MEMBERS"
if sh "$SCRIPT" ext-xx "$K2" >/dev/null 2>&1 && [ "$(grep -c '^ext-xx$' "$ETA_ADDMEMBER_MEMBERS")" = 1 ] && grep -q 'eta-bus:ext-xx' "$ETA_ADDMEMBER_AK"; then echo "PASS re-key of existing member"; PASS=$((PASS+1)); else echo "FAIL re-key of existing member"; FAIL=$((FAIL+1)); fi
# accepted run wrote exactly one restricted key line and the name
reset
sh "$SCRIPT" ext-chk "$K2" >/dev/null 2>&1
if [ "$(grep -c 'eta-bus:ext-chk' "$ETA_ADDMEMBER_AK")" = 1 ] && grep -q '^restrict,command=' "$ETA_ADDMEMBER_AK" && [ "$(cat "$ETA_ADDMEMBER_MEMBERS")" = "ext-chk" ]; then echo "PASS accepted run writes one restricted key + members line"; PASS=$((PASS+1)); else echo "FAIL accepted run output"; FAIL=$((FAIL+1)); fi
echo "add-member.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
