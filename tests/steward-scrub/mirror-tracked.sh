#!/bin/bash
# Every mirrors/<src>/ must carry tracked MIRROR.md and WITHHELD.md (a mirrored .gitignore must not hide them).
cd "$(git rev-parse --show-toplevel)" || exit 2
fail=0
for d in mirrors/*/; do
  [ -d "$d" ] || continue
  for f in MIRROR.md WITHHELD.md; do
    git ls-files --error-unmatch "${d}${f}" >/dev/null 2>&1 || { echo "FAIL ${d}${f} is not tracked"; fail=1; }
  done
done
[ $fail -eq 0 ] && echo "mirror provenance files tracked"
exit $fail
