"""Validators for REB track files and window manifests (REB-SPEC-v1.md section 2).
Reject on write, not just on read: a track missing engine/version/config_hash/status must never
reach disk (spec's step-2 order says so explicitly).
"""
from .schema import (
    REQUIRED_TRACK_FIELDS, REQUIRED_MANIFEST_FIELDS, REQUIRED_AUDIO_FIELDS,
    REQUIRED_SEGMENT_FIELDS, STATUS_VALUES, SCHEMA_VERSION,
    SOURCE_KIND_VALUES, CLOCK_VALUES, SUITE_ROOM_PREFIX,
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

        source_kind = manifest.get("source_kind")
        if source_kind is not None and source_kind not in SOURCE_KIND_VALUES:
            errors.append(f"manifest: source_kind {source_kind!r} not one of {SOURCE_KIND_VALUES}")
        room_id = manifest.get("room_id")
        if source_kind == "suite_synthetic" and isinstance(room_id, str) and not room_id.startswith(SUITE_ROOM_PREFIX):
            errors.append(
                f"manifest: source_kind='suite_synthetic' requires room_id to start with "
                f"{SUITE_ROOM_PREFIX!r} (got {room_id!r}) — a synthetic window must never be able to "
                "collide with, or be mistaken for, a real room (bus #4784)"
            )
        elif source_kind != "suite_synthetic" and isinstance(room_id, str) and room_id.startswith(SUITE_ROOM_PREFIX):
            errors.append(
                f"manifest: room_id {room_id!r} uses the reserved {SUITE_ROOM_PREFIX!r} prefix but "
                "source_kind is not 'suite_synthetic' — that prefix is reserved for synthetic suites"
            )

        clock = manifest.get("clock")
        if clock is not None and clock not in CLOCK_VALUES:
            errors.append(f"manifest: clock {clock!r} not one of {CLOCK_VALUES}")
    if errors and raise_on_error:
        raise ValidationError(errors)
    return errors
