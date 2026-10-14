"""Validators for REB track files and window manifests (REB-SPEC-v1.md section 2).
Reject on write, not just on read: a track missing engine/version/config_hash/status must never
reach disk (spec's step-2 order says so explicitly).
"""
from .schema import (
    REQUIRED_TRACK_FIELDS, REQUIRED_MANIFEST_FIELDS, REQUIRED_AUDIO_FIELDS,
    REQUIRED_SEGMENT_FIELDS, STATUS_VALUES, SCHEMA_VERSION,
    SOURCE_KIND_VALUES, DEFAULT_SOURCE_KIND, CLOCK_VALUES,
    SUITE_ROOM_RE, REAL_ROOM_ID_RE,
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
        # The DEFAULT (source_kind omitted) is room_tape — the check below applies to it too, per
        # eta-refuter-2's #4805 S1: the safe side must be the default, not an opt-in you can forget.
        effective_source_kind = source_kind or DEFAULT_SOURCE_KIND
        room_id = manifest.get("room_id")
        clock = manifest.get("clock")
        effective_clock = clock or "tape_utc"

        if effective_source_kind == "suite_synthetic":
            if isinstance(room_id, str) and not SUITE_ROOM_RE.match(room_id):
                errors.append(
                    f"manifest: source_kind='suite_synthetic' requires room_id to match {SUITE_ROOM_RE.pattern!r} "
                    f"(got {room_id!r}) — a synthetic window must never be able to collide with, or be "
                    "mistaken for, a real room (bus #4784/#4805)"
                )
            if clock != "clip_local":
                errors.append(
                    f"manifest: source_kind='suite_synthetic' requires clock='clip_local' (got {clock!r}) "
                    "— a synthetic window has no tape clock and must not look like it's on one"
                )
        else:  # room_tape (explicit or defaulted) and dev_clip both use a REAL room_id
            if isinstance(room_id, str) and not REAL_ROOM_ID_RE.match(room_id):
                errors.append(
                    f"manifest: source_kind={effective_source_kind!r} requires room_id to match "
                    f"{REAL_ROOM_ID_RE.pattern!r} (got {room_id!r}) — this is the POSITIVE check "
                    "(eta-refuter-2 #4805 S1): a made-up room_id must never be silently accepted as a "
                    "real room just because source_kind was left unset"
                )
            if effective_clock == "clip_local":
                errors.append(
                    f"manifest: source_kind={effective_source_kind!r} must not have clock='clip_local' "
                    "(that means 'no tape clock', which contradicts having a real room_id)"
                )

        if effective_source_kind == "dev_clip":
            # A dev_clip can span MORE than one tape chunk / hist-bulk window (a consult-length crop,
            # for instance) -- eta-refuter-2 #4853 (also independently flagged by eta-refuter-3 #4855):
            # a single {run_id, window_id} silently recorded only the first source and broke the
            # traceability this field exists for. Always a non-empty LIST, even for a one-source clip.
            #
            # Two valid entry shapes (terms #5225): {run_id, window_id} for a crop built from
            # hist-bulk's own WINDOW jsons (DEV30's original case -- window_id isn't globally unique
            # on its own, so run_id is required alongside it); {r2_key} for a crop built directly from
            # the raw CHUNK inventory (set-(c)'s case, per reb #5192 -- an r2_key already fully
            # qualifies one chunk on its own, e.g. "bench/<slug>/<date>/<session>/chunk_NNNNN.webm", so
            # no second field is needed). Both are real, honest provenance of what tape data a crop
            # actually drew from -- this field's own error message always said "tape chunk/hist-bulk
            # window" (both), the validator just hadn't caught up to the chunk-level case yet.
            source_windows = manifest.get("source_windows")

            def _valid_source_window(sw):
                if not isinstance(sw, dict):
                    return False
                if sw.get("run_id") and sw.get("window_id"):
                    return True
                r2_key = sw.get("r2_key")
                return isinstance(r2_key, str) and bool(r2_key)  # eta-refuter-3 #5234 nit

            valid = (
                isinstance(source_windows, list) and len(source_windows) > 0
                and all(_valid_source_window(sw) for sw in source_windows)
            )
            if not valid:
                errors.append(
                    "manifest: source_kind='dev_clip' requires source_windows=[{'run_id':..., "
                    "'window_id':...}, ...] or [{'r2_key':...}, ...] (non-empty; EVERY tape chunk/"
                    "hist-bulk window this sub-clip spans, not just the first — eta-refuter-2 "
                    "#4805/#4853, chunk-level shape added for terms' set-(c) crops #5225)"
                )

        if clock is not None and clock not in CLOCK_VALUES:
            errors.append(f"manifest: clock {clock!r} not one of {CLOCK_VALUES}")
    if errors and raise_on_error:
        raise ValidationError(errors)
    return errors
