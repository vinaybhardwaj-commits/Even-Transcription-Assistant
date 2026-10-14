import json

from kit.reb import sarvam_stats as st


def test_dice_normalisation_and_edges():
    assert st.dice(st.norm("Hello, World!"), st.norm("hello world")) == 1.0
    assert st.dice("ab", "cd") == 0.0
    assert st.dice("a", "abc") is None                         # too short to have a bigram
    assert 0 < st.dice(st.norm("the quick brown fox"), st.norm("the quick brown dog")) < 1


def test_agreement_dominant_mapping():
    sar = [(0, 10, "A"), (10, 20, "B")]
    ref = [(0, 10, "x"), (10, 20, "y")]
    assert st.agreement(sar, ref) == (1.0, 20.0)
    # two Sarvam speakers over ONE reference speaker still agree (many-to-one mapping)
    assert st.agreement([(0, 5, "A"), (5, 10, "B")], [(0, 10, "x")])[0] == 1.0
    # the minority overlap is the disagreement: A overlaps x 8 s and y 2 s
    ag, tot = st.agreement([(0, 10, "A")], [(0, 8, "x"), (8, 10, "y")])
    assert tot == 10 and abs(ag - 0.8) < 1e-9
    assert st.agreement([(0, 5, "A")], [(6, 9, "x")]) == (None, 0.0)


def test_summaries_and_buckets():
    s = st.summ([1, 2, 3, 4, None])
    assert s["n"] == 4 and s["median"] == 2.5 and s["max"] == 4 and st.summ([])["n"] == 0
    assert st.bucket(None) == "no_letters" and st.bucket(0) == "0" and st.bucket(0.6) == "<=0.75" and st.bucket(1.0) == "<=1.0"
    assert st.indic_share("abc") == 0.0 and st.indic_share("अआx") == 2 / 3 and st.indic_share("123") is None


def test_jsonable_handles_none_keys():
    import json
    assert json.dumps(st.jsonable({None: 1, "a": {None: 2}}), sort_keys=True)


def test_script_checks_and_translate_summary():
    assert st.seg_script("hello there") == "latin" and st.seg_script("नमस्ते दुनिया") == "indic" and st.seg_script("ab") is None
    segs = [{"lang": "en-IN", "text": "नमस्ते दुनिया"}, {"lang": "en-IN", "text": "hello there"},
            {"lang": "hi-IN", "text": "hello there"}, {"lang": "hi-IN", "text": "नमस्ते"}, {"lang": "en-IN", "text": "x"}]
    assert st.script_mismatches(segs) == {"en_labelled_indic": 1, "non_en_labelled_latin": 1, "scored": 4}
    tr = {"status": "ok", "extras": {"translated_to": "en-IN"}, "segments": [
        {"lang": "en-IN", "text": "hello there", "extras": {"source_language_code": "hi-IN"}},
        {"lang": "en-IN", "text": "नमस्ते", "extras": {}}]}
    s = st.translate_summary(tr, [("t", 12.5, None)])
    assert s["n_segments"] == 2 and s["seg_en_in"] == 2 and s["seg_with_source_lang"] == 1 and s["indic_segments"] == 1
    assert s["job_wall_s"] == 12.5 and s["source_lang_mix"] == {"hi-IN": 1, None: 1} and st.translate_summary(None, []) is None


def test_koyal_overlap_counts_any_status(tmp_path):
    import json
    w = tmp_path / "2026-10-05" / "r1" / "w1"
    w.mkdir(parents=True)
    (w / "manifest.json").write_text(json.dumps({"window_id": "w1", "t0_ms": 1000, "t1_ms": 2000, "tracks": [
        {"engine": "koyal", "layer": "stt", "status": "failed", "path": "x"}, {"engine": "other", "layer": "stt", "status": "ok", "path": "y"}]}))
    cache = {}
    assert st.koyal_overlap(str(tmp_path), "2026-10-05", "r1", 1500, 3000, cache) == [("w1", "failed")]
    assert st.koyal_overlap(str(tmp_path), "2026-10-05", "r1", 2000, 3000, cache) == []


# ---------------------------------------------------------------- window mode (7B part 3)
def _window_store(tmp_path):
    from kit.reb import write_track
    from kit.reb.writer import config_hash
    root, room, date = str(tmp_path), "room_aaaa1111", "2026-09-26"
    wid, t0 = f"c-{date}_{room}_1100", 1790400600000
    stub = {"window_id": wid, "room_id": room, "room_slug": room, "ist_date": date, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": "room_tape",
            "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 900000}}

    def put(layer, engine, segs, cfg):
        t = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1", "config": cfg,
             "config_hash": config_hash(cfg), "machine": "t", "status": "ok", "reason": None, "segments": segs, "extras": {"n_speakers": 2} if engine == "sarvam-saaras-v3" else {}}
        write_track(root, date, room, wid, t, manifest_stub=stub)
    text = "the patient has fever and pain in the knee since two days and the blood pressure test report is fine " * 3
    put("stt", "sarvam-saaras-v3", [{"t0_ms": t0 + 1000, "t1_ms": t0 + 9000, "text": text, "lang": "en-IN", "speaker": "0"}], {"w": 1})
    put("diar", "sarvam-saaras-v3", [{"t0_ms": t0 + 0, "t1_ms": t0 + 10000, "speaker": "0"}, {"t0_ms": t0 + 10000, "t1_ms": t0 + 20000, "speaker": "1"}], {"w": 1})
    put("diar", "pyannote-local-twin", [{"t0_ms": 0, "t1_ms": 10000, "speaker": "A"}, {"t0_ms": 10000, "t1_ms": 20000, "speaker": "B"}], {"d": 1})
    put("stt", "whisper-auto", [{"t0_ms": 0, "t1_ms": 5000, "text": text}], {"language": "auto", "response_format": "verbose_json"})   # real shape: 'auto', no segment lang
    put("stt", "whisper-forced-en", [{"t0_ms": 0, "t1_ms": 5000, "text": text}], {"language": "en", "response_format": "verbose_json"})
    put("stt", "sravaani", [{"t0_ms": 0, "t1_ms": 5000, "text": text}], {"chunk_s": 30, "device": "cuda", "model": "SraVaani"})                # real shape: no language,
    put("stt", "sravaani", [{"t0_ms": 0, "t1_ms": 5000, "text": "unrelated words " * 20}], {"backend": "box-twin-cpu", "chunk_s": 30})        # two configs
    put("stt", "koyal", [{"t0_ms": 0, "t1_ms": 5000, "text": text, "lang": "ta-IN"}], {"lang": "ta-IN", "engine": "koyal"})                # no config in Sarvam's language
    put("stt", "koyal", [{"t0_ms": 0, "t1_ms": 5000, "text": text, "lang": "kn-IN"}], {"lang": "kn-IN", "engine": "koyal"})
    put("stt", "indic-conformer", [{"t0_ms": 60000, "t1_ms": 70000, "text": "completely different words about something else entirely here " * 4, "lang": "hi"}], {"language": "hi"})
    put("stt", "indic-conformer", [{"t0_ms": 60000, "t1_ms": 70000, "text": text, "lang": "en"}], {"language": "en"})
    put("stt", "router-twin-c3s0", [{"t0_ms": t0 - 50000, "t1_ms": t0 - 40000, "text": "x" * 200, "lang": "kn"}, {"t0_ms": t0 + 2000, "t1_ms": t0 + 4000, "text": text, "lang": "en"}], {"r": 1})
    return root, wid


def test_window_report_dice_languages_clinical_and_speakers(tmp_path):
    root, wid = _window_store(tmp_path)
    r = st.window_report([wid, "c-2026-09-26_room_nope_0900"][:1], root=root)[0]
    assert r["sarvam"]["language_code"] == "en-IN" and r["sarvam"]["clinical_hits"] == 3 * 9
    e = r["engines"]
    assert e["whisper-auto"]["dice_matched"] == 1.0 and e["whisper-auto"]["matched_language"] is None
    assert e["indic-conformer"]["variants"] == 2 and e["indic-conformer"]["matched_language"] is True and e["indic-conformer"]["dice_matched"] == 1.0
    assert e["indic-conformer"]["dice_best"] == 1.0 and e["indic-conformer"]["seg_langs"] == {"en": 1}
    assert e["router-twin"]["dice_matched"] == 1.0 and e["router-twin"]["n_segments"] == 1                                   # the segment before the window is dropped
    sp = r["speakers"]
    assert sp["n_sarvam"] == sp["n_pyannote"] == 2 and sp["agreement"] == 1.0                                                # absolute vs relative ms normalised
    assert "fever" not in json.dumps(r)                                                                                      # numbers only


def test_window_aggregates_and_missing_sarvam(tmp_path):
    root, wid = _window_store(tmp_path)
    rows = st.window_report([wid], root=root) + [{"window_id": "w2", "room_id": "r", "ist_date": "d", "audio_s": 900.0, "engines": {}, "sarvam": None}]
    A = st.window_aggregates(rows)
    assert A["windows_asked"] == 2 and A["windows_with_sarvam"] == 1 and A["audio_h_with_sarvam"] == 0.25
    ic = A["engines"]["indic-conformer"]
    assert ic["dice_matched"]["n"] == 1 and ic["dice_matched"]["median"] == 1.0 and ic["segment_language_mix"] == {"en": 1}
    assert A["engines"]["whisper-auto"]["share_windows_sarvam_hits_ge_engine"] == 1.0 and A["speakers"]["speaker_count_equal_share"] == 1.0
    assert A["engines"]["whisper-auto"]["dice_matched_en_in_windows"]["n"] == 1 and A["engines"]["whisper-auto"]["dice_best_on_matched_windows"]["n"] == 1
    assert A["engines"]["koyal"]["dice_best_on_matched_windows"]["n"] == 0
    assert A["en_in_windows"] == 1 and A["engines"]["whisper-auto"]["clinical_hits_en_in_windows"]["windows"] == 1
    assert A["engines"]["sravaani__cuda"]["windows_present"] == 1 and A["engines"]["koyal"]["dice_matched"]["n"] == 0
    tab = st.window_table(A)
    assert "Sarvam vs other engines" in tab and "fever" not in tab and tab.count("Latin-only") >= 3 and "en-IN windows only" in tab and "CAVEAT" in tab


def test_out_path_is_honoured_in_window_mode(tmp_path):
    import os
    root, wid = _window_store(tmp_path / "store")
    ids = tmp_path / "ids.json"
    ids.write_text(json.dumps({"sample_window_ids": [wid]}))
    out = tmp_path / "custom-name.json"
    assert st.main(["--windows-file", str(ids), "--root", root, "--out", str(out)]) == 0
    assert out.exists() and oct(os.stat(out).st_mode & 0o777) == "0o600" and out.with_suffix(".md").exists()
    assert json.load(open(out))["aggregates"]["windows_with_sarvam"] == 1


def test_rel_s_and_engine_groups():
    assert st.rel_s(1790400601800, 1790400600000) == 1.8 and st.rel_s(30000, 1790400600000) == 30.0
    assert st.engine_group("indic-ctc-hi") == "indic-ctc" and st.engine_group("router-twin-box") == "router-twin" and st.engine_group("medasr") is None
    assert st.lang_base("hi-IN") == "hi" and st.lang_base(None) is None and st.clinical_hits("Fever, fever and pain; xyz") == 3


def test_language_less_multi_config_engine_is_always_per_config_even_with_one_config_live(tmp_path):
    from kit.reb import write_track
    from kit.reb.writer import config_hash
    root, room, date = str(tmp_path), "room_aaaa1111", "2026-09-26"
    wid, t0 = f"c-{date}_{room}_1100", 1790400600000
    stub = {"window_id": wid, "room_id": room, "room_slug": room, "ist_date": date, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": "room_tape",
            "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 900000}}
    text = "the patient has fever and pain in the knee since two days and the blood pressure test report is fine " * 3

    def put(engine, cfg, text_, fin):
        t = {"schema": "reb.track.v1", "window_id": wid, "layer": "stt", "engine": engine, "model": "m", "version": "v1", "config": cfg,
             "config_hash": config_hash(cfg), "machine": "t", "status": "ok", "reason": None, "segments": [{"t0_ms": 0, "t1_ms": 5000, "text": text_}], "extras": {}}
        write_track(root, date, room, wid, t, manifest_stub=stub, finished_at=fin)
    put("sarvam-saaras-v3", {"w": 1}, text, None)
    put("sravaani", {"chunk_s": 30, "device": "cuda", "model": "M"}, text, "2026-09-30T10:00:00Z")
    put("sravaani", {"chunk_s": 30, "device": "cuda", "model": "M2"}, "other words entirely " * 30, "2026-09-30T11:00:00Z")     # a rerun: same label, later
    r = st.window_report([wid], root=root)[0]
    assert list(r["engines"]) == ["sravaani__cuda"] and "sravaani" not in r["engines"]                                      # one row per config label
    assert r["duplicate_labels"] == ["sravaani__cuda"] and r["engines"]["sravaani__cuda"]["dice_matched"] < 0.5          # the later run wins, and it is counted
