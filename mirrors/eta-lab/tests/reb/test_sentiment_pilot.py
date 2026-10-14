import json
import os
import stat

from kit.reb import sentiment_pilot as sp

T0 = 1791000000000


def track(layer, engine, segs, status="ok", extras=None, finished="2026-10-09T08:00:00Z"):
    return {"layer": layer, "engine": engine, "status": status, "finished_at": finished, "window_id": "consult-x", "segments": segs, "extras": extras or {}}


def seg(a, b, spk="1", text="t", lang="hi-IN", role=None):
    s = {"t0_ms": T0 + a * 1000, "t1_ms": T0 + b * 1000, "speaker": spk, "text": text, "lang": lang, "extras": {"speaker_id": spk}}
    if role:
        s["role"] = role
    return s


def make(root, uid, tracks, doctor=True, date="2026-10-03", room="room_a"):
    d = os.path.join(root, date, room, "_consults", uid)
    os.makedirs(os.path.join(d, "tracks"))
    json.dump({"consult": {"attribution": {"doctor_identified": doctor, "doctor_uid": "SECRETDOC"}}}, open(os.path.join(d, "manifest.json"), "w"))
    for i, t in enumerate(tracks):
        json.dump(t, open(os.path.join(d, "tracks", f"{t['layer']}.{t['engine']}__v__{i}.json"), "w"))


def stt(segs, **kw):
    return track("stt", "sarvam-saaras-v3", segs, extras={"raw": {"big": "payload"}, "audio_s": 60.0, "job_id": "j1", "clip_signature": {"start": 1.0, "end": 2.0, "room": "opd"}}, **kw)


def test_done_translate_aligned_by_overlap_no_raw_no_doctor_id(tmp_path):
    root, out = str(tmp_path / "reb"), str(tmp_path / "out")
    segs = [seg(0, 10, "1", "नमस्ते"), seg(10, 20, "2", "दर्द है")]
    tr = [seg(0, 4, text="hello", lang="en-IN"), seg(4, 9, text="doctor", lang="en-IN"), seg(9, 18, text="pain", lang="en-IN"), seg(18, 20, text="here", lang="en-IN")]
    make(root, "u1", [stt(segs), track("translate", "sarvam-saaras-v3", tr, extras={"source_language_code": "hi-IN"}),
                      track("role", "text-judge", [seg(0, 10, "1", role="doctor"), seg(10, 20, "2", role="other")], extras={"map": {"1": "doctor"}}),
                      track("role", "sarvam-doctor-map", [seg(0, 20, "1", role="other")])])
    res = sp.run(root, ["u1"], out)
    assert res["status"] == {"done": 1} and res["non_english_without_translate"] == []
    doc = json.load(open(os.path.join(out, "u1.json")))
    s = doc["stt"]["segments"]
    assert [x["en"] for x in s] == ["hello doctor", "pain here"]                        # each translate segment lands on one stt segment, none repeated
    assert [x["role"] for x in s] == ["doctor", "other"]                                # text-judge wins over the doctor-map
    assert [x["en_idx"] for x in s] == [[0, 1, 2], [2, 3]]
    assert [x["text"] for x in doc["translate"]["segments"]] == ["hello", "doctor", "pain", "here"] and doc["translate"]["segments"][2]["i"] == 2
    assert s[0]["t0_ist"].endswith("+05:30") and "extras" not in s[0]
    blob = open(os.path.join(out, "u1.json")).read()
    assert "payload" not in blob and "SECRETDOC" not in blob and doc["doctor_assigned"] is True
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o700 and stat.S_IMODE(os.stat(os.path.join(out, "u1.json")).st_mode) == 0o600
    assert open(os.path.join(out, "index.csv")).read().splitlines()[1].startswith("u1,2026-10-03,room_a,True,True,hi-IN,True,True,done,")


def test_pending_reasons_and_english_needs_no_translate(tmp_path):
    root, out = str(tmp_path / "reb"), str(tmp_path / "out")
    role = track("role", "text-judge", [seg(0, 10, "1", role="doctor", lang="en-IN")])
    make(root, "hi_no_tr", [stt([seg(0, 10)]), role])
    make(root, "en_ok", [stt([seg(0, 10, lang="en-IN")]), role])
    make(root, "no_role", [stt([seg(0, 10, lang="en-IN")])])
    make(root, "empty", [track("stt", "sarvam-saaras-v3", [], status="empty")])
    make(root, "bad", [track("stt", "sarvam-saaras-v3", [], status="failed")])
    res = sp.run(root, ["hi_no_tr", "en_ok", "no_role", "empty", "bad", "ghost", "en_ok"], out)       # a duplicate uid counts once
    assert res["consults"] == 6
    assert res["status"] == {"pending": 4, "done": 1, "failed": 1}
    assert res["reasons"] == {"no_translate": 1, "no_role": 1, "stt_empty": 1, "stt_failed": 1, "no_consult": 1}
    assert res["non_english_without_translate"] == ["hi_no_tr"]
    assert os.path.exists(os.path.join(out, "hi_no_tr.json")) and not os.path.exists(os.path.join(out, "ghost.json"))


def test_nothing_is_written_to_the_store(tmp_path):
    root, out = str(tmp_path / "reb"), str(tmp_path / "out")
    make(root, "u1", [stt([seg(0, 10)]), track("role", "text-judge", [seg(0, 10, role="doctor")])])
    snap = lambda: sorted((dp, f, os.path.getsize(os.path.join(dp, f)), os.path.getmtime(os.path.join(dp, f))) for dp, _, fs in os.walk(root) for f in fs)
    before = snap()
    sp.run(root, ["u1"], out)
    assert snap() == before


def test_english_is_complete_when_the_translate_segmentation_is_coarser(tmp_path):
    root, out = str(tmp_path / "reb"), str(tmp_path / "out")
    segs = [seg(0, 4, "1", "a"), seg(4, 6, "2", "b"), seg(30, 34, "1", "c")]                  # the 2nd stt segment is swallowed by one longer translate segment
    tr = [seg(0, 8, text="one long translated turn", lang="en-IN")]
    make(root, "u1", [stt(segs), track("translate", "sarvam-saaras-v3", tr), track("role", "text-judge", [seg(0, 34, "1", role="doctor")])])
    sp.run(root, ["u1"], out)
    doc = json.load(open(os.path.join(out, "u1.json")))
    s = doc["stt"]["segments"]
    assert [x["en"] for x in s] == ["one long translated turn", "", ""]                      # the text sits once, on the best overlap
    assert [x["en_idx"] for x in s] == [[0], [0], []]                                         # the empty `en` of segment 2 is explained: translate segment 0 covers it
    assert [x["text"] for x in doc["translate"]["segments"]] == ["one long translated turn"]  # and segment 3 has no translate segment at all


def test_translate_segment_in_a_gap_is_kept_and_counted(tmp_path):
    root, out = str(tmp_path / "reb"), str(tmp_path / "out")
    segs = [seg(0, 5, "1", "a"), seg(25, 30, "1", "b")]
    tr = [seg(0, 5, text="first", lang="en-IN"), seg(10, 20, text="said in the gap", lang="en-IN"), seg(25, 30, text="last", lang="en-IN")]
    make(root, "u1", [stt(segs), track("translate", "sarvam-saaras-v3", tr), track("role", "text-judge", [seg(0, 30, "1", role="doctor")])])
    sp.run(root, ["u1"], out)
    doc = json.load(open(os.path.join(out, "u1.json")))
    assert [x["text"] for x in doc["translate"]["segments"]] == ["first", "said in the gap", "last"]        # nothing is dropped
    assert [x["en"] for x in doc["stt"]["segments"]] == ["first", "last"] and [x["en_idx"] for x in doc["stt"]["segments"]] == [[0], [2]]
    assert doc["en_stats"] == {"n_translate_segments": 3, "n_translate_unlinked": 1, "n_stt_segments": 2, "n_stt_en_empty": 0, "n_stt_en_empty_text_on_neighbour": 0}
    row = open(os.path.join(out, "index.csv")).read().splitlines()
    assert row[0].endswith("n_translate_unlinked,n_stt_en_empty") and row[1].endswith(",done,,1,0")


def test_en_stats_count_empty_en_with_text_on_a_neighbour(tmp_path):
    root, out = str(tmp_path / "reb"), str(tmp_path / "out")
    make(root, "u1", [stt([seg(0, 4, "1", "a"), seg(4, 6, "2", "b"), seg(30, 34, "1", "c")]),
                      track("translate", "sarvam-saaras-v3", [seg(0, 8, text="one long turn", lang="en-IN")]), track("role", "text-judge", [seg(0, 34, "1", role="doctor")])])
    sp.run(root, ["u1"], out)
    assert json.load(open(os.path.join(out, "u1.json")))["en_stats"] == {"n_translate_segments": 1, "n_translate_unlinked": 0, "n_stt_segments": 3, "n_stt_en_empty": 2,
                                                                            "n_stt_en_empty_text_on_neighbour": 1}
