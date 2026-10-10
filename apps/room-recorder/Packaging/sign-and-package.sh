#!/bin/bash
#
# sign-and-package.sh — the whole final step for TS-H1 #38 / TS-H2 #39, in one command.
#
#   Packaging/sign-and-package.sh [output-dir]
#
# Builds the release binaries (app, helper, tapewriter), assembles EvenScribe Room Recorder.app,
# signs everything inside-out with "EvenScribe Room Recorder Code Signing 1" (via build-bundle.sh),
# wraps the bundle in a .pkg that installs to /Applications, signs the .pkg if the identity can,
# then verifies every artifact and prints the lines to paste into the report.
#
# ─── RUN IT IN Terminal.app ON THE MINI, AS V ────────────────────────────────────────────────
# Signing needs the login keychain in the GUI session. Over SSH or from a herdr pane the key is
# unusable (errSecInternalComponent, verified 10 Oct). This script does not unlock anything and
# never asks for a password; it stops at the first step that fails.
#
# ─── ON THE .pkg SIGNATURE ───────────────────────────────────────────────────────────────────
# `productsign` accepts only an INSTALLER identity. V's identity carries the Code Signing key usage
# alone (checked 10 Oct), so productsign refuses it. Rather than fail the whole run for that, the
# script tries productsign and, if it is refused, keeps the pkg UNSIGNED and says so in the final
# summary. What protects the install then is the sha256 beside the pkg plus the pinned-leaf
# codesign check on the app inside it, both verified here. Nothing is hidden: the summary prints
# the `pkgutil --check-signature` output either way.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT="${1:-${PACKAGE_DIR}/.build/release-bundle}"

readonly SIGNING_IDENTITY="187DD424FB866204111113D60C6F88A21D098EDB"
readonly SIGNING_IDENTITY_NAME="EvenScribe Room Recorder Code Signing 1"
readonly APP_NAME="EvenScribe Room Recorder.app"
readonly PKG_IDENTIFIER="com.evenscribe.room-recorder.pkg"
readonly LEAF_LOWER="$(/bin/echo "$SIGNING_IDENTITY" | /usr/bin/tr 'A-Z' 'a-z')"

say() { /bin/echo "==> $*"; }
die() { /bin/echo "sign-and-package: $*" >&2; exit 1; }

VERSION="$(/usr/bin/tr -d ' \n\r' < "${SCRIPT_DIR}/VERSION")"

# The encoder is a build input this script does not build. Same lookup order build-bundle.sh uses,
# plus the copy already installed on this Mac (signed with this same identity, re-signed below).
if [ -z "${ETA_FFMPEG_BINARY:-}" ]; then
  for candidate in \
    "${PACKAGE_DIR}/.build/encoder-candidate/artifact/Contents/Helpers/ffmpeg" \
    "${PACKAGE_DIR}/.build/encoder-candidate/artifact/bin/ffmpeg" \
    "${HOME}/Applications/${APP_NAME}/Contents/Helpers/ffmpeg" \
    "/Applications/${APP_NAME}/Contents/Helpers/ffmpeg"; do
    if [ -x "$candidate" ]; then export ETA_FFMPEG_BINARY="$candidate"; break; fi
  done
fi
[ -n "${ETA_FFMPEG_BINARY:-}" ] || die "no ffmpeg found. Set ETA_FFMPEG_BINARY=/path/to/ffmpeg and re-run."
say "Encoder: ${ETA_FFMPEG_BINARY}"

# ─── 1. Build, assemble, sign, zip. build-bundle.sh fails loudly and leaves nothing on failure. ─
say "Building and signing the bundle (build-bundle.sh)"
"${SCRIPT_DIR}/build-bundle.sh" "$OUT"
APP="${OUT}/stage/${APP_NAME}"
[ -d "$APP" ] || die "build-bundle.sh did not leave ${APP}"

# ─── 2. The pkg ──────────────────────────────────────────────────────────────────────────────
say "Building the pkg"
PKG_ROOT="${OUT}/pkg-root"
PKG_UNSIGNED="${OUT}/EvenScribe-Room-Recorder-${VERSION}-unsigned.pkg"
PKG="${OUT}/EvenScribe-Room-Recorder-${VERSION}.pkg"
/bin/rm -rf "$PKG_ROOT" "$PKG_UNSIGNED" "$PKG"
/bin/mkdir -p "$PKG_ROOT"
/usr/bin/ditto "$APP" "${PKG_ROOT}/${APP_NAME}"
/usr/bin/pkgbuild \
  --root "$PKG_ROOT" \
  --install-location /Applications \
  --scripts "${SCRIPT_DIR}/pkg-scripts" \
  --identifier "$PKG_IDENTIFIER" \
  --version "$VERSION" \
  --ownership recommended \
  "$PKG_UNSIGNED"

PKG_SIGNED="no"
say "Signing the pkg (productsign)"
if /usr/bin/productsign --sign "$SIGNING_IDENTITY" "$PKG_UNSIGNED" "$PKG" 2>"${OUT}/productsign.err"; then
  PKG_SIGNED="yes"
  /bin/rm -f "$PKG_UNSIGNED"
else
  /bin/echo "    productsign refused the identity: $(/usr/bin/tr '\n' ' ' < "${OUT}/productsign.err")"
  /bin/echo "    keeping the pkg unsigned; see the header of this script."
  /bin/mv "$PKG_UNSIGNED" "$PKG"
fi
/bin/rm -f "${OUT}/productsign.err"

# ─── 3. Verify what is actually IN the pkg ───────────────────────────────────────────────────
say "Verifying the pkg payload"
EXPAND="$(/usr/bin/mktemp -d)/expanded"
/usr/sbin/pkgutil --expand-full "$PKG" "$EXPAND"
INSTALLED_APP="$(/usr/bin/find "$EXPAND" -maxdepth 3 -name "$APP_NAME" -type d | /usr/bin/head -1)"
[ -n "$INSTALLED_APP" ] || die "the pkg does not contain ${APP_NAME}"
codesign --verify --strict --deep --verbose=2 \
  -R "= certificate leaf = H\"${LEAF_LOWER}\"" "$INSTALLED_APP" \
  || die "the app inside the pkg does not verify against the pinned leaf"
codesign --verify --strict "${INSTALLED_APP}/Contents/MacOS/room-recorder-helper" \
  || die "the helper inside the pkg does not verify"
# Captured, not piped into `grep -q`: grep exits at the first match, codesign then dies of SIGPIPE,
# and `pipefail` turns a correct identifier into a failure.
HELPER_INFO="$(codesign -dv "${INSTALLED_APP}/Contents/MacOS/room-recorder-helper" 2>&1)"
case "$HELPER_INFO" in
  *"Identifier=com.evenscribe.room-recorder.helper"*) ;;
  *) die "the helper's signing identifier is not com.evenscribe.room-recorder.helper" ;;
esac
/usr/bin/plutil -lint "${INSTALLED_APP}/Contents/Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist" >/dev/null \
  || die "the helper launchd plist is missing or does not lint"
/bin/rm -rf "$(/usr/bin/dirname "$EXPAND")"

PKG_SHA="$(/usr/bin/shasum -a 256 "$PKG" | /usr/bin/awk '{print $1}')"
/bin/echo "${PKG_SHA}  $(/usr/bin/basename "$PKG")" > "${PKG}.sha256"

# ─── 4. The lines for the report ─────────────────────────────────────────────────────────────
say "Summary"
/bin/echo
/bin/echo "  version      ${VERSION}"
/bin/echo "  app          ${APP}"
/bin/echo "  pkg          ${PKG}"
/bin/echo "  pkg sha256   ${PKG_SHA}  (${PKG}.sha256)"
/bin/echo "  pkg signed   ${PKG_SIGNED}"
/bin/echo
/bin/echo "--- codesign -dv, app ---"
codesign -dv --verbose=2 "$APP" 2>&1 | /usr/bin/grep -E "^Identifier|^Authority|^CDHash|^Format"
/bin/echo "--- codesign -dv, helper ---"
codesign -dv --verbose=2 "${APP}/Contents/MacOS/room-recorder-helper" 2>&1 | /usr/bin/grep -E "^Identifier|^Authority|^CDHash"
/bin/echo "--- codesign --verify, app (pinned leaf) ---"
codesign --verify --strict --deep -R "= certificate leaf = H\"${LEAF_LOWER}\"" "$APP" && /bin/echo "valid on disk, satisfies the designated requirement"
/bin/echo "--- pkgutil --check-signature ---"
/usr/sbin/pkgutil --check-signature "$PKG" || true
/bin/echo
if [ "$PKG_SIGNED" = "no" ]; then
  /bin/echo "NOTE: the pkg is UNSIGNED (the identity has no Installer key usage). Verified instead:"
  /bin/echo "      sha256 above, and the app inside the pkg against the pinned leaf."
fi
/bin/echo "Done."
