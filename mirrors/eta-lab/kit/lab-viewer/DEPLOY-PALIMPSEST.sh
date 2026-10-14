#!/bin/bash
# DEPLOY-PALIMPSEST.sh - W49 palimpsest overnight deliverable (Fable, 28 Sep). The exact remaining steps, IN ORDER,
# now that lab-viewer/reb-palimpsest is on main @ 70bd066f (eta-refuter-2 PASS; verdict at
# ~/oc/refuter2/PALIMPSEST-VERDICT.md). NOT RUN by lab-viewer - both steps below were denied on that pane tonight
# (deploy is always denied there; the R2 write was denied specifically as "Modify Shared Resources"). Run this from
# a pane that can do both. The Cloudflare token is read from its file into the environment for each wrangler call
# only - never printed, never logged, never put in argv.
#
# (The clip-local offset issue noted here earlier is FIXED on main: room_tape offset = window start, a padded segment is clamped,
# outliers dropped. The seed also carries the R3/W51 guard and refuses to run if ~/eta-data/drtpqma/heldout.py cannot be loaded.)
# 8 Oct 2026 (6V, architect GO #10125): PIN is now 3ad527fe (the 6V consult drawer build, version ea22b9d6 live). Step 2 below REPLACES the 26-27 Sep
# timeline docs, so it now runs ONLY with an explicit flag:  bash DEPLOY-PALIMPSEST.sh --reseed-timelines.  With no flag only the viewer is deployed.
# Move PIN (to the sha you reviewed) before every deploy; the script refuses a REPO whose HEAD is not PIN.
# 6V also needs two Worker secrets, set once by hand (never in this script): CLIP_HMAC_KEY (>= 32 random chars), REB_INDEX_READ_TOKEN.
# Rollback: CLOUDFLARE_API_TOKEN=$(cat ~/.claude/secrets/cloudflare_api_token) npx wrangler rollback f9ab166e-55ce-4d96-b9e6-a04d7d7c6fda  (from kit/lab-viewer)
set -euo pipefail
RESEED=0
for a in "$@"; do
  case "$a" in
    --reseed-timelines) RESEED=1 ;;
    *) echo "unknown argument: $a (only --reseed-timelines is accepted)" >&2; exit 2 ;;
  esac
done

# REPO must be a checkout AT the pinned sha. Do NOT point it at the shared ~/dev/eta-lab (it may not contain the sha):
#   git -C ~/dev/eta-lab worktree add --detach /tmp/wt-palimpsest 6f74d57380a16c1ab1649f4b76883f57680badd1
#   REPO=/tmp/wt-palimpsest bash ~/oc/lab-viewer/DEPLOY-PALIMPSEST.sh
PIN="3ad527fe578d158210541708b95c145e49ef2feb"
REPO="${REPO:?set REPO=<worktree at $PIN> (see header)}"
if [ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" != "$PIN" ]; then echo "REPO HEAD is not $PIN - refusing" >&2; exit 1; fi
LAB_VIEWER="$REPO/kit/lab-viewer"
TOKEN_FILE="$HOME/.claude/secrets/cloudflare_api_token"
REB_ROOT="$HOME/eta-data/reb"

if [ ! -f "$TOKEN_FILE" ]; then echo "missing $TOKEN_FILE" >&2; exit 1; fi
if [ ! -d "$LAB_VIEWER" ]; then echo "missing $LAB_VIEWER (set REPO=... if your checkout is elsewhere)" >&2; exit 1; fi

echo "== 1. Deploy the viewer (kit/lab-viewer @ $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')) =="
( cd "$LAB_VIEWER" && CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")" npx wrangler deploy )

if [ "$RESEED" = "1" ]; then
  echo "== 2. REB palimpsest lanes: merge + load for every real room, 26 and 27 Sep =="
  for DATE in 2026-09-26 2026-09-27; do
    [ -d "$REB_ROOT/$DATE" ] || { echo "-- no $REB_ROOT/$DATE, skipping --"; continue; }
    for ROOM_DIR in "$REB_ROOT/$DATE"/*/; do
      ROOM="$(basename "$ROOM_DIR")"
      case "$ROOM" in suite-*) continue ;; esac   # synthetic benchmark rooms (suite-clinical1 etc) are never a real room-day
      echo "-- $ROOM / $DATE --"
      OUT="$(mktemp -d)"
      CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")" python3 "$LAB_VIEWER/tools/reb_timeline_seed.py" merge --room "$ROOM" --date "$DATE" --reb-root "$REB_ROOT" --out "$OUT"
      CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")" python3 "$LAB_VIEWER/tools/timeline_seed.py" load --dir "$OUT" --replace
      rm -rf "$OUT"
    done
  done

else
  echo "== 2. skipped: the 26-27 Sep timeline re-seed (it REPLACES live docs) runs only with --reseed-timelines =="
fi
echo "== Done. Open a room-day, e.g.: https://lab.llmvinayminihome.uk/timeline/room_d74hhmc4/2026-09-26 =="
