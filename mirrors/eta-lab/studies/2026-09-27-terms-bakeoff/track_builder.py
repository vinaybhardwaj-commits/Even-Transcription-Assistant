"""W50 terms bake-off: builds a REB-schema track dict (kit/reb/schema.py's "reb.track.v1") from
chunked_runner.run_engine_for_track()'s output, closing the other half of refuter-3's T2 (bus #4936/#4938):
"there's ... no track builder/writer: seconds t0/t1 -> t0_ms/t1_ms, status ok/empty/failed, write_track."

Design choices, stated:
- Never lets a transcribe_chunk exception propagate and crash the whole run: catches it and returns a
  status="failed" track with a `reason`, matching dev_ingest's own observed convention (ADDENDUM-14's N2) of
  recording a failure explicitly rather than leaving a window stuck. A PinnedConfigMismatch is the one exception
  NOT caught this way - config drift must always surface loudly, never quietly become a routine "failed" track.
- status="empty" (ran fine, produced no segments) vs status="failed" (the call raised) are kept distinct, per
  ADDENDUM-10's N2: an engine correctly reporting silence is real data, not a failure.
- Segment times are converted from float seconds (chunked_runner's units) to int milliseconds (REB's schema),
  rounding rather than truncating.
"""
from chunked_runner import run_engine_for_track
from pinned_configs import PinnedConfigMismatch

SCHEMA_VERSION = "reb.track.v1"


def build_track(*, engine, config, model, version, machine, window_id, layer, duration_s, transcribe_chunk,
                 dataset_set=None):
    """The single entry point for a W50 engine's track. Runs the (possibly chunked, config-guarded) transcription
    and returns a fully-formed REB track dict, ready for kit/reb.writer.write_track() (which will independently
    recompute config_hash and validate the schema - this function does not duplicate that check, only builds the
    dict in the right shape).
    -> track dict: {schema, window_id, layer, engine, model, version, config, config_hash, machine, status,
       segments: [{t0_ms, t1_ms, text?}, ...], reason? (only present when status=="failed")}.
    Raises PinnedConfigMismatch (never swallowed) if `config` doesn't match the pre-registered value.
    """
    from pinned_configs import config_hash as _config_hash

    base = {
        "schema": SCHEMA_VERSION,
        "window_id": window_id,
        "layer": layer,
        "engine": engine,
        "model": model,
        "version": version,
        "config": config,
        "config_hash": _config_hash(config),
        "machine": machine,
    }

    try:
        _windows, raw_segments = run_engine_for_track(
            engine, config, duration_s, transcribe_chunk, dataset_set=dataset_set
        )
    except PinnedConfigMismatch:
        raise  # config drift is never a routine "failed" track - it must stop the caller, not get buried
    except Exception as e:  # noqa: BLE001 - deliberately broad: any model/network/decoding failure becomes status=failed
        return {**base, "status": "failed", "reason": f"{type(e).__name__}: {e}", "segments": []}

    segments_ms = [_to_ms_segment(seg) for seg in raw_segments]
    status = "empty" if not segments_ms else "ok"
    return {**base, "status": status, "segments": segments_ms}


def _to_ms_segment(seg):
    out = {"t0_ms": round(seg["t0"] * 1000), "t1_ms": round(seg["t1"] * 1000)}
    if "text" in seg:
        out["text"] = seg["text"]
    for extra_key in ("lang", "script", "conf", "words", "speaker"):
        if extra_key in seg:
            out[extra_key] = seg[extra_key]
    return out
