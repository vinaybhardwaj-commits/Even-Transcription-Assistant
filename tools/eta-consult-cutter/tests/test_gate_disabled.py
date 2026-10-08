"""m3-09 (V decision, option C): config.GPU_WINDOW_ENABLED = False -> no night gate; the T4 is shared per job through gpu.lock (taken for ONE job, released straight after)."""
import datetime as dt, fcntl, os, subprocess, tempfile, unittest
from cutter import config as C, gpu as G, speak as SP
IST = G.IST
at = lambda h, m: dt.datetime(2026, 10, 8, h, m, tzinfo=IST).timestamp()

class Gate(unittest.TestCase):
    def test_default_in_production_is_off(self):
        import runpy; ns = runpy.run_path(C.__file__)                                                        # the file's own value (the conftest fixture turns it on for the other tests)
        self.assertIs(ns["GPU_WINDOW_ENABLED"], False); self.assertEqual((ns["GPU_STOP"], ns["GPU_START"], ns["GPU_HARD_STOP"]), ((22, 30), (6, 0), (22, 50)))          # constants kept so the gate can be turned back on
    def test_23_30_is_allowed_when_disabled_and_deferred_when_enabled(self):
        C.GPU_WINDOW_ENABLED = False
        for hm in ((23, 30), (3, 0), (22, 29), (5, 59), (12, 0)):
            g = G.gate(at(*hm), 30.0); self.assertTrue(g["ok"], hm); self.assertIsNone(g["not_after"]); self.assertIsNone(g["hard_stop"]); self.assertGreaterEqual(g["timeout_s"], 1800.0); self.assertGreater(g["wait_s"], 0)
        C.GPU_WINDOW_ENABLED = True
        for hm in ((23, 30), (3, 0)): self.assertEqual(G.gate(at(*hm), 30.0), dict(ok=False, why="gpu_window_closed"))
        self.assertTrue(G.gate(at(12, 0), 30.0)["ok"]); self.assertEqual(G.gate(at(22, 29), 30.0)["why"], "would_finish_after_22:30")
    def test_worker_gets_no_deadline_flags_when_the_gate_is_off(self):
        seen = []; C.GPU_WINDOW_ENABLED = False; SP.run_job(dict(id="x", audio="a", out="o"), G.gate(at(23, 30), 10.0), runner=lambda cmd, stdin: seen.append(cmd) or 0)
        self.assertEqual(seen[0][:2], ["flock", "-w"]); self.assertNotIn("--not-after", seen[0]); self.assertNotIn("--hard-stop", seen[0])
        C.GPU_WINDOW_ENABLED = True; SP.run_job(dict(id="x", audio="a", out="o"), G.gate(at(12, 0), 10.0), runner=lambda cmd, stdin: seen.append(cmd) or 0); self.assertIn("--not-after", seen[1]); self.assertIn("--hard-stop", seen[1])

class LockPerJob(unittest.TestCase):
    def test_lock_is_released_between_two_consecutive_jobs(self):
        C.GPU_WINDOW_ENABLED = False; d = tempfile.mkdtemp(); lock = f"{d}/gpu.lock"; g = G.gate(at(23, 30), 10.0)
        def free():                                                                                            # what CLARITY's runner does between our jobs: take the same flock without waiting
            f = open(lock, "a")
            try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); return True
            except OSError: return False
            finally: f.close()
        self.assertEqual(SP.run_job(dict(id="a", audio="a", out="o"), g, lock=lock, worker_cmd=["touch", f"{d}/m1"], wait_scale=0.002), 0); self.assertTrue(os.path.exists(f"{d}/m1")); self.assertTrue(free())
        self.assertEqual(SP.run_job(dict(id="b", audio="a", out="o"), g, lock=lock, worker_cmd=["touch", f"{d}/m2"], wait_scale=0.002), 0); self.assertTrue(os.path.exists(f"{d}/m2")); self.assertTrue(free())
    def test_a_holder_blocks_one_job_and_it_runs_after_release(self):
        C.GPU_WINDOW_ENABLED = False; d = tempfile.mkdtemp(); lock = f"{d}/gpu.lock"; g = dict(G.gate(at(23, 30), 10.0), wait_s=3000.0)
        h = subprocess.Popen(["flock", lock, "sleep", "2"]); import time; time.sleep(0.5)                       # CLARITY holds the T4 for 2 s
        t0 = time.time(); rc = SP.run_job(dict(id="a", audio="a", out="o"), g, lock=lock, worker_cmd=["touch", f"{d}/m1"], wait_scale=0.002)       # waits 6 s max
        self.assertEqual(rc, 0); self.assertGreater(time.time() - t0, 1.0); self.assertTrue(os.path.exists(f"{d}/m1")); h.wait()
        g2 = dict(g, wait_s=500.0); h = subprocess.Popen(["flock", lock, "sleep", "3"]); time.sleep(0.5)
        self.assertEqual(SP.run_job(dict(id="b", audio="a", out="o"), g2, lock=lock, worker_cmd=["touch", f"{d}/m2"], wait_scale=0.002), "deferred"); self.assertFalse(os.path.exists(f"{d}/m2")); h.wait()      # 1 s wait < 3 s hold: deferred, next hour
