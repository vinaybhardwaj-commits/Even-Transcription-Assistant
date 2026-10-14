import hashlib, json, os, tempfile, unittest, io as _io, contextlib
import parity389_compare as C

def seg(i, txt, lang="en", eng="whisper", ref=False):
    return {"start_s": i * 3.0, "end_s": i * 3.0 + 2.5, "lang": lang, "engine": eng, "text": txt, "refused": ref, "refused_reason": "x" if ref else None}

def build(root, wids, hf_mut=None):
    ship = {w: {"audio_sha256": "s" + w, "probe_audio_sha256": "p" + w} for w in wids}
    os.makedirs(f"{root}/.window-audio", exist_ok=True)
    json.dump(ship, open(f"{root}/.window-audio/manifest.json", "w"))
    names = ["ETA_A", "ETA_B"]
    for side in ("mini", "hf"):
        for d in ("router", "whisper"): os.makedirs(f"{root}/{side}/{d}", exist_ok=True)
        for w in wids:
            segs = [seg(0, "invented sentence one"), seg(1, "invented sentence two")]
            wsegs = [{"start": 0.0, "end": 2.5, "text": "aa", "no_speech_prob": 0.10}, {"start": 3.0, "end": 5.5, "text": "bb", "no_speech_prob": 0.20}]
            router = {"ok": True, "result": {"status": "ok", "segments": segs}}
            meta = {"audio_sha256": "s" + w, "probe_audio_sha256": "p" + w, "probe_language": "en", "eta_env_names": list(names)}
            wh = {"language": "en", "segments": wsegs}
            if side == "hf" and hf_mut and w == hf_mut[0]: router, meta, wh = hf_mut[1](router, meta, wh)
            json.dump(router, open(f"{root}/{side}/router/{w}.json", "w")); json.dump(meta, open(f"{root}/{side}/router/{w}.meta.json", "w"))
            for k in ("probe", "full"): json.dump(wh, open(f"{root}/{side}/whisper/{w}.{k}.json", "w"))
    g = {"windows": {"english": [{"window_id": w} for w in wids]}}
    json.dump(g, open(f"{root}/g.json", "w"))
    json.dump({"router": {"eta_env_names_exact": {"live_process_names": names}}}, open(f"{root}/m.json", "w"))
    sha = hashlib.sha256(open(f"{root}/.window-audio/manifest.json", "rb").read()).hexdigest()[:16]
    return sha

def run(root, sha):
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = C.main(["--io", root, "--golden", f"{root}/g.json", "--manifest", f"{root}/m.json", "--ship-manifest-sha16", sha, "--golden-sha", hashlib.sha256(open(f"{root}/g.json", "rb").read()).hexdigest(), "--manifest-sha", hashlib.sha256(open(f"{root}/m.json", "rb").read()).hexdigest(), "--out", f"{root}/out.json", "--nsp-threshold", "0.6"])
    return rc, buf.getvalue(), json.load(open(f"{root}/out.json")) if os.path.exists(f"{root}/out.json") else None

class T(unittest.TestCase):
    def go(self, mut):
        d = tempfile.mkdtemp(); sha = build(d, ["w1", "w2"], ("w1", mut) if mut else None); return run(d, sha)
    def test_identical_passes_but_verdict_needs_48(self):
        rc, out, j = self.go(None)
        self.assertTrue(all(r["pass"] for r in j["windows"].values())); self.assertEqual(j["verdict_router_and_whisper_only"], "NO MATCH")  # 2 windows != 48
    def test_text_change_is_edit_rate_only_and_listed(self):
        def m(r, me, w): r["result"]["segments"][0]["text"] = "invented sentence ZZZ"; return r, me, w
        rc, out, j = self.go(m); row = j["windows"]["w1"]
        self.assertGreater(row["router"]["edit_rate"], 0.0); self.assertEqual(j["per_stratum"]["english"]["edit_gt_5pct"], 1)
    def test_flag_lang_engine_count_boundary_probe_env_sha(self):
        cases = {
            "router:refused_flag": lambda r, me, w: (r["result"]["segments"][1].update(refused=True) or (r, me, w)),
            "router:lang": lambda r, me, w: (r["result"]["segments"][1].update(lang="hi") or (r, me, w)),
            "router:engine": lambda r, me, w: (r["result"]["segments"][1].update(engine="sravaani") or (r, me, w)),
            "router:segment_count": lambda r, me, w: (r["result"]["segments"].pop() and (r, me, w)),
            "router:boundary": lambda r, me, w: (r["result"]["segments"][0].update(end_s=9.0) or (r, me, w)),
            "probe_language": lambda r, me, w: (me.update(probe_language="hi") or (r, me, w)),
            "hf_env_names": lambda r, me, w: (me["eta_env_names"].append("ETA_EXTRA") or (r, me, w)),
            "audio_sha256_VOID": lambda r, me, w: (me.update(audio_sha256="other") or (r, me, w)),
            "whisper_full:language": lambda r, me, w: (w.update(language="hi") or (r, me, w)),
            "whisper_probe:boundary": lambda r, me, w: (w["segments"][0].update(end=4.0) or (r, me, w)),
        }
        for name, mut in cases.items():
            rc, out, j = self.go(mut); self.assertIn(name, j["windows"]["w1"]["diff"], name); self.assertTrue(j["windows"]["w2"]["pass"], name)
    def test_nsp_near_threshold_counted(self):
        def m(r, me, w): w["segments"][0]["no_speech_prob"] = 0.61; return r, me, w
        rc, out, j = self.go(m); self.assertEqual(j["windows"]["w1"]["whisper_full"]["near_threshold"], 1)
        self.assertAlmostEqual(j["windows"]["w1"]["whisper_full"]["nsp_diff_max"], 0.51, places=6)
    def test_missing_side_is_not_computable(self):
        d = tempfile.mkdtemp(); sha = build(d, ["w1"]); os.remove(f"{d}/hf/router/w1.meta.json"); rc, out, j = run(d, sha)
        self.assertTrue(j["verdict_router_and_whisper_only"].startswith("NOT COMPUTABLE"))
    def test_refuter_B1_absence_never_equal(self):
        cases = {
            "audio_sha256_VOID": lambda r, me, w: (me.pop("audio_sha256") and (r, me, w)),
            "probe_audio_sha256_VOID": lambda r, me, w: (me.pop("probe_audio_sha256") and (r, me, w)),
            "probe_language_missing": lambda r, me, w: (me.pop("probe_language", None), (r, me, w))[1],
            "router:missing_field": lambda r, me, w: (r["result"]["segments"][0].pop("start_s", None), (r, me, w))[1],
            "whisper_full:missing_field": lambda r, me, w: (w["segments"][0].pop("no_speech_prob", None), (r, me, w))[1],
        }
        for name, mut in cases.items():
            rc, out, j = self.go(mut); self.assertIn(name, j["windows"]["w1"]["diff"], name)
    def test_same_wrong_sha_on_both_sides_is_void_and_absent_on_both_too(self):
        d = tempfile.mkdtemp(); sha = build(d, ["w1"])
        for side in ("mini", "hf"):
            p = f"{d}/{side}/router/w1.meta.json"; m = json.load(open(p)); m["audio_sha256"] = "WRONG"; m.pop("probe_language"); json.dump(m, open(p, "w"))
        rc, out, j = run(d, sha); self.assertIn("audio_sha256_VOID", j["windows"]["w1"]["diff"]); self.assertIn("probe_language_missing", j["windows"]["w1"]["diff"])
        self.assertNotEqual(j["verdict_router_and_whisper_only"], "MATCH")
    def test_golden_and_manifest_pinned(self):
        d = tempfile.mkdtemp(); sha = build(d, ["w1"])
        for bad in ("--golden-sha", "--manifest-sha"):
            buf = _io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = C.main(["--io", d, "--golden", f"{d}/g.json", "--manifest", f"{d}/m.json", "--ship-manifest-sha16", sha, bad, "0" * 64])
            self.assertEqual(rc, 2)
    def test_ship_manifest_sha_mismatch_refuses(self):
        d = tempfile.mkdtemp(); build(d, ["w1"]); rc, out, j = run(d, "0000000000000000"); self.assertEqual(rc, 2)
    def test_herdrkit_4829a_concordant_absence_is_equal_not_a_diff(self):
        # 'refused'/'refused_reason' missing on BOTH sides (the real production shape) must not diff.
        def m(r, me, w):
            for s in r["result"]["segments"]: s.pop("refused", None); s.pop("refused_reason", None)
            return r, me, w
        d = tempfile.mkdtemp(); sha = build(d, ["w1", "w2"])
        for side in ("mini", "hf"):
            p = f"{d}/{side}/router/w1.json"; rr = json.load(open(p))
            for s in rr["result"]["segments"]: s.pop("refused", None); s.pop("refused_reason", None)
            json.dump(rr, open(p, "w"))
        rc, out, j = run(d, sha)
        self.assertEqual(j["windows"]["w1"]["diff"], [])
        self.assertTrue(j["windows"]["w1"]["pass"])
    def test_herdrkit_4829a_presence_mismatch_still_a_diff(self):
        def m(r, me, w): r["result"]["segments"][0].pop("refused", None); r["result"]["segments"][0].pop("refused_reason", None); return r, me, w
        rc, out, j = self.go(m)
        self.assertIn("router:refused_flag_presence", j["windows"]["w1"]["diff"])
        self.assertTrue(j["windows"]["w2"]["pass"])
    def test_herdrkit_4829b_one_extra_segment_does_not_cascade(self):
        # hf has one extra segment inserted mid-stream; alignment must not misread every later pair as a
        # boundary miss (the bug: raw index-zip on a 343-vs-342 real window reported 342/342 'miss').
        def m(r, me, w):
            extra = {"start": 1.5, "end": 2.0, "text": "x", "no_speech_prob": 0.1}
            w["segments"] = [w["segments"][0], extra, w["segments"][1]]
            return r, me, w
        rc, out, j = self.go(m)
        wf = j["windows"]["w1"]["whisper_full"]
        self.assertIn("whisper_full:unaligned_segments", j["windows"]["w1"]["diff"])
        self.assertNotIn("whisper_full:boundary", j["windows"]["w1"]["diff"])  # the 2 real pairs still align and match
        self.assertEqual(wf["boundary_misses"], 0); self.assertEqual(wf["aligned_pairs"], 2)
        self.assertEqual(wf["unmatched_mini"], 0); self.assertEqual(wf["unmatched_hf"], 1)
    def test_no_text_in_stdout_or_out(self):
        rc, out, j = self.go(None); self.assertNotIn("invented", out); self.assertNotIn("invented", json.dumps(j))
if __name__ == "__main__": unittest.main()
