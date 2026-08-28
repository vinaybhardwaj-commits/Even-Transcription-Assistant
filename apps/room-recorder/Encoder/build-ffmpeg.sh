#!/bin/bash

set -euo pipefail
IFS=$'\n\t'
umask 022

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd -P)"
LOCK_JSON="${SCRIPT_DIRECTORY}/source-lock.json"
LOCK_SHELL="${SCRIPT_DIRECTORY}/source-lock.sh"
OUTPUT_ROOT="${1:-${SCRIPT_DIRECTORY}/../.build/encoder-candidate}"
SOURCE_CACHE="${ETA_ENCODER_SOURCE_CACHE:-${OUTPUT_ROOT}/downloads}"
ARTIFACT_ROOT="${OUTPUT_ROOT}/artifact"
BUILD_LOG="${OUTPUT_ROOT}/build.log"

sha256() {
  local line
  line="$(/usr/bin/shasum -a 256 "$1")"
  /usr/bin/printf '%s\n' "${line%% *}"
}

require_sha256() {
  if [[ ! "$2" =~ ^[0-9a-f]{64}$ ]]; then
    /usr/bin/printf '%s hash is absent or malformed\n' "$1" >&2
    exit 1
  fi
}

verify_file() {
  local label="$1"
  local path="$2"
  local expected_hash="$3"
  local expected_bytes="$4"
  local actual_hash actual_bytes

  if [[ ! -f "$path" || -L "$path" ]]; then
    /usr/bin/printf '%s is not a regular retained file: %s\n' "$label" "$path" >&2
    exit 1
  fi
  actual_hash="$(sha256 "$path")"
  actual_bytes="$(/usr/bin/stat -f '%z' "$path")"
  if [[ "$actual_hash" != "$expected_hash" || "$actual_bytes" != "$expected_bytes" ]]; then
    /usr/bin/printf '%s verification failed: sha256=%s bytes=%s\n' \
      "$label" "$actual_hash" "$actual_bytes" >&2
    exit 1
  fi
}

download_source() {
  local label="$1"
  local url="$2"
  local destination="$3"
  local expected_hash="$4"
  local expected_bytes="$5"
  local temporary

  if [[ -e "$destination" ]]; then
    verify_file "$label" "$destination" "$expected_hash" "$expected_bytes"
    return
  fi

  temporary="${destination}.download.$$"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$temporary" "$url"
  verify_file "$label" "$temporary" "$expected_hash" "$expected_bytes"
  /bin/mv "$temporary" "$destination"
}

if [[ ! -f "$LOCK_JSON" || ! -f "$LOCK_SHELL" ]]; then
  /usr/bin/printf 'source lock is incomplete\n' >&2
  exit 1
fi
if [[ -e "$ARTIFACT_ROOT" ]]; then
  /usr/bin/printf 'refusing to replace an encoder artifact: %s\n' "$ARTIFACT_ROOT" >&2
  exit 1
fi

# shellcheck source=source-lock.sh
source "$LOCK_SHELL"

require_sha256 "FFmpeg source" "$FFMPEG_SHA256"
require_sha256 "FFmpeg signature" "$FFMPEG_SIGNATURE_SHA256"
require_sha256 "FFmpeg signing key" "$FFMPEG_KEY_SHA256"
require_sha256 "libopus source" "$OPUS_SHA256"
for locked_value in \
  "$SOURCE_LOCK_SCHEMA_VERSION" "$FFMPEG_VERSION" "$FFMPEG_ARCHIVE" "$FFMPEG_URL" \
  "$FFMPEG_SHA256" "$FFMPEG_BYTES" "$FFMPEG_SIGNATURE" "$FFMPEG_SIGNATURE_SHA256" \
  "$FFMPEG_KEY" "$FFMPEG_KEY_SHA256" "$FFMPEG_KEY_FINGERPRINT" "$OPUS_VERSION" \
  "$OPUS_ARCHIVE" "$OPUS_URL" "$OPUS_SHA256" "$OPUS_BYTES"; do
  if ! /usr/bin/grep -Fq "${locked_value}" "$LOCK_JSON"; then
    /usr/bin/printf 'JSON and shell source locks disagree at: %s\n' "$locked_value" >&2
    exit 1
  fi
done

/bin/mkdir -p "$OUTPUT_ROOT" "$SOURCE_CACHE"
exec > >(/usr/bin/tee "$BUILD_LOG") 2>&1

/usr/bin/printf 'Building unsigned Room Recorder encoder candidate\n'
/usr/bin/printf 'FFmpeg %s sha256=%s\n' "$FFMPEG_VERSION" "$FFMPEG_SHA256"
/usr/bin/printf 'libopus %s sha256=%s\n' "$OPUS_VERSION" "$OPUS_SHA256"

FFMPEG_ARCHIVE_PATH="${SOURCE_CACHE}/${FFMPEG_ARCHIVE}"
OPUS_ARCHIVE_PATH="${SOURCE_CACHE}/${OPUS_ARCHIVE}"
FFMPEG_SIGNATURE_PATH="${SCRIPT_DIRECTORY}/${FFMPEG_SIGNATURE}"
FFMPEG_KEY_PATH="${SCRIPT_DIRECTORY}/${FFMPEG_KEY}"

download_source "FFmpeg source" "$FFMPEG_URL" "$FFMPEG_ARCHIVE_PATH" \
  "$FFMPEG_SHA256" "$FFMPEG_BYTES"
download_source "libopus source" "$OPUS_URL" "$OPUS_ARCHIVE_PATH" \
  "$OPUS_SHA256" "$OPUS_BYTES"
verify_file "FFmpeg signature" "$FFMPEG_SIGNATURE_PATH" \
  "$FFMPEG_SIGNATURE_SHA256" "520"
verify_file "FFmpeg signing key" "$FFMPEG_KEY_PATH" "$FFMPEG_KEY_SHA256" "1709"

GPG="$(command -v gpg || true)"
GPGV="$(command -v gpgv || true)"
if [[ -z "$GPG" || -z "$GPGV" ]]; then
  /usr/bin/printf 'gpg and gpgv are required to verify the retained FFmpeg signature\n' >&2
  exit 1
fi

WORK_ROOT="$(/usr/bin/mktemp -d "${OUTPUT_ROOT}/work.XXXXXX")"
cleanup_work() {
  local status=$?
  if [[ "$status" -eq 0 ]]; then
    /bin/rm -rf "$WORK_ROOT"
  else
    /usr/bin/printf 'failed build retained at %s\n' "$WORK_ROOT" >&2
  fi
  exit "$status"
}
trap cleanup_work EXIT
GPG_HOME="${WORK_ROOT}/gnupg"
GPG_KEYRING="${WORK_ROOT}/ffmpeg-release-keyring.gpg"
/bin/mkdir -m 700 "$GPG_HOME"
ACTUAL_FINGERPRINT="$(
  "$GPG" --homedir "$GPG_HOME" --batch --no-options --with-colons \
    --show-keys "$FFMPEG_KEY_PATH" \
    | /usr/bin/awk -F: '$1 == "fpr" { print $10; exit }'
)"
if [[ "$ACTUAL_FINGERPRINT" != "$FFMPEG_KEY_FINGERPRINT" ]]; then
  /usr/bin/printf 'FFmpeg signing key fingerprint mismatch: %s\n' "$ACTUAL_FINGERPRINT" >&2
  exit 1
fi
"$GPG" --homedir "$GPG_HOME" --batch --no-options --dearmor \
  --output "$GPG_KEYRING" "$FFMPEG_KEY_PATH"
"$GPGV" --keyring "$GPG_KEYRING" "$FFMPEG_SIGNATURE_PATH" "$FFMPEG_ARCHIVE_PATH"

SOURCE_ROOT="${WORK_ROOT}/source"
OPUS_BUILD="${WORK_ROOT}/opus-build"
OPUS_PREFIX="${WORK_ROOT}/opus-prefix"
FFMPEG_BUILD="${WORK_ROOT}/ffmpeg-build"
/bin/mkdir -p "$SOURCE_ROOT" "$OPUS_BUILD" "$OPUS_PREFIX" "$FFMPEG_BUILD"
/usr/bin/tar -xJf "$FFMPEG_ARCHIVE_PATH" -C "$SOURCE_ROOT"
/usr/bin/tar -xzf "$OPUS_ARCHIVE_PATH" -C "$SOURCE_ROOT"

FFMPEG_SOURCE="${SOURCE_ROOT}/ffmpeg-${FFMPEG_VERSION}"
OPUS_SOURCE="${SOURCE_ROOT}/opus-${OPUS_VERSION}"
if [[ ! -x "${FFMPEG_SOURCE}/configure" || ! -x "${OPUS_SOURCE}/configure" ]]; then
  /usr/bin/printf 'verified archives did not contain the pinned source roots\n' >&2
  exit 1
fi

SDK_ROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
CC="$(/usr/bin/xcrun --sdk macosx --find clang)"
AR="$(/usr/bin/xcrun --sdk macosx --find ar)"
RANLIB="$(/usr/bin/xcrun --sdk macosx --find ranlib)"
STRIP="$(/usr/bin/xcrun --sdk macosx --find strip)"
JOBS="${ETA_BUILD_JOBS:-$(/usr/sbin/sysctl -n hw.ncpu)}"
COMMON_CFLAGS="-O2 -arch arm64 -mmacosx-version-min=15.0 -isysroot ${SDK_ROOT}"
COMMON_LDFLAGS="-arch arm64 -mmacosx-version-min=15.0 -isysroot ${SDK_ROOT}"

(
  cd "$OPUS_BUILD"
  env CC="$CC" AR="$AR" RANLIB="$RANLIB" \
    CFLAGS="$COMMON_CFLAGS" LDFLAGS="$COMMON_LDFLAGS" \
    "$OPUS_SOURCE/configure" \
      --prefix="$OPUS_PREFIX" \
      --host=aarch64-apple-darwin \
      --disable-shared \
      --enable-static \
      --disable-doc \
      --disable-extra-programs
  /usr/bin/make -j "$JOBS"
  /usr/bin/make install
)

export OPUS_PREFIX
(
  cd "$FFMPEG_BUILD"
  "$FFMPEG_SOURCE/configure" \
    --prefix="${WORK_ROOT}/ffmpeg-prefix" \
    --arch=arm64 \
    --target-os=darwin \
    --cc="$CC" \
    --host-cc="$CC" \
    --host-cflags="$COMMON_CFLAGS" \
    --host-ld="$CC" \
    --host-ldflags="$COMMON_LDFLAGS" \
    --ar="$AR" \
    --ranlib="$RANLIB" \
    --strip="$STRIP" \
    --pkg-config="${SCRIPT_DIRECTORY}/pkg-config-opus.sh" \
    --extra-cflags="${COMMON_CFLAGS} -I${OPUS_PREFIX}/include" \
    --extra-ldflags="${COMMON_LDFLAGS} -L${OPUS_PREFIX}/lib" \
    --disable-autodetect \
    --disable-shared \
    --enable-static \
    --disable-doc \
    --disable-debug \
    --disable-network \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-gpl \
    --disable-nonfree \
    --disable-version3 \
    --disable-everything \
    --enable-ffmpeg \
    --enable-protocol=file \
    --enable-protocol=pipe \
    --enable-demuxer=pcm_s16le \
    --enable-decoder=pcm_s16le \
    --enable-libopus \
    --enable-encoder=libopus \
    --enable-muxer=webm \
    --enable-pthreads
  /usr/bin/make -j "$JOBS" ffmpeg
)

HELPERS="${ARTIFACT_ROOT}/Contents/Helpers"
RESOURCES="${ARTIFACT_ROOT}/Contents/Resources"
/bin/mkdir -p "$HELPERS" "${RESOURCES}/licenses" "${RESOURCES}/sources" \
  "${RESOURCES}/build" "${RESOURCES}/relink"
/bin/cp "${FFMPEG_BUILD}/ffmpeg" "${HELPERS}/ffmpeg"
"$STRIP" -x "${HELPERS}/ffmpeg"
/bin/chmod 755 "${HELPERS}/ffmpeg"
/bin/cp "${FFMPEG_SOURCE}/COPYING.LGPLv2.1" \
  "${RESOURCES}/licenses/FFmpeg-LGPL.txt"
/bin/cp "${OPUS_SOURCE}/COPYING" \
  "${RESOURCES}/licenses/libopus-BSD-3-Clause.txt"
/bin/cp "$FFMPEG_ARCHIVE_PATH" "$OPUS_ARCHIVE_PATH" "$FFMPEG_SIGNATURE_PATH" \
  "$FFMPEG_KEY_PATH" "${RESOURCES}/sources/"
/bin/cp "$0" "${SCRIPT_DIRECTORY}/pkg-config-opus.sh" "$LOCK_JSON" "$LOCK_SHELL" \
  "${RESOURCES}/build/"
/usr/bin/ditto "$FFMPEG_BUILD" "${RESOURCES}/relink/ffmpeg-build"
/usr/bin/ditto "$OPUS_BUILD" "${RESOURCES}/relink/libopus-build"

ENCODER="${HELPERS}/ffmpeg"
ARCHITECTURES="$(/usr/bin/lipo -archs "$ENCODER")"
if [[ "$ARCHITECTURES" != "arm64" ]]; then
  /usr/bin/printf 'encoder is not thin arm64: %s\n' "$ARCHITECTURES" >&2
  exit 1
fi

DEPENDENCIES="${OUTPUT_ROOT}/encoder-dependencies.txt"
/usr/bin/otool -L "$ENCODER" > "$DEPENDENCIES"
while read -r dependency _; do
  [[ -z "$dependency" || "$dependency" == *: ]] && continue
  case "$dependency" in
    /usr/lib/* | /System/Library/*)
      ;;
    *)
      /usr/bin/printf 'non-system encoder dependency: %s\n' "$dependency" >&2
      exit 1
      ;;
  esac
done < "$DEPENDENCIES"

ENCODER_SHA256="$(sha256 "$ENCODER")"
/usr/bin/printf '%s\n' \
  '{' \
  "  \"binary_sha256\": \"${ENCODER_SHA256}\"," \
  '  "certificate_sha256": null,' \
  '  "encoder_identifier": "com.evenscribe.room-recorder.ffmpeg",' \
  "  \"ffmpeg_source_sha256\": \"${FFMPEG_SHA256}\"," \
  "  \"libopus_source_sha256\": \"${OPUS_SHA256}\"," \
  '  "production_ready": false,' \
  '  "reason": "unsigned_encoder_candidate",' \
  '  "schema_version": 1' \
  '}' > "${RESOURCES}/build-provenance.json"

"$ENCODER" -version
/usr/bin/printf 'encoder_sha256=%s\n' "$ENCODER_SHA256"
/usr/bin/printf 'artifact=%s\n' "$ARTIFACT_ROOT"
/usr/bin/printf 'production_ready=false (signing and frozen-command gates remain)\n'
