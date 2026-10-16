import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import poll  # noqa: E402

NOW = 1_800_000_000
TARGET = "user@kiosk-secret-host.example"
AUTH_VALUE = "tok-SECRET-VALUE-123"
RAW = "2026-10-16 09:00:00 ok 2"


def remote(line=RAW, age=30, restored=(), nofile=False, now=NOW):
    if nofile:
        out = ["NOFILE"]
    else:
        out = ["LAST " + line, "MTIME %d" % (now - age)]
    out.append("NOW %d" % now)
    out += ["RESTORED " + s for s in restored]
    return "\n".join(out) + "\n"


def cls(text, now=NOW):
    return poll.classify(poll.parse_remote(text), now)


class Classify(unittest.TestCase):
    def test_ok(self):
        p = cls(remote())
        self.assertEqual((p["state"], p["reason"], p["age_s"], p["restored_today"]), ("ok", None, 30, 0))
        self.assertTrue(p["last_line_at"].endswith("Z"))

    def test_restored(self):
        p = cls(remote("2026-10-16 09:00:00 restored 0->2", restored=["2026-10-16 08:00:00", "2026-10-16 09:00:00"]))
        self.assertEqual(p["state"], "restored")
        self.assertEqual(p["restored_today"], 2)
        self.assertEqual(p["last_restored_at"], "2026-10-16T09:00:00+05:30")

    def test_each_guard_word(self):
        for w in ("read_error", "missing", "write_failed", "db_missing"):
            p = cls(remote("2026-10-16 09:00:00 " + w))
            self.assertEqual((p["state"], p["reason"]), (w, None))

    def test_line_old(self):
        p = cls(remote(age=301))
        self.assertEqual((p["state"], p["reason"]), ("stale", "line_old"))
        self.assertEqual(cls(remote(age=300))["state"], "ok")

    def test_unparsed(self):
        for bad in ("garbage text here", "2026-10-16 09:00:00 ok 3", "2026-10-16 09:00:00 restored x->2", ""):
            p = cls(remote(bad))
            self.assertEqual((p["state"], p["reason"]), ("read_error", "unparsed"), bad)

    def test_no_file(self):
        self.assertEqual(cls(remote(nofile=True))["state"], "not_installed")

    def test_unreachable_and_not_configured(self):
        self.assertEqual((poll.unreachable_payload()["state"], poll.unreachable_payload()["reason"]), ("stale", "ssh_unreachable"))
        self.assertEqual(poll.not_configured_payload()["state"], "not_installed")

    def test_bad_restored_stamps_dropped(self):
        p = cls(remote(restored=["not a stamp", "2026-10-16 08:00:00"]))
        self.assertEqual(p["restored_today"], 1)


class PollRoom(unittest.TestCase):
    def test_installed_false_never_calls_ssh(self):
        calls = []
        p = poll.poll_room({"room_id": "r", "machine": "m", "ssh": TARGET, "installed": False}, lambda *a: calls.append(a), NOW, 1e12)
        self.assertEqual(p["state"], "not_installed")
        self.assertEqual(calls, [])

    def test_runner_none_or_raises_is_unreachable(self):
        e = {"room_id": "r", "machine": "m", "ssh": TARGET, "installed": True}
        self.assertEqual(poll.poll_room(e, lambda *a: None, NOW, 1e12)["reason"], "ssh_unreachable")

        def boom(*a):
            raise RuntimeError(TARGET)
        self.assertEqual(poll.poll_room(e, boom, NOW, 1e12)["reason"], "ssh_unreachable")

    def test_command_is_the_fixed_read_only_one(self):
        seen = []
        e = {"room_id": "r", "machine": "m", "ssh": TARGET, "installed": True}
        poll.poll_room(e, lambda t, c, to: seen.append((t, c)) or remote(), NOW, 1e12)
        self.assertEqual(seen[0], (TARGET, poll.REMOTE_COMMAND))
        for bad in ("sudo", ">", "rm ", "tee", "install", "sqlite3"):
            self.assertNotIn(bad, poll.REMOTE_COMMAND.replace("2>/dev/null", ""))

    @unittest.skipUnless(sys.platform == "darwin", "REMOTE_COMMAND uses BSD stat; the kiosks are macOS")
    def test_remote_command_runs_locally_against_fake_home(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(home + "/Library/Logs")
            today = subprocess.run(["date", "+%F"], capture_output=True, text=True).stdout.strip()
            with open(home + "/Library/Logs/eta-tcc-guard.last", "w") as fh:
                fh.write(today + " 09:00:00 ok 2\n")
            with open(home + "/Library/Logs/eta-tcc-guard.log", "w") as fh:
                fh.write("2000-01-01 01:00:00 RESTORED com.x auth_value 0 -> 2\n%s 08:15:00 RESTORED com.x auth_value 0 -> 2\n" % today)
            r = subprocess.run(["sh", "-c", poll.REMOTE_COMMAND], capture_output=True, text=True, env={"HOME": home, "PATH": os.environ["PATH"]})
            parsed = poll.parse_remote(r.stdout)
            self.assertEqual(parsed["restored"], [today + " 08:15:00"])
            self.assertEqual(parsed["line"], today + " 09:00:00 ok 2")
            self.assertIsNotNone(parsed["mtime"])
            self.assertNotIn("com.x", r.stdout)


class PostRule(unittest.TestCase):
    P = {"state": "ok", "reason": None, "restored_today": 0}

    def test_first_post(self):
        self.assertTrue(poll.should_post(None, self.P, NOW))

    def test_unchanged_recent_not_posted(self):
        prev = dict(self.P, posted_at=NOW - 299)
        self.assertFalse(poll.should_post(prev, self.P, NOW))

    def test_refresh_at_300(self):
        prev = dict(self.P, posted_at=NOW - 300)
        self.assertTrue(poll.should_post(prev, self.P, NOW))

    def test_change_posts_immediately(self):
        prev = dict(self.P, posted_at=NOW - 5)
        self.assertTrue(poll.should_post(prev, dict(self.P, state="restored"), NOW))
        self.assertTrue(poll.should_post(prev, dict(self.P, reason="line_old"), NOW))
        self.assertTrue(poll.should_post(prev, dict(self.P, restored_today=1), NOW))

    def test_build_events_shape_and_seq(self):
        entries = [{"room_id": "r1", "machine": "m1", "ssh": TARGET, "installed": True}]
        st = {"boot_epoch": 1700000000, "seq": 7, "rooms": {}}
        ev, marks = poll.build_events(entries, {"r1": cls(remote())}, st, NOW)
        e = ev[0]
        self.assertEqual((e["kind"], e["source"], e["install_id"], e["boot_id"], e["seq"], e["machine"], e["room_id"]),
                         ("mic_guard", "mini_micguard_poller", "mini-micguard-poller", "1700000000", 8, "m1", "r1"))
        self.assertRegex(e["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(sorted(e["payload"]), ["age_s", "last_line_at", "last_restored_at", "reason", "restored_today", "state"])
        self.assertEqual(st["seq"], 8)
        self.assertIn("r1", marks)


class RunOnce(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.cfg = self.d + "/kiosks.json"
        with open(self.cfg, "w") as fh:
            json.dump([
                {"room_id": "r1", "machine": "m1", "ssh": TARGET, "installed": True},
                {"room_id": "r2", "machine": "m2", "ssh": TARGET + "2", "installed": False},
            ], fh)
        self.tokf = self.d + "/tok"
        with open(self.tokf, "w") as fh:
            fh.write(AUTH_VALUE + "\n")
        self.env = {"MICGUARD_KIOSKS": self.cfg, "MICGUARD_TOKEN_FILE": self.tokf, "MICGUARD_STATE": self.d + "/state.json", "MICGUARD_ROOMS": "r1,r2",
                    "MICGUARD_INGEST_URL": "https://ingest.example.test/api/kiosk-health"}
        self.posts = []
        self.timeouts = []

    def poster(self, status=200):
        def f(url, token, body, timeout=None):
            self.timeouts.append(timeout)
            self.posts.append((url, token, json.loads(body)))
            return status
        return f

    def run_it(self, runner, poster, now=NOW):
        buf = io.StringIO()
        with redirect_stdout(buf):
            poll.run_once(self.env, runner, poster, now)
        return buf.getvalue()

    def test_missing_token_file_never_posts(self):
        os.remove(self.tokf)
        out = self.run_it(lambda *a: remote(), self.poster())
        self.assertEqual(self.posts, [])
        self.assertIn("token", out)
        self.assertFalse(os.path.exists(self.env["MICGUARD_STATE"]))

    def test_posts_batch_then_quiet_then_refresh(self):
        out1 = self.run_it(lambda *a: remote(), self.poster())
        self.assertEqual(len(self.posts), 1)
        url, token, body = self.posts[0]
        self.assertEqual(token, AUTH_VALUE)
        self.assertEqual(sorted(e["room_id"] for e in body["events"]), ["r1", "r2"])
        self.run_it(lambda *a: remote(now=NOW + 60), self.poster(), NOW + 60)
        self.assertEqual(len(self.posts), 1)  # unchanged, under 300 s
        self.run_it(lambda *a: remote(now=NOW + 300), self.poster(), NOW + 300)
        self.assertEqual(len(self.posts), 2)  # refresh
        seqs = [e["seq"] for _, _, b in self.posts for e in b["events"]]
        self.assertEqual(seqs, sorted(set(seqs)))
        self.assertEqual(len({e["boot_id"] for _, _, b in self.posts for e in b["events"]}), 1)
        self.assertNotIn(AUTH_VALUE, out1)

    def test_failed_post_retries_next_poll(self):
        self.run_it(lambda *a: remote(), self.poster(503))
        self.run_it(lambda *a: remote(now=NOW + 60), self.poster(200), NOW + 60)
        self.assertEqual(len(self.posts), 2)

    def test_change_posts_only_that_room(self):
        self.run_it(lambda *a: remote(), self.poster())
        self.run_it(lambda *a: remote("2026-10-16 09:00:00 read_error", now=NOW + 60), self.poster(), NOW + 60)
        self.assertEqual([e["room_id"] for e in self.posts[1][2]["events"]], ["r1"])
        self.assertEqual(self.posts[1][2]["events"][0]["payload"]["state"], "read_error")

    def test_unreachable_posts_stale(self):
        self.run_it(lambda *a: None, self.poster())
        r1 = [e for e in self.posts[0][2]["events"] if e["room_id"] == "r1"][0]
        self.assertEqual((r1["payload"]["state"], r1["payload"]["reason"]), ("stale", "ssh_unreachable"))

    def test_no_raw_line_token_or_target_in_output_post_or_state(self):
        secret_line = "2026-10-16 09:00:00 SECRET-RAW-LINE zzz"
        out = self.run_it(lambda *a: remote(secret_line), self.poster())
        out += self.run_it(lambda *a: None, self.poster(), NOW + 400)
        with open(self.env["MICGUARD_STATE"]) as fh:
            blob = out + json.dumps([b for _, _, b in self.posts]) + fh.read()
        for needle in ("SECRET-RAW-LINE", TARGET, "kiosk-secret-host", AUTH_VALUE):
            self.assertNotIn(needle, blob)

    def test_runner_exception_text_not_logged(self):
        def boom(*a):
            raise RuntimeError("leak " + TARGET)
        out = self.run_it(boom, self.poster())
        self.assertNotIn("leak", out)
        self.assertNotIn(TARGET, out)

    def test_restored_survives_ssh_failure_carry_forward(self):
        base = 1_800_000_000 - (1_800_000_000 % 86400) + 4 * 3600  # 09:30 IST on some IST day
        ok_restored = lambda *a: remote("2026-10-16 10:00:00 restored 0->2", restored=["2026-10-16 10:00:00"], now=base)
        self.run_it(ok_restored, self.poster(), base)
        self.run_it(lambda *a: None, self.poster(), base + 600)   # unreachable: restored must not drop to 0
        self.run_it(lambda *a: None, self.poster(), base + 3600)
        evs = [e for _, _, b in self.posts for e in b["events"] if e["room_id"] == "r1"]
        last = evs[-1]["payload"]
        self.assertEqual((last["state"], last["reason"], last["restored_today"]), ("stale", "ssh_unreachable", 1))
        self.assertEqual(last["last_restored_at"], "2026-10-16T10:00:00+05:30")
        self.assertTrue(all(e["payload"]["restored_today"] >= 1 for e in evs))

    def test_carry_resets_on_next_ist_day(self):
        base = 1_800_000_000
        self.run_it(lambda *a: remote(restored=["2026-10-16 10:00:00"], now=base), self.poster(), base)
        nxt = base + 86400
        self.run_it(lambda *a: None, self.poster(), nxt)
        last = [e for _, _, b in self.posts for e in b["events"] if e["room_id"] == "r1"][-1]["payload"]
        self.assertEqual(last["restored_today"], 0)

    def test_never_posts_lower_same_day_count(self):
        base = 1_800_000_000
        self.run_it(lambda *a: remote(restored=["2026-10-16 10:00:00", "2026-10-16 10:05:00"], now=base), self.poster(), base)
        self.run_it(lambda *a: remote(restored=["2026-10-16 10:00:00"], now=base + 60), self.poster(), base + 60)
        counts = [e["payload"]["restored_today"] for _, _, b in self.posts for e in b["events"] if e["room_id"] == "r1"]
        self.assertEqual(counts, sorted(counts))

    def test_second_run_exits_without_posting_while_locked(self):
        import fcntl
        os.makedirs(self.d, exist_ok=True)
        fh = open(self.env["MICGUARD_STATE"] + ".lock", "w")
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            out = self.run_it(lambda *a: remote(), self.poster())
        finally:
            fh.close()
        self.assertEqual(self.posts, [])
        self.assertIn("lock", out)
        self.run_it(lambda *a: remote(), self.poster())  # lock released: runs
        self.assertEqual(len(self.posts), 1)

    def test_post_timeout_capped_by_budget(self):
        self.run_it(lambda *a: remote(), self.poster())
        self.assertTrue(0 < self.timeouts[0] <= poll.POST_TIMEOUT_S)
        self.assertLessEqual(poll.SSH_PHASE_S + poll.POST_TIMEOUT_S, poll.TOTAL_BUDGET_S + 0)  # 30 + 15 fits inside 50

    def test_bad_target_and_unknown_room_skipped_without_printing_values(self):
        with open(self.cfg, "w") as fh:
            json.dump([
                {"room_id": "r1", "machine": "m1", "ssh": "-oProxyCommand=EVILVALUE", "installed": True},
                {"room_id": "not-a-room-EVILROOM", "machine": "m2", "ssh": TARGET, "installed": True},
                {"room_id": "r2", "machine": "m3", "ssh": TARGET, "installed": True},
            ], fh)
        seen = []
        out = self.run_it(lambda t, c, to: seen.append(t) or remote(), self.poster())
        self.assertEqual(seen, [TARGET])
        self.assertIn("bad_target", out)
        self.assertIn("unknown_room", out)
        self.assertNotIn("EVILVALUE", out)
        self.assertNotIn("EVILROOM", out)

    def test_target_regex_rejects_leading_dash_and_metachars(self):
        for bad in ("-oProxyCommand=x@h", "u@-h", "u@h;rm", "u@h $(x)", "@h", "u@"):
            self.assertIsNone(poll._TARGET_RE.match(bad), bad)
        self.assertIsNotNone(poll._TARGET_RE.match("user_1.a@kiosk-a.example"))

    def test_default_url_is_www(self):
        self.assertTrue(poll.DEFAULT_URL.startswith("https://www."))

    def test_load_config_validation_rules(self):
        with open(self.cfg, "w") as fh:
            json.dump([{"room_id": "r1", "machine": "bad machine!", "ssh": TARGET}, {"room_id": "r1", "machine": "m", "ssh": "user@host;rm", "installed": True},
                       {"room_id": "r1", "machine": "m", "ssh": "anything", "installed": False}], fh)
        entries, skipped = poll.load_config(self.cfg, ("r1",))
        self.assertEqual(skipped, {"bad_machine": 1, "bad_target": 1})
        self.assertEqual([e["installed"] for e in entries], [False])
        self.assertEqual(entries[0]["ssh"], "")


if __name__ == "__main__":
    unittest.main()
