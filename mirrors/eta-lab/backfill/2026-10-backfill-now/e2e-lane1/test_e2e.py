"""Tests for the HF-4 E2E lane (no GPU, no network, no HF, no real data written; everything in temp dirs). Run: ../hf-lane1/.venv/bin/python -m unittest -v test_e2e"""
import hashlib, json, multiprocessing as mp, os, sys, tempfile, threading, types, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(os.path.dirname(HERE), "hf-lane1")); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/kit"))
import e2e_worker as W, plan_e2e as P, collect_e2e as CE, claim_box as CB, launch_lane as L
JM = W.JM; heldout, union, _ = L.load_guard()
from reb.validate import validate_track
def win(wid, room, day, hh="1000", blind_end=None, audio=b"audio-bytes-1"):
    return {"win_id": wid, "room": room, "ist_date": day, "start": f"{day}T{hh[:2]}:{hh[2:]}:00+00:00", "end": f"{day}T{hh[:2]}:{int(hh[2:])+15:02d}:00+00:00"}
OK = win("c-2026-09-29_room_87frpus9_1530", "room_87frpus9", "2026-09-29"); OK2 = win("c-2026-09-29_room_87frpus9_1545", "room_87frpus9", "2026-09-29", "1015")
BLIND = win("c-2026-09-28_room_qyzghzaf_2100", "room_qyzghzaf", "2026-09-28", "1530")
class Stub:
    dtype = "stub"; dev = "cpu"
    def __init__(s, *a): pass
    def detect(s, x): return "en", 0.9, {"en": 0.9}
    def run(s, chunks, language, prompt): return [{"t0_ms": 0, "t1_ms": 1000, "text": "x" * 5, "extras": {}}]
def setup(t, wins, payloads=None):
    """node-like tree: audio/<rel>, worklist.jsonl; returns args namespace"""
    os.makedirs(f"{t}/audio", exist_ok=True); wl = []
    for w in wins:
        rel = f"{w['ist_date']}/{w['room']}/{w['win_id']}.webm"; os.makedirs(os.path.dirname(f"{t}/audio/{rel}"), exist_ok=True); b = (payloads or {}).get(w["win_id"], b"audio:" + w["win_id"].encode())
        open(f"{t}/audio/{rel}", "wb").write(b); wl.append({**w, "audio": rel, "audio_sha256": hashlib.sha256(b"audio:" + w["win_id"].encode()).hexdigest(), "need": list(JM.CONFIGS)})
    open(f"{t}/worklist.jsonl", "w").write("".join(json.dumps(x) + "\n" for x in wl))
    return types.SimpleNamespace(worklist=f"{t}/worklist.jsonl", audio=f"{t}/audio", out=f"{t}/out", claims=f"{t}/claims", run_dir=f"{t}/run", node="n1", gpu=0, gpu_index_offset=0)
def fake_decode(opened): 
    def d(p): opened.append(os.path.basename(p)); return __import__("numpy").zeros(16000 * 40, dtype="float32")
    return d
def run_w(a, opened=None):
    opened = [] if opened is None else opened
    with mock.patch.object(JM, "decode_to_16k_mono", fake_decode(opened)):
        return W.run(a, env={}, engine_cls=Stub)

class TestWorker(unittest.TestCase):
    def test_vendored_job_is_byte_identical_and_claim_layout_matches(self):
        self.assertEqual(W.sha16(f"{HERE}/vendor/whisper3_hf_job.py"), "3bec47c98551c29b"); self.assertEqual(W.sha16(f"{HERE}/vendor/whisper3_hf_job.py"), W.sha16(L.JOB))
        self.assertEqual(W.claim_path("/c", "whisper-auto", "w"), L.claim_path("/c", "whisper-auto", "w")); self.assertEqual(JM.LANE_HASHES, L.TRACKS)
    def test_blind_refused_before_claim_and_before_audio_open(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [BLIND, OK]); op = []; n = run_w(a, op)
            self.assertEqual(op, [OK["win_id"] + ".webm"]); self.assertEqual(n["blind"], 1); self.assertFalse(os.path.exists(f"{a.out}/{BLIND['win_id']}.json"))
            self.assertFalse(any(os.path.exists(W.claim_path(a.claims, e, BLIND["win_id"])) for e in JM.CONFIGS))
    def test_unparseable_window_is_blind(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [{**OK, "win_id": "garbage"}]); op = []; n = run_w(a, op); self.assertEqual((op, n["blind"], n["done"]), ([], 1, 0))
    def test_identity_same_tracks_as_the_hf_job_except_machine_and_provenance(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [OK]); run_w(a); mine = json.load(open(f"{a.out}/{OK['win_id']}.json"))
            e = {"EXPECT_SCRIPT_SHA16": L.sha256_file(L.JOB)[:16], "HELDOUT_SHA16": JM.HELDOUT_SHA16, "EXPECT_BLIND_SHA16": JM.blind_list_sha16(JM.BLIND), "MODEL_ID": "openai/whisper-large-v3-turbo", "MODEL_REVISION": JM.PINNED_REVISION,
                 "WINDOWS": json.dumps([{k: OK[k] for k in ("win_id", "room", "ist_date", "start", "end")} | {"audio": f"{OK['win_id']}.webm"}]), "AUDIO_ROOT": f"{t}/audio/2026-09-29/room_87frpus9", "OUT_ROOT": f"{t}/jobout", "HF_JOB_ID": "j1"}
            with mock.patch.dict(os.environ, e), mock.patch.object(JM, "Engine", Stub), mock.patch.object(JM, "decode_to_16k_mono", fake_decode([])): JM.main()
            ref = json.load(open(f"{t}/jobout/{OK['win_id']}.json")); self.assertEqual(mine["manifest_stub"], ref["manifest_stub"])
            strip = lambda tr: {k: v for k, v in tr.items() if k not in ("machine", "provenance")}
            self.assertEqual({k: strip(v) for k, v in mine["tracks"].items()}, {k: strip(v) for k, v in ref["tracks"].items()})
            self.assertEqual({v["config_hash"] for v in mine["tracks"].values()}, {"e0d31902", "5a550766", "2e3b6c81"})
            for v in mine["tracks"].values(): self.assertEqual(validate_track(v, raise_on_error=False), []); self.assertEqual(v["machine"], "e2e-node:n1:gpu0"); self.assertEqual(v["provenance"]["script_sha16"], "3bec47c98551c29b")
    def test_skip_if_out_exists_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [OK, OK2]); os.makedirs(a.out); open(f"{a.out}/{OK['win_id']}.json", "w").write('{"keep":1}'); op = []; n = run_w(a, op)
            self.assertEqual(op, [OK2["win_id"] + ".webm"]); self.assertEqual(n["skip_exists"], 1); self.assertEqual(open(f"{a.out}/{OK['win_id']}.json").read(), '{"keep":1}')
            self.assertFalse(os.path.exists(W.claim_path(a.claims, "whisper-auto", OK["win_id"])))     # skipped before claiming
    def test_write_once(self):
        with tempfile.TemporaryDirectory() as t:
            p = f"{t}/x.json"; self.assertTrue(W.write_once(p, {"a": 1})); self.assertFalse(W.write_once(p, {"a": 2})); self.assertEqual(json.load(open(p)), {"a": 1}); self.assertEqual(os.listdir(t), ["x.json"])
    def test_tampered_audio_refused(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [OK, OK2], payloads={OK["win_id"]: b"TAMPERED"}); op = []; n = run_w(a, op)
            self.assertEqual((n["tampered"], n["done"]), (1, 1)); self.assertEqual(op, [OK2["win_id"] + ".webm"]); self.assertFalse(os.path.exists(f"{a.out}/{OK['win_id']}.json"))
            self.assertIn("audio_sha256_mismatch", open(f"{a.run_dir}/failed.jsonl").read()); self.assertFalse(os.path.exists(W.claim_path(a.claims, "whisper-cap2", OK["win_id"])))   # claim MOVED to _released
            self.assertTrue(any(f == OK["win_id"] for _, _, fs in os.walk(f"{a.claims}/_released") for f in fs))
    def test_audio_missing_is_failed_not_crash(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [OK]); os.unlink(f"{a.audio}/2026-09-29/room_87frpus9/{OK['win_id']}.webm"); n = run_w(a); self.assertEqual((n["audio_missing"], n["done"]), (1, 0))
    def test_stop_file_and_pause(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [OK]); os.makedirs(a.run_dir); open(f"{a.run_dir}/STOP", "w").close(); op = []; n = run_w(a, op); self.assertEqual((op, n["done"]), ([], 0))
    def test_startup_refuses_wrong_vendored_sha_and_blind_list(self):
        with mock.patch.object(W, "JOB_SHA16", "0" * 16):
            with self.assertRaises(SystemExit): W.startup({})
        with self.assertRaises(SystemExit): W.startup({"EXPECT_BLIND_SHA16": "0" * 16})
        with self.assertRaises(SystemExit): W.startup({"MODEL_ID": "other/model"})
        with self.assertRaises(SystemExit): W.startup({"MODEL_REVISION": "0" * 40})
        with self.assertRaises(SystemExit): W.startup({"HELDOUT_SHA16": "0" * 16})
        self.assertIsNotNone(W.startup({}))

def _race(args):
    t, idx = args; a = types.SimpleNamespace(worklist=f"{t}/worklist.jsonl", audio=f"{t}/audio", out=f"{t}/out", claims=f"{t}/claims", run_dir=f"{t}/run", node="n1", gpu=idx, gpu_index_offset=0)
    def pw(eng, w, ap, machine, prov):
        os.write(os.open(f"{t}/calls.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND), (w["win_id"] + "\n").encode()); import time; time.sleep(0.01)
        return {"manifest_stub": {"window_id": w["win_id"]}, "tracks": {}}, 1.0
    with mock.patch.object(W, "process_window", pw): return W.run(a, env={}, engine_cls=Stub)["done"]
class TestRace(unittest.TestCase):
    def test_eight_workers_each_window_processed_exactly_once(self):
        with tempfile.TemporaryDirectory() as t:
            wins = [win(f"c-2026-09-29_room_87frpus9_{h:04d}", "room_87frpus9", "2026-09-29", f"{10 + h // 60:02d}{h % 60:02d}") for h in range(40)]
            a = setup(t, wins)
            with mp.get_context("fork").Pool(8) as pool: done = pool.map(_race, [(t, i) for i in range(8)])
            calls = open(f"{t}/calls.log").read().split(); self.assertEqual(sorted(calls), sorted(w["win_id"] for w in wins)); self.assertEqual(sum(done), 40)
            self.assertEqual(len([f for f in os.listdir(a.out) if f.endswith(".json")]), 40)
    def test_claim_o_excl_across_processes(self):
        with tempfile.TemporaryDirectory() as t:
            with mp.get_context("fork").Pool(8) as pool: r = pool.starmap(_claim_all, [(t, i) for i in range(8)])
            self.assertEqual(sorted(sum(r, [])), sorted(f"w{i}" for i in range(50)))
def _claim_all(t, i): return [f"w{k}" for k in range(50) if W.claim(f"{t}/c", "whisper-auto", f"w{k}", f"e2e-n1-{i}")]

class TestPlanCollectClaim(unittest.TestCase):
    def test_plan_check_rejects_blind_dup_and_escape(self):
        with tempfile.TemporaryDirectory() as t:
            f = f"{t}/a.webm"; open(f, "wb").write(b"x"); good = {**OK, "audio": "2026-09-29/r/a.webm", "audio_sha256": "0" * 64, "_abs": f, "need": ["whisper-auto"]}
            with self.assertRaises(SystemExit): P.check([{**good, **BLIND}], heldout, union, wreb=t)
            with self.assertRaises(SystemExit): P.check([good, good], heldout, union, wreb=t)
            with self.assertRaises(SystemExit): P.check([{**good, "audio": "../x"}], heldout, union, wreb=t)
            with self.assertRaises(SystemExit): P.check([{**good, "_abs": "/etc/hostname"}], heldout, union, wreb=t)
            P.check([good], heldout, union, wreb=t)
    def _pull(self, t):
        a = setup(t, [OK, OK2]); run_w(a); pull = f"{t}/pull"; os.makedirs(pull, mode=0o700); 
        for f in os.listdir(a.out): os.link(f"{a.out}/{f}", f"{pull}/{f}")
        return a, pull
    def test_collector_dry_run_write_once_and_rejections(self):
        with tempfile.TemporaryDirectory() as t:
            a, pull = self._pull(t); reb = f"{t}/reb"
            stage = f"{t}/st1"; scr, days = CE.screen(pull, a.worklist, stage); self.assertEqual((scr["accepted_for_collect"], days), (2, ["2026-09-29"]))
            c = CE.C.collect("2026-09-29", f"{stage}/2026-09-29", reb, False, heldout, union); self.assertEqual((c["tracks_ok"], c["written"], c["rejected"]), (6, 0, 0)); self.assertFalse(os.path.exists(reb))
            c = CE.C.collect("2026-09-29", f"{stage}/2026-09-29", reb, True, heldout, union); self.assertEqual((c["written"], c["exists_skipped"]), (6, 0))
            c = CE.C.collect("2026-09-29", f"{stage}/2026-09-29", reb, True, heldout, union); self.assertEqual((c["written"], c["exists_skipped"]), (0, 6))
    def test_collector_screens(self):
        with tempfile.TemporaryDirectory() as t:
            a, pull = self._pull(t)
            def mutate(fn, f):
                p = f"{pull}/{OK['win_id']}.json"; d = json.load(open(p)); f(d); os.unlink(p); json.dump(d, open(p, "w"))
            def count(): s = f"{t}/s{len(os.listdir(t))}"; return CE.screen(pull, a.worklist, s)[0]
            mutate(0, lambda d: [x.update(machine="hf-job:abc") for x in d["tracks"].values()]); self.assertEqual(count()["machine_not_e2e"], 1)
            mutate(0, lambda d: [x.update(machine="e2e-node:n1:gpu0") for x in d["tracks"].values()] and d["manifest_stub"]["audio"].update(sha256="f" * 64)); self.assertEqual(count()["audio_sha_mismatch"], 1)
            open(f"{pull}/not-in-list.json", "w").write("{}"); self.assertEqual(count()["not_in_worklist"], 1)
            mutate(0, lambda d: [x["provenance"].update(script_sha16="0" * 16) for x in d["tracks"].values()] and d["manifest_stub"]["audio"].update(sha256=hashlib.sha256(b"audio:" + OK["win_id"].encode()).hexdigest())); self.assertEqual(count()["script_sha_mismatch"], 1)
    def test_collector_rejects_wrong_hash_and_blind_via_collect_lane(self):
        with tempfile.TemporaryDirectory() as t:
            a, pull = self._pull(t); p = f"{pull}/{OK['win_id']}.json"; d = json.load(open(p)); d["tracks"]["whisper-auto"]["config_hash"] = "4b67551a"; os.unlink(p); json.dump(d, open(p, "w"))
            stage = f"{t}/st"; CE.screen(pull, a.worklist, stage); c = CE.C.collect("2026-09-29", f"{stage}/2026-09-29", f"{t}/reb", False, heldout, union); self.assertEqual(c["rejected_reasons"], {"engine_or_hash_not_lane1": 1})
    def test_claim_box_dry_run_apply_and_blind(self):
        with tempfile.TemporaryDirectory() as t:
            a = setup(t, [OK, OK2]); self.assertEqual(CB.run(a.worklist, "n1", f"{t}/cl", False)["would_claim"], 2); self.assertFalse(os.path.exists(f"{t}/cl"))
            self.assertEqual(CB.run(a.worklist, "n1", f"{t}/cl", True)["claimed"], 2); self.assertEqual(CB.run(a.worklist, "n1", f"{t}/cl", True)["already_claimed"], 2)
            self.assertEqual(json.load(open(L.claim_path(f"{t}/cl", "whisper-auto", OK["win_id"])))["job"], "e2e-n1")
            open(f"{t}/bl.jsonl", "w").write(json.dumps({**BLIND, "need": ["whisper-auto"]}) + "\n")
            with self.assertRaises(SystemExit): CB.run(f"{t}/bl.jsonl", "n1", f"{t}/cl2", True)

if __name__ == "__main__": unittest.main()
