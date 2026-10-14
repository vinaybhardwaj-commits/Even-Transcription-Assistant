import json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import relay

FAKE = os.path.join(os.path.dirname(__file__), "fake_mcp.py")


def ln(body):
    """the spool line inside a posted body (the relay appends '\\nrelay-key: <sha256>')."""
    return body.split("\nrelay-key: ")[0]


def key_of(body):
    return body.rsplit("\nrelay-key: ", 1)[1]


class Rec:
    """Sender that records posts; `fail` = number of leading calls that raise BusError. posts hold (subject, line); raw holds
    (subject, full body)."""
    def __init__(self, fail=0, refuse=()):
        self.posts, self.raw, self.fail, self.calls, self.refuse = [], [], fail, 0, set(refuse)

    def post(self, subject, body):
        self.calls += 1
        if self.calls <= self.fail:
            raise relay.BusError("down")
        if any(r in body for r in self.refuse):
            raise relay.PermanentBusError("subject too long")
        self.posts.append((subject, ln(body)))
        self.raw.append((subject, body))


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.spool = os.path.join(self.d, "ALERTS.jsonl")
        self.cfg = {**relay.DEFAULTS, "spool": self.spool, "state": os.path.join(self.d, "st", "state.json"),
                    "backoff_start_s": 1.0, "backoff_max_s": 8.0}
        self.sleeps = []

    def relay(self, sender, stop=lambda: False):
        return relay.Relay(self.cfg, sender, sleep=self.sleeps.append, stop=stop)

    def add(self, *lines, raw=None):
        with open(self.spool, "a") as f:
            for l in lines:
                f.write((json.dumps(l) if isinstance(l, dict) else l) + "\n")
            if raw:
                f.write(raw)


def A(text, src="cutter.run"):
    return {"at": "2026-10-08T17:00:00+0530", "source": src, "alert": text}


class Core(Base):
    def test_posts_each_new_line_once_with_subject_and_body(self):
        self.add(A("ALERT cutter-hourly failed: boom"))
        s = Rec(); r = self.relay(s)
        self.assertEqual(r.poll_once(), 1)
        subj, body = s.posts[0]
        self.assertEqual(subj, "ALERT consult: ALERT cutter-hourly failed: boom")
        self.assertEqual(json.loads(body)["source"], "cutter.run")          # body = the line
        self.assertEqual(r.poll_once(), 0)                                  # nothing new
        self.assertEqual(len(s.posts), 1)

    def test_subject_is_first_60_chars_one_line_and_at_most_120(self):
        self.add(A("x" * 200 + "\nsecond"))
        s = Rec(); self.relay(s).poll_once()
        self.assertEqual(s.posts[0][0], "ALERT consult: " + "x" * 60)
        self.assertNotIn("\n", s.posts[0][0])
        self.add("tab\there\x07bell " + "y" * 200)
        self.relay(s).poll_once()
        self.assertTrue(all(c.isprintable() for c in s.posts[1][0]) and len(s.posts[1][0]) <= 120)

    def test_offset_persists_and_restart_sends_nothing_twice(self):
        self.add(A("one"), A("two"))
        s = Rec(); self.relay(s).poll_once()
        self.assertEqual(len(s.posts), 2)
        s2 = Rec(); r2 = self.relay(s2)                                     # a new process: state from disk
        self.assertEqual(r2.poll_once(), 0)
        self.add(A("three"))
        self.assertEqual(r2.poll_once(), 1)
        self.assertEqual([json.loads(ln(b))["alert"] for _, b in s2.posts], ["three"])

    def test_state_file_is_atomic_0600_and_has_no_tmp_left(self):
        self.add(A("one")); self.relay(Rec()).poll_once()
        p = self.cfg["state"]
        self.assertEqual(oct(os.stat(p).st_mode & 0o777), "0o600")
        self.assertFalse(os.path.exists(p + ".tmp"))
        self.assertEqual(json.load(open(p))["offset"], os.path.getsize(self.spool))

    def test_partial_last_line_waits_until_complete(self):
        self.add(A("one"), raw='{"at": "t", "source": "x", "ale')
        s = Rec(); r = self.relay(s)
        self.assertEqual(r.poll_once(), 1)
        with open(self.spool, "a") as f:
            f.write('rt": "two"}\n')
        self.assertEqual(r.poll_once(), 1)
        self.assertEqual(json.loads(s.posts[1][1])["alert"], "two")

    def test_malformed_and_blank_lines_never_stop_the_relay(self):
        self.add("this is not json", "", "{broken", A("good"))
        s = Rec(); self.relay(s).poll_once()
        bodies = [b for _, b in s.posts]
        self.assertEqual(bodies[0], "this is not json")
        self.assertEqual(s.posts[0][0], "ALERT consult: this is not json")
        self.assertEqual(bodies[1], "{broken")
        self.assertEqual(json.loads(bodies[2])["alert"], "good")
        self.assertEqual(len(bodies), 3)                                     # the blank line is skipped, not posted

    def test_no_spool_yet_is_fine_and_a_late_spool_is_read_from_the_start(self):
        s = Rec(); r = self.relay(s)
        self.assertEqual(r.poll_once(), 0)
        self.add(A("first"))
        self.assertEqual(r.poll_once(), 1)

    def test_start_end_skips_history(self):
        self.add(A("old"))
        self.cfg["start"] = "end"
        s = Rec(); r = self.relay(s)
        self.assertEqual(r.poll_once(), 0)
        self.add(A("new"))
        self.assertEqual(r.poll_once(), 1)
        self.assertEqual(json.loads(s.posts[0][1])["alert"], "new")

    def test_oversize_body_is_truncated_not_dropped(self):
        self.add(A("z" * 30000))
        s = Rec(); self.relay(s).poll_once()
        self.assertLessEqual(len(s.posts[0][1].encode()), 16000)
        self.assertIn("truncated by relay", s.posts[0][1])


class RotationAndTruncation(Base):
    def test_rotation_finishes_the_old_file_then_reads_the_new_one(self):
        self.add(A("a1"))
        s = Rec(); r = self.relay(s); r.poll_once()
        self.add(A("a2"))                                                   # unread when the rotation happens
        os.rename(self.spool, self.spool + ".1")
        self.add(A("b1"), A("b2"))                                          # new file
        self.assertEqual(r.poll_once(), 3)
        self.assertEqual([json.loads(ln(b))["alert"] for _, b in s.posts], ["a1", "a2", "b1", "b2"])
        self.assertEqual(r.poll_once(), 0)

    def test_rotation_across_a_restart(self):
        self.add(A("a1")); self.relay(Rec()).poll_once()
        self.add(A("a2"))
        os.rename(self.spool, self.spool + ".1"); self.add(A("b1"))
        s = Rec(); self.relay(s).poll_once()
        self.assertEqual([json.loads(ln(b))["alert"] for _, b in s.posts], ["a2", "b1"])

    def test_rotation_with_the_old_file_gone_starts_the_new_one(self):
        self.add(A("a1")); r = self.relay(Rec()); r.poll_once()
        os.remove(self.spool); self.add(A("b1"))
        s = Rec(); r.sender = s
        self.assertEqual(r.poll_once(), 1)

    def test_replaced_file_that_reuses_the_inode_and_size_is_still_detected(self):
        self.add(A("a1")); s = Rec(); r = self.relay(s); r.poll_once()
        size = os.path.getsize(self.spool)
        with open(self.spool, "r+") as f:                                    # same inode, same length, different content
            f.write(json.dumps(A("b1")) + "\n")
        self.assertEqual(os.path.getsize(self.spool), size)
        self.assertEqual(r.poll_once(), 1)
        self.assertEqual(json.loads(s.posts[-1][1])["alert"], "b1")

    def test_truncation_restarts_at_zero(self):
        self.add(A("a1"), A("a2"))
        s = Rec(); r = self.relay(s); r.poll_once()
        open(self.spool, "w").close()                                       # truncated in place (same inode)
        self.add(A("c1"))
        self.assertEqual(r.poll_once(), 1)
        self.assertEqual(json.loads(s.posts[-1][1])["alert"], "c1")


class BusDown(Base):
    def test_bus_down_retries_with_backoff_and_loses_nothing(self):
        self.add(A("one"), A("two"))
        s = Rec(fail=3); r = self.relay(s)
        self.assertEqual(r.poll_once(), 2)
        self.assertEqual(self.sleeps, [1.0, 2.0, 4.0])                      # exponential, then success
        self.assertEqual([json.loads(ln(b))["alert"] for _, b in s.posts], ["one", "two"])

    def test_backoff_is_capped(self):
        self.add(A("one"))
        s = Rec(fail=7); self.relay(s).poll_once()
        self.assertEqual(self.sleeps, [1.0, 2.0, 4.0, 8.0, 8.0, 8.0, 8.0])

    def test_stop_while_the_bus_is_down_keeps_the_line_for_the_next_run(self):
        self.add(A("one"))
        n = {"k": 0}
        def stop():
            n["k"] += 1
            return n["k"] > 2
        s = Rec(fail=99); r = self.relay(s, stop=stop); r.poll_once()
        st = json.load(open(self.cfg["state"]))
        self.assertEqual(st["offset"], 0)
        self.assertGreaterEqual(st["inflight"]["tries"], 1)                  # attempts so far are remembered
        s2 = Rec(); self.assertEqual(self.relay(s2).poll_once(), 1)         # delivered after the "restart", marked as a retry
        self.assertRegex(s2.posts[0][0], r"\[retry \d+\]$")

    def test_crash_between_post_and_save_resends_once_and_marks_the_retry(self):
        self.add(A("one"), A("two"))
        r = self.relay(Rec()); r._init_state()
        line = open(self.spool).readline().rstrip("\n")
        import hashlib
        r.st["inflight"] = {"end": len(line) + 1, "sha": hashlib.sha256(line.encode()).hexdigest()[:16], "tries": 1}   # 1 attempt was started
        relay.save_state(self.cfg["state"], r.st)
        s = Rec(); self.relay(s).poll_once()
        self.assertEqual(len(s.posts), 2)
        self.assertTrue(s.posts[0][0].endswith(" [retry 1]"))
        self.assertNotIn("[retry", s.posts[1][0])


class DryRunAndTransport(Base):
    def test_dry_run_never_runs_a_command_and_uses_its_own_state(self):
        self.add(A("one"))
        import io, contextlib
        cfgp = os.path.join(self.d, "cfg.json")
        json.dump({"spool": self.spool, "state": self.cfg["state"], "ssh_command": ["/nonexistent/should-not-run"]}, open(cfgp, "w"))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            relay.main(["--config", cfgp, "--once"])
        out = buf.getvalue()
        self.assertIn("DRY-RUN WOULD POST", out)
        self.assertIn("to=consult-lead,fable", out)
        self.assertIn("as=consult-alerts", out)
        self.assertFalse(os.path.exists(self.cfg["state"]))                 # live state untouched
        self.assertTrue(os.path.exists(self.cfg["state"].replace(".json", "") + ".dryrun.json"))

    def live_cfg(self, mode="ok"):
        log = os.path.join(self.d, "bus.log")
        os.environ["FAKE_LOG"], os.environ["FAKE_MODE"] = log, mode
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in ("FAKE_LOG", "FAKE_MODE")])
        return {**self.cfg, "ssh_command": [sys.executable, FAKE]}, log

    def test_mcp_sender_speaks_initialize_then_bus_post_to_both_recipients(self):
        cfg, log = self.live_cfg()
        relay.McpSshSender(cfg).post("ALERT consult: x", "the line")
        rec = [json.loads(l) for l in open(log)]
        self.assertEqual(rec[0]["name"], "bus_post")
        self.assertEqual(rec[0]["arguments"], {"to": ["consult-lead", "fable"], "subject": "ALERT consult: x", "body": "the line"})

    def test_mcp_sender_failures_raise_bus_error(self):
        for mode in ("iserror", "rpcerror", "silent", "die"):
            cfg, _ = self.live_cfg(mode)
            cfg["call_timeout_s"] = 3.0
            with self.assertRaises(relay.BusError, msg=mode):
                relay.McpSshSender(cfg).post("s", "b")
        cfg = {**self.cfg, "ssh_command": ["/nonexistent/cmd"]}
        with self.assertRaises(relay.BusError):
            relay.McpSshSender(cfg).post("s", "b")

    def test_end_to_end_with_the_fake_server_survives_a_failure_then_delivers(self):
        cfg, log = self.live_cfg("die")
        self.cfg = cfg
        self.add(A("one"))
        calls = {"n": 0}
        sender = relay.McpSshSender(cfg)
        def flaky_sleep(d):
            calls["n"] += 1
            os.environ["FAKE_MODE"] = "ok"                                  # the bus comes back during the backoff
        r = relay.Relay(cfg, sender, sleep=flaky_sleep)
        self.assertEqual(r.poll_once(), 1)
        self.assertEqual(calls["n"], 1)
        self.assertEqual(len(open(log).readlines()), 1)

    def test_systemd_unit_is_in_the_repo_restart_always_and_dry_by_default(self):
        u = open(os.path.join(os.path.dirname(__file__), "..", "systemd", "consult-alert-relay.service")).read()
        self.assertIn("Restart=always", u)
        exec_line = next(l for l in u.splitlines() if l.startswith("ExecStart="))
        self.assertNotIn("--live", exec_line)


if __name__ == "__main__":
    unittest.main()
