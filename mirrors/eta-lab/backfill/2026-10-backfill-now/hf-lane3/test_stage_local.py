"""HF-3c tests: stage_local.py helpers + run_lane3.sh marker refusal. No network, temp dirs only. Run: python3 -m unittest -v test_stage_local"""
import hashlib, json, os, shutil, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import stage_local as S
JOB = f"{HERE}/lane3_cpu_job.py"; WANT = S.sha256_file(JOB)[:16]
def tree(L):
    """a minimal staged local root"""
    for d in ("bin", "hf_home/lane3-pins", "hf_home/hub/models--a--b/snapshots/rev1", "audio", "work", "out", "venv-indic/bin", "venv-sra/bin"): os.makedirs(f"{L}/{d}", exist_ok=True)
    shutil.copy(JOB, f"{L}/bin/lane3_cpu_job.py"); shutil.copy(f"{HERE}/stage_local.py", f"{L}/bin/stage_local.py")
    open(f"{L}/hf_home/lane3-pins/pinned_snapshots.json", "w").write("{}")
    for v in ("venv-indic", "venv-sra"): open(f"{L}/{v}/bin/python", "w").write("")
class TestMarker(unittest.TestCase):
    def test_write_check_and_refusals(self):
        with tempfile.TemporaryDirectory() as t:
            L = f"{t}/l"; tree(L); self.assertIn("no/unreadable", S.marker_check(L, WANT))
            S.marker_write(L, f"{L}/bin/lane3_cpu_job.py"); self.assertIsNone(S.marker_check(L, WANT))
            self.assertIn("job sha16", S.marker_check(L, "0" * 16))                                              # wrong pinned job
            m = json.load(open(f"{L}/READY")); m["job_sha16"] = "0" * 16; json.dump(m, open(f"{L}/READY", "w")); self.assertIn("not self-consistent", S.marker_check(L, WANT))   # tampered marker
            S.marker_write(L, f"{L}/bin/lane3_cpu_job.py"); open(f"{L}/bin/lane3_cpu_job.py", "a").write("#x"); self.assertIn("differs", S.marker_check(L, WANT))   # local job changed
            shutil.copy(JOB, f"{L}/bin/lane3_cpu_job.py"); os.unlink(f"{L}/venv-sra/bin/python"); self.assertIn("missing", S.marker_check(L, WANT))             # venv gone (e.g. Space restart)
    def test_marker_for_another_root(self):
        with tempfile.TemporaryDirectory() as t:
            L = f"{t}/l"; tree(L); S.marker_write(L, f"{L}/bin/lane3_cpu_job.py"); shutil.copytree(L, f"{t}/l2", symlinks=True); self.assertIn("another root", S.marker_check(f"{t}/l2", WANT))
    def test_run_lane3_refuses_without_marker(self):
        with tempfile.TemporaryDirectory() as t:
            L = f"{t}/l"; tree(L); env = dict(os.environ, L3_LOCAL=L, L3_PERSIST=f"{t}/p")
            if S.sha256_file(JOB)[:16] != "ab5cef4fd47825e9": self.skipTest("job sha differs from the pin in run_lane3.sh")
            r = subprocess.run(["bash", f"{HERE}/run_lane3.sh", "indic", "w.json"], env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)
            self.assertEqual(r.returncode, 3); self.assertIn("no/unreadable READY marker", r.stdout); self.assertFalse(os.path.exists(f"{t}/p/work/run.pid"))
class TestCopyMirror(unittest.TestCase):
    def test_copy_atomic_never_overwrites(self):
        with tempfile.TemporaryDirectory() as t:
            open(f"{t}/a", "w").write("1"); open(f"{t}/b", "w").write("2"); self.assertEqual(S.copy_atomic(f"{t}/a", f"{t}/d/x"), "copied"); self.assertEqual(S.copy_atomic(f"{t}/b", f"{t}/d/x"), "exists")
            self.assertEqual(open(f"{t}/d/x").read(), "1"); self.assertEqual(os.listdir(f"{t}/d"), ["x"])                                 # no tmp left
    def test_mirror_resume_skips_done_keeps_differing_and_copies_logs(self):
        with tempfile.TemporaryDirectory() as t:
            for fam, w, c in (("indic", "w1", "A"), ("indic", "w2", "B"), ("sravaani", "w1", "C")): os.makedirs(f"{t}/o/{fam}", exist_ok=True); open(f"{t}/o/{fam}/{w}.json", "w").write(c)
            open(f"{t}/o/indic/.w3.json.tmp", "w").write("partial"); os.makedirs(f"{t}/lg"); open(f"{t}/lg/job.log", "w").write("Traceback...")
            c1 = S.mirror(f"{t}/o", f"{t}/d", f"{t}/lg", f"{t}/dl"); self.assertEqual((c1["copied"], c1["logs"]), (3, 1)); self.assertFalse(os.path.exists(f"{t}/d/indic/.w3.json.tmp"))
            c2 = S.mirror(f"{t}/o", f"{t}/d"); self.assertEqual((c2["copied"], c2["exists_skipped"]), (0, 3))                              # resume: nothing recopied
            open(f"{t}/d/indic/w1.json", "w").write("DIFF"); c3 = S.mirror(f"{t}/o", f"{t}/d"); self.assertEqual(c3["differs_kept"], 1); self.assertEqual(open(f"{t}/d/indic/w1.json").read(), "DIFF")
            self.assertEqual(open(f"{t}/dl/job.log").read(), "Traceback...")
class TestAudio(unittest.TestCase):
    def test_stage_audio_verify_resume_and_mismatch(self):
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(f"{t}/src"); good, bad = b"good", b"bad"; open(f"{t}/src/g.webm", "wb").write(good); open(f"{t}/src/b.webm", "wb").write(b"TAMPERED")
            wf = f"{t}/w.json"; json.dump([{"audio": "g.webm", "audio_sha256": hashlib.sha256(good).hexdigest()}, {"audio": "b.webm", "audio_sha256": hashlib.sha256(bad).hexdigest()}, {"audio": "m.webm", "audio_sha256": "0" * 64}], open(wf, "w"))
            c = S.stage_audio(f"{t}/src", f"{t}/dst", [wf]); self.assertEqual((c["copied"], c["sha_mismatch"], c["missing"]), (1, 1, 1)); self.assertFalse(os.path.exists(f"{t}/dst/b.webm")); self.assertTrue(any(".bad-" in f for f in os.listdir(f"{t}/dst")))
            c = S.stage_audio(f"{t}/src", f"{t}/dst", [wf]); self.assertEqual(c["present_ok"], 1)                                          # resume
            open(f"{t}/dst/g.webm", "wb").write(b"corrupt"); c = S.stage_audio(f"{t}/src", f"{t}/dst", [wf]); self.assertEqual(c["copied"], 1)  # corrupt local copy re-fetched (old one kept as .bad-)
            self.assertEqual(S.main(["audio", "--src", f"{t}/src", "--dst", f"{t}/dst", "--windows", wf]), 1)                              # non-zero on mismatch/missing
if __name__ == "__main__": unittest.main()
