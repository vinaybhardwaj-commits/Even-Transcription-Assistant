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

# Per-segment fields: t0_ms/t1_ms are the only ones required on every segment (spec section 2 marks
# the rest optional with "?"). A segment describing a scalar (e.g. an acoustics frame-stat value)
# uses "value" instead of "text"; extras is a free-form escape hatch, never a substitute for a named field.
REQUIRED_SEGMENT_FIELDS = ("t0_ms", "t1_ms")
OPTIONAL_SEGMENT_FIELDS = ("text", "lang", "script", "conf", "words", "speaker", "value", "extras")
