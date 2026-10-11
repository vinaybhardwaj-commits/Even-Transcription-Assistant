"""Pure-patient windows from synthetic Nemotron timelines. No audio, no R2."""

from __future__ import annotations

import numpy as np
import pytest

from tools.timbre.nemotron_probs import FrameStepWarning, pack_nlp
from tools.timbre.nemotron_windows import (
    WINDOWS_COLUMNS,
    build_from_nlp,
    build_patient_windows,
    main,
    pure_spans,
    windows_from_mask,
    write_windows_csv,
)
from tools.timbre.purity import PurityRule, probs_purity
from tools.timbre.slots import map_slots
from tools.timbre.windows import load_windows


def _at(cos: float, dim: int = 4) -> np.ndarray:
    v = np.zeros(dim, dtype=np.float64)
    v[0] = cos
    v[1] = np.sqrt(max(0.0, 1.0 - cos * cos))
    return v


def _meta():
    return dict(clip_id="CLIP", room="ROOM-A", date="2026-01-01", lang="en", phase="open")


def test_spans_drop_short_tails_and_split_at_15s():
    hop = 10.0
    twenty = np.ones(2000, dtype=bool)  # 20 s
    rows = windows_from_mask(twenty, frame_ms=hop, **_meta())
    assert [round(r["end_s"] - r["start_s"], 3) for r in rows] == [15.0, 5.0]
    assert rows[0]["window_id"] == "CLIP_p0000000"
    assert rows[1]["window_id"] == "CLIP_p0015000"
    assert rows[0]["patient_speech_s"] == pytest.approx(15.0)
    assert rows[0]["role"] == "patient" and rows[0]["diar_src"] == "nemotron"

    sixteen = np.ones(1600, dtype=bool)  # 16 s → 15 s kept, 1 s tail dropped
    assert len(windows_from_mask(sixteen, frame_ms=hop, **_meta())) == 1

    short = np.ones(200, dtype=bool)  # 2 s
    assert windows_from_mask(short, frame_ms=hop, **_meta()) == []

    origin = windows_from_mask(np.ones(400, dtype=bool), frame_ms=hop, origin_s=1.5, **_meta())
    assert origin[0]["window_id"] == "CLIP_p0001500"
    assert origin[0]["start_s"] == pytest.approx(1.5)


def test_gap_is_not_bridged_unless_asked():
    mask = np.zeros(810, dtype=bool)
    mask[:400] = True
    mask[410:] = True  # 0.1 s hole at 10 ms
    assert pure_spans(mask, 0) == [(0, 400), (410, 810)]
    split = windows_from_mask(mask, frame_ms=10, **_meta())
    assert len(split) == 2
    bridged = windows_from_mask(mask, frame_ms=10, max_gap_s=0.2, **_meta())
    assert len(bridged) == 1
    assert bridged[0]["patient_speech_s"] == pytest.approx(8.0)
    assert bridged[0]["end_s"] - bridged[0]["start_s"] == pytest.approx(8.1)


def test_ambiguous_map_writes_no_windows_even_when_one_voice_is_long():
    probs = np.zeros((2000, 3), dtype=np.float64)
    probs[:200, 0] = 0.95
    probs[200:1200, 1] = 0.95
    probs[1200:, 2] = 0.95
    emb = np.stack([_at(0.9), _at(0.0), _at(0.05)])
    build = build_patient_windows(
        probs,
        frame_ms=10,
        slot_embeddings=emb,
        doctor_centroid=np.array([1.0, 0.0, 0.0, 0.0]),
        **_meta(),
    )
    assert build.decision.reason == "patient_rival"
    assert build.rows == []
    assert build.n_windows == 0


def test_accepted_timeline_matches_the_csv_schema_and_the_purity_rule():
    probs = np.zeros((1000, 2), dtype=np.float64)
    probs[:200, 0] = 0.95  # doctor, 2 s
    probs[200:, 1] = 0.95  # patient, 8 s
    emb = np.stack([_at(0.9), _at(0.0)])
    build = build_patient_windows(
        probs,
        frame_ms=10,
        slot_embeddings=emb,
        doctor_centroid=np.array([1.0, 0.0, 0.0, 0.0]),
        **_meta(),
    )
    assert build.decision.status == "ok"
    assert build.n_windows == 1
    row = build.rows[0]
    assert row["window_id"] == "CLIP_p0002000"
    assert row["start_s"] == pytest.approx(2.0)
    assert row["end_s"] == pytest.approx(10.0)
    assert row["patient_speech_s"] == pytest.approx(8.0)
    assert list(WINDOWS_COLUMNS)[:8] == [
        "window_id",
        "room",
        "date",
        "lang",
        "phase",
        "start_s",
        "end_s",
        "patient_speech_s",
    ]
    a = int(round(row["start_s"] * 100))  # 10 ms frames
    b = int(round(row["end_s"] * 100))
    score = probs_purity(probs[a:b], build.decision.patient_slot, doctor_slot=build.decision.doctor_slot, frame_s=0.01)
    assert score["purity"] == pytest.approx(1.0)
    assert score["pure_patient_s"] == pytest.approx(8.0)
    assert PurityRule().passes(score)


def test_header_80ms_is_corrected_before_the_window_clock(monkeypatch):
    """Frame 200 is 2.0 s at 10 ms and 16 s at the header's 80 ms. The cut uses 2.0 s."""
    probs = np.zeros((1000, 2), dtype=np.float64)
    probs[:200, 0] = 0.95
    probs[200:, 1] = 0.95
    blob = pack_nlp(probs, frame_ms=80)
    for key in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(key, raising=False)

    class _Body:
        def read(self):
            return blob

    class _Client:
        def get_object(self, **kwargs):
            assert kwargs["Key"].startswith("lab/nemotron-probs/")
            assert kwargs["Key"].endswith(".nlp")
            return {"Body": _Body()}

    from tools.timbre.nemotron_probs import load_probs_source

    with pytest.warns(FrameStepWarning, match="using 10"):
        loaded = load_probs_source(
            "lab/nemotron-probs/bw_x_1_primary.nlp",
            client=_Client(),
            expected_duration_s=10.0,
        )
    assert loaded.frame_ms == pytest.approx(10)
    assert loaded.duration_s == pytest.approx(10.0)
    emb = np.stack([_at(0.9), _at(0.0)])
    build = build_from_nlp(
        loaded,
        slot_embeddings=emb,
        doctor_centroid=np.array([1.0, 0.0, 0.0, 0.0]),
        **_meta(),
    )
    assert build.rows[0]["start_s"] == pytest.approx(2.0)
    assert build.rows[0]["end_s"] == pytest.approx(10.0)


def test_cli_round_trip_and_ambiguous_exit(tmp_path):
    probs = np.zeros((1000, 2), dtype=np.float64)
    probs[:200, 0] = 0.95
    probs[200:, 1] = 0.95
    nlp = tmp_path / "timeline.nlp"
    nlp.write_bytes(pack_nlp(probs, frame_ms=10))
    emb = tmp_path / "slots.npy"
    cen = tmp_path / "doctor.npy"
    np.save(emb, np.stack([_at(0.9), _at(0.0)]))
    np.save(cen, np.array([1.0, 0.0, 0.0, 0.0]))
    out = tmp_path / "windows.csv"
    code = main(
        [
            "--nlp",
            str(nlp),
            "--duration-s",
            "10",
            "--clip-id",
            "CLIP",
            "--room",
            "ROOM-A",
            "--date",
            "2026-01-01",
            "--lang",
            "en",
            "--phase",
            "open",
            "--embeddings",
            str(emb),
            "--centroid",
            str(cen),
            "--out",
            str(out),
        ]
    )
    assert code == 0
    loaded = load_windows(out)
    assert len(loaded) == 1
    assert loaded[0].window_id == "CLIP_p0002000"
    assert loaded[0].role == "patient"
    assert loaded[0].meta["diar_src"] == "nemotron"
    assert loaded[0].start_s == pytest.approx(2.0)
    assert loaded[0].patient_speech_s == pytest.approx(8.0)
    assert loaded[0].clip_id == "CLIP"

    # Rebuild the same bytes through the writer the CLI used, then a rival map.
    rival = tmp_path / "empty.csv"
    close = tmp_path / "close.npy"
    np.save(close, np.stack([_at(0.80), _at(0.78)]))
    code_bad = main(
        [
            "--nlp",
            str(nlp),
            "--duration-s",
            "10",
            "--clip-id",
            "CLIP",
            "--room",
            "ROOM-A",
            "--date",
            "2026-01-01",
            "--phase",
            "open",
            "--embeddings",
            str(close),
            "--centroid",
            str(cen),
            "--out",
            str(rival),
        ]
    )
    assert code_bad == 3
    assert load_windows(rival) == []
    text = rival.read_text(encoding="utf-8").splitlines()
    assert text[0].split(",") == list(WINDOWS_COLUMNS)

    with pytest.raises(SystemExit):
        main(["--duration-s", "10"])
    # Explicit slots still cut, with no centroid file.
    given = tmp_path / "given.csv"
    assert (
        main(
            [
                "--nlp",
                str(nlp),
                "--duration-s",
                "10",
                "--clip-id",
                "CLIP",
                "--room",
                "ROOM-A",
                "--date",
                "2026-01-01",
                "--phase",
                "open",
                "--doctor-slot",
                "0",
                "--patient-slot",
                "1",
                "--out",
                str(given),
            ]
        )
        == 0
    )
    assert load_windows(given)[0].window_id == "CLIP_p0002000"
    decision = map_slots(probs, frame_ms=10, doctor_slot=0, patient_slot=1)
    assert decision.doctor_source == "given"
    write_windows_csv(tmp_path / "again.csv", build_patient_windows(probs, frame_ms=10, decision=decision, **_meta()).rows)
