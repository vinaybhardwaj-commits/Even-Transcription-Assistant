"""Tests for HF-3 lane 3 (job identity/blind/pins/skip/write-once, plan, collector). Run: python3 -W ignore -m unittest test_lane3   (no network, no models, no real audio: engines are stubbed)."""
import hashlib, json, os, shutil, sys, tempfile, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import lane3_plan as P, collect_lane3 as C
JM = P.JM; heldout, union = P.load_guard()
EXISTING = {"indic-conformer-kn": "39ec4d29", "indic-conformer-hi": "ab4dc753", "indic-conformer-ta": "000515d7", "indic-conformer-te": "4a42ca36", "indic-conformer-ml": "088e3ac3", "sravaani": "1956ddf2"}
OK = {"win_id": "c-2026-09-29_room_87frpus9_1530", "room": "room_87frpus9", "ist_date": "2026-09-29", "start": "2026-09-29T10:00:00+00:00", "end": "2026-09-29T10:15:00+00:00", "audio": "/x/c-2026-09-29_room_87frpus9_1530.webm", "sha256": "0" * 64, "cut": {"duration_s": 900.0, "covered_fraction": 1.0}}
BLIND = {**OK, "win_id": "c-2026-09-28_room_qyzghzaf_2100", "room": "room_qyzghzaf", "ist_date": "2026-09-28", "start": "2026-09-28T15:30:00+00:00", "end": "2026-09-28T15:45:00+00:00", "audio": "/x/c-2026-09-28_room_qyzghzaf_2100.webm"}
BAD = {**OK, "win_id": "garbage", "start": "x", "end": "y", "audio": "/x/garbage.webm"}
def env_ok(**kw):
    e = {"EXPECT_SCRIPT_SHA16": JM.sha256_file(P.JOB)[:16], "HELDOUT_SHA16": JM.HELDOUT_SHA16, "EXPECT_BLIND_SHA16": JM.blind_list_sha16(JM.BLIND)}; e.update(kw); return e
def jw(w): return {"win_id": w["win_id"], "room": w["room"], "ist_date": w["ist_date"], "start": w["start"], "end": w["end"], "audio": os.path.basename(w["audio"])}

class TestIdentity(unittest.TestCase):
    def test_existing_configs_reproduce_the_six_existing_hashes(self):
        for k, c in JM.existing_configs().items(): self.assertEqual(JM.config_hash(c), EXISTING[k]); self.assertEqual(JM.EXISTING_HASHES[k], EXISTING[k])
    def test_lane_hashes_differ_and_strip_back(self):
        self.assertEqual(set(JM.LANE_HASHES), set(EXISTING)); self.assertEqual(len(set(JM.LANE_HASHES.values())), 6)
        for k, (cfg, h) in JM.CONFIGS.items():
            self.assertNotEqual(h, EXISTING[k]); self.assertEqual(JM.config_hash(cfg), h); self.assertEqual(cfg["device"], "cpu"); self.assertEqual(cfg["producer"], "hf1-cpu-torch-fp32")
            self.assertEqual(JM.config_hash(JM.to_existing(k, cfg)), EXISTING[k])           # strip producer fields (+ restore sravaani's old device=cuda) => the existing hash
    def test_identity_checks_pass_and_catch_tampering(self):
        JM.identity_checks()
        bad = dict(JM.CONFIGS); k = "sravaani"; bad[k] = ({**bad[k][0], "chunk_s": 31}, bad[k][1])
        with mock.patch.object(JM, "CONFIGS", bad):
            with self.assertRaises(SystemExit): JM.identity_checks()
        same = dict(JM.CONFIGS); same[k] = (same[k][0], EXISTING[k])
        with mock.patch.object(JM, "CONFIGS", same):
            with self.assertRaises(SystemExit): JM.identity_checks()
    def test_revision_is_part_of_identity(self):
        c = JM.lane_configs()
        with mock.patch.dict(JM.MODELS, {"sravaani": (JM.MODELS["sravaani"][0], "c" * 40)}): self.assertNotEqual(JM.config_hash(JM.lane_configs()["sravaani"]), JM.LANE_HASHES["sravaani"])
        self.assertEqual(JM.config_hash(c["sravaani"]), JM.LANE_HASHES["sravaani"])

class TestBlind(unittest.TestCase):
    def test_predicates_agree_on_blind_ok_unparseable(self):
        for w, want in ((BLIND, True), (OK, False), (BAD, True)):
            self.assertEqual(JM.is_blind(jw(w)), want); self.assertEqual(P.is_blind(w, heldout, union), want)
    def test_every_heldout_day_room_is_blind_in_the_job(self):
        rid = {"OPD4": "room_ux92qpws", "OPD5": "room_4ggnkg5x", "OPD7": "room_qyzghzaf"}
        for x in union:
            d, r = x.split(); w = {"win_id": f"c-{d}_{rid[r]}_1200", "room": rid[r], "ist_date": d, "start": f"{d}T06:30:00+00:00", "end": f"{d}T06:45:00+00:00"}
            self.assertTrue(JM.is_blind(w), x); self.assertTrue(P.is_blind({**w, "audio": "a"}, heldout, union), x)
    def test_plan_never_lists_blind(self):
        with tempfile.TemporaryDirectory() as t:
            m = f"{t}/m.jsonl"; open(m, "w").write("\n".join(json.dumps(w) for w in (OK, BLIND, BAD)) + "\n"); os.makedirs(f"{t}/aud")
            for w in (OK, BLIND, BAD): open(f"{t}/aud/{os.path.basename(w['audio'])}", "w").close()
            ws = [{**w, "audio": f"{t}/aud/{os.path.basename(w['audio'])}"} for w in (OK, BLIND, BAD)]; open(m, "w").write("\n".join(json.dumps(w) for w in ws) + "\n")
            wins, st = P.plan("2026-09-29", heldout, union, reb_root=f"{t}/reb", manifest_path=m, wreb=f"{t}/none")
            self.assertEqual([w["win_id"] for w in wins], [OK["win_id"]]); self.assertEqual(st["blind_excluded"] + st["ignore_list_excluded"], 2); self.assertEqual(wins[0]["audio_sha256"], "0" * 64)
    def test_plan_skips_tracks_already_in_reb(self):
        with tempfile.TemporaryDirectory() as t:
            m = f"{t}/m.jsonl"; open(f"{t}/a.webm", "w").close(); open(m, "w").write(json.dumps({**OK, "audio": f"{t}/a.webm"}) + "\n")
            for k in ("sravaani", "indic-conformer-kn"):
                p = f"{t}/reb/2026-09-29/room_87frpus9/{OK['win_id']}/tracks/stt.{JM.ENGINE_OF[k]}__{JM.VERSION}__{JM.LANE_HASHES[k]}.json"; os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").close()
            wins, _ = P.plan("2026-09-29", heldout, union, reb_root=f"{t}/reb", manifest_path=m, wreb=f"{t}/none"); self.assertNotIn("sravaani", wins[0]["need"]); self.assertEqual(len(wins[0]["need"]), 4)

class TestPins(unittest.TestCase):
    def test_ok(self): JM.startup_checks(env_ok())
    def test_wrong_script_heldout_blindlist(self):
        for kw in ({"EXPECT_SCRIPT_SHA16": "0" * 16}, {"HELDOUT_SHA16": "0" * 16}, {"EXPECT_BLIND_SHA16": "0" * 16}):
            with self.assertRaises(SystemExit): JM.startup_checks(env_ok(**kw))
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(), blind=set(list(JM.BLIND)[:-1]))
    def test_modified_script_refused(self):
        with tempfile.TemporaryDirectory() as t:
            p = f"{t}/j.py"; shutil.copy(P.JOB, p); open(p, "a").write("\n# edited\n")
            with self.assertRaises(SystemExit): JM.startup_checks(env_ok(), script_path=p)
    def test_bad_revision_refused(self):
        with mock.patch.dict(JM.MODELS, {"indic": (JM.MODELS["indic"][0], "main")}):
            with self.assertRaises(SystemExit): JM.startup_checks(env_ok())
    def _snap(self, t, family):
        rev = JM.MODELS[family][1]; d = f"{t}/{rev}"; os.makedirs(d)
        for rel in JM.CODE_PINS[family]: open(f"{d}/{rel}", "w").write("x")
        return d
    def test_snapshot_verification(self):
        with tempfile.TemporaryDirectory() as t:
            d = self._snap(t, "sravaani"); fake = {"sravaani": {rel: hashlib.sha256(b"x").hexdigest() for rel in JM.CODE_PINS["sravaani"]}, "indic": JM.CODE_PINS["indic"]}
            with mock.patch.object(JM, "CODE_PINS", fake): JM.verify_snapshot("sravaani", d)                                  # right revision dir + matching shas
            with mock.patch.object(JM, "CODE_PINS", {**fake, "sravaani": {**fake["sravaani"], "modeling_sravaani.py": "0" * 64}}):
                with self.assertRaises(SystemExit): JM.verify_snapshot("sravaani", d)                                         # tampered remote code
            with self.assertRaises(SystemExit): JM.verify_snapshot("sravaani", d)                                             # real pins vs these dummy files
            os.rename(d, f"{t}/other")
            with mock.patch.object(JM, "CODE_PINS", fake):
                with self.assertRaises(SystemExit): JM.verify_snapshot("sravaani", f"{t}/other")                                # not the pinned revision dir

class Stub:
    """Engines stand-in: counts calls, returns fixed text."""
    def __init__(self): self.n = 0
    def indic_chunk(self, chunk, lang): self.n += 1; return "t" * 7
    def sravaani_piece(self, p): self.n += 1; return "s" * 9

class TestJobRun(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(); self.aud = f"{self.t}/audio"; self.out = f"{self.t}/out"; os.makedirs(self.aud); os.makedirs(f"{self.t}/work")
        for w in (OK, BLIND): open(f"{self.aud}/{os.path.basename(w['audio'])}", "wb").write(b"a")
        self.sha = hashlib.sha256(b"a").hexdigest(); self.opened = []
        import numpy as np
        def dec(p): self.opened.append(os.path.basename(p)); return np.zeros(16000 * 30, dtype="float32")
        self.p = mock.patch.object(JM, "decode_to_16k_mono", dec); self.p.start()
        self.q = mock.patch.dict(sys.modules, {"soundfile": mock.MagicMock()}); self.q.start()
    def tearDown(self): self.p.stop(); self.q.stop(); shutil.rmtree(self.t)
    def run_(self, fam, wins, eng=None):
        eng = eng or Stub(); r = JM.process(wins, fam, self.aud, self.out, eng, "test", {}, lambda s: None); return r, eng
    def W(self, w, sha=None): return {**jw(w), "audio_sha256": sha or self.sha}
    def test_blind_refused_before_audio_open(self):
        (done, blind, skip, bad), eng = self.run_("indic", [self.W(BLIND), self.W(OK)])
        self.assertEqual((done, blind), (1, 1)); self.assertEqual(self.opened, [os.path.basename(OK["audio"])]); self.assertFalse(os.path.exists(f"{self.out}/indic/{BLIND['win_id']}.json"))
    def test_unparseable_is_blind(self):
        (done, blind, *_), _ = self.run_("indic", [{**jw(BAD), "audio_sha256": self.sha}]); self.assertEqual((done, blind, self.opened), (0, 1, []))
    def test_tracks_written_with_lane_hashes_and_timing(self):
        self.run_("indic", [self.W(OK)]); o = json.load(open(f"{self.out}/indic/{OK['win_id']}.json"))
        self.assertEqual(set(o["tracks"]), {k for k in JM.CONFIGS if JM.FAMILY_OF[k] == "indic"})
        for k, t in o["tracks"].items(): self.assertEqual(t["config_hash"], JM.LANE_HASHES[k]); self.assertEqual(t["version"], JM.VERSION); self.assertEqual(t["status"], "ok")
        self.assertIn("total", o["timing_s"]); self.run_("sravaani", [self.W(OK)]); self.assertEqual(json.load(open(f"{self.out}/sravaani/{OK['win_id']}.json"))["tracks"]["sravaani"]["config_hash"], JM.LANE_HASHES["sravaani"])
    def test_skip_if_exists_and_write_once(self):
        self.run_("indic", [self.W(OK)]); p = f"{self.out}/indic/{OK['win_id']}.json"; before = open(p).read(); self.opened.clear()
        (done, _, skip, _), eng = self.run_("indic", [self.W(OK)]); self.assertEqual((done, skip, self.opened, eng.n), (0, 1, [], 0)); self.assertEqual(open(p).read(), before)      # no decode, no engine call, file untouched
    def test_audio_sha_mismatch_refused(self):
        (done, _, _, bad), _ = self.run_("indic", [self.W(OK, sha="f" * 64)]); self.assertEqual((done, bad), (0, 1)); self.assertEqual(self.opened, [])
    def test_engine_failure_writes_nothing(self):
        class Boom(Stub):
            def indic_chunk(self, c, l): raise RuntimeError("x")
        (done, *_), _ = self.run_("sravaani", [self.W(OK)], Boom()); self.assertEqual(done, 1)          # sravaani path does not use indic_chunk
        class BoomS(Stub):
            def sravaani_piece(self, p): raise RuntimeError("x")
        self.run_("sravaani", [self.W({**OK, "win_id": "c-2026-09-29_room_87frpus9_1545", "audio": "/x/b.webm"}, )], BoomS())      # audio absent => skipped, nothing written
        self.assertFalse(os.path.exists(f"{self.out}/sravaani/c-2026-09-29_room_87frpus9_1545.json"))

class TestCollector(unittest.TestCase):
    def mk(self, t, fam="indic", win=OK, mutate=None):
        import datetime as D
        keys = [k for k in JM.CONFIGS if JM.FAMILY_OF[k] == fam]; tracks = {}
        for k in keys:
            cfg, h = JM.CONFIGS[k]; cfg = json.loads(json.dumps(cfg)); tracks[k] = {"schema": "reb.track.v1", "window_id": win["win_id"], "layer": "stt", "engine": JM.ENGINE_OF[k], "model": cfg["model"], "version": JM.VERSION, "config": cfg, "config_hash": h,
                                                  "machine": "hf-space:eta-hf-1", "status": "ok", "reason": None, "segments": [{"t0_ms": 0, "t1_ms": 1000, "text": "abc", "lang": "kn"}]}
        stub = {"window_id": win["win_id"], "room_id": win["room"], "room_slug": win["room"], "ist_date": win["ist_date"], "t0_ms": int(D.datetime.fromisoformat(win["start"]).timestamp() * 1000), "t1_ms": int(D.datetime.fromisoformat(win["end"]).timestamp() * 1000),
                "audio": {"r2_key": "a.webm", "sha256": "0" * 64, "sample_rate": 16000, "duration_ms": 900000}}
        o = {"manifest_stub": stub, "tracks": tracks, "timing_s": {}}
        if mutate: mutate(o)
        os.makedirs(f"{t}/src/{fam}", exist_ok=True); json.dump(o, open(f"{t}/src/{fam}/{win['win_id']}.json", "w"))
    def col(self, t, write=True, day="2026-09-29"): return C.collect(day, f"{t}/src", f"{t}/reb", write, heldout, union)
    def test_dry_run_then_write_then_write_once(self):
        with tempfile.TemporaryDirectory() as t:
            self.mk(t); self.mk(t, "sravaani"); d = self.col(t, False); self.assertEqual((d["tracks_ok"], d["written"]), (6, 0)); self.assertFalse(os.path.exists(f"{t}/reb"))
            c1 = self.col(t); self.assertEqual((c1["written"], c1["rejected"]), (6, 0)); c2 = self.col(t); self.assertEqual((c2["written"], c2["exists_skipped"]), (0, 6))
            names = os.listdir(f"{t}/reb/2026-09-29/room_87frpus9/{OK['win_id']}/tracks"); self.assertTrue(all("hf1-cpu-lane3-1" in n for n in names))
    def test_existing_product_hash_rejected(self):
        def mut(o):
            for k, t in o["tracks"].items(): t["config"] = JM.existing_configs()[k]; t["config_hash"] = JM.EXISTING_HASHES[k]
        with tempfile.TemporaryDirectory() as t: self.mk(t, mutate=mut); c = self.col(t); self.assertEqual((c["written"], c["rejected"]), (0, 5)); self.assertIn("existing_product_hash", c["rejected_reasons"])
    def test_tampered_tracks_rejected(self):
        for name, mut in (("hash", lambda o: o["tracks"]["indic-conformer-kn"].update(config_hash="deadbeef")), ("config", lambda o: o["tracks"]["indic-conformer-kn"]["config"].update(chunk_s=13.0)),
                          ("version", lambda o: o["tracks"]["indic-conformer-kn"].update(version="hf-l4-backfill-2")), ("status", lambda o: o["tracks"]["indic-conformer-kn"].update(status="failed", reason="x")),
                          ("schema", lambda o: o["tracks"]["indic-conformer-kn"].pop("segments")), ("family", lambda o: o["tracks"].update({"sravaani": o["tracks"]["indic-conformer-kn"]}))):
            with tempfile.TemporaryDirectory() as t:
                self.mk(t, mutate=mut); c = self.col(t); self.assertEqual(c["rejected"], 1, name); self.assertEqual(c["written"], 5 if name == "family" else 4, name)
    def test_blind_file_refused_and_day_mismatch(self):
        with tempfile.TemporaryDirectory() as t:
            self.mk(t, win=BLIND); c = C.collect("2026-09-28", f"{t}/src", f"{t}/reb", True, heldout, union); self.assertEqual((c["blind_refused"], c["written"]), (1, 0)); self.assertFalse(os.path.exists(f"{t}/reb"))
        with tempfile.TemporaryDirectory() as t:
            self.mk(t); c = self.col(t, day="2026-09-30"); self.assertEqual((c["written"], c["rejected"]), (0, 1))
    def test_renamed_file_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            self.mk(t); os.rename(f"{t}/src/indic/{OK['win_id']}.json", f"{t}/src/indic/c-2026-09-29_room_87frpus9_1545.json"); c = self.col(t); self.assertEqual((c["written"], c["rejected"]), (0, 1))

class TestHF3b(unittest.TestCase):
    """HF-3b: offline snapshots, full manifest verification, staging script."""
    def tree(self, t, files):
        os.makedirs(t, exist_ok=True)
        for rel, data in files.items():
            p = os.path.join(t, rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(data)
        return {rel: hashlib.sha256(d).hexdigest() for rel, d in files.items()}
    def test_offline_mode_and_snapshot_path(self):
        self.assertFalse(JM.offline_mode({})); self.assertTrue(JM.offline_mode({"L3_OFFLINE": "1"})); self.assertTrue(JM.offline_mode({"HF_HUB_OFFLINE": "1"})); self.assertFalse(JM.offline_mode({"HF_HUB_OFFLINE": "0"}))
        p = JM.snapshot_path("/data/lane3/hf_home", "sravaani"); self.assertEqual(p, f"/data/lane3/hf_home/hub/models--ARTPARK-IISc--SraVaani-1.0/snapshots/{JM.MODELS['sravaani'][1]}")
        self.assertEqual(os.path.basename(JM.snapshot_path("/h", "indic")), JM.MODELS["indic"][1])
    def test_verify_manifest(self):
        with tempfile.TemporaryDirectory() as t:
            m = self.tree(f"{t}/s", {"a.py": b"x", "assets/m.onnx": b"yy"}); JM.verify_manifest(f"{t}/s", m)                       # ok
            open(f"{t}/s/assets/m.onnx", "wb").write(b"yz")
            with self.assertRaises(SystemExit): JM.verify_manifest(f"{t}/s", m)                                                       # tampered weight file
            open(f"{t}/s/assets/m.onnx", "wb").write(b"yy"); open(f"{t}/s/extra.bin", "wb").write(b"1")
            with self.assertRaises(SystemExit): JM.verify_manifest(f"{t}/s", m)                                                       # extra file
            os.remove(f"{t}/s/extra.bin"); os.remove(f"{t}/s/a.py")
            with self.assertRaises(SystemExit): JM.verify_manifest(f"{t}/s", m)                                                       # missing file
    def test_stage_pins_accepts_exact_and_refuses_tampered(self):
        import stage_pins as SP
        with tempfile.TemporaryDirectory() as t:
            J = SP.job(); fam_files = {}
            for fam, key in (("indic", "indic_conformer"), ("sravaani", "sravaani")):
                repo, rev = J.MODELS[fam]; snap = f"{t}/{fam}hub/models--{repo.replace('/', '--')}/snapshots/{rev}"
                fam_files[fam] = (key, self.tree(snap, {"cfg.py": b"code-" + fam.encode(), "w/weights.bin": b"w" * 10}))
                J.CODE_PINS[fam] = {"cfg.py": fam_files[fam][1]["cfg.py"]}
            meas = {"hf_snapshots": {key: {"repo": J.MODELS[f][0], "revision": J.MODELS[f][1], "files_sha256": files} for f, (key, files) in fam_files.items()}}
            json.dump(meas, open(f"{t}/m.json", "w")); args = ["--indic-hub", f"{t}/indichub", "--sra-hub", f"{t}/sravaanihub", "--measured", f"{t}/m.json", "--stage-dir", f"{t}/stage"]
            with mock.patch.object(SP, "job", lambda: J): self.assertEqual(SP.main(args), 0)
            man = json.load(open(f"{t}/stage/lane3-pins/pinned_snapshots.json")); self.assertEqual(set(man["families"]), {"indic", "sravaani"}); self.assertEqual(man["families"]["indic"]["n_files"], 2)
            open(f"{t}/indichub/models--{J.MODELS['indic'][0].replace('/', '--')}/snapshots/{J.MODELS['indic'][1]}/w/weights.bin", "wb").write(b"EVIL")
            with mock.patch.object(SP, "job", lambda: J):
                with self.assertRaises(SystemExit): SP.main(args)                                                                      # tampered weight => refuse to stage
    def run_stage(self, **env):
        import subprocess
        e = {**os.environ, **env}; return subprocess.run(["bash", f"{HERE}/stage_snapshots.sh"], capture_output=True, env=e)
    def test_stage_script_refuses_missing_snapshot_and_streams_nothing(self):
        with tempfile.TemporaryDirectory() as t:
            r = self.run_stage(STAGE_INDIC_HUB=f"{t}/none", STAGE_DIR=f"{t}/stage"); self.assertNotEqual(r.returncode, 0); self.assertEqual(r.stdout, b"")
    def test_stage_script_refuses_when_measurement_disagrees(self):
        with tempfile.TemporaryDirectory() as t:
            meas = json.load(open(f"{HERE}/../c4_measured-20261008.json")); f = meas["hf_snapshots"]["sravaani"]["files_sha256"]; k = sorted(f)[0]; f[k] = "0" * 64
            json.dump(meas, open(f"{t}/m.json", "w")); r = self.run_stage(STAGE_MEASURED=f"{t}/m.json", STAGE_DIR=f"{t}/stage"); self.assertNotEqual(r.returncode, 0); self.assertEqual(r.stdout, b"")
    def test_stage_script_streams_only_the_two_pinned_snapshots(self):
        import subprocess
        if not os.path.isdir(os.path.expanduser("~/.cache/huggingface/hub/models--ai4bharat--indic-conformer-600m-multilingual")): self.skipTest("box snapshots not present")
        with tempfile.TemporaryDirectory() as t:
            p = subprocess.Popen(["bash", f"{HERE}/stage_snapshots.sh"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, "STAGE_DIR": f"{t}/stage"})
            lst = subprocess.run(["tar", "-tf", "-"], stdin=p.stdout, capture_output=True).stdout.decode().split("\n"); p.stdout.close(); p.wait(); self.assertEqual(p.returncode, 0)
            names = [n for n in lst if n]; ri, rs = JM.MODELS["indic"][1], JM.MODELS["sravaani"][1]
            ok = (f"hub/models--ai4bharat--indic-conformer-600m-multilingual/snapshots/{ri}", f"hub/models--ARTPARK-IISc--SraVaani-1.0/snapshots/{rs}", "lane3-pins")
            self.assertTrue(all(n.startswith(ok) for n in names), [n for n in names if not n.startswith(ok)][:3])
            comps = [c for n in names for c in n.split("/")]; self.assertFalse(any(c in ("token", ".hf_ro_token", "blobs", "refs", "secrets", "stored_tokens") or c.endswith((".webm", ".wav", ".m4a")) for c in comps))                       # no blobs/refs/other cache/audio/token
            self.assertIn("lane3-pins/pinned_snapshots.json", names); self.assertEqual(sum(n.startswith("hub/models--ai4bharat") for n in names) - 3 >= 400, True)
if __name__ == "__main__": unittest.main()
