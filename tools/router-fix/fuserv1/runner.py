#!/usr/bin/env python3
"""FUSER v1 B4: the DEV/TEST runner. Ties every earlier piece together for ONE window: cut_slices ->
build_slice_prepass -> build_payload -> call_slice -> validate_slice, with per-slice latency/usage
recorded for design section 7's cost/latency measurement. `window` is duck-typed to reb.Window's read
interface, same convention as prepass.py -- this module has no import-time dependency on reb, so it
tests against reb's real writer/reader without a hard package dependency (see test_runner.py).

NOTHING here writes a fused.gemini-v1 track back to REB yet -- that is section 5's output-track shape,
which belongs to the TEST/freeze step (B5), once B4's own DEV numbers are reviewed. This module's job
is measurement: does the pipeline run end to end on real tracks, what does it cost, how long does it
take, what outcome (pass/repair/fallback) does the validator reach per slice.
"""
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gemini_call as gc  # noqa: E402
import payload as pl  # noqa: E402
import prepass  # noqa: E402
import schema as sc  # noqa: E402
import slicing  # noqa: E402
import validator as val  # noqa: E402

INDIC_ENGINES = ["sravaani", *prepass.INDIC_CTC_ENGINES]


def _indic_texts(tokens_by_engine: dict[str, list[dict]]) -> dict[str, str]:
    """One core (citable-only) text per Indic engine that actually has content this slice -- what V4's
    anchor search and the agreement matrix both read, rebuilt here from prepass's own "tokens" output
    the same way prepass.py builds its internal core_texts (so this never drifts from what the model
    itself was shown in the payload)."""
    out = {}
    for eng in INDIC_ENGINES:
        text = " ".join(t["text"] for t in tokens_by_engine.get(eng, []) if t.get("citable"))
        if text:
            out[eng] = text
    return out


def run_slice(window, slice_bounds: dict, lexicon: dict[str, int], reverse_index: dict[str, int],
             send) -> dict:
    """One slice end to end. `send` is gemini_call's transport function (http_transport(key) for a real
    call, or a stub in tests) -- never constructed here, so a caller controls exactly what network
    access (if any) a given run actually gets."""
    pos_stats = None
    prepass_output = prepass.build_slice_prepass(window, slice_bounds, lexicon, reverse_index)
    payload = pl.build_payload(prepass_output)
    t0 = time.monotonic()
    reply = gc.call_slice(payload, send)
    latency_ms = round((time.monotonic() - t0) * 1000)
    if reply["status"] != "ok":
        validated = {"outcome": "fallback", "reasons": [f"api_{reply['status']}"],
                    "dropped_items": [], "dropped_share": 1.0}
    else:
        flat = val.flatten_tokens(prepass_output["tokens"])
        indic_texts = _indic_texts(prepass_output["tokens"])
        flat_reply, pre_dropped, pos_stats = sc.normalise_items(reply["data"])
        validated = val.validate_slice(flat_reply, flat, reverse_index, prepass_output["p_en"],
                                       indic_texts, prepass_output["drug_candidates"], pre_dropped,
                                       v7_lexicon=lexicon)
        validated["pos_stats"] = pos_stats
    n_native_items = pos_stats["n_raw_items"] if reply["status"] == "ok" else 0
    return {
        "slice": slice_bounds, "cut_source": prepass_output["cut_source"],
        "reply_status": reply["status"], "usage": reply.get("usage"),
        "finish_reason": reply.get("finish_reason"),
        "latency_ms": latency_ms, "n_native_items": n_native_items,
        "validated": validated,
    }


def clip_local_bounds(window) -> tuple[int, int]:
    """(0, duration_ms) -- NEVER (window.t0_ms, window.t1_ms). Found the hard way on B4's own smoke test:
    every STT/diar/VAD engine timestamps its segments relative to the start of the actual audio FILE it
    was given, always starting at 0, regardless of where that file sits on a real day's timeline. A
    window's own manifest t0_ms/t1_ms is a REPORTING-time concern only -- for a "clip_local"-clock window
    (REB-SPEC's suite_synthetic convention) it happens to already be 0-based, but for a "tape_utc"-clock
    window (the dev_clip convention: a short real-room clip placed at its true absolute tape position) it
    is a huge absolute number that shares no origin with the segments inside its own tracks at all. Using
    it directly as the slicing bounds silently zeroed every extracted token for all 30 real DEV30 windows
    before this fix existed -- every engine's own track was status="ok" with real segments, but every one
    of them fell outside a [t0_ms, t1_ms] window computed from the wrong clock, so prepass reported total
    silence for windows that indisputably were not silent (L009, the same Kannada PCNL/dilators clip from
    the original router eval, is a case in point).

    VERIFIED ONLY for suite_synthetic/clip_local and dev_clip/tape_utc,approx (eta-refuter-2 #5020,
    checked against all 222 real B4 windows: every one of their tracks' segments is 0-based). NOT yet
    verified for source_kind="room_tape" (a real full-day room recording, the eventual backfill case,
    default when the manifest doesn't declare source_kind at all) -- a room_tape window's engine may have
    been given a much larger slice of continuous audio and could plausibly timestamp its own segments on
    the SAME absolute clock as the window's own manifest t0_ms/t1_ms, unlike a dev_clip's short, separately
    -extracted file. Asserting rather than silently assuming (0, duration) is still correct there (per
    refuter-2's explicit ask: "assert the clock per source_kind before any room run") -- fails loud so
    whoever wires up the first real room_tape run through FUSER has to make that call deliberately, never
    inherits this dev_clip-shaped assumption by accident."""
    manifest = getattr(window, "manifest", None) or {}
    source_kind = manifest.get("source_kind", "room_tape")
    if source_kind == "room_tape":
        raise NotImplementedError(
            f"clip_local_bounds: window {getattr(window, 'window_id', '?')!r} has source_kind="
            "'room_tape' (or none declared, which defaults to it) -- (0, duration_ms) is verified only "
            "for suite_synthetic/dev_clip windows (eta-refuter-2 #5020). A room_tape window's own "
            "segment clock has not been checked and must not be assumed; verify it and extend this "
            "function deliberately before running FUSER against real room-tape backfill data.")
    audio = getattr(window, "audio", None) or {}
    duration = audio.get("duration_ms")
    if duration is None:
        duration = window.t1_ms - window.t0_ms  # best-effort fallback if audio metadata is ever absent
    return 0, duration


def run_window(window, lexicon: dict[str, int], reverse_index: dict[str, int], send,
              diar_segments=None, vad_segments=None) -> dict:
    """Every slice of one window, plus the aggregate DEV metrics section 7 asks for: p95 latency, total
    usage (tokens/cost, whatever the API actually reported -- never estimated), and an outcome tally.
    Bounds are ALWAYS derived from the window itself (clip_local_bounds) -- never caller-supplied -- so
    this can't be misused the way the pre-fix version was (see clip_local_bounds' own docstring)."""
    t0, t1 = clip_local_bounds(window)
    slices = slicing.cut_slices(t0, t1, diar_segments, vad_segments)
    results = [run_slice(window, s, lexicon, reverse_index, send) for s in slices]
    latencies = [r["latency_ms"] for r in results]
    outcomes: dict[str, int] = {}
    for r in results:
        o = r["validated"]["outcome"]
        outcomes[o] = outcomes.get(o, 0) + 1
    total_cost = sum(r["usage"]["cost"] for r in results if r.get("usage") and "cost" in r["usage"])
    total_prompt_tok = sum(r["usage"]["prompt_tokens"] for r in results
                           if r.get("usage") and "prompt_tokens" in r["usage"])
    total_completion_tok = sum(r["usage"]["completion_tokens"] for r in results
                               if r.get("usage") and "completion_tokens" in r["usage"])
    return {
        "n_slices": len(results), "slices": results, "outcomes": outcomes,
        "p95_latency_ms": (statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 2
                          else (latencies[0] if latencies else None)),
        "total_cost_usd": round(total_cost, 6) if total_cost else None,
        "total_prompt_tokens": total_prompt_tok or None,
        "total_completion_tokens": total_completion_tok or None,
    }
