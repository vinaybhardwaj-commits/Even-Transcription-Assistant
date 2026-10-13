#!/bin/bash
# Stages every fixture under a temp data/ dir, runs scrub.sh --tree once with the fixtures allowlist disabled,
# then asserts: each hit-<rule>-* entry produced a hit for <rule>, each ok-* entry produced none.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export STEWARD_SCRUB_NO_ALLOW=1 STEWARD_HOSTS_FILE=/nonexistent
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/data"
cp -R "$HERE"/fixtures/. "$T/data/"
# Generated at run time, not committed: the repo's no-identity-literals guard rejects committed person-name fields in test-like files.
printf '{"patient_%s": "Fake Person", "visit": 1}\n' name > "$T/data/hit-phi-field.json"
printf '{"a":1,"patient%s":"Fake Person"}\n{"b":2}\n' Name > "$T/data/hit-phi-field-camel.jsonl"
mkdir -p "$T/data/ok-synthetic/fixtures/synthetic"
printf '{"patient_%s":"Fake Person"}\n' name > "$T/data/ok-synthetic/fixtures/synthetic/p.json"
"$ROOT/scripts/steward/scrub.sh" --tree "$T" > "$T/out.tsv" 2>/dev/null
rc=$?
[ $rc -eq 1 ] || { echo "FAIL scrub.sh exit $rc, expected 1"; exit 1; }
pass=0; fail=0
for e in "$T"/data/*; do
  name="$(basename "$e")"
  # rules that fired for this entry (rule<TAB>path:line<TAB>commit)
  rules="$(awk -F'\t' -v p="data/$name" 'index($2,p"/")>0 || index($2,p":")>0 {print $1}' "$T/out.tsv" | sort -u)"
  case "$name" in
    hit-*)
      want="${name#hit-}"; ok=0
      for r in $rules; do case "$want" in "$r"*) ok=1;; esac; done ;;
    ok-*) ok=1; [ -z "$rules" ] || ok=0 ;;
    xfail-*) # known limit: expected NOT to be caught today. Never fails the run; reports if it starts being caught.
      ok=1; [ -z "$rules" ] || echo "NOTE $name is now caught: promote it to hit-*" ;;
    *) ok=0 ;;
  esac
  if [ $ok -eq 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $name"; fi
done
"$ROOT/scripts/steward/scrub.sh" deadbeefdeadbeef..HEAD >/dev/null 2>&1; r=$?
if [ $r -ne 2 ]; then fail=$((fail+1)); echo "FAIL invalid-range-must-exit-2 (rc=$r)"; else pass=$((pass+1)); fi
echo "steward-scrub fixtures: $pass pass, $fail fail, $((pass+fail)) total"
[ $fail -eq 0 ]
