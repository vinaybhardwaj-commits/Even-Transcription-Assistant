#!/bin/bash
#
# build-bundle.sh — assemble, sign and zip EvenScribe Room Recorder.app
# (Install and Fleet PRD §5.1, §5.2, Build R2 §2.1)
#
# Output: EvenScribe-Room-Recorder-<version>.zip and release.json, side by side, in the output
# directory. `release.json` is exactly the manifest POST /api/admin/releases expects — the server
# re-streams the Blob object and recomputes sha256 and size_bytes from the bytes, and refuses with
# SHA_MISMATCH on any disagreement with this file. So the numbers written here are a claim that is
# about to be checked, not a value anyone is asked to trust.
#
# ─── THIS SCRIPT MUST RUN AT THE MAC'S CONSOLE ───────────────────────────────────────────────
# Signing needs the login keychain unlocked, which an SSH session does not have. Verified 8 Sep:
# `codesign` over SSH fails with errSecInternalComponent and succeeds in Terminal.app on the Mac.
# Ratified 8 Sep: builds happen at the console, with no scripted `unlock-keychain` and no second
# keychain. This script therefore does not try to unlock anything — it fails loudly instead.
#
# ─── AND IT FAILS LOUDLY, NEVER PARTIALLY ────────────────────────────────────────────────────
# `set -euo pipefail`, every step checked, and the zip is written LAST. A run that dies half way
# leaves no zip and no release.json, so there is nothing for a publisher to pick up by mistake.
# An unsigned or wrongly-signed bundle is the one output that must never exist, because the whole
# install path downstream — the sha256 in the script, R3's codesign verify — assumes it cannot.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PACKAGE_DIR}/../.." && pwd)"

# ─── The ratified constants (8 Sep) ──────────────────────────────────────────────────────────
# The signing identity is pinned by SHA-1, not by name. A name is ambiguous — two certificates
# may carry it, and `codesign -s` would pick one — while the hash names exactly the key X1
# created. D1 binds the microphone grant on all four Macs to this identity, so signing with the
# wrong one is not a build error, it is four walks to four rooms.
readonly SIGNING_IDENTITY="187DD424FB866204111113D60C6F88A21D098EDB"
readonly SIGNING_IDENTITY_NAME="EvenScribe Room Recorder Code Signing 1"
readonly CERT_SHA256="903EDCE6F78C2199DFF45939D492041FED0C0A8394DDABB985278349BB281643"
readonly BUNDLE_ID="com.evenscribe.room-recorder"
readonly FFMPEG_BUNDLE_ID="com.evenscribe.room-recorder.ffmpeg"
readonly TAPEWRITER_BUNDLE_ID="com.evenscribe.room-recorder.tapewriter"
readonly MIN_MACOS="15.0"
readonly APP_NAME="EvenScribe Room Recorder.app"

VERSION_FILE="${SCRIPT_DIR}/VERSION"
OUTPUT_ROOT="${1:-${PACKAGE_DIR}/.build/release-bundle}"
FFMPEG_SOURCE="${ETA_FFMPEG_BINARY:-}"

say() { /bin/echo "==> $*"; }
die() { /bin/echo "build-bundle: $*" >&2; exit 1; }

# ─── Preflight. Everything that can be wrong is checked BEFORE anything is built. ─────────────
say "Preflight"

[ -f "$VERSION_FILE" ] || die "no VERSION file at ${VERSION_FILE}"
VERSION="$(/usr/bin/tr -d ' \n\r' < "$VERSION_FILE")"
[ -n "$VERSION" ] || die "VERSION is empty"
/bin/echo "$VERSION" | /usr/bin/grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$' \
  || die "VERSION '${VERSION}' is not a valid release version"

# The build sha is derived, never typed (the R2 rule). A dirty tree is refused rather than
# stamped with a sha that does not describe the bytes being built.
BUILD_SHA="$(cd "$REPO_DIR" && /usr/bin/git rev-parse --short HEAD)"
if ! (cd "$REPO_DIR" && /usr/bin/git diff --quiet && /usr/bin/git diff --cached --quiet); then
  if [ "${ETA_ALLOW_DIRTY_BUILD:-0}" != "1" ]; then
    die "the working tree is dirty; ${BUILD_SHA} would not describe this bundle. Commit, or set ETA_ALLOW_DIRTY_BUILD=1 for a throwaway build."
  fi
  say "WARNING: dirty tree, build_sha ${BUILD_SHA} does not fully describe these bytes"
fi

# The identity must exist AND be valid for code signing. `find-identity -v` only lists identities
# that pass the codesigning policy, so this proves the certificate is present, has its private key,
# and is trusted — the three things that were separately missing during X1.
/usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -q "$SIGNING_IDENTITY" \
  || die "signing identity ${SIGNING_IDENTITY} (${SIGNING_IDENTITY_NAME}) is not a valid code-signing identity."

# AND IT MUST ACTUALLY SIGN. The check above is NOT sufficient and finding that out the hard way
# is why this trial exists: `find-identity -v` is a read-only trust evaluation and it SUCCEEDS
# over SSH, while `codesign` fails there with errSecInternalComponent because using the private
# key needs an unlocked login keychain. Verified 8 Sep, both directions.
#
# So preflight signs something disposable and throws it away. Ten milliseconds here, instead of a
# full release build that dies at the signing step minutes later.
TRIAL="$(/usr/bin/mktemp -d)/trial"
/bin/cp /bin/ls "$TRIAL"
/bin/chmod u+w "$TRIAL"
if ! codesign --force --timestamp=none --sign "$SIGNING_IDENTITY" "$TRIAL" 2>/dev/null; then
  /bin/rm -rf "$(/usr/bin/dirname "$TRIAL")"
  die "the signing key is present but UNUSABLE in this session.
  Almost always this means an SSH session: the login keychain is locked and there is no
  SecurityAgent to unlock it. Run this script from Terminal.app on the Mac's own screen
  (ratified 8 Sep: builds happen at the console, no scripted unlock-keychain)."
fi
/bin/rm -rf "$(/usr/bin/dirname "$TRIAL")"

# ─── The vendored encoder (§5.1, X2) ─────────────────────────────────────────────────────────
# X2 is closed: ship the vendored encoder with its LGPL notices. The app no longer uses Homebrew.
if [ -z "$FFMPEG_SOURCE" ]; then
  for candidate in \
    "${PACKAGE_DIR}/.build/encoder-candidate/artifact/bin/ffmpeg" \
    "${PACKAGE_DIR}/.build/encoder-candidate/artifact/ffmpeg"; do
    [ -x "$candidate" ] && FFMPEG_SOURCE="$candidate" && break
  done
fi
[ -n "$FFMPEG_SOURCE" ] && [ -x "$FFMPEG_SOURCE" ] || die "no vendored ffmpeg. Run Encoder/build-ffmpeg.sh first, or set ETA_FFMPEG_BINARY.
  X2 is ruled: the bundle ships its own encoder and must not fall back to Homebrew."
say "Encoder: ${FFMPEG_SOURCE}"

# ─── Build (§2.1: release binaries at deployment target 15.0) ────────────────────────────────
# The toolchain on this Mac defaults to macosx28.0. Left implicit, the bundle would refuse to
# launch on the macOS 15 clinic Macs (D4) with a message no operator could act on. Ratified 8 Sep.
say "Building release binaries for macOS ${MIN_MACOS}"
(
  cd "$PACKAGE_DIR"
  swift build -c release \
    --product room-recorder \
    --product tapewriter \
    -Xswiftc -target -Xswiftc "$(/usr/bin/uname -m)-apple-macosx${MIN_MACOS}"
)
BIN_DIR="$(cd "$PACKAGE_DIR" && swift build -c release --show-bin-path)"
[ -x "${BIN_DIR}/room-recorder" ] || die "room-recorder was not built"
[ -x "${BIN_DIR}/tapewriter" ] || die "tapewriter was not built"

# ─── Assemble (§5.1) ─────────────────────────────────────────────────────────────────────────
say "Assembling ${APP_NAME}"
STAGE="${OUTPUT_ROOT}/stage"
APP="${STAGE}/${APP_NAME}"
/bin/rm -rf "$STAGE"
/bin/mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Helpers" "${APP}/Contents/Resources/Licenses"

/bin/cp "${BIN_DIR}/room-recorder" "${APP}/Contents/MacOS/room-recorder"
/bin/cp "${BIN_DIR}/tapewriter" "${APP}/Contents/Helpers/tapewriter"
/bin/cp "$FFMPEG_SOURCE" "${APP}/Contents/Helpers/ffmpeg"
/bin/chmod 0755 "${APP}/Contents/MacOS/room-recorder" \
  "${APP}/Contents/Helpers/tapewriter" "${APP}/Contents/Helpers/ffmpeg"

# LGPL notices and the source lock ride inside the bundle (X2's condition for shipping).
for licence in "${PACKAGE_DIR}/Encoder/source-lock.json" "${PACKAGE_DIR}/Encoder/README.md"; do
  [ -f "$licence" ] && /bin/cp "$licence" "${APP}/Contents/Resources/Licenses/"
done
if [ -f "${PACKAGE_DIR}/Encoder/LGPL-NOTICES.txt" ]; then
  /bin/cp "${PACKAGE_DIR}/Encoder/LGPL-NOTICES.txt" "${APP}/Contents/Resources/LGPL-NOTICES.txt"
else
  die "Encoder/LGPL-NOTICES.txt is missing. X2 ships the vendored encoder ONLY with its notices bundled; without them this build must not be produced."
fi

# ─── Info.plist (§5.2) ───────────────────────────────────────────────────────────────────────
# No CFBundleURLTypes: the URL scheme went with D2. LSUIElement true: this is a resident agent
# with no Dock icon and no window. ETABuildSHA is read back at runtime by BuildInfo.buildSHA, so
# the app reports the sha of the bundle it is actually running rather than a compiled-in guess.
PLIST="${APP}/Contents/Info.plist"
/usr/bin/plutil -create xml1 "$PLIST"
plist_set() { /usr/bin/plutil -replace "$1" -"$2" "$3" "$PLIST"; }
plist_set CFBundleIdentifier string "$BUNDLE_ID"
plist_set CFBundleName string "EvenScribe Room Recorder"
plist_set CFBundleDisplayName string "EvenScribe Room Recorder"
plist_set CFBundleExecutable string "room-recorder"
plist_set CFBundlePackageType string "APPL"
plist_set CFBundleShortVersionString string "$VERSION"
plist_set CFBundleVersion string "$VERSION"
plist_set ETABuildSHA string "$BUILD_SHA"
plist_set LSMinimumSystemVersion string "$MIN_MACOS"
plist_set LSUIElement bool true
plist_set NSMicrophoneUsageDescription string "$(/bin/cat "${SCRIPT_DIR}/MicrophoneUsageDescription.txt")"
/usr/bin/plutil -lint "$PLIST" >/dev/null || die "Info.plist did not lint"

# ─── Sign (§2.1: helpers first, then the bundle) ─────────────────────────────────────────────
# INSIDE OUT, and the order is not stylistic. The outer signature seals the bundle's contents, so
# a helper signed afterwards invalidates the app's own seal — `codesign --verify --strict` on the
# bundle would then fail, which is exactly what R3's updater refuses to install.
say "Signing helpers, then the bundle"
codesign --force --timestamp --options runtime \
  --identifier "$FFMPEG_BUNDLE_ID" --sign "$SIGNING_IDENTITY" "${APP}/Contents/Helpers/ffmpeg"
codesign --force --timestamp --options runtime \
  --identifier "$TAPEWRITER_BUNDLE_ID" --sign "$SIGNING_IDENTITY" "${APP}/Contents/Helpers/tapewriter"
codesign --force --timestamp --options runtime \
  --identifier "$BUNDLE_ID" --sign "$SIGNING_IDENTITY" "$APP"

# ─── Verify, pinned to our anchor ────────────────────────────────────────────────────────────
# The same requirement string R3 uses. Verified 8 Sep to discriminate: pinned to a different leaf
# it fails, so this is a check and not a formality.
say "Verifying"
codesign --verify --strict --verbose=4 \
  -R "= anchor trusted and certificate leaf = H\"$(/bin/echo "$SIGNING_IDENTITY" | /usr/bin/tr 'A-Z' 'a-z')\"" \
  "$APP" || die "the signed bundle does not satisfy the pinned requirement"
for helper in ffmpeg tapewriter; do
  codesign --verify --strict "${APP}/Contents/Helpers/${helper}" \
    || die "helper ${helper} failed verification"
done
codesign -dv --verbose=4 "$APP" 2>&1 | /usr/bin/grep -E "^Authority|^Identifier|^CDHash" || true

# ─── Zip, hash, manifest ─────────────────────────────────────────────────────────────────────
# `ditto -c -k --keepParent` is the counterpart of the `ditto -x -k` the §4.4 script runs, and it
# preserves the resource forks and extended attributes a signature depends on. `zip(1)` does not,
# and a bundle zipped with it arrives on the clinic Mac with a broken signature.
say "Zipping"
ZIP="${OUTPUT_ROOT}/EvenScribe-Room-Recorder-${VERSION}.zip"
/bin/rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

SHA256="$(/usr/bin/shasum -a 256 "$ZIP" | /usr/bin/awk '{print $1}')"
SIZE="$(/usr/bin/stat -f %z "$ZIP")"

MANIFEST="${OUTPUT_ROOT}/release.json"
/bin/cat > "$MANIFEST" <<JSON
{
  "version": "${VERSION}",
  "build_sha": "${BUILD_SHA}",
  "sha256": "${SHA256}",
  "size_bytes": ${SIZE},
  "min_macos": "${MIN_MACOS}",
  "identity_sha1": "${SIGNING_IDENTITY}",
  "certificate_sha256": "${CERT_SHA256}"
}
JSON
/usr/bin/plutil -lint "$MANIFEST" >/dev/null 2>&1 || true

say "Done"
/bin/echo
/bin/echo "  bundle   ${APP}"
/bin/echo "  zip      ${ZIP}"
/bin/echo "  manifest ${MANIFEST}"
/bin/echo
/bin/cat "$MANIFEST"
