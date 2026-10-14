#!/usr/bin/env bash
# W50 set (c): the ONLY step that actually moves patient audio off this box, to the private HF bucket Fable's
# ruling names (hf://buckets/vrbeven/eta-parity-io/w50-setc-2026-09-28/). This script is meant to be run by a
# human (Fable), NOT by terms or any other agent - hf-fleet (#5170) and reb (#5171) both independently hit a
# permission-classifier block trying to move real tape/room audio from an agent session, even a same-box local
# copy. Reviewed by eta-refuter-3 (#5173/#5196/#5213/#5221 checklist) before this is ever run.
#
# What it does, per file listed in manifest.jsonl (never a directory glob - refuter-3 #5208/#5213): recomputes
# that file's sha256, compares it against the manifest's recorded value, and refuses to upload on any mismatch
# rather than silently uploading a file that changed since staging. Uploads manifest.jsonl itself last, once
# every audio file has been verified+uploaded, so a partial run never leaves a manifest claiming files that
# aren't actually there.
#
# refuter-3 review (#5221) fixes, all required before Fable runs this:
# U1 - EXPECTED_MANIFEST_SHA is now REQUIRED: refuses unless sha256(manifest.jsonl) matches exactly, so Fable
#      uploads exactly the 87-consult set refuter-3 already verified, not a silently re-staged one.
# U2 - each wav_path is refused unless it resolves (realpath) to somewhere under $STAGE_DIR/audio/ - a
#      hand-edited or corrupted manifest.jsonl could otherwise point at any file on the box.
# U3 - consult_id is refused unless it matches ^[A-Za-z0-9_-]+$ before being used as a bucket filename - guards
#      against path traversal or shell-meaningful characters reaching `hf cp`'s destination argument.
#
# Usage: EXPECTED_MANIFEST_SHA=<sha256> STAGE_DIR=~/eta-data/terms/setc-stage bash upload_set_c_to_bucket.sh
set -euo pipefail

STAGE_DIR="${STAGE_DIR:-$HOME/eta-data/terms/setc-stage}"
BUCKET_PREFIX="hf://buckets/vrbeven/eta-parity-io/w50-setc-2026-09-28"
MANIFEST="$STAGE_DIR/manifest.jsonl"
AUDIO_DIR="$STAGE_DIR/audio"

if [ -z "${EXPECTED_MANIFEST_SHA:-}" ]; then
    echo "ERROR: EXPECTED_MANIFEST_SHA is required (refuter-3 U1) - set it to the exact sha256 of the" >&2
    echo "       manifest.jsonl that was reviewed, so this uploads exactly that set, not a re-staged one." >&2
    exit 1
fi

if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: $MANIFEST not found - nothing to upload" >&2
    exit 1
fi

actual_manifest_sha=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
if [ "$actual_manifest_sha" != "$EXPECTED_MANIFEST_SHA" ]; then
    echo "ERROR: $MANIFEST sha256 is $actual_manifest_sha, expected $EXPECTED_MANIFEST_SHA - stopping." >&2
    echo "       This is not the reviewed manifest - do not force past this." >&2
    exit 1
fi

audio_dir_real=$(realpath "$AUDIO_DIR")
n_lines=$(wc -l < "$MANIFEST")
echo "Manifest sha256 verified ($EXPECTED_MANIFEST_SHA). Uploading $n_lines consults from $MANIFEST to $BUCKET_PREFIX/"
echo "Each file's sha256 is verified against the manifest before upload - any mismatch stops the run."
echo

n_ok=0
while IFS= read -r line; do
    consult_id=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['consult_id'])")
    wav_path=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['wav_path'])")
    expected_sha=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha256'])")

    if ! [[ "$consult_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
        echo "ERROR: consult_id '$consult_id' has unexpected characters - refusing (U3) - stopping" >&2
        exit 1
    fi

    if [ ! -f "$wav_path" ]; then
        echo "ERROR: $consult_id: $wav_path listed in manifest but does not exist on disk - stopping" >&2
        exit 1
    fi
    wav_path_real=$(realpath "$wav_path")
    case "$wav_path_real" in
        "$audio_dir_real"/*) ;;
        *)
            echo "ERROR: $consult_id: $wav_path_real is not under $audio_dir_real - refusing (U2) - stopping" >&2
            exit 1
            ;;
    esac

    actual_sha=$(sha256sum "$wav_path" | cut -d' ' -f1)
    if [ "$actual_sha" != "$expected_sha" ]; then
        echo "ERROR: $consult_id: sha256 mismatch - manifest says $expected_sha, file is $actual_sha - stopping" >&2
        echo "       (the file changed since staging - re-run decode_set_c_audio.py, do not force past this)" >&2
        exit 1
    fi

    hf cp "$wav_path" "$BUCKET_PREFIX/${consult_id}.wav"
    n_ok=$((n_ok + 1))
    echo "  [$n_ok/$n_lines] $consult_id: verified sha256, uploaded"
done < "$MANIFEST"

echo
echo "All $n_ok audio files verified and uploaded. Uploading manifest.jsonl itself..."
hf cp "$MANIFEST" "$BUCKET_PREFIX/manifest.jsonl"
echo "Done: $n_ok/$n_lines consults + manifest.jsonl uploaded to $BUCKET_PREFIX/"
