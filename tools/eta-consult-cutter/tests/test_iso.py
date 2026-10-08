import datetime as dt, unittest
from cutter import run as R
class Iso(unittest.TestCase):
    def test_millisecond_rounding_carries_into_the_seconds(self):
        t = dt.datetime(2026, 10, 7, 10, 3, 36, tzinfo=R.IST).timestamp()
        self.assertEqual(R.iso(t + 0.9996), "2026-10-07 10:03:37.000"); self.assertEqual(R.iso(t + 0.726), "2026-10-07 10:03:36.726"); self.assertEqual(R.iso(t), "2026-10-07 10:03:36.000")
        self.assertEqual(R.iso(dt.datetime(2026, 10, 7, 23, 59, 59, tzinfo=R.IST).timestamp() + 0.9996), "2026-10-08 00:00:00.000")
if __name__ == "__main__": unittest.main()
