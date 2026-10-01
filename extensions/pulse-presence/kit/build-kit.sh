#!/bin/bash
# Packs the extension into a CRX with the stable key (key.pem in the kit dir, mode 600, never committed).
#   build-kit.sh                  generic CRX (empty eta_config)
#   HOST_CONFIG=<json> build-kit.sh   per-host CRX: eta_config baked into the packaged manifest and the
#                                 version bumped (0.1.0.<seq>) so Chrome treats it as an update. The JSON
#                                 file holds {ingest_url, token, machine_id, room}; it lives outside git.
# Output: $KIT_OUT (default ~/oc/pulse-ext/kit), or $KIT_OUT/hosts/<machine_id> for a per-host build.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${KIT_OUT:-$HOME/oc/pulse-ext/kit}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
umask 077
mkdir -p "$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/ext"
cp -R "$REPO/manifest.json" "$REPO/managed_schema.json" "$REPO/src" "$STAGE/ext/"
KEY="$OUT/key.pem"
DEST="$OUT"
if [ -n "${HOST_CONFIG:-}" ]; then
  SEQFILE="$OUT/build-seq"
  SEQ=$(( $(cat "$SEQFILE" 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$SEQ" > "$SEQFILE"
  MACHINE="$(python3 - "$STAGE/ext/manifest.json" "$HOST_CONFIG" "$SEQ" <<'PY'
import json, sys, re
mpath, cpath, seq = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(open(mpath)); c = json.load(open(cpath))
cfg = {k: str(c.get(k, "")) for k in ("ingest_url", "token", "machine_id", "room")}
if not cfg["ingest_url"].startswith("https://") or not cfg["token"] or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", cfg["machine_id"]):
    sys.exit("bad host config")
m["eta_config"] = cfg
m["version"] = m["version"] + "." + seq
json.dump(m, open(mpath, "w"), indent=2)
import os as _os
_jsp = _os.path.join(_os.path.dirname(mpath), "src", "eta_config.js")
open(_jsp, "w").write("globalThis.ETA_CONFIG = " + json.dumps(cfg) + ";\n")
_tp = _os.path.join(_os.path.dirname(mpath), "src", "lib", "transport.js")
_ts = open(_tp).read()
_old = "const BAKED_CONFIG = {}; // ETA_BAKE"
assert _ts.count(_old) == 1, "transport bake anchor missing"
_ts = _ts.replace(_old, "const BAKED_CONFIG = " + json.dumps(cfg) + "; // ETA_BAKE")
open(_tp, "w").write(_ts)
print(cfg["machine_id"])
PY
)"
  DEST="$OUT/hosts/$MACHINE"
  mkdir -p "$DEST"
fi
VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$STAGE/ext/manifest.json")"
if [ -f "$KEY" ]; then
  "$CHROME" --user-data-dir="$STAGE/ud" --pack-extension="$STAGE/ext" --pack-extension-key="$KEY" >/dev/null 2>&1 || true
elif [ -z "${HOST_CONFIG:-}" ]; then
  "$CHROME" --user-data-dir="$STAGE/ud" --pack-extension="$STAGE/ext" >/dev/null 2>&1 || true
  [ -f "$STAGE/ext.pem" ] && mv "$STAGE/ext.pem" "$KEY"
else
  echo "no key.pem: refusing to create a new key for a per-host build (the id must stay fixed)" >&2; exit 1
fi
[ -f "$STAGE/ext.crx" ] && [ -f "$KEY" ] || { echo "pack failed" >&2; exit 1; }
chmod 600 "$KEY"
# Extension id: first 128 bits of sha256(SPKI DER), each hex digit mapped 0-f -> a-p.
ID="$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | xxd -p -l 16 | tr '0-9a-f' 'a-p')"
if [ -n "${HOST_CONFIG:-}" ] && [ -f "$OUT/extension-id.txt" ] && [ "$(cat "$OUT/extension-id.txt")" != "$ID" ]; then
  echo "extension id changed: STOP" >&2; exit 1
fi
CRX="eta-pulse-presence-$VERSION.crx"
cp "$STAGE/ext.crx" "$DEST/$CRX"
cat > "$DEST/update.xml" <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$ID'>
    <updatecheck codebase='file:///Library/Application%20Support/eta-presence/$CRX' version='$VERSION' />
  </app>
</gupdate>
XML
printf '%s\n' "$ID" > "$DEST/extension-id.txt"
printf '%s\n' "$VERSION" > "$DEST/version.txt"
printf '%s\n' "$CRX" > "$DEST/crx-name.txt"
if [ -z "${HOST_CONFIG:-}" ]; then
  mkdir -p "$OUT/remote"
  cp "$REPO/kit/install.sh" "$REPO/kit/uninstall.sh" "$OUT/"
  cp "$REPO/kit/build-kit.sh" "$OUT/build-kit.sh"
  cp "$REPO/kit/remote/apply.sh" "$REPO/kit/remote/remove.sh" "$OUT/remote/"
  chmod 755 "$OUT/install.sh" "$OUT/uninstall.sh" "$OUT/build-kit.sh" "$OUT/remote/"*.sh
fi
echo "extension id: $ID"
echo "crx: $DEST/$CRX"
