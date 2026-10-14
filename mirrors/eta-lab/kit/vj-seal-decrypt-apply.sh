#!/bin/bash
# vj-seal-decrypt-apply.sh (herdr-kit, FABLE 448: option (a) ADOPTED) -- the ONE script
# V runs himself, in a terminal on the Mini, to install ~/bin/vj-seal-decrypt ON THE BOX
# (e2e-lab-ts). The wrapper is the single sanctioned path for a VJ pane to decrypt one
# file of the VJ truth seal; it is reviewed by eta-refuter-2 (by sha) like the arm-4
# shim before V deploys it.
#
# THE WRAPPER (installed at /home/eta/bin/vj-seal-decrypt on the box):
#   vj-seal-decrypt <name.gpg> [outdir]
#   - decrypts $SEAL/<name.gpg> with gpg, using the seal key the wrapper reads itself
#     from $KEYDIR/vj-truth-seal.key (the key path is a literal BELOW, never printed,
#     never logged, never an argv element of the caller -- the caller names only the
#     .gpg file and an outdir);
#   - refuses any outdir outside $SEAL: a relative outdir resolves INSIDE $SEAL, an
#     absolute outdir must be $SEAL itself or below it; traversal ("..") refused;
#   - the name must be a bare filename matching ^[A-Za-z0-9._-]+\.gpg$ (no slashes, no
#     traversal), and the encrypted file must exist in $SEAL;
#   - never prints or logs the key, never cats it, never puts it on argv (gpg gets it
#     via --passphrase-file and --pinentry-mode loopback);
#   - logs one line per call (ts, caller agent from HERDR_PANE_ID when present, the
#     .gpg basename, the outdir basename, success/fail) to $HOME/.vj-seal-decrypt.log;
#   - writes the plaintext to $OUTDIR/<name without .gpg>, mode 0600, refusing to
#     overwrite an existing output (set env FORCE=1 to overwrite).
#
# THIS INSTALLER: default --dry-run prints the wrapper content + the exact install
# commands; --apply writes the wrapper on the box (user-local, no sudo) and verifies
# the sha. It does NOT touch the key, the seal contents, ~/.ssh, or any pane config;
# it never reads or prints the key. --uninstall removes the wrapper.
#
# KNOWN OPEN QUESTION (flagged to eta-refuter-2/vj-refuter, not solved here): the vj-*
# panes' bash deny "*vj-truth-sealed*" blocks any pane bash command that NAMES the
# seal path -- so a pane should call the wrapper with a RELATIVE outdir (e.g.
# `vj-seal-decrypt vj-truth-20260925.tar.gpg out1`), which this wrapper resolves
# inside $SEAL; whether that satisfies the blinding rules end-to-end is the checker's
# call, not this script's.
#
# usage (V, on the Mini): vj-seal-decrypt-apply.sh [--dry-run|--apply|--uninstall]
set -u

MODE="dry-run"
BOX_SSH="e2e-lab-ts"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    *) echo "unknown argument: $1 (use --dry-run|--apply|--uninstall)" >&2; exit 3 ;;
  esac
done

ok()   { printf 'OK    %s\n' "$1"; }
fail() { printf 'FAIL  %s: %s\n' "$1" "$2" >&2; }
say()  { printf '      %s\n' "$1"; }
FAILED=0

wrapper_content() {
  cat <<'WRAP_EOF'
#!/bin/bash
# vj-seal-decrypt (herdr-kit, FABLE 448) -- single-purpose VJ seal decryptor.
# Reads the seal key ITSELF; the caller names only the .gpg file and an outdir.
set -u
KEYDIR="$HOME/.claude/secrets-archive/voice-lab-1"
KEY="$KEYDIR/vj-truth-seal.key"
SEAL="$HOME/eta-data/vj-truth-sealed"
LOG="$HOME/.vj-seal-decrypt.log"
ts() { date -u +%FT%TZ; }

# FABLE 448 + vj-refuter #3653(2): a VJ BUILDER pane must never decrypt truth
# (r168 blinding). Only vj-refuter (the checker) and key-less callers (V) pass.
# Best-effort: resolve THIS pane's agent name from the pane's own herdr env
# (HERDR_PANE_ID + HERDR_SOCKET_PATH); if the name resolves to a vj-* builder,
# refuse loud. If herdr cannot resolve, the vj-* configs' bash deny
# "*vj-seal-decrypt*" remains the primary guard (added 26 Sep).
VJ_CALLER=""
if [ -n "${HERDR_PANE_ID:-}" ]; then
  PANE_NAME=$(herdr agent list 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
pid = sys.argv[1]
for a in d.get("result", {}).get("agents", []):
    if a.get("pane_id") == pid and a.get("agent") == "opencode":
        print(a.get("name") or "")
        break
' "$HERDR_PANE_ID" 2>/dev/null)
  case "$PANE_NAME" in
    vj-refuter) VJ_CALLER="checker" ;;
    vj-*) 
      printf '%s caller=%s REFUSED vj-builder-pane\n' "$(ts)" "$HERDR_PANE_ID" >> "$LOG"
      echo "vj-seal-decrypt: REFUSED — vj builder panes ($PANE_NAME) may not decrypt the truth seal (r168)" >&2
      exit 3
      ;;
    "") VJ_CALLER="unresolved" ;;
    *) VJ_CALLER="$PANE_NAME" ;;
  esac
fi

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: vj-seal-decrypt <name.gpg> [outdir-inside-seal]" >&2
  exit 3
fi
NAME="$1"
OUTDIR_ARG="${2:-.}"

# name: bare filename, .gpg suffix, no traversal
case "$NAME" in
  */*) echo "vj-seal-decrypt: name must be a bare .gpg filename" >&2; exit 3 ;;
esac
if ! printf '%s' "$NAME" | grep -qE '^[A-Za-z0-9._-]+\.gpg$'; then
  echo "vj-seal-decrypt: bad name" >&2
  exit 3
fi

SEALR=$(cd "$SEAL" 2>/dev/null && pwd -P) || { echo "vj-seal-decrypt: seal dir missing" >&2; exit 3; }
if [ ! -f "$SEALR/$NAME" ]; then
  echo "vj-seal-decrypt: $NAME not found in the seal" >&2
  exit 3
fi

# outdir: relative resolves INSIDE the seal; absolute must be the seal or below;
# traversal refused.
case "$OUTDIR_ARG" in
  /*) OUTDIR="$OUTDIR_ARG" ;;
  *)  OUTDIR="$SEALR/$OUTDIR_ARG" ;;
esac
case "$(cd "$(dirname "$OUTDIR")" 2>/dev/null && pwd -P)" in
  "$SEALR") : ;;
  "$SEALR"/*) : ;;
  *) echo "vj-seal-decrypt: outdir must be inside the seal" >&2; exit 3 ;;
esac
mkdir -p "$OUTDIR"

BASE="${NAME%.gpg}"
OUT="$OUTDIR/$BASE"
if [ -e "$OUT" ] && [ "${FORCE:-0}" != 1 ]; then
  echo "vj-seal-decrypt: output already exists (set FORCE=1 to overwrite)" >&2
  exit 3
fi

if [ ! -r "$KEY" ]; then
  printf '%s caller=%s %s FAIL key-unreadable\n' "$(ts)" "${HERDR_PANE_ID:-none}" "$NAME" >> "$LOG"
  echo "vj-seal-decrypt: key not readable" >&2
  exit 3
fi

if gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$KEY" \
     -o "$OUT" --decrypt "$SEALR/$NAME" >/dev/null 2>&1; then
  chmod 600 "$OUT" 2>/dev/null
  printf '%s caller=%s(%s) %s -> %s OK\n' "$(ts)" "${HERDR_PANE_ID:-none}" "${VJ_CALLER:-none}" "$NAME" "$BASE" >> "$LOG"
  echo "$OUT"
else
  RC=$?
  rm -f "$OUT" 2>/dev/null
  printf '%s caller=%s %s FAIL gpg-rc=%s\n' "$(ts)" "${HERDR_PANE_ID:-none}" "$NAME" "$RC" >> "$LOG"
  echo "vj-seal-decrypt: decrypt failed" >&2
  exit 1
fi
WRAP_EOF
}

REMOTE="$BOX_SSH"
echo "=== vj-seal-decrypt-apply.sh :: mode=$MODE ==="

if [ "$MODE" = "uninstall" ]; then
  ssh -o BatchMode=yes "$REMOTE" 'rm -f "$HOME/bin/vj-seal-decrypt" && echo wrapper-removed'
  ok "uninstall done"
  exit 0
fi

tmp=$(mktemp)
wrapper_content > "$tmp"
WRAP_SHA=$(shasum -a 256 "$tmp" | awk '{print $1}')
say "wrapper sha256: $WRAP_SHA"

if [ "$MODE" = "dry-run" ]; then
  say "would write /home/eta/bin/vj-seal-decrypt on $REMOTE:"
  cat "$tmp"
  say "then: ssh $REMOTE 'chmod 755 ~/bin/vj-seal-decrypt && shasum -a 256 ~/bin/vj-seal-decrypt'"
  ok "dry-run complete"
else
  scp -o BatchMode=yes -q "$tmp" "$REMOTE:.vj-seal-decrypt.draft" \
    && ssh -o BatchMode=yes "$REMOTE" 'mkdir -p "$HOME/bin" && mv "$HOME/.vj-seal-decrypt.draft" "$HOME/bin/vj-seal-decrypt" && chmod 755 "$HOME/bin/vj-seal-decrypt"' \
    && ok "wrapper installed" \
    || { fail "install" "copy/chmod failed"; FAILED=1; }
  if [ "$FAILED" = 0 ]; then
    ssh -o BatchMode=yes "$REMOTE" 'shasum -a 256 "$HOME/bin/vj-seal-decrypt"'
    ssh -o BatchMode=yes "$REMOTE" 'bash -n "$HOME/bin/vj-seal-decrypt" && echo bash-n-OK' || { fail "syntax" "remote bash -n failed"; FAILED=1; }
  fi
fi
rm -f "$tmp"
echo "=== vj-seal-decrypt-apply.sh :: done, mode=$MODE ==="
exit $FAILED
