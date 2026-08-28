#!/bin/bash

set -euo pipefail

: "${OPUS_PREFIX:?OPUS_PREFIX must name the verified libopus installation}"

mode=""
package_seen=0
for argument in "$@"; do
  case "$argument" in
    --version)
      /usr/bin/printf '%s\n' "room-recorder-opus-pkg-config-1"
      exit 0
      ;;
    --exists | --print-errors | --static)
      ;;
    --cflags | --cflags-only-I | --libs | --variable=includedir)
      if [[ -n "$mode" ]]; then
        /usr/bin/printf 'unsupported pkg-config query\n' >&2
        exit 2
      fi
      mode="$argument"
      ;;
    opus)
      package_seen=1
      ;;
    *)
      /usr/bin/printf 'unsupported pkg-config argument: %s\n' "$argument" >&2
      exit 2
      ;;
  esac
done

if [[ "$package_seen" -ne 1 ]]; then
  /usr/bin/printf 'only the pinned opus package is available\n' >&2
  exit 1
fi

case "$mode" in
  "")
    exit 0
    ;;
  --cflags | --cflags-only-I)
    /usr/bin/printf '%s\n' "-I${OPUS_PREFIX}/include/opus"
    ;;
  --libs)
    /usr/bin/printf '%s\n' "-L${OPUS_PREFIX}/lib -lopus"
    ;;
  --variable=includedir)
    /usr/bin/printf '%s\n' "${OPUS_PREFIX}/include"
    ;;
esac
