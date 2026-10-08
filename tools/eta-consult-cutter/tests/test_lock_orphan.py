import fcntl, json, os, tempfile, unittest
from cutter import config as C, run as R

class RunLock(unittest.TestCase):
    def test_second_concurrent_run_exits_0_with_a_log_line_and_does_nothing(self):
        d = tempfile.mkdtemp(); C.RUN_LOCK = f"{d}/cutter.lock"
        first = R.acquire_run_lock(); self.assertIsNotNone(first)
        self.assertIsNone(R.acquire_run_lock())                                                       # a second run cannot get the lock
        from unittest import mock
        calls = []                                                                                    # must not even reach the database
        with mock.patch.object(R.Wn, "fetch", lambda since: calls.append(since) or []), self.assertLogs("cutter", level="INFO") as cm: rc = R.main(["--once"])
        self.assertEqual(rc, 0); self.assertEqual(calls, []); self.assertTrue(any("another cutter run holds" in m for m in cm.output))
        first.close(); again = R.acquire_run_lock(); self.assertIsNotNone(again); again.close()        # released when the first run ends
if __name__ == "__main__": unittest.main()
