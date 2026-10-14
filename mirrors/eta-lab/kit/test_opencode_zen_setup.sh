#!/bin/bash
# Test of kit/opencode-zen-setup.sh on INVENTED data in a temp HOME (no real key, no network needed beyond opencode's model list).
# usage: kit/test_opencode_zen_setup.sh [path-to-opencode-binary]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BIN="${1:-$HOME/.local/bin/opencode}"; T="$(mktemp -d)"
mkdir -p "$T/.claude/secrets" "$T/.config/opencode"; printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$T/.config/opencode/opencode.jsonc"
run(){ HOME="$T" OPENCODE_BIN="$BIN" bash "$HERE/opencode-zen-setup.sh"; }
fail(){ echo "FAIL: $1"; exit 1; }
run >/dev/null; [ $? -eq 3 ] || fail "missing key must exit 3"; grep -q apiKey "$T/.config/opencode/opencode.jsonc" && fail "config changed with no key"
printf 'invented-key-111\n' > "$T/.claude/secrets/opencode_zen_key"; chmod 644 "$T/.claude/secrets/opencode_zen_key"
run >/dev/null; [ $? -eq 4 ] || fail "mode 644 must exit 4"; grep -q apiKey "$T/.config/opencode/opencode.jsonc" && fail "config changed with a 644 key file"
chmod 600 "$T/.claude/secrets/opencode_zen_key"
run >/dev/null; [ $? -eq 0 ] || fail "valid key file must exit 0"
grep -q "invented-key-111" "$T/.config/opencode/opencode.jsonc" && fail "the key VALUE is in the config"
grep -q "{file:$T/.claude/secrets/opencode_zen_key}" "$T/.config/opencode/opencode.jsonc" || fail "config must hold the {file:} path"
run >/dev/null; [ $? -eq 0 ] || fail "second run must be idempotent"
[ "$(stat -c %a "$T/.config/opencode/opencode.jsonc" 2>/dev/null || stat -f %Lp "$T/.config/opencode/opencode.jsonc")" = "600" ] || fail "config mode must be 600"
# a .jsonc with a comment: python cannot parse it -> exit 6, config untouched, no success message
printf '{\n  // a comment\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$T/.config/opencode/opencode.jsonc"; cp "$T/.config/opencode/opencode.jsonc" "$T/before.jsonc"
out=$(run 2>&1); rc=$?; [ $rc -eq 6 ] || fail "a config with a comment must exit 6, got $rc"; cmp -s "$T/before.jsonc" "$T/.config/opencode/opencode.jsonc" || fail "unparseable config was changed"
echo "$out" | grep -q "config points at the key file" && fail "success message printed after a parse failure"
# the first successful run keeps a one-time backup of the previous config
[ -e "$T/.config/opencode/opencode.jsonc.bak-zen" ] || fail "one-time backup missing"
# a stub opencode whose model list never grows with the config (a key that did not take): the count is not above the no-key baseline -> exit 5
printf '#!/bin/bash\nfor i in 1 2 3 4 5 6 7 8; do echo "opencode/free-$i"; done\n' > "$T/stub"; chmod +x "$T/stub"; printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$T/.config/opencode/opencode.jsonc"
HOME="$T" OPENCODE_BIN="$T/stub" bash "$HERE/opencode-zen-setup.sh" >/dev/null 2>&1; [ $? -eq 5 ] || fail "a count not above the no-key baseline must exit 5"
echo "opencode-zen-setup tests OK (missing -> 3, mode 644 -> 4, ok -> path only / no key value / idempotent / config 600, comment in .jsonc -> 6 untouched, one-time backup, count not above the no-key baseline -> 5)"
