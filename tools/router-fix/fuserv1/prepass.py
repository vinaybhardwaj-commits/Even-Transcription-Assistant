#!/usr/bin/env python3
"""FUSER v1 B1: the integration layer. Assembles ONE slice's full pre-pass output from a REB window's
tracks (design section 2), tying together tokenize_tracks, agreement, whisper_lid, number_parse and
drug_candidates/M6's language pick into what B2's prompt-builder needs.

`window` is duck-typed to reb.Window's read interface: window.tracks(layer, engine=None) ->
list[Track], each Track exposing .status, .reason, .segments (a plain list[dict], per REB-SPEC-v1.md).
Not import-coupled to reb's package here, so this module tests against reb's real writer/reader (see
test_prepass.py) without a hard dependency at import time.

lid-debug #4741's integration checklist, each addressed below:
  - every track shown, including empty/failed/skipped, with its status (L4) -- `tracks` in the output.
  - context tokens (the +-5s padding) are marked non-citable, not omitted -- every token's `citable`.
  - fused.v0 (the frozen commit) is read as an INPUT track, not only the eval baseline.
  - diar speaker + acoustics SNR are carried per slice.
  - p_en is None ("unknown") when no LID exists anywhere in the slice, never defaulted to 1.0 or 0.0.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agreement as ag  # noqa: E402
import drug_candidates as dc  # noqa: E402
import number_parse as npm  # noqa: E402
import tokenize_tracks as tt  # noqa: E402
import whisper_lid as wl  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import router_server as rs  # noqa: E402

STT_ENGINES = ["whisper-auto", "whisper-forced-en", "whisper-cap2",
              "indic-ctc-kn", "indic-ctc-hi", "indic-ctc-ta", "indic-ctc-te", "indic-ctc-ml", "sravaani"]
# CORRECTION (eta-refuter-2 #4842, noted for the step-2 code-freeze record, not a design edit): the
# design text (FUSER-V1-DESIGN.md sec 2) names this track "whisper-cap2prompt", but REB's real writer
# names it "whisper-cap2" (confirmed against ~/eta-data/reb's own live index). Using the design's literal
# spelling here would make this track show up as "not_present" in every real slice -- a silent loss of
# one input track, not a failure -- while the other 8 engine names already match REB exactly.
INDIC_CTC_ENGINES = {"indic-ctc-kn": "kn", "indic-ctc-hi": "hi", "indic-ctc-ta": "ta",
                     "indic-ctc-te": "te", "indic-ctc-ml": "ml"}
FUSED_V0_ENGINE = "fuser-v0-m6-etr"


def _latest(window, layer, engine=None):
    """The most recent track for (layer, engine), OK or not. reb's own tracks(latest_ok=True) (the
    default) silently DROPS a failed/skipped track from its result entirely -- found empirically
    testing this module against reb's real writer/reader: a track written with status="failed" simply
    did not appear, which would have violated L4 ("empty/failed/skipped is shown as such, never
    omitted") by making it indistinguishable from a track reb never even tried to write. Call with
    latest_ok=False and pick the newest entry ourselves, by whatever order reb.Window.tracks(latest_ok=
    False) returns them in (its docstring says "oldest first" for the manifest's own write order)."""
    ts = window.tracks(layer=layer, engine=engine, latest_ok=False)
    return ts[-1] if ts else None


def _track_status(track) -> dict:
    """Never omits a track (L4): a missing track is its own explicit status, not silence."""
    if track is None:
        return {"status": "not_present"}
    return {"status": track.status, "reason": getattr(track, "reason", None)}


def _slice_segments(track, t0_ms, t1_ms) -> list[dict]:
    if track is None or track.status != "ok":
        return []
    return [s for s in track.segments if s.get("t1_ms", -1) > t0_ms and s.get("t0_ms", float("inf")) < t1_ms]


def _mark_citable(tokens: list[dict], core_t0_ms: int, core_t1_ms: int) -> None:
    """In place: a token is citable only if it falls inside the CORE span, not the +-context padding."""
    for tok in tokens:
        if tok["t0_ms"] is None or tok["t1_ms"] is None:
            tok["citable"] = False
            continue
        centre = (tok["t0_ms"] + tok["t1_ms"]) / 2
        tok["citable"] = core_t0_ms <= centre < core_t1_ms


def _core_text(tokens: list[dict]) -> str:
    return " ".join(t["text"] for t in tokens if t.get("citable"))


def build_slice_prepass(window, slice_bounds: dict, lexicon: dict[str, int],
                        reverse_index: dict[str, int]) -> dict:
    """One slice's full pre-pass output. slice_bounds is one entry from slicing.cut_slices()."""
    t0, t1 = slice_bounds["t0_ms"], slice_bounds["t1_ms"]
    core_t0, core_t1 = slice_bounds["core_t0_ms"], slice_bounds["core_t1_ms"]

    tracks_out: dict[str, dict] = {}
    tokens_by_engine: dict[str, list[dict]] = {}
    for k, engine in enumerate(STT_ENGINES):
        track = _latest(window, "stt", engine)
        status = _track_status(track)
        segs = _slice_segments(track, t0, t1)
        toks = tt.tokenize_track(k, segs)
        _mark_citable(toks, core_t0, core_t1)
        tokens_by_engine[engine] = toks
        tracks_out[engine] = {**status, "n_tokens": len(toks), "n_citable": sum(t["citable"] for t in toks)}

    v0_track = _latest(window, "fused", FUSED_V0_ENGINE)
    v0_status = _track_status(v0_track)
    v0_segs = _slice_segments(v0_track, t0, t1)
    v0_toks = tt.tokenize_track(len(STT_ENGINES), v0_segs)
    _mark_citable(v0_toks, core_t0, core_t1)
    tracks_out["fused.v0"] = {**v0_status, "n_tokens": len(v0_toks), "n_citable": sum(t["citable"] for t in v0_toks)}

    core_texts = {eng: _core_text(toks) for eng, toks in tokens_by_engine.items()}
    core_texts["fused.v0"] = _core_text(v0_toks)

    # p(en) / top languages: whisper-auto preferred, forced-en as fallback; None if neither has LID.
    p_en, top_languages, lid_source = None, [], None
    for eng in ("whisper-auto", "whisper-forced-en"):
        track = _latest(window, "stt", eng)
        segs = _slice_segments(track, t0, t1)
        p = wl.slice_p_en(segs, core_t0, core_t1)
        if p is not None:
            p_en, top_languages, lid_source = p, wl.slice_top_languages(segs, core_t0, core_t1), eng
            break

    # M6 language pick: REB's indic-ctc-* tracks already ran ctc for every candidate language, so the
    # hi/mr tiebreak reads from what's already fetched -- no live engine call.
    indic_results = {lang: core_texts[eng] for eng, lang in INDIC_CTC_ENGINES.items() if core_texts.get(eng)}

    def _ctc_from_tracks(wav_path, language, decoding="rnnt", timeout=None):
        return {"text": indic_results.get(language, "")}
    sra_text = core_texts.get("sravaani", "")
    m6_language = (rs.pick_indic_lang_by_sravaani(sra_text, indic_results, _ctc_from_tracks, None)
                  if sra_text else None)

    indic_engines = ["sravaani", *INDIC_CTC_ENGINES]
    indic_texts = {eng: core_texts[eng] for eng in indic_engines if core_texts.get(eng)}
    agreement_matrix = ag.agreement_matrix(indic_texts) if len(indic_texts) >= 2 else {}
    numbers = {eng: npm.parse_numbers(text, reverse_index) for eng, text in indic_texts.items()}

    whisper_engine = "whisper-forced-en" if tokens_by_engine.get("whisper-forced-en") else "whisper-auto"
    drug_candidates_by_track: dict[str, list[dict]] = {}
    w_toks = [t for t in tokens_by_engine.get(whisper_engine, []) if t["citable"]]
    if w_toks:
        for eng in indic_engines:
            i_toks = [t for t in tokens_by_engine.get(eng, []) if t["citable"]]
            if i_toks:
                cands = dc.find_drug_candidates(w_toks, i_toks, lexicon)
                if cands:
                    drug_candidates_by_track[eng] = cands

    speaker = None
    diar_track = _latest(window, "diar")
    if diar_track is not None and diar_track.status == "ok":
        for seg in diar_track.segments:
            if seg.get("t0_ms", 0) < core_t1 and seg.get("t1_ms", 0) > core_t0:
                speaker = seg.get("speaker")
                break
    tracks_out["diar"] = _track_status(diar_track)

    snr = None
    for ac_track in window.tracks(layer="acoustics") or []:
        if ac_track.status != "ok":
            continue
        for seg in ac_track.segments:
            if seg.get("t0_ms", 0) < core_t1 and seg.get("t1_ms", 0) > core_t0 and seg.get("value") is not None:
                snr = seg.get("value")
                break
        if snr is not None:
            break
    tracks_out["acoustics"] = {"status": "ok" if snr is not None else "not_present"}

    tokens_out = dict(tokens_by_engine)
    tokens_out["fused.v0"] = v0_toks

    return {
        "t0_ms": t0, "t1_ms": t1, "core_t0_ms": core_t0, "core_t1_ms": core_t1,
        "cut_source": slice_bounds.get("cut_source"),
        "tracks": tracks_out, "tokens": tokens_out,
        "p_en": p_en, "top_languages": top_languages, "lid_source": lid_source,
        "m6_language": m6_language, "agreement": agreement_matrix, "numbers": numbers,
        "drug_candidates": drug_candidates_by_track, "speaker": speaker, "snr": snr,
    }
