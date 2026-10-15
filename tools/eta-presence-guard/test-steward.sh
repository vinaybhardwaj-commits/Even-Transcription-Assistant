#!/bin/bash
# test-steward.sh — offline test of eta-steward.sh + steward-verify against the Room Steward ticket contract v1.
# Builds the Swift helper with swiftc, signs fixtures with a throwaway Ed25519 keypair, stubs curl/launchctl/pkill/pgrep/
# caffeinate/killall/id/sleep/ioreg/date. No network, no root, no kiosk. (python3 is used by the TEST only, on the dev machine.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STEW="$HERE/eta-steward.sh"
T="$(mktemp -d)"; trap 'rm -rf "${T:?}"' EXIT
pass=0; fail=0
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then pass=$((pass+1)); printf 'PASS  %s\n' "$d"; else fail=$((fail+1)); printf 'FAIL  %s\n' "$d"; fi; }
has() { grep -qF -- "$2" <<< "$1"; }
no() { ! grep -qF -- "$2" <<< "$1"; }

bash -n "$STEW" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL bash -n"; }
swiftc -O -o "$T/steward-verify" "$HERE/steward-verify/Canon.swift" "$HERE/steward-verify/DupScan.swift" "$HERE/steward-verify/main.swift" 2>/dev/null || { echo "swiftc verify failed"; exit 1; }
swiftc -O -o "$T/steward-sign" "$HERE/steward-verify/Canon.swift" "$HERE/tests-steward/sign/main.swift" 2>/dev/null || { echo "swiftc sign failed"; exit 1; }
read -r SEED PUB < <("$T/steward-sign" gen)
read -r SEED2 PUB2 < <("$T/steward-sign" gen)
"$T/steward-sign" pem "$PUB" > "$T/pub.pem"; "$T/steward-sign" pem "$PUB2" > "$T/pub2.pem"
PEMSHA="$(shasum -a 256 "$T/pub.pem" | awk '{print $1}')"

MACH="OPD-6.local"; TOKEN="SECRET-TOKEN-XYZ-123"
ISS="2026-10-06T10:00:00.000Z"; EXP="2026-10-06T10:05:00.000Z"
ISS_E=1791280800; EXP_E=1791281100; NOW=1791280920
CFG="$T/config.json"; ST="$T/state"; HR="$T/Users"; mkdir -p "$ST"
printf '{"machine":"%s","token":"%s","sink_url":"https://sink.invalid/api/kiosk-health","post":false}\n' "$MACH" "$TOKEN" > "$CFG"
RDIR="$HR/kiosk/Library/Application Support/EvenScribe/RoomRecorder"; CDIR="$HR/kiosk/Library/Application Support/Google/Chrome"
EXTD="$CDIR/Profile 1/Extensions/choegfgddhpljibnolbcljnlfhfpimbh"
mkdir -p "$RDIR" "$EXTD/0.1.0.14_0" "$CDIR/Profilé 1"
printf '{"state":"idle","session_id":null}' > "$RDIR/status.json"
MP="$T/mp/com.google.Chrome.plist"; mkdir -p "$T/mp"; echo POLICY > "$MP"

B="$T/bin"; mkdir -p "$B"
cat > "$B/curl" <<'S'
#!/bin/bash
all="$*"; stdin=$(cat); echo "$all" >> "$T/curl.args"; echo "$stdin" >> "$T/curl.stdin"
if [[ "$all" == *"-X POST"* ]]; then
  prev=""; for a in "$@"; do [ "$prev" = "--data-binary" ] && echo "$a" >> "$T/posts.log"; prev="$a"; done
  [ -e "$T/postfail" ] && { printf '503'; exit 0; }
  printf '200'; exit 0
fi
[ -e "$T/getcode" ] && code=$(cat "$T/getcode") || code=200
printf '%s\n%s' "$(cat "$T/resp" 2>/dev/null)" "$code"
S
for c in pkill killall caffeinate; do
  printf '#!/bin/bash\necho "%s $*" >> "$T/calls"\n' "$c" > "$B/$c"
  if [ "$c" = pkill ]; then printf '[ -n "${KILL_SELF:-}" ] && kill -TERM "$PPID"\n' >> "$B/$c"; fi
  printf 'exit 0\n' >> "$B/$c"
done
printf '#!/bin/bash\n[ -e "$T/chrome_down" ] && exit 1\nexit 0\n' > "$B/pgrep"
printf '#!/bin/bash\n/bin/sleep 0.03\n' > "$B/sleep"
cat > "$B/id" <<'S'
#!/bin/bash
if [ "$1 ${2:-}" = "-u kiosk" ]; then echo 501; else exec /usr/bin/id "$@"; fi
S
# ioreg: HIDIdleTime from the next value of $T/idleseq (space separated seconds; the last value repeats); else 1000 s
cat > "$B/ioreg" <<'S'
#!/bin/bash
[ -s "$T/idleseq" ] || { echo '    "HIDIdleTime" = 1000000000000'; exit 0; }
read -r first rest < "$T/idleseq"
[ -n "$rest" ] && echo "$rest" > "$T/idleseq"
echo "    \"HIDIdleTime\" = ${first}000000000"
S
# date: `date +%s` returns $T/dateseq and advances it by 30 s per call when that file exists; everything else is the real date
cat > "$B/date" <<'S'
#!/bin/bash
if [ "$*" = "+%s" ] && [ -f "$T/dateseq" ]; then n=$(cat "$T/dateseq"); echo $((n + 30)) > "$T/dateseq"; echo "$n"; exit 0; fi
exec /bin/date "$@"
S
cat > "$B/launchctl" <<'S'
#!/bin/bash
echo "launchctl $*" >> "$T/calls"
E="$CDIR/Profile 1/Extensions/choegfgddhpljibnolbcljnlfhfpimbh"
case "$1" in
  bootout) rm -f "$T/loaded" ;;
  bootstrap) touch "$T/loaded" ;;
  print) [ -f "$T/loaded" ]; exit $? ;;
  asuser) if [ -f "$MP" ]; then mkdir -p "$E/0.1.1.39_0"; else rm -rf "${E:?}"/*; fi ;;
esac
exit 0
S
chmod +x "$B"/*; export T CDIR MP

N=0
tk() { # tk <id> <action> [machine] [iss] [exp] [params-json] [nonce]: a contract ticket (8 fields); fresh nonce unless given
  local nonce="${7:-n$(uuidgen | tr -d '-' | cut -c1-21)}" params="${6:-}"; [ -n "$params" ] || params='{}'
  printf '{"v":1,"ticket_id":"%s","machine":"%s","action":"%s","params":%s,"issued_at":"%s","expires_at":"%s","nonce":"%s"}' \
    "$1" "${3:-$MACH}" "$2" "$params" "${4:-$ISS}" "${5:-$EXP}" "$nonce"
}
sign() { printf '%s' "$1" | "$T/steward-sign" sign "${2:-$SEED}"; }
serve() { local IFS=,; printf '{"ok":true,"key_id":"6275a79b","tickets":[%s]}' "$*" > "$T/resp"; }
tick() { # tick [ENV=val...]: one executor tick; stdout+stderr
  env STEWARD_TEST_MODE=1 STEWARD_PEM_OVERRIDE="$T/pub.pem" STEWARD_PEM_SHA256="$PEMSHA" \
      STATE_DIR="$ST" KH_CONFIG="$CFG" HOME_ROOT="$HR" PLIST_PATH="$MP" STEWARD_VERIFY_OVERRIDE="$T/steward-verify" STEWARD_URL_OVERRIDE="https://steward.invalid/t" \
      NOW_OVERRIDE="${NOW_O:-$NOW}" HID_IDLE_OVERRIDE="${IDLE:-1000}" CONSOLE_USER_OVERRIDE=kiosk PATH="$B:$PATH" "$@" bash "$STEW" 2>&1
}
reset() {
  : > "$T/calls"; : > "$T/posts.log"; : > "$T/curl.stdin"; : > "$T/curl.args"
  rm -f "$ST"/steward_* "$ST"/*aside "$T/postfail" "$T/getcode" "$T/chrome_down" "$T/idleseq" "$T/dateseq"
  touch "$T/loaded"; echo POLICY > "$MP"
  rm -rf "${EXTD:?}"; mkdir -p "$EXTD/0.1.0.14_0"
  printf '{"state":"idle","session_id":null}' > "$RDIR/status.json"
}
one() { reset; serve "$(sign "$1" "${2:-}")"; NOW_O="${NOW_T:-$NOW}" tick >/dev/null; }   # reset, serve one signed ticket, one tick
calls() { cat "$T/calls"; }
# first posted event as outcome|detail ; all posted events as ticket_id|outcome|detail|machine
res() { python3 -c 'import json,sys
for l in open(sys.argv[1]):
    for e in json.loads(l)["events"]:
        p=e["payload"]; print(p["outcome"]+"|"+p["detail"]); sys.exit()' "$T/posts.log" 2>/dev/null; }
allres() { python3 -c 'import json,sys
for l in open(sys.argv[1]):
    for e in json.loads(l)["events"]:
        p=e["payload"]; print(p["ticket_id"]+"|"+p["outcome"]+"|"+p["detail"]+"|"+e["machine"])' "$T/posts.log" 2>/dev/null; }
rejected() { [ "$(res)" = "rejected|$1" ] && ! grep -q 'caffeinate\|asuser\|kickstart' "$T/calls"; }
mutsig() { python3 -c 'import sys,json
e=json.loads(sys.stdin.read()); m=sys.argv[1]; s=e["signature"]
A="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
if m=="short87": s=s[:85]+"=="
elif m=="long89": s=s[:86]+"A=="
elif m=="url": s=s.replace("+","-").replace("/","_") if ("+" in s or "/" in s) else s[:5]+"-"+s[6:]
elif m=="unpadded": s=s[:86]
elif m=="noncanon": s=s[:85]+A[A.index(s[85])^1]+"=="
elif m=="space": s=s[:40]+" "+s[41:]
elif m=="junk": s=s+"x"
elif m=="empty": s=""
e["signature"]=s; print(json.dumps(e))' "$1"; }

# 1. valid tickets, result envelope
reset; serve "$(sign "$(tk 00000000-0000-4000-8000-000000000001 wake "" "" "" "" n000000000000000000001)")"; out="$(tick)"
check "wake: caffeinate -u -t 5 run" has "$(calls)" "caffeinate -u -t 5"
check "wake: outcome done posted" test "$(res)" = "done|caffeinate_u"
check "wake: event kind, own boot_id namespace, ticket id + nonce" bash -c "grep -q '\"kind\":\"steward.result\"' '$T/posts.log' && grep -q '\"boot_id\":\"steward-' '$T/posts.log' && grep -q '\"ticket_id\":\"00000000-0000-4000-8000-000000000001\"' '$T/posts.log' && grep -q '\"nonce\":\"n000000000000000000001\"' '$T/posts.log'"
check "wake: result machine equals the ticket machine" bash -c "grep -q '\"machine\":\"$MACH\"' '$T/posts.log'"
check "wake: outbox cleared after 2xx" test ! -s "$ST/steward_outbox.jsonl"
check "poll: bearer on stdin only, not argv" bash -c "! grep -q '$TOKEN' '$T/curl.args' && grep -q '$TOKEN' '$T/curl.stdin'"
check "poll: machine in query" bash -c "grep -q 'machine=$MACH' '$T/curl.args'"
check "poll: no -L (redirects are not followed)" bash -c "! grep -qE '(^| )-[A-Za-z]*L|--location' '$T/curl.args'"
check "config needs no steward_pubkey (trust anchor is the pinned PEM)" no "$(cat "$CFG")" steward_pubkey

# 2. replay (ticket_id or nonce, last 200)
: > "$T/calls"; : > "$T/posts.log"; out="$(tick)"
check "replay: same ticket again -> not run" bash -c "! grep -q caffeinate '$T/calls'"
check "replay: rejected, detail replay" test "$(res)" = "rejected|replay"
reset; serve "$(sign "$(tk 00000000-0000-4000-8000-0000000000a1 wake "" "" "" "" AAAAAAAAAAAAAAAAAAAAAA)")"; tick >/dev/null
: > "$T/calls"; : > "$T/posts.log"; serve "$(sign "$(tk 00000000-0000-4000-8000-0000000000a2 wake "" "" "" "" AAAAAAAAAAAAAAAAAAAAAA)")"; tick >/dev/null
check "replay: same nonce, new ticket_id -> rejected replay, not run" bash -c "[ \"$(res)\" = 'rejected|replay' ] && ! grep -q caffeinate '$T/calls'"
: > "$T/calls"; : > "$T/posts.log"; serve "$(sign "$(tk 00000000-0000-4000-8000-0000000000a1 wake)")"; tick >/dev/null
check "replay: same ticket_id, new nonce -> rejected replay, not run" bash -c "[ \"$(res)\" = 'rejected|replay' ] && ! grep -q caffeinate '$T/calls'"
reset; for i in $(seq 1 205); do echo "old$i oldn$i" >> "$ST/steward_replay"; done; serve "$(sign "$(tk 00000000-0000-4000-8000-0000000000b1 wake)")"; tick >/dev/null
check "replay store trimmed to 200 lines, newest kept" bash -c "[ \$(wc -l < '$ST/steward_replay' | tr -d ' ') = 200 ] && tail -1 '$ST/steward_replay' | grep -q '^00000000-0000-4000-8000-0000000000b1 ' && ! grep -q '^old1 ' '$ST/steward_replay'"
check "replay store mode 600" test "$(stat -f %Lp "$ST/steward_replay")" = 600
reset; serve "$(sign "$(tk 00000000-0000-4000-8000-0000000000c1 wake)")" "$(sign "$(tk 00000000-0000-4000-8000-0000000000c1 wake)")"; tick >/dev/null
check "same ticket twice in one poll runs once" test "$(grep -c caffeinate "$T/calls")" = 1
reset; ELEVEN=(); for i in $(seq 1 11); do ELEVEN+=("$(sign "$(tk 00000000-0000-4000-8000-0000000001$(printf %02d $i) wake)")"); done; serve "${ELEVEN[@]}"; tick >/dev/null
check "only the first 10 tickets of a poll are processed" test "$(allres | wc -l | tr -d ' ')" = 10

# 3. one case per reject reason (outcome rejected, detail = the exact reason string, nothing runs)
G=00000000-0000-4000-8000-000000000f
T0="$(tk ${G}01 wake)"
one "${T0%\}},\"decision_id\":\"d\"}"; check "malformed: extra field (decision_id)" rejected malformed
one "$(tk ${G}02 wake | sed 's/,"nonce":"[^"]*"//')"; check "malformed: missing field (nonce)" rejected malformed
one "$(tk ${G}03 wake | sed 's/"v":1/"v":2/')"; check "malformed: v=2" rejected malformed
one "$(tk ${G}04 wake | sed 's/"v":1/"v":"1"/')"; check "malformed: v=\"1\" (string)" rejected malformed
one "$(tk ${G}05 wake | sed 's/"v":1/"v":true/')"; check "malformed: v=true" rejected malformed
one "$(tk ${G}06 wake "" "2026-10-06T10:00:00.00Z")"; check "malformed: timestamp with 2 fractional digits" rejected malformed
one "$(tk ${G}07 wake "" "2026-10-06T10:00:00Z")"; check "malformed: timestamp without fraction" rejected malformed
one "$(tk ${G}08 wake "" "" "2026-10-06T10:05:00.0000Z")"; check "malformed: timestamp with 4 fractional digits" rejected malformed
one "$(tk ${G}09 wake "" "2026-10-06T10:00:00.000+00:00")"; check "malformed: timestamp with an offset instead of Z" rejected malformed
one "$(tk ${G}10 wake "" "" "" "" AAAAAAAAAAAAAAAAAAAAA)"; check "malformed: nonce 21 chars" rejected malformed
one "$(tk ${G}11 wake "" "" "" "" AAAAAAAAAAAAAAAAAAAAAAA)"; check "malformed: nonce 23 chars" rejected malformed
one "$(tk ${G}12 wake "" "" "" "" 'AAAAAAAAAAAAAAAAAAAA+/')"; check "malformed: nonce with + / (not base64url)" rejected malformed
one "$(tk ${G}13 wake "" "" "" '{"a":{"B":1}}')"; check "malformed: key at depth 2 breaks the regex (B)" rejected malformed
one "$(tk ${G}14 wake "" "" "" '{"1x":1}')"; check "malformed: key \"1x\"" rejected malformed
one "$(tk ${G}15 wake "" "" "" '{"a":[{"x-y":1}]}')"; check "malformed: bad key inside an array of objects" rejected malformed
one "$(tk ${G}16 wake "" "" "2026-10-06T10:15:00.001Z")"; check "malformed: ttl 900.001 s" rejected malformed
one "$(tk ${G}17 wake "" "" "2026-10-06T10:00:00.000Z")"; check "malformed: expires_at == issued_at" rejected malformed
one "$(tk ${G}18 wake "" "" "2026-10-06T09:59:00.000Z")"; check "malformed: expires_at before issued_at" rejected malformed
one "$(tk ${G}19 wake | sed 's/"params":{}/"params":[]/')"; check "malformed: params not an object" rejected malformed
one "$(tk ${G}20 wake | sed 's/"ticket_id":"[^"]*"/"ticket_id":""/')"; check "malformed: empty ticket_id" rejected malformed
reset; echo '{"ok":true,"key_id":"6275a79b","tickets":[5,"x",{"ticket":5}]}' > "$T/resp"; tick >/dev/null
check "malformed: tickets that are not objects" test "$(allres | cut -d'|' -f2,3 | sort -u)" = "rejected|malformed"
reset; serve "$(sign "$(tk ${G}21 wake "" "" "2026-10-06T10:15:00.000Z")")"; tick >/dev/null
check "ttl exactly 900 s is accepted" test "$(res)" = "done|caffeinate_u"

one "$(tk ${G}30 wake)" "$SEED2"; check "bad_signature: signed by another key" rejected bad_signature
reset; env_=$(sign "$(tk ${G}31 wake)"); serve "${env_//\"wake\"/\"open_pulse\"}"; tick >/dev/null
check "bad_signature: action changed after signing" rejected bad_signature
for m in short87 long89 url unpadded noncanon space junk empty; do
  reset; serve "$(sign "$(tk ${G}4$((RANDOM%10)) wake)" | mutsig $m)"; tick >/dev/null
  check "bad_signature: signature variant '$m'" rejected bad_signature
done
reset; serve "$(sign "$(tk ${G}50 wake)" | sed 's/"signature"/"sig"/')"; tick >/dev/null
check "bad_signature: the 'sig' alias is not accepted" rejected bad_signature
reset; serve "$(sign "$(tk ${G}51 wake)" | sed 's/,"signature":"[^"]*"//; s/"signature":"[^"]*",//')"; tick >/dev/null
check "bad_signature: signature missing" rejected bad_signature
reset; env_=$(sign "$(tk ${G}52 wake)"); serve "$(python3 -c 'import json,sys;e=json.loads(sys.argv[1]);e["signature"]=e["signature"]+e["signature"];print(json.dumps(e))' "$env_")"; tick >/dev/null
check "bad_signature: two signatures concatenated" rejected bad_signature
check "bad_signature: the ticket is not entered in the replay store" bash -c "[ ! -s '$ST/steward_replay' ]"

NOW_T=$EXP_E one "$(tk ${G}60 wake)"; check "expired: expires_at == now (no grace)" rejected expired
NOW_T=$((EXP_E + 1)) one "$(tk ${G}61 wake)"; check "expired: now = expires_at + 1 s" rejected expired
NOW_T=$((EXP_E - 1)) one "$(tk ${G}62 wake)"; check "not expired: now = expires_at - 1 s runs" test "$(res)" = "done|caffeinate_u"
NOW_T=$((ISS_E - 500)) one "$(tk ${G}63 wake)"; check "an issued_at in the future is not rejected (no not_yet_valid)" test "$(res)" = "done|caffeinate_u"
check "not_yet_valid does not exist in the script" bash -c "! grep -q not_yet_valid '$STEW'"

one "$(tk ${G}70 format_disk)"; check "action_not_allowed: unknown action" rejected action_not_allowed
one "$(tk ${G}71 WAKE)"; check "action_not_allowed: case differs" rejected action_not_allowed
one "$(tk ${G}72 'wake;id')"; check "action_not_allowed: injection text" rejected action_not_allowed

one "$(tk ${G}80 wake "" "" "" '{"x":1}')"; check "bad_params: wake with a key" rejected bad_params
one "$(tk ${G}81 restart_kiosk_health "" "" "" '{"profile":"Default"}')"; check "bad_params: restart_kiosk_health with profile" rejected bad_params
one "$(tk ${G}82 open_pulse)"; check "bad_params: open_pulse without profile" rejected bad_params
one "$(tk ${G}83 open_pulse "" "" "" '{"profile":""}')"; check "bad_params: empty profile" rejected bad_params
one "$(tk ${G}84 open_pulse "" "" "" "{\"profile\":\"$(printf 'a%.0s' $(seq 1 65))\"}")"; check "bad_params: profile of 65 chars" rejected bad_params
one "$(tk ${G}85 open_pulse "" "" "" '{"profile":"Default","extra":1}')"; check "bad_params: extra key beside profile" rejected bad_params
one "$(tk ${G}86 policy_cycle "" "" "" '{"profile":5}')"; check "bad_params: profile not a string" rejected bad_params
one "$(tk ${G}87 relaunch_chrome "" "" "" '{"profile":["Default"]}')"; check "bad_params: profile an array" rejected bad_params

one "$(tk ${G}90 wake OTHER-MAC)"; check "machine_mismatch: another machine" rejected machine_mismatch
check "machine_mismatch: the result carries the ticket's machine" test "$(allres | cut -d'|' -f4)" = OTHER-MAC
one "$(tk ${G}91 wake "${MACH}x")"; check "machine_mismatch: lookalike" rejected machine_mismatch
one "$(tk ${G}92 wake "$(printf '%s' "$MACH" | tr 'a-z' 'A-Z')")"; check "machine_mismatch: case differs" rejected machine_mismatch

# 4. check order, pairwise: first failure wins
BADKEY='{"B":1}'
one "$(tk ${G}a0 wake "" "" "" "$BADKEY")" "$SEED2"; check "order: malformed beats bad_signature" rejected malformed
NOW_T=$((EXP_E + 5)) one "$(tk ${G}a1 wake)" "$SEED2"; check "order: bad_signature beats expired" rejected bad_signature
NOW_T=$((EXP_E + 5)) one "$(tk ${G}a2 wake OTHER-MAC)"; check "order: expired beats machine_mismatch" rejected expired
NOW_T=$((EXP_E + 5)) one "$(tk ${G}a3 format_disk)"; check "order: expired beats action_not_allowed" rejected expired
one "$(tk ${G}a4 format_disk OTHER-MAC "" "" '{"x":1}')"; check "order: action_not_allowed beats bad_params and machine" rejected action_not_allowed
one "$(tk ${G}a5 wake OTHER-MAC "" "" '{"x":1}')"; check "order: bad_params beats machine_mismatch" rejected bad_params
one "$(tk ${G}a6 wake OTHER-MAC "" "" "$BADKEY")" "$SEED2"; check "order: malformed beats everything" rejected malformed

# 5. envelope
reset; serve "$(sign "$(tk ${G}b0 wake)")"; sed -i '' 's/6275a79b/deadbeef/' "$T/resp"; out="$(tick)"; out2="$(tick)"
check "key_id mismatch: nothing processed" bash -c "! grep -q caffeinate '$T/calls' && [ ! -s '$T/posts.log' ]"
check "key_id mismatch: logged once, not on every tick" bash -c "[ \$(grep -c 'key_id_mismatch' <<< \"$out\") = 1 ] && ! grep -q 'key_id_mismatch' <<< \"$out2\""
reset; printf '[%s]' "$(sign "$(tk ${G}b1 wake)")" > "$T/resp"; tick >/dev/null
check "bare array (no envelope): nothing processed" bash -c "! grep -q caffeinate '$T/calls'"
reset; serve "$(sign "$(tk ${G}b2 wake)")"; sed -i '' 's/"ok":true/"ok":false/' "$T/resp"; tick >/dev/null
check "ok:false envelope: nothing processed" bash -c "! grep -q caffeinate '$T/calls'"
reset; serve "$(sign "$(tk ${G}b3 wake)")"; sed -i '' 's/"ok":true,//' "$T/resp"; tick >/dev/null
check "envelope without ok: nothing processed" bash -c "! grep -q caffeinate '$T/calls'"
reset; echo 'not json' > "$T/resp"; out="$(tick)"
check "non-JSON 200 body: nothing processed, no crash" bash -c "! grep -q caffeinate '$T/calls'"
for code in 401 400 500 503 404 302 301; do
  reset; serve "$(sign "$(tk ${G}c0 wake)")"; echo $code > "$T/getcode"; out="$(tick)"
  check "poll status $code: log status only, no action, no result" bash -c "grep -q 'poll status=$code' <<< \"$out\" && ! grep -q caffeinate '$T/calls' && [ ! -s '$T/posts.log' ]"
done

# 6. trust anchor
reset; serve "$(sign "$(tk ${G}d0 wake)")"; out="$(tick STEWARD_PEM_SHA256=0000000000000000000000000000000000000000000000000000000000000000)"
check "baked PEM sha mismatch: no tickets run, no poll, logged" bash -c "! grep -q caffeinate '$T/calls' && grep -q 'sha256 mismatch' <<< \"$out\" && ! grep -q steward.invalid '$T/curl.args'"
reset; serve "$(sign "$(tk ${G}d1 wake)")"; out="$(tick STEWARD_PEM_OVERRIDE=$T/missing.pem)"
check "PEM missing: no tickets run" bash -c "! grep -q caffeinate '$T/calls'"
reset; serve "$(sign "$(tk ${G}d2 wake)")"; out="$(tick STEWARD_TEST_MODE=0)"
check "production mode: env PEM/pin overrides ignored, shipped path absent -> nothing runs" bash -c "! grep -q caffeinate '$T/calls' && grep -q 'sha256 mismatch' <<< \"$out\""
reset; serve "$(sign "$(tk ${G}d3 wake)" "$SEED2")"; out="$(tick STEWARD_PEM_OVERRIDE=$T/pub2.pem STEWARD_PEM_SHA256=$(shasum -a 256 "$T/pub2.pem" | awk '{print $1}'))"
check "the pinned key is what decides trust (other pinned key verifies its own tickets)" test "$(res)" = "done|caffeinate_u"
check "script pins the contract sha256" grep -q '21bd841f301e46cc03c2737ebdc59e09e98c60fa8c76efcc98583f38242c6c3c' "$STEW"
check "helper pins key_id 6275a79b" grep -q '6275a79b' "$HERE/steward-verify/main.swift"
check "no pubkey env/config path in the script" bash -c "! grep -v '^ *#' '$STEW' | grep -q 'STEWARD_PUBKEY\|steward_pubkey'"

# 7. non-ASCII param (canonical form keeps UTF-8 raw)
reset; serve "$(sign "$(tk ${G}e0 open_pulse "" "" "" '{"profile":"Profilé 1"}')")"; tick >/dev/null
check "non-ASCII profile verifies (raw UTF-8 in the canonical bytes) and opens" has "$(calls)" "--profile-directory=Profilé 1 https://pulse.even.in/"

# 8. open_pulse / relaunch_chrome (idle-gated, profile must exist)
PAR='{"profile":"Profile 1"}'
reset; serve "$(sign "$(tk ${G}f0 open_pulse "" "" "" "$PAR")")"; tick >/dev/null
check "open_pulse: binary handoff with the profile, Chrome not quit" has "$(calls)" "launchctl asuser 501 sudo -u kiosk /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Profile 1 https://pulse.even.in/"
check "open_pulse: no pkill" no "$(calls)" "pkill"
check "open_pulse: done" test "$(res)" = "done|opened_Profile 1"
reset; serve "$(sign "$(tk ${G}f1 open_pulse "" "" "" "$PAR")")"; IDLE=599 tick >/dev/null
check "open_pulse: idle 599 -> failed not_idle, nothing run" bash -c "[ \"$(res)\" = 'failed|not_idle_599s' ] && [ ! -s '$T/calls' ]"
reset; serve "$(sign "$(tk ${G}f2 open_pulse "" "" "" "$PAR")")"; IDLE=600 tick >/dev/null
check "open_pulse: idle exactly 600 -> runs" grep -q asuser "$T/calls"
reset; serve "$(sign "$(tk ${G}f3 open_pulse "" "" "" '{"profile":"Profile 9"}')")"; tick >/dev/null
check "open_pulse: missing profile dir -> failed profile_not_found" bash -c "[ \"$(res)\" = 'failed|profile_not_found' ] && [ ! -s '$T/calls' ]"
reset; serve "$(sign "$(tk ${G}f4 open_pulse "" "" "" '{"profile":"../x"}')")"; tick >/dev/null
check "open_pulse: path-like profile -> failed, nothing run" bash -c "[ \"$(res | cut -d'|' -f1)\" = failed ] && [ ! -s '$T/calls' ]"
reset; touch "$T/chrome_down"; serve "$(sign "$(tk ${G}f5 open_pulse "" "" "" "$PAR")")"; tick >/dev/null
check "open_pulse: Chrome not running -> open -a with --args profile" has "$(calls)" 'sudo -u kiosk open -a Google Chrome --args --profile-directory=Profile 1 https://pulse.even.in/'
reset; serve "$(sign "$(tk ${G}f6 relaunch_chrome "" "" "" "$PAR")")"; tick >/dev/null
check "relaunch_chrome: TERM then open on the profile" bash -c "grep -q 'pkill -TERM -x Google Chrome' '$T/calls' && grep -q 'profile-directory=Profile 1' '$T/calls'"
reset; serve "$(sign "$(tk ${G}f7 relaunch_chrome "" "" "" "$PAR")")"; IDLE=10 tick >/dev/null
check "relaunch_chrome: not idle -> failed, Chrome untouched" bash -c "[ \"$(res)\" = 'failed|not_idle_10s' ] && [ ! -s '$T/calls' ]"
reset; echo "1000 5" > "$T/idleseq"; serve "$(sign "$(tk ${G}f8 relaunch_chrome "" "" "" "$PAR")")"; tick HID_IDLE_OVERRIDE= >/dev/null
check "C10 relaunch_chrome: console active right before the kill -> failed console_active_midcycle, Chrome not killed" bash -c "[ \"$(res)\" = 'failed|console_active_midcycle' ] && ! grep -q pkill '$T/calls'"

# 9. policy_cycle
reset; serve "$(sign "$(tk ${G}g0 policy_cycle "" "" "" "$PAR")")"; out="$(tick)"
check "policy_cycle: plist content restored" test "$(cat "$MP")" = POLICY
check "policy_cycle: no aside copy left" test ! -e "$ST/com.google.Chrome.plist.steward-aside"
check "policy_cycle: guard booted out then bootstrapped" bash -c "grep -q 'bootout system/com.eta.presence-guard' '$T/calls' && grep -q 'bootstrap system /Library/LaunchDaemons/com.eta.presence-guard.plist' '$T/calls'"
check "policy_cycle: cfprefsd flushed" grep -q "killall cfprefsd" "$T/calls"
check "policy_cycle: new version dir installed -> done" test "$(res)" = "done|installed_0.1.1.39"
check "policy_cycle: guard loaded afterwards" test -f "$T/loaded"
reset; serve "$(sign "$(tk ${G}g1 policy_cycle "" "" "" "$PAR")")"; tick KILL_SELF=1 >/dev/null
check "policy_cycle: SIGTERM mid-run -> trap restores plist" test "$(cat "$MP" 2>/dev/null)" = POLICY
check "policy_cycle: SIGTERM mid-run -> guard re-bootstrapped" test -f "$T/loaded"
reset; serve "$(sign "$(tk ${G}g2 policy_cycle "" "" "" "$PAR")")"; IDLE=5 tick >/dev/null
check "policy_cycle: not idle at the start -> failed, guard and plist untouched" bash -c "[ ! -s '$T/calls' ] && [ \"\$(cat '$MP')\" = POLICY ]"
# C10: idle sequence = ticket gate, before kill 1, before kill 2
reset; echo "1000 1000 5" > "$T/idleseq"; serve "$(sign "$(tk ${G}g3 policy_cycle "" "" "" "$PAR")")"; tick HID_IDLE_OVERRIDE= >/dev/null
check "C10 policy_cycle: activity before the 2nd kill -> failed console_active_midcycle" test "$(res)" = "failed|console_active_midcycle"
check "C10 policy_cycle: plist back, guard bootstrapped, cfprefsd flushed" bash -c "[ \"\$(cat '$MP')\" = POLICY ] && [ -f '$T/loaded' ] && grep -q 'bootstrap system' '$T/calls' && grep -q 'killall cfprefsd' '$T/calls'"
check "C10 policy_cycle: Chrome running at the abort -> nothing launched after the restore" bash -c "lb=\$(grep -n 'bootstrap system' '$T/calls' | tail -1 | cut -d: -f1); la=\$(grep -n '^launchctl asuser' '$T/calls' | tail -1 | cut -d: -f1); [ -n \"\$lb\" ] && { [ -z \"\$la\" ] || [ \"\$la\" -lt \"\$lb\" ]; }"
check "C10 policy_cycle: the second Chrome kill never happened" test "$(grep -c 'pkill -TERM' "$T/calls")" = 1
reset; echo "1000 5" > "$T/idleseq"; serve "$(sign "$(tk ${G}g4 policy_cycle "" "" "" "$PAR")")"; tick HID_IDLE_OVERRIDE= >/dev/null
check "C10 policy_cycle: activity before the 1st kill -> failed, restored, Chrome never killed" bash -c "[ \"$(res)\" = 'failed|console_active_midcycle' ] && ! grep -q pkill '$T/calls' && [ \"\$(cat '$MP')\" = POLICY ] && [ -f '$T/loaded' ]"

# C10, Chrome dead at the abort: exactly one launch, on the profile, without the Pulse URL
reset; echo "1000 1000 5" > "$T/idleseq"; touch "$T/chrome_down"; serve "$(sign "$(tk ${G}g5 policy_cycle "" "" "" "$PAR")")"; tick HID_IDLE_OVERRIDE= >/dev/null
check "C10 policy_cycle: Chrome dead at the abort -> failed console_active_midcycle" test "$(res)" = "failed|console_active_midcycle"
check "C10 policy_cycle: Chrome dead -> one launch after the restore, profile only, no Pulse URL" bash -c "lb=\$(grep -n 'bootstrap system' '$T/calls' | tail -1 | cut -d: -f1); n=\$(tail -n +\$((lb+1)) '$T/calls' | grep -c '^launchctl asuser'); [ \"\$n\" = 1 ] && tail -n +\$((lb+1)) '$T/calls' | grep '^launchctl asuser' | grep -q 'open -a Google Chrome --args --profile-directory=Profile 1\$' "
check "C10 policy_cycle: Chrome dead -> plist restored and guard loaded" bash -c "[ \"\$(cat '$MP')\" = POLICY ] && [ -f '$T/loaded' ]"
reset; echo "1000 5" > "$T/idleseq"; touch "$T/chrome_down"; serve "$(sign "$(tk ${G}g6 policy_cycle "" "" "" "$PAR")")"; tick HID_IDLE_OVERRIDE= >/dev/null
check "C10 policy_cycle: abort before the 1st kill, Chrome dead -> still exactly one launch, no URL" bash -c "[ \$(grep -c '^launchctl asuser' '$T/calls') = 1 ] && grep '^launchctl asuser' '$T/calls' | grep -q 'profile-directory=Profile 1\$' && ! grep -q pulse.even.in '$T/calls'"

# 10. recorder / kiosk-health
LBL=com.evenscribe.recorder
reset; serve "$(sign "$(tk ${G}h0 restart_recorder_app)")"; tick STEWARD_RECORDER_LABEL=$LBL >/dev/null
check "recorder: closed session -> kickstart gui domain, done" bash -c "grep -q 'launchctl kickstart -k gui/501/$LBL' '$T/calls' && [ \"$(res)\" = 'done|kickstart_gui' ]"
reset; printf '{"state":"recording","session_id":"s"}' > "$RDIR/status.json"; serve "$(sign "$(tk ${G}h1 restart_recorder_app)")"; tick STEWARD_RECORDER_LABEL=$LBL >/dev/null
check "recorder: open session -> failed session_open, no restart" bash -c "[ \"$(res)\" = 'failed|session_open' ] && [ ! -s '$T/calls' ]"
reset; rm -f "$RDIR/status.json"; serve "$(sign "$(tk ${G}h2 restart_recorder_app)")"; tick STEWARD_RECORDER_LABEL=$LBL >/dev/null
check "recorder: status.json absent -> fail closed" bash -c "[ \"$(res)\" = 'failed|session_unknown' ] && [ ! -s '$T/calls' ]"
reset; printf 'not json' > "$RDIR/status.json"; serve "$(sign "$(tk ${G}h3 restart_recorder_app)")"; tick STEWARD_RECORDER_LABEL=$LBL >/dev/null
check "recorder: status.json unparseable -> fail closed" bash -c "[ \"$(res)\" = 'failed|session_unknown' ] && [ ! -s '$T/calls' ]"
reset; mkdir -p "$RDIR/captures/s1/seg"; touch "$RDIR/captures/s1/seg/tape.pcm"; serve "$(sign "$(tk ${G}h4 restart_recorder_app)")"; tick STEWARD_RECORDER_LABEL=$LBL >/dev/null
check "recorder: idle status but fresh tape file -> failed" bash -c "[ \"$(res)\" = 'failed|session_open_tape_recent' ] && [ ! -s '$T/calls' ]"
rm -rf "${RDIR:?}/captures"
reset; serve "$(sign "$(tk ${G}h5 restart_recorder_app)")"; tick >/dev/null
check "recorder: label unset -> failed recorder_label_unset" bash -c "[ \"$(res)\" = 'failed|recorder_label_unset' ] && [ ! -s '$T/calls' ]"
reset; serve "$(sign "$(tk ${G}h6 restart_kiosk_health)")"; tick >/dev/null
check "kiosk-health: kickstart -k system/com.evenscribe.kiosk-health, done" bash -c "grep -q 'launchctl kickstart -k system/com.evenscribe.kiosk-health' '$T/calls' && [ \"$(res)\" = 'done|kickstart_system' ]"

# 11. expiry while waiting: two tickets in one poll, each `date +%s` call advances 30 s (poll at +60, ticket 1 at +90, ticket 2 at +120)
reset; echo $((ISS_E + 60)) > "$T/dateseq"
serve "$(sign "$(tk ${G}i0 wake "" "" "2026-10-06T10:02:00.000Z")")" "$(sign "$(tk ${G}i1 wake "" "" "2026-10-06T10:01:40.000Z")")"
tick NOW_OVERRIDE= >/dev/null
check "expired mid-wait: first ticket runs once" test "$(grep -c caffeinate "$T/calls")" = 1
check "expired mid-wait: second ticket reported expired, detail says so" has "$(allres)" "${G}i1|expired|expired_before_execution"

# 12. detail truncation (<= 2048 bytes, ends in an ellipsis on a character boundary)
LONG="$(printf 'a%.0s' $(seq 1 3000))"
tr_out="$(STEWARD_SOURCE_ONLY=1 STEWARD_TEST_MODE=1 bash -c "source '$STEW'; truncate_detail '$LONG'")"
check "detail of 3000 bytes truncated to <= 2048 bytes" test "$(printf '%s' "$tr_out" | wc -c | tr -d ' ')" -le 2048
check "truncated detail ends in the ellipsis character" bash -c "[[ \"$tr_out\" == *… ]]"
tr_short="$(STEWARD_SOURCE_ONLY=1 STEWARD_TEST_MODE=1 bash -c "source '$STEW'; truncate_detail short")"
check "short detail unchanged" test "$tr_short" = short

# 13. transport behaviour
reset; serve "$(sign "$(tk ${G}j0 wake)")"; touch "$T/postfail"; tick >/dev/null
check "post failure: result kept in outbox" test -s "$ST/steward_outbox.jsonl"
rm -f "$T/postfail"; echo '{"ok":true,"key_id":"6275a79b","tickets":[]}' > "$T/resp"; : > "$T/posts.log"; tick >/dev/null
check "post retry next tick: delivered and outbox cleared" bash -c "grep -q ${G}j0 '$T/posts.log' && [ ! -s '$ST/steward_outbox.jsonl' ]"
reset; printf '{"machine":"%s","token":"%s"}\n' "$MACH" "$TOKEN" > "$CFG"; serve "$(sign "$(tk ${G}j1 wake)")"; tick >/dev/null
check "config without steward_pubkey works" grep -q caffeinate "$T/calls"

# 14. aside recovery / token handling
reset; echo POLICY > "$ST/com.google.Chrome.plist.steward-aside"; rm -f "$MP"; rm -f "$T/loaded"; echo '{"ok":true,"key_id":"6275a79b","tickets":[]}' > "$T/resp"; out="$(tick)"
check "recover: ordinary tick puts the aside plist back" test "$(cat "$MP" 2>/dev/null)" = POLICY
check "recover: aside copy gone, cfprefsd flushed, guard bootstrapped" bash -c "[ ! -e '$ST/com.google.Chrome.plist.steward-aside' ] && grep -q 'killall cfprefsd' '$T/calls' && grep -q 'bootstrap system' '$T/calls' && [ -f '$T/loaded' ]"
reset; echo '{"ok":true,"key_id":"6275a79b","tickets":[]}' > "$T/resp"; tick >/dev/null
check "recover: nothing to recover -> no launchctl/killall" bash -c "[ ! -s '$T/calls' ]"
printf '{"machine":"%s","token":"%s"}\n' "$MACH" 'ab\"c\\d' > "$CFG"
reset; echo '{"ok":true,"key_id":"6275a79b","tickets":[]}' > "$T/resp"; tick >/dev/null
check "token with quote and backslash is escaped in the curl config line" grep -qF 'header = "Authorization: Bearer ab\"c\\d"' "$T/curl.stdin"
printf '{"machine":"%s","token":"abc\\ndef"}\n' "$MACH" > "$CFG"
reset; echo '{"ok":true,"key_id":"6275a79b","tickets":[]}' > "$T/resp"; out="$(tick)"
check "token with a newline: refused, nothing sent" bash -c "[ ! -s '$T/curl.stdin' ] && grep -q 'bad token' <<< \"$out\""
printf '{"machine":"%s","token":"%s","sink_url":"https://sink.invalid/api/kiosk-health"}\n' "$MACH" "$TOKEN" > "$CFG"

# 15. outcome vocabulary, secrets, banned things
check "outcomes are done|failed|rejected|expired only (no ok/refused/unsupported on the Mac)" bash -c "! grep -nE 'queue_result [^ ]+ [^ ]+ (ok|refused|unsupported)' '$STEW'"
reset; serve "$(sign "$(tk ${G}k0 wake)")"; out="$(tick)"
check "no token in tick output" no "$out" "$TOKEN"
check "no token in state dir" bash -c "! grep -rq '$TOKEN' '$ST'"
check "no token in posted events" bash -c "! grep -q '$TOKEN' '$T/posts.log'"
check "script has no python3/osascript" bash -c "! grep -E '^[^#]*(python3|osascript)' '$STEW'"
check "script never names Preferences/Cookies/Login Data (except Managed Preferences)" bash -c "! grep -v '^ *#' '$STEW' | grep -E 'Preferences|Cookies|Login Data' | grep -qv 'Managed Preferences'"
check "script never opens the private key" bash -c "! grep -qi 'ticket-private' '$STEW'"

# 17. review fixes: anchoring, ASCII digits, no env path to the verifier
one "$(tk ${G}m0 wake "" "" "" "" 'AAAAAAAAAAAAAAAAAAAAAA\n')"; check "malformed: nonce with a trailing newline" rejected malformed
one "$(tk ${G}m1 wake "" "" "" '{"a\n":1}')"; check "malformed: key with a trailing newline" rejected malformed
one "$(tk ${G}m2 wake "" "2026-10-06T10:00:00.000Z\n")"; check "malformed: issued_at with a trailing newline" rejected malformed
one "$(tk ${G}m3 wake "" "२०२६-10-06T10:00:00.000Z")"; check "malformed: issued_at in Devanagari digits" rejected malformed
one "$(tk ${G}m4 wake)" ; reset; serve "$(sign "$(tk 'abc\n' wake)")"; tick >/dev/null
check "malformed: ticket_id with a trailing newline" rejected malformed
reset; serve "$(sign "$(tk ${G}m5 wake)")"; out="$(tick STEWARD_VERIFY_OVERRIDE=/usr/bin/false STEWARD_VERIFY=/usr/bin/false STEWARD_URL=https://evil.invalid/t STEWARD_TEST_MODE=0 STEWARD_PEM_OVERRIDE=$T/pub.pem)"
check "production mode ignores verifier/url env (nothing runs, evil URL never polled)" bash -c "! grep -q caffeinate '$T/calls' && ! grep -q evil.invalid '$T/curl.args'"
check "no bare STEWARD_VERIFY / STEWARD_URL env default in the script" bash -c "! grep -E '^STEWARD_(VERIFY|URL)=\"\\$\\{STEWARD_(VERIFY|URL):-' '$STEW'"

# 18. duplicate JSON keys anywhere in the ticket document are malformed (both wire orders); other tickets in the poll still run
dupone() { # dupone <sed-expr> <ticket>: sign, inject a duplicate key into the wire text, one tick
  reset; local e; e="$(sign "$2")"; e="$(printf '%s' "$e" | sed "$1")"; serve "$e"; tick >/dev/null
}
DT="$(tk ${G}n0 wake)"
dupone 's/"action":"wake"/"action":"wake","action":"wake"/' "$DT"; check "duplicate top-level key (same value, after)" rejected malformed
dupone 's/"action":"wake"/"action":"format_disk","action":"wake"/' "$DT"; check "duplicate top-level key (other value first, signed last wins)" rejected malformed
dupone 's/"action":"wake"/"action":"wake","action":"format_disk"/' "$DT"; check "duplicate top-level key (other value last)" rejected malformed
dupone 's/"action":"wake"/"\\u0061ction":"wake","action":"wake"/' "$DT"; check "duplicate key through a \\u escape (\\u0061ction == action)" rejected malformed
DP="$(tk ${G}n1 open_pulse "" "" "" '{"profile":"Profile 1"}')"
dupone 's/"profile":"Profile 1"/"profile":"Profile 1","profile":"Profile 1"/' "$DP"; check "duplicate key inside params (same value)" rejected malformed
dupone 's/"profile":"Profile 1"/"profile":"Other","profile":"Profile 1"/' "$DP"; check "duplicate key inside params (other value first)" rejected malformed
dupone 's/"profile":"Profile 1"/"profile":"Profile 1","profile":"Other"/' "$DP"; check "duplicate key inside params (other value last)" rejected malformed
dupone 's/"signature":"/"signature":"x","signature":"/' "$DT"; check "duplicate key in the ticket envelope item (signature)" rejected malformed
reset; serve "$(sign "$(tk ${G}n2 wake)")"; sed -i '' 's/"ok":true/"ok":true,"ok":true/' "$T/resp"; out="$(tick)"
check "duplicate key at the poll root: envelope refused, nothing runs" bash -c "! grep -q caffeinate '$T/calls' && grep -q 'envelope_shape' <<< \"$out\""
reset; E1="$(sign "$(tk ${G}n3 wake)" | sed 's/"action":"wake"/"action":"wake","action":"wake"/')"; E2="$(sign "$(tk ${G}n4 wake)")"; serve "$E1" "$E2"; tick >/dev/null
check "a duplicate key spoils only its own ticket: the second ticket still runs" bash -c "grep -q '${G}n3|rejected|malformed' <<< \"$(allres)\" && grep -q '${G}n4|done|caffeinate_u' <<< \"$(allres)\" && [ \$(grep -c caffeinate '$T/calls') = 1 ]"
# 16. golden vectors from the reference signer (must pass when present; the real public PEM is a public file)
GOLD="$HOME/oc/eta-steward/golden"; REALPEM="$HOME/oc/eta-steward/ticket-public.pem"
if [ -n "$(ls "$GOLD" 2>/dev/null)" ] && [ -f "$REALPEM" ]; then
  check "golden vectors (canonical bytes, signatures, negatives, expiry)" python3 -I "$HERE/tests-steward/golden.py" "$T/steward-verify" "$T/steward-sign" "$REALPEM" "$GOLD"
  check "PEM shipped in the repo (steward-verify/steward-public.pem.txt) equals the pinned sha" test "$(shasum -a 256 "$HERE/steward-verify/steward-public.pem.txt" | awk '{print $1}')" = 21bd841f301e46cc03c2737ebdc59e09e98c60fa8c76efcc98583f38242c6c3c
else echo "golden vectors pending (none in $GOLD)"; fi

printf '\nSUMMARY: PASS=%d FAIL=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
