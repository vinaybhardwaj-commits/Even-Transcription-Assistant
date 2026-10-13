#!/bin/bash
# Steward scrub gate: gitleaks + path deny + PHI field + host deny.
# usage: scrub.sh <rev-range> | --staged | --tree PATH
# Exit 0 clean, 1 on any hit, 2 on usage or tool error. Prints rule id, path:line, commit. Never prints a matched value.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GL="${GITLEAKS:-$(command -v gitleaks || true)}"
CFG="${STEWARD_GITLEAKS_CONFIG:-$ROOT/.gitleaks.toml}"
[ -n "$GL" ] || { echo "scrub: gitleaks not found" >&2; exit 2; }
[ $# -ge 1 ] || { echo "usage: scrub.sh <rev-range> | --staged | --tree PATH" >&2; exit 2; }

TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
IGN="$TMP/ignore"; : > "$IGN"
[ -f "$ROOT/.gitleaksignore" ] && cat "$ROOT/.gitleaksignore" >> "$IGN"
if [ -f "$ROOT/steward/scrub-allow.txt" ] && [ "${STEWARD_SCRUB_NO_ALLOW:-0}" != "1" ]; then
  grep -v '^[[:space:]]*#' "$ROOT/steward/scrub-allow.txt" | sed 's/[[:space:]]*#.*$//' | grep -v '^[[:space:]]*$' >> "$IGN"
fi
REP="$TMP/gl.json"
rc=0
case "$1" in
  --tree)
    [ $# -eq 2 ] || { echo "usage: scrub.sh --tree PATH" >&2; exit 2; }
    [ -e "$2" ] || { echo "scrub: no such path" >&2; exit 2; }
    TREE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; set -- --tree "$TREE"
    "$GL" dir "$2" --no-banner --redact --ignore-gitleaks-allow -c "$CFG" -i "$IGN" -f json -r "$REP" --exit-code 0 >/dev/null 2>&1 || { echo "scrub: gitleaks error" >&2; exit 2; }
    py=(tree "$2") ;;
  --staged)
    ( cd "$ROOT" && "$GL" git --staged --no-banner --redact --ignore-gitleaks-allow -c "$CFG" -i "$IGN" -f json -r "$REP" --exit-code 0 . >/dev/null 2>&1 ) || { echo "scrub: gitleaks error" >&2; exit 2; }
    py=(staged) ;;
  *)
    ( cd "$ROOT" && git rev-list "$1" >/dev/null 2>&1 ) || { echo "scrub: invalid range" >&2; exit 2; }
    ( cd "$ROOT" && "$GL" git --log-opts="-m $1" --no-banner --redact --ignore-gitleaks-allow -c "$CFG" -i "$IGN" -f json -r "$REP" --exit-code 0 . >/dev/null 2>"$TMP/gl.err" ) || { echo "scrub: gitleaks error" >&2; exit 2; }
    grep -q ' ERR ' "$TMP/gl.err" && { echo "scrub: gitleaks reported an error" >&2; exit 2; }
    py=(range "$1") ;;
esac
# gitleaks hits: rule id, file, line, commit only.
[ -s "$REP" ] || { echo "scrub: gitleaks wrote no report" >&2; exit 2; }
python3 -I - "$REP" <<'PY' > "$TMP/gl.out"
import json,sys
try: items=json.load(open(sys.argv[1])) or []
except Exception: items=[]
for i in items:
    print("%s\t%s:%s\t%s" % (i.get("RuleID","?"), i.get("File","?"), i.get("StartLine",0), (i.get("Commit") or "-")[:10]))
PY
[ -s "$TMP/gl.out" ] && rc=1
(cd "$ROOT" && python3 -I "$HERE/scrub_rules.py" "${py[@]}") > "$TMP/py.out"
[ $? -ne 0 ] && rc=1
cat "$TMP/gl.out" "$TMP/py.out"
n=$(cat "$TMP/gl.out" "$TMP/py.out" | wc -l | tr -d ' ')
[ "$rc" -ne 0 ] && echo "scrub: $n hit(s)" >&2
exit $rc
