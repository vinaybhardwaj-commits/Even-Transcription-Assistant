#!/bin/sh
# scripts/check-number-words.sh — does ETA's number lexicon still match the router's?
#
# lib/stt/number-words.json is a COPY of eta-router's generated lexicon (eta_number_words.py), and one
# dose number has to be protected identically in the router, the whisper-shim and this app. A copy can
# drift silently: nothing in this repo fails if the router's list changes and this file does not
# (ETA-Refuter on assembled-collapse, 23 Sep). This is the other half of that guard.
#
# It compares ONE value: the lexicon sha256 recorded in this repo's JSON against the lexicon sha256 in
# the header of the router's eta_number_words.py ON ITS main BRANCH (read through git, so an uncommitted
# edit in the router checkout cannot make it pass or fail). Both hashes are sha256 of the sorted words,
# newline-joined, and both files are generated, so equal hashes mean equal word sets.
#
# Exit 0 = in step. Exit 1 = DRIFT: regenerate lib/stt/number-words.json from router main.
# Exit 2 = cannot check (no router checkout here, or a hash could not be read) — a Mini-side step, not a
# Yoga one: the Yoga runner has no ~/eta-router, so this is deliberately NOT part of the vitest suite.
#
# Usage: scripts/check-number-words.sh [path-to-eta-router]   (default ~/eta-router)
set -u
ROUTER="${1:-$HOME/eta-router}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
JSON="$HERE/lib/stt/number-words.json"

[ -d "$ROUTER/.git" ] || { echo "check-number-words: no git checkout at $ROUTER — cannot check" >&2; exit 2; }
[ -f "$JSON" ] || { echo "check-number-words: $JSON missing — cannot check" >&2; exit 2; }

ETA_HASH=$(sed -n 's/.*"lexicon_sha256": *"\([0-9a-f]\{16\}\)".*/\1/p' "$JSON" | head -1)
ROUTER_HASH=$(git -C "$ROUTER" show main:eta_number_words.py 2>/dev/null \
  | sed -n 's/.*lexicon sha256 \([0-9a-f]\{16\}\).*/\1/p' | head -1)
ROUTER_SHA=$(git -C "$ROUTER" rev-parse --short main 2>/dev/null)

[ -n "$ETA_HASH" ] || { echo "check-number-words: no lexicon_sha256 in $JSON — cannot check" >&2; exit 2; }
[ -n "$ROUTER_HASH" ] || { echo "check-number-words: no lexicon hash in router main:eta_number_words.py — cannot check" >&2; exit 2; }

if [ "$ETA_HASH" = "$ROUTER_HASH" ]; then
  echo "check-number-words: in step — lexicon $ETA_HASH (router main $ROUTER_SHA)"
  exit 0
fi
echo "check-number-words: DRIFT — ETA $ETA_HASH vs router main $ROUTER_SHA $ROUTER_HASH; regenerate lib/stt/number-words.json" >&2
exit 1
