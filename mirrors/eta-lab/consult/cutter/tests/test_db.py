"""R2: the read-only guard is enforced at connect time (live connection; skipped when the credential file is absent). Nothing is ever written: the INSERT selects zero rows."""
import os, unittest
from cutter import config as C

@unittest.skipUnless(os.path.exists(C.DB_URL_FILE), "no DB credential on this machine")
class ReadOnly(unittest.TestCase):
    def test_live_connection_is_read_only(self):
        import psycopg
        from cutter import db
        with db.connect() as c:
            self.assertEqual(c.execute("SHOW transaction_read_only").fetchone()[0], "on")             # the first transaction already, not a later one
            self.assertEqual(c.execute("SHOW default_transaction_read_only").fetchone()[0], "on")
            with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction):                           # SQLSTATE 25006
                c.execute("INSERT INTO room_audio_day SELECT * FROM room_audio_day WHERE false")
        with db.connect() as c2:
            with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction): c2.execute("DELETE FROM room_audio_state WHERE false")
    def test_windows_and_state_use_the_guarded_connection(self):
        import inspect
        from cutter import windows, state
        self.assertIn("db.connect", inspect.getsource(windows.fetch)); self.assertIn("db.connect", inspect.getsource(state.no_tape_reason))
        self.assertNotIn("psycopg.connect", inspect.getsource(windows) + inspect.getsource(state))
if __name__ == "__main__": unittest.main()
