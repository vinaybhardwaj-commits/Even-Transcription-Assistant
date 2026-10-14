"""REB-SPEC-v1.md section 2/3 — the shapes every track and manifest must match.
Kept deliberately small: the schema is a contract test writers/readers share, not a full JSON-schema
document. "any new engine = new track" (spec section 3) means layer/engine are open strings, not enums.
"""

SCHEMA_VERSION = "reb.track.v1"

STATUS_VALUES = ("ok", "empty", "failed", "skipped")

# Fields every track file must have, regardless of layer/engine (spec section 2, "Track file").
REQUIRED_TRACK_FIELDS = (
    "schema", "window_id", "layer", "engine", "model", "version",
    "config", "config_hash", "machine", "status",
)

# Fields every manifest.json must have (spec section 2).
REQUIRED_MANIFEST_FIELDS = (
    "window_id", "room_id", "room_slug", "ist_date", "t0_ms", "t1_ms", "audio",
)

REQUIRED_AUDIO_FIELDS = ("r2_key", "sha256", "sample_rate", "duration_ms")

# Optional manifest fields distinguishing what a window's audio actually is (bus #4783/#4784, for the
# clinical1/label200 DEV ingest): a real room recording (the default, and the only kind that counts
# for anything that aggregates real rooms — the day record, viewer rollups, S2), a fully synthetic
# test suite (S1's clinical1: no tape origin at all), or a short real-room sub-clip pulled out of a
# larger hist-bulk window for dev/eval purposes (label200's DEV30). Absent = "room_tape", same as
# every window written before this field existed.
SOURCE_KIND_VALUES = ("room_tape", "suite_synthetic", "dev_clip")
DEFAULT_SOURCE_KIND = "room_tape"

# How trustworthy a window's t0_ms/t1_ms are as real tape-clock UTC: "tape_utc" (the normal case, or
# a dev_clip whose absolute time was reconstructed from its source window's start + cut offsets),
# "approx" (reconstructed but the source cut had a nonzero gap, so it's off by up to that gap), or
# "clip_local" (a suite_synthetic window: there is no tape clock, t0/t1 are just relative to the clip
# itself). Absent = "tape_utc", same as every window written before this field existed.
CLOCK_VALUES = ("tape_utc", "approx", "clip_local")
DEFAULT_CLOCK = "tape_utc"

# A suite_synthetic window's room_id must use this prefix (enforced by validate_manifest) so it can
# never collide with, or be mistaken for, a real room_id — this is what makes "reject a suite_synthetic
# window whose room_id is a real room" (lid-debug, #4784) checkable without maintaining a live list of
# real room ids in the schema.
SUITE_ROOM_PREFIX = "suite-"

# Per-segment fields: t0_ms/t1_ms are the only ones required on every segment (spec section 2 marks
# the rest optional with "?"). A segment describing a scalar (e.g. an acoustics frame-stat value)
# uses "value" instead of "text"; extras is a free-form escape hatch, never a substitute for a named field.
REQUIRED_SEGMENT_FIELDS = ("t0_ms", "t1_ms")
OPTIONAL_SEGMENT_FIELDS = ("text", "lang", "script", "conf", "words", "speaker", "value", "extras")
