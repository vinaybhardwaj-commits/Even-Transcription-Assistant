#!/bin/bash
# opencode-zen-setup — point OpenCode's Zen provider at V's key FILE (r388 update, 25 Sep). Idempotent. Never reads, prints or copies the key.
# Applies ONLY when the key file exists, is non-empty and mode 600: OpenCode treats a {file:} reference to a missing file as an INVALID CONFIG and would break every run.
# NEVER run `opencode debug config` after this: it prints the resolved key.
# Exit codes: 0 ok | 3 key file missing | 4 key file mode not 600 | 5 Zen model count not above the no-key baseline | 6 config could not be parsed/written (left untouched)
set -u
KEYFILE="${OPENCODE_ZEN_KEYFILE:-$HOME/.claude/secrets/opencode_zen_key}"
CONF="${OPENCODE_CONFIG_FILE:-$HOME/.config/opencode/opencode.jsonc}"
BIN="${OPENCODE_BIN:-$HOME/.local/bin/opencode}"
count(){ "$BIN" models opencode 2>/dev/null | grep -c '^opencode/'; }
[ -s "$KEYFILE" ] || { echo "opencode-zen-setup: key file not present yet (config left unchanged)"; exit 3; }
mode=$(stat -c %a "$KEYFILE" 2>/dev/null || stat -f %Lp "$KEYFILE")
[ "$mode" = "600" ] || { echo "opencode-zen-setup: key file mode is $mode, not 600 (config left unchanged)"; exit 4; }
# the no-key baseline of THIS build: free Zen models list without any key (measured in an empty temp HOME)
TMPH=$(mktemp -d); free=$(HOME="$TMPH" "$BIN" models opencode 2>/dev/null | grep -c '^opencode/'); [ -n "$TMPH" ] && rm -rf -- "$TMPH"
before=$(count)
mkdir -p "$(dirname "$CONF")"
[ -e "$CONF" ] && [ ! -e "$CONF.bak-zen" ] && cp -p "$CONF" "$CONF.bak-zen"   # one-time backup of the previous config
python3 - "$CONF" "$KEYFILE" <<'PY' || { echo "opencode-zen-setup: config could not be parsed or written (a comment or trailing comma in a .jsonc?); left untouched; merge the one apiKey line by hand"; exit 6; }
import json, os, sys
conf, keyfile = sys.argv[1], sys.argv[2]
d = json.load(open(conf)) if os.path.exists(conf) and os.path.getsize(conf) else {}
d.setdefault("$schema", "https://opencode.ai/config.json")
d.setdefault("provider", {}).setdefault("opencode", {}).setdefault("options", {})["apiKey"] = "{file:%s}" % keyfile
tmp = conf + ".tmp"; json.dump(d, open(tmp, "w"), indent=2); os.chmod(tmp, 0o600); os.replace(tmp, conf)
PY
after=$(count)
echo "opencode-zen-setup: config points at the key file; Zen models listed: no-key baseline $free | before $before | after $after"
[ "$after" -gt "$free" ] || { echo "opencode-zen-setup: the count is not above the no-key baseline, so the file was NOT shown to be resolved"; exit 5; }
