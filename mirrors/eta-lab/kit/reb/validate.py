"""Validators for REB track files and window manifests (REB-SPEC-v1.md section 2).
Reject on write, not just on read: a track missing engine/version/config_hash/status must never
reach disk (spec's step-2 order says so explicitly).
"""
from .schema import (
    REQUIRED_TRACK_FIELDS, REQUIRED_MANIFEST_FIELDS, REQUIRED_AUDIO_FIELDS,
    REQUIRED_SEGMENT_FIELDS, STATUS_VALUES, SCHEMA_VERSION,
)


class ValidationError(ValueError):
    """Raised with every problem found, not just the first, so a caller can fix a track in one pass."""

    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


def _check_required(d, fields, where, errors):
    if not isinstance(d, dict):
        errors.append(f"{where}: expected an object, got {type(d).__name__}")
        return
    for f in fields:
        if f not in d or d[f] in (None, ""):
            errors.append(f"{where}: missing required field '{f}'")


def validate_track(track, raise_on_error=True):
    """Validate one track dict against REB-SPEC-v1.md section 2. Returns the list of errors
    (empty = valid). Raises ValidationError if raise_on_error and there are any errors."""
    errors = []
    _check_required(track, REQUIRED_TRACK_FIELDS, "track", errors)

    if isinstance(track, dict):
        schema = track.get("schema")
        if schema is not None and schema != SCHEMA_VERSION:
            errors.append(f"track: schema '{schema}' != expected '{SCHEMA_VERSION}'")

        status = track.get("status")
        if status is not None and status not in STATUS_VALUES:
            errors.append(f"track: status '{status}' not one of {STATUS_VALUES}")
        if status in ("failed", "skipped") and not track.get("reason"):
            errors.append(f"track: status '{status}' requires a non-empty 'reason'")

        config = track.get("config")
        if config is not None and not isinstance(config, dict):
            errors.append("track: 'config' must be an object")

        segments = track.get("segments")
        if segments is None:
            if status == "ok":
                errors.append("track: status 'ok' requires a 'segments' list (use [] for none, or status 'empty')")
        elif not isinstance(segments, list):
            errors.append("track: 'segments' must be a list")
        else:
            for i, seg in enumerate(segments):
                _check_required(seg, REQUIRED_SEGMENT_FIELDS, f"track.segments[{i}]", errors)
                if isinstance(seg, dict) and "t0_ms" in seg and "t1_ms" in seg:
                    try:
                        if seg["t1_ms"] < seg["t0_ms"]:
                            errors.append(f"track.segments[{i}]: t1_ms < t0_ms")
                    except TypeError:
                        errors.append(f"track.segments[{i}]: t0_ms/t1_ms must be numeric")

    if errors and raise_on_error:
        raise ValidationError(errors)
    return errors


def validate_manifest(manifest, raise_on_error=True):
    """Validate a window manifest.json against REB-SPEC-v1.md section 2."""
    errors = []
    _check_required(manifest, REQUIRED_MANIFEST_FIELDS, "manifest", errors)
    if isinstance(manifest, dict):
        audio = manifest.get("audio")
        if audio is not None:
            _check_required(audio, REQUIRED_AUDIO_FIELDS, "manifest.audio", errors)
        tracks = manifest.get("tracks", [])
        if not isinstance(tracks, list):
            errors.append("manifest: 'tracks' must be a list")
    if errors and raise_on_error:
        raise ValidationError(errors)
    return errors
