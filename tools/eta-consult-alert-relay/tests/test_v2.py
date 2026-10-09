"""alert-relay v2: M1 idempotency key + retry marks, M2 permanent vs transient + dead letter + UTF-16 subject, M3 identity by ssh alias,
L1 damaged state starts at the end, L3 unit condition."""
import hashlib, json, os, sys, unittest
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import relay
from test_relay import Base, Rec, A, ln, key_of, FAKE


class Slow:
    """Sender whose first `n` calls raise a transport error AFTER committing (the reply was lost), like a bus that is slow."""
    def __init__(self, n):
        self.n, self.committed, self.calls = n, [], 0

    def post(self, subject, body):
        self.calls += 1
        self.committed.append((subject, body))
        if self.calls <= self.n:
            raise relay.BusError("timeout waiting for the reply")


class M1Key(Base):
    def test_every_post_carries_the_sha256_of_path_offset_and_line(self):
        self.add(A("one"), A("two"))
        s = Rec(); self.relay(s).poll_once()
        lines = open(self.spool).read().splitlines()
        off1 = len(lines[0]) + 1
        want = [hashlib.sha256(f"{self.spool}\0{o}\0{l}".encode()).hexdigest() for o, l in ((0, lines[0]), (off1, lines[1]))]
        self.assertEqual([key_of(b) for _, b in s.raw], want)
        self.assertEqual(s.raw[0][1].splitlines()[-1], "relay-key: " + want[0])      # on the body's last line

    def test_retries_carry_the_same_key_and_a_retry_mark_that_counts(self):
        self.add(A("one"))
        s = Slow(3); self.relay(s).poll_once()
        subj = [x for x, _ in s.committed]
        self.assertEqual(len(subj), 4)
        self.assertNotIn("[retry", subj[0])
        self.assertEqual([x.rsplit(" ", 2)[-2:] for x in subj[1:]], [["[retry", "1]"], ["[retry", "2]"], ["[retry", "3]"]])
        self.assertEqual(len({key_of(b) for _, b in s.committed}), 1)               # a consumer can dedupe on it

    def test_the_key_is_the_same_after_a_restart(self):
        self.add(A("one"))
        s = Slow(1); self.relay(s, stop=lambda: s.calls >= 1).poll_once()          # stopped after the lost reply
        s2 = Rec(); self.relay(s2).poll_once()
        self.assertEqual(key_of(s.committed[0][1]), key_of(s2.raw[0][1]))
        self.assertTrue(s2.raw[0][0].endswith("[retry 1]"))

    def test_key_survives_body_truncation(self):
        self.add(A("z" * 30000))
        s = Rec(); self.relay(s).poll_once()
        self.assertEqual(len(key_of(s.raw[0][1])), 64)
        self.assertLessEqual(len(s.raw[0][1].encode()), 16000)

    def test_call_timeout_default_is_raised(self):
        self.assertGreaterEqual(relay.DEFAULTS["call_timeout_s"], 60)


class M2Permanent(Base):
    def test_a_refused_line_goes_to_the_dead_letter_and_the_queue_moves_on(self):
        self.cfg["dead_letter"] = os.path.join(self.d, "dl", "dead.jsonl")
        self.add(A("good one"), A("POISON"), A("good two"))
        s = Rec(refuse=["POISON"]); r = self.relay(s)
        self.assertEqual(r.poll_once(), 3)
        self.assertEqual([json.loads(b)["alert"] for _, b in s.posts], ["good one", "good two"])
        rec = [json.loads(l) for l in open(self.cfg["dead_letter"])]
        self.assertEqual(len(rec), 1)
        self.assertEqual(json.loads(rec[0]["line"])["alert"], "POISON")
        self.assertEqual(rec[0]["reason"], "subject too long")
        self.assertEqual(len(rec[0]["key"]), 64)
        self.assertEqual(oct(os.stat(self.cfg["dead_letter"]).st_mode & 0o777), "0o600")
        self.assertEqual(json.load(open(self.cfg["state"]))["offset"], os.path.getsize(self.spool))
        self.assertEqual(self.sleeps, [])                                         # no backoff for a permanent refusal
        self.assertEqual(r.poll_once(), 0)                                        # and it is not retried later

    def test_only_transport_errors_retry(self):
        self.cfg["dead_letter"] = os.path.join(self.d, "dead.jsonl")
        self.add(A("one"))
        s = Rec(fail=2); self.relay(s).poll_once()
        self.assertEqual(len(s.posts), 1)
        self.assertFalse(os.path.exists(self.cfg["dead_letter"]))

    def test_mcp_sender_classifies_only_the_bus_validation_texts_as_permanent(self):
        cases = [("iserror", "subject exceeds 120 UTF-16 code units", relay.PermanentBusError),
                 ("iserror", "subject contains control characters", relay.PermanentBusError),
                 ("iserror", "body exceeds 16384 bytes", relay.PermanentBusError),
                 ("iserror", "message looks like it contains a secret", relay.PermanentBusError),
                 ("rpcerror", '"to" must be a non-empty array', relay.PermanentBusError),
                 ("iserror", "no recipients resolved", relay.PermanentBusError),
                 ("iserror", "Command failed: herdr agent list\n", relay.BusError),            # herdr timeout -> transient
                 ("iserror", "database is locked", relay.BusError),
                 ("iserror", "identity unknown: cannot post", relay.BusError),                 # wrong forced command at go-live -> retry, not dead-letter
                 ("rpcerror", "something nobody has seen before", relay.BusError),
                 ("silent", "", relay.BusError), ("die", "", relay.BusError)]
        for mode, text, exc in cases:
            os.environ["FAKE_LOG"], os.environ["FAKE_MODE"], os.environ["FAKE_TEXT"] = os.path.join(self.d, "b.log"), mode, text
            cfg = {**self.cfg, "ssh_command": [sys.executable, FAKE], "call_timeout_s": 3.0}
            with self.assertRaises(relay.BusError) as cm:
                relay.McpSshSender(cfg).post("s", "b")
            self.assertEqual(type(cm.exception), exc, (mode, text))
        for k in ("FAKE_LOG", "FAKE_MODE", "FAKE_TEXT"):
            os.environ.pop(k, None)

    def test_a_transient_refusal_is_retried_with_a_marker_and_never_dead_lettered(self):
        self.cfg["dead_letter"] = os.path.join(self.d, "dead.jsonl")
        self.add(A("one"))
        class Locked:
            def __init__(self): self.n, self.subj = 0, []
            def post(self, subject, body):
                self.n += 1; self.subj.append(subject)
                if self.n < 3:
                    raise relay.McpSshSender._refuse("database is locked")
        s = Locked(); self.relay(s).poll_once()
        self.assertEqual(s.n, 3)
        self.assertTrue(s.subj[1].endswith("[retry 1]") and s.subj[2].endswith("[retry 2]"))
        self.assertFalse(os.path.exists(self.cfg["dead_letter"]))

    def test_subject_is_at_most_100_utf16_units_even_with_emoji_and_a_retry_mark(self):
        self.add(A("\U0001F525" * 80))
        s = Rec(); self.relay(s).poll_once()
        subj = s.posts[0][0]
        self.assertLessEqual(relay.utf16_len(subj), 100)
        self.assertTrue(subj.startswith("ALERT consult: \U0001F525"))
        subj2, _ = relay.make_message(json.dumps(A("\U0001F525" * 80)), self.cfg, "k", retry=12)
        self.assertLessEqual(relay.utf16_len(subj2), 100)
        self.assertTrue(subj2.endswith(" [retry 12]"))
        subj3, _ = relay.make_message(json.dumps(A("x" * 200)), self.cfg, "k")
        self.assertEqual(subj3, "ALERT consult: " + "x" * 60)                      # the 60-char rule still holds for plain text


class M3Identity(Base):
    def test_default_ssh_command_uses_a_dedicated_alias_and_no_pane_id(self):
        cmd = relay.DEFAULTS["ssh_command"]
        self.assertIn("consult-alerts-bus", cmd)
        self.assertNotIn("mini-bus", cmd)
        self.assertFalse(any("HERDR_PANE_ID" in a or "{identity}" in a for a in cmd))
        self.assertIn("BatchMode=yes", cmd)

    def test_the_sender_runs_exactly_the_configured_command_and_sends_no_identity(self):
        cfg = {**self.cfg, "ssh_command": ["/bin/echo", "alias-x"], "identity": "consult-alerts"}
        self.assertEqual(relay.McpSshSender(cfg).command(), ["/bin/echo", "alias-x"])

    def test_repo_has_the_ssh_alias_example_with_the_forced_command_note(self):
        t = open(os.path.join(os.path.dirname(__file__), "..", "ssh-config.example")).read()
        self.assertIn("ETA_BUS_AS=consult-alerts", t)
        self.assertIn("Host consult-alerts-bus", t)
        self.assertNotIn("HERDR_PANE_ID=", t.replace("-u HERDR_PANE_ID", ""))


class L1StateReset(Base):
    def reset_case(self, text):
        self.add(A("old1"), A("old2"))
        os.makedirs(os.path.dirname(self.cfg["state"]), exist_ok=True)
        with open(self.cfg["state"], "w") as f:
            f.write(text)
        s = Rec(); r = self.relay(s)
        r.poll_once()
        self.assertEqual(len(s.posts), 1, text)                                   # ONLY the notice; the old lines are not re-sent
        subj, body = s.raw[0]
        self.assertEqual(subj, "ALERT consult: relay state reset")
        self.assertIn("END of the spool", body)
        self.add(A("new1"))
        r.poll_once()
        self.assertEqual(json.loads(ln(s.posts[1][1]))["alert"], "new1")
        self.assertEqual(len(s.posts), 2)
        self.assertNotIn("notice", json.load(open(self.cfg["state"])))
        s3 = Rec(); self.relay(s3).poll_once()
        self.assertEqual(s3.posts, [])                                            # the notice is sent once

    def test_corrupt_json(self):
        self.reset_case("{not json")

    def test_empty_file(self):
        self.reset_case("")

    def test_missing_inode_field(self):
        self.reset_case(json.dumps({"offset": 0}))

    def test_wrong_types_and_negative_offset(self):
        self.reset_case(json.dumps({"inode": "x", "offset": 0}))
        self.setUp()
        self.reset_case(json.dumps({"inode": 5, "offset": -3}))
        self.setUp()
        self.reset_case(json.dumps([1, 2]))

    def test_no_state_file_at_all_is_a_normal_first_start_not_a_reset(self):
        self.add(A("one"))
        s = Rec(); self.relay(s).poll_once()
        self.assertEqual(len(s.posts), 1)
        self.assertNotIn("state reset", s.posts[0][0])

    def test_reset_while_the_spool_is_absent_reads_the_new_file_from_the_start(self):
        os.makedirs(os.path.dirname(self.cfg["state"]), exist_ok=True)
        open(self.cfg["state"], "w").write("garbage")
        s = Rec(); r = self.relay(s)
        r.poll_once()
        self.assertEqual([x for x, _ in s.posts], ["ALERT consult: relay state reset"])     # the notice goes out at once, spool or not
        self.add(A("fresh"))
        r.poll_once()
        self.assertEqual(len(s.posts), 2)
        self.assertEqual(json.loads(ln(s.posts[1][1]))["alert"], "fresh")             # the new file is read from its start

    def test_notice_is_retried_when_the_bus_is_down_and_never_lost(self):
        self.add(A("old"))
        os.makedirs(os.path.dirname(self.cfg["state"]), exist_ok=True)
        open(self.cfg["state"], "w").write("")
        s = Rec(fail=2); r = self.relay(s); r.poll_once()
        self.assertEqual(len(s.posts), 1)
        self.assertEqual(s.posts[0][0], "ALERT consult: relay state reset [retry 2]")
        self.assertEqual(len(s.posts), 1)

    def test_state_is_fsynced_with_its_directory(self):
        calls = []
        real = os.fsync
        os.fsync = lambda fd: (calls.append(fd), real(fd))[1]
        try:
            self.add(A("one")); self.relay(Rec()).poll_once()
        finally:
            os.fsync = real
        self.assertGreaterEqual(len(calls), 2)                                    # file and directory


class V3Lows(Base):
    def write_state(self, obj):
        os.makedirs(os.path.dirname(self.cfg["state"]), exist_ok=True)
        open(self.cfg["state"], "w").write(json.dumps(obj))

    def test_wrong_typed_inflight_or_notice_resets_like_a_corrupt_state(self):
        for extra in ({"inflight": "x"}, {"inflight": 5}, {"inflight": {"tries": "many"}}, {"inflight": {"end": "z"}},
                      {"notice": "oops"}, {"notice": {"reason": 1, "at": "t"}}, {"head": 7}):
            self.setUp()
            self.add(A("old1"), A("old2"))
            st = {"inode": os.stat(self.spool).st_ino, "offset": 0, "inflight": None, "head": None}
            self.write_state({**st, **extra})
            s = Rec(); r = self.relay(s); r.poll_once()                              # must not raise, must not replay
            self.assertEqual([x for x, _ in s.posts], ["ALERT consult: relay state reset"], extra)

    def test_a_valid_state_with_inflight_and_notice_still_loads(self):
        self.add(A("one"))
        self.write_state({"inode": os.stat(self.spool).st_ino, "offset": 0, "inflight": {"end": 5, "sha": "ab", "tries": 2},
                          "head": None})
        self.assertIsNotNone(relay.load_state(self.cfg["state"])[0])

    def test_reset_with_a_partial_last_line_starts_at_the_last_newline_not_mid_line(self):
        self.add(A("old"), raw='{"at": "t", "source": "x", "alert": "do')
        self.write_state("garbage")
        s = Rec(); r = self.relay(s); r.poll_once()
        self.assertEqual(len(s.posts), 1)                                          # only the notice; the fragment is not an alert
        with open(self.spool, "a") as f:
            f.write('ne"}\n')
        r.poll_once()
        self.assertEqual(json.loads(ln(s.posts[1][1]))["alert"], "done")            # the finished line is forwarded whole, once

    def test_start_end_with_a_partial_last_line_also_waits_for_the_newline(self):
        self.cfg["start"] = "end"
        self.add(A("old"), raw='{"at": "t", "source": "x", "alert": "par')
        s = Rec(); r = self.relay(s); r.poll_once()
        self.assertEqual(s.posts, [])
        with open(self.spool, "a") as f:
            f.write('tial"}\n')
        r.poll_once()
        self.assertEqual(json.loads(ln(s.posts[0][1]))["alert"], "partial")

    def test_a_saved_offset_in_the_middle_of_a_line_skips_to_the_next_newline(self):
        self.add(A("alpha"), A("beta"))
        first = len(open(self.spool).readline())
        self.write_state({"inode": os.stat(self.spool).st_ino, "offset": first - 7, "inflight": None, "head": None})
        s = Rec(); self.relay(s).poll_once()
        self.assertEqual([json.loads(b)["alert"] for _, b in s.posts], ["beta"])

    def test_spool_replaced_by_a_copy_with_a_new_inode_does_not_resend(self):
        self.add(A("a"), A("b"))
        s = Rec(); r = self.relay(s); r.poll_once()
        self.assertEqual(len(s.posts), 2)
        import shutil
        shutil.copy(self.spool, self.spool + ".new"); os.replace(self.spool + ".new", self.spool)       # cp + mv: new inode, same bytes
        self.add(A("c"))
        self.assertEqual(r.poll_once(), 1)
        self.assertEqual([json.loads(b)["alert"] for _, b in s.posts], ["a", "b", "c"])
        s2 = Rec(); self.assertEqual(self.relay(s2).poll_once(), 0)

    def test_a_genuinely_new_smaller_spool_still_starts_at_zero(self):
        self.add(A("a" * 100), A("b" * 100))
        s = Rec(); r = self.relay(s); r.poll_once()
        os.remove(self.spool); self.add(A("n"))
        self.assertEqual(r.poll_once(), 1)
        self.assertEqual(json.loads(ln(s.posts[-1][1]))["alert"], "n")

    def test_notice_retry_count_survives_a_crash(self):
        self.add(A("old"))
        self.write_state("garbage")
        s = Slow(1)
        r = self.relay(s, stop=lambda: s.calls >= 1); r.poll_once()                  # reset notice posted once, reply lost, stopped
        self.assertGreaterEqual(json.load(open(self.cfg["state"]))["inflight"]["tries"], 1)
        s2 = Rec(); self.relay(s2).poll_once()
        self.assertEqual(s2.posts[0][0], "ALERT consult: relay state reset [retry 1]")
        self.assertEqual(key_of(s.committed[0][1]), key_of(s2.raw[0][1]))

    def test_bad_config_json_exits_78_once_with_a_log_line(self):
        import io, contextlib
        for text in ("{not json", "[1, 2]", '{"recipients": []}', '{"recipients": "x"}'):
            p = os.path.join(self.d, "bad.json")
            open(p, "w").write(text)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = relay.main(["--config", p, "--once"])
            self.assertEqual(rc, 78, text)
            self.assertIn("CONFIG ERROR", buf.getvalue())

    def test_every_wrongly_typed_config_value_exits_78_at_start(self):
        import io, contextlib
        bad = {"poll_s": "5", "call_timeout_s": 0, "backoff_start_s": -1, "backoff_max_s": "x", "subject_chars": "60",
               "subject_max_utf16": 500, "max_body": 99999, "spool": 5, "state": None, "dead_letter": "", "identity": ["a"],
               "recipients": "consult-lead", "ssh_command": "ssh host", "start": "middle"}
        for k, v in bad.items():
            p = os.path.join(self.d, "c.json")
            json.dump({k: v}, open(p, "w"))
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = relay.main(["--config", p, "--once"])
            self.assertEqual(rc, 78, (k, v))
            self.assertIn(f"{k} must", buf.getvalue())
        for v in ({"recipients": ["a", 1]}, {"ssh_command": []}, {"poll_s": True}, {"backoff_start_s": 10, "backoff_max_s": 5}):
            json.dump(v, open(p, "w"))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(relay.main(["--config", p, "--once"]), 78, v)

    def test_a_valid_config_and_the_defaults_pass_validation(self):
        self.assertEqual(relay.validate_config(dict(relay.DEFAULTS)), [])
        ex = json.load(open(os.path.join(os.path.dirname(__file__), "..", "config.example.json")))
        self.assertEqual(relay.validate_config({**relay.DEFAULTS, **ex}), [])
        self.assertEqual(relay.validate_config({**relay.DEFAULTS, "poll_s": 2, "max_body": 15000, "start": "end"}), [])

    def test_missing_config_file_also_exits_78(self):
        self.assertEqual(relay.main(["--config", os.path.join(self.d, "nope.json"), "--once"]), 78)

    def test_unit_does_not_restart_on_exit_78(self):
        u = open(os.path.join(os.path.dirname(__file__), "..", "systemd", "consult-alert-relay.service")).read()
        self.assertIn("RestartPreventExitStatus=78", u)

    def test_ssh_example_no_longer_claims_a_post_allowlist(self):
        t = open(os.path.join(os.path.dirname(__file__), "..", "ssh-config.example")).read()
        self.assertIn('from="127.0.0.1,::1"', t)
        self.assertNotIn("[POST_TO_ALLOW=consult-lead,fable]", t)
        self.assertIn("NOT by run.sh", t)


class L3Unit(unittest.TestCase):
    def test_unit_has_a_condition_on_the_config_and_stays_dry(self):
        u = open(os.path.join(os.path.dirname(__file__), "..", "systemd", "consult-alert-relay.service")).read()
        self.assertIn("ConditionPathExists=%h/.config/consult-alert-relay/config.json", u)
        self.assertIn("Restart=always", u)
        self.assertNotIn("--live", next(l for l in u.splitlines() if l.startswith("ExecStart=")))
        self.assertLess(u.index("[Unit]"), u.index("ConditionPathExists"))
        self.assertLess(u.index("ConditionPathExists"), u.index("[Service]"))


if __name__ == "__main__":
    unittest.main()
