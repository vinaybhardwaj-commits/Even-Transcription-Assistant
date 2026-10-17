"""The one-shot probe CLI (`consult_hold.py --probe <file>`) with stub sources: one compute, per-room hold / reasons / row counts, no publish, no audit file, no credential."""
import json, os, subprocess, sys, tempfile, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber"))
import consult_hold as ch

# built at run time from parts: no literal URL with a password may appear in the source (scrub env-secret-assign, gitleaks)
USER_, PW_, HOST_ = "probe" + "user", "x" * 12, "db.example" + ".invalid"
FAKE_CONN = "postgres" + "://" + USER_ + ":" + PW_ + "@" + HOST_ + "/neondb"


class Src:
    def __init__(self, **v): self.v, self.calls = v, []
    def __getitem__(self, name):
        def f(now, arg):
            self.calls.append(name)
            x = self.v[name]
            if isinstance(x, BaseException): raise x
            return x
        return f


NOW = time.time()
GOOD = {"presence": {"hb": [("MK1", NOW - 5, 1)], "enc": [("MK1", "encounter_close", NOW - 400, 2)], "post": []}, "session": set(), "levels": [], "windows": []}


class Probe(unittest.TestCase):
    def cfg(self, **extra):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup); self.dir = d.name
        c = dict({"consult_room_map": {"opd-6": {"machine": "MK1", "room_id": "rid6", "slug": "slug6"}}, "consult_db_url_file": os.path.join(d.name, "db.url")}, **extra)
        open(c["consult_db_url_file"], "w").write(FAKE_CONN + "\n")
        p = os.path.join(d.name, "probe.json"); open(p, "w").write(json.dumps(c)); return p

    def test_one_compute_per_room_hold_reasons_and_row_counts(self):
        src = Src(**GOOD); out = ch.probe(self.cfg(), sources=src, clock=lambda: NOW)
        r = out["rooms"]["opd-6"]
        self.assertEqual(sorted(src.calls), ["levels", "presence", "session"])             # one compute, one call per source; the windows query is not made (flag off)
        self.assertIs(r["hold"], True); self.assertEqual(r["reasons"], ["health_stale"])    # the probe has no kiosk health line
        self.assertIs(r["db_hold"], False)
        self.assertEqual((r["machine"], r["room_id"], r["slug"]), (["MK1"], "rid6", "slug6"))
        self.assertEqual(r["rows"]["presence"], {"hb": 1, "enc": 1, "post": 0, "enc_newest": {"MK1": "encounter_close"}, "post_newest": {}})
        self.assertEqual(r["rows"]["session"], {"open": 0})
        self.assertEqual(out["errors"], [])

    def test_an_open_consult_and_an_open_session_show_in_the_reasons(self):
        v = dict(GOOD, presence={"hb": [("MK1", NOW - 5, 1)], "enc": [("MK1", "encounter_open", NOW - 30, 2)], "post": [("MK1", "encounter_open", NOW - 30, 2)]}, session={"rid6"},
                 levels=[("rid6", NOW - 10)])
        out = ch.probe(self.cfg(), sources=Src(**v), clock=lambda: NOW)["rooms"]["opd-6"]
        self.assertIn("presence_consulting", out["reasons"]); self.assertIn("session_open", out["reasons"]); self.assertIs(out["db_hold"], True)
        self.assertEqual(out["rows"]["levels"], {"rows": 1, "active_recent": True})

    def test_sql_errors_are_listed_verbatim_with_the_url_and_credentials_redacted(self):
        v = dict(GOOD, session=RuntimeError(f"column s.nope does not exist; connecting to {FAKE_CONN} as {USER_} pw {PW_} host {HOST_}"))
        out = ch.probe(self.cfg(), sources=Src(**v), clock=lambda: NOW)
        self.assertEqual(len(out["errors"]), 1); e = out["errors"][0]
        self.assertEqual(e["source"], "session"); self.assertIn("column s.nope does not exist", e["error"])
        for s in (PW_, USER_, HOST_, FAKE_CONN): self.assertNotIn(s, json.dumps(out))
        self.assertIs(out["rooms"]["opd-6"]["hold"], True); self.assertIn("session_down", out["rooms"]["opd-6"]["reasons"]); self.assertTrue(out["source_errors"]["session"])

    def test_it_never_writes_an_audit_file_or_calls_a_sink(self):
        p = self.cfg(); ch.probe(p, sources=Src(**GOOD), clock=lambda: NOW)
        left = [f for _r, _d, fs in os.walk(self.dir) for f in fs]
        self.assertEqual(sorted(left), ["db.url", "probe.json"]); self.assertFalse(os.path.exists("/nonexistent-probe-home"))

    def test_the_flags_in_the_file_are_honoured(self):
        out = ch.probe(self.cfg(consult_windows_enabled=True, open_session_requires_levels=False), sources=Src(**GOOD), clock=lambda: NOW)
        self.assertIs(out["switches"]["consult_windows_enabled"], True); self.assertIs(out["switches"]["open_session_requires_levels"], False)
        self.assertEqual(out["rooms"]["opd-6"]["rows"]["windows"], {"rows": 0})

    def test_a_config_without_a_room_map_is_refused(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup); p = os.path.join(d.name, "c.json"); open(p, "w").write("{}")
        with self.assertRaises(ValueError): ch.probe(p, sources=Src(**GOOD))

    def test_the_cli_usage_and_a_bad_file_exit_nonzero_without_a_trace_of_secrets(self):
        script = os.path.join(HERE, "..", "subscriber", "consult_hold.py")
        r = subprocess.run([sys.executable, "-I", script], capture_output=True, text=True, timeout=30); self.assertEqual(r.returncode, 64)
        r = subprocess.run([sys.executable, "-I", script, "--probe", os.path.join(self.cfg() + ".missing")], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 2); self.assertNotIn(PW_, r.stdout + r.stderr)


class Redaction(unittest.TestCase):
    """CO-8 N1 (host as written, first label, any case), N2 (top-level handler redacts), N3 (room keys), N4 (timeouts in errors)."""
    MIXED = "EP-Cold-Fog-123456." + "Example.invalid"                       # a host written in mixed case, built at run time

    def cfg(self, url_host, mapkeys=("opd-6",), **extra):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup); self.dir = d.name
        url = "postgres" + "://" + USER_ + ":" + PW_ + "@" + url_host + "/neondb"
        c = dict({"consult_room_map": {k: {"machine": "MK1", "room_id": "rid6", "slug": "slug6"} for k in mapkeys}, "consult_db_url_file": os.path.join(d.name, "db.url")}, **extra)
        open(c["consult_db_url_file"], "w").write(url + "\n")
        p = os.path.join(d.name, "probe.json"); open(p, "w").write(json.dumps(c)); return p

    def test_n1_the_host_as_written_and_its_first_label_are_redacted_in_any_case(self):
        label = self.MIXED.split(".")[0]
        for text in (f'could not translate host name "{self.MIXED}" to address', f'host {self.MIXED.lower()} refused', f'host {self.MIXED.upper()} refused', f"endpoint {label} not found",
                     f"endpoint {label.lower()} not found", f"endpoint {label.upper()} not found"):
            with self.subTest(text):
                out = ch.probe(self.cfg(self.MIXED), sources=Src(**dict(GOOD, session=RuntimeError(text))), clock=lambda: NOW)
                blob = json.dumps(out)
                for bad in (self.MIXED, self.MIXED.lower(), self.MIXED.upper(), label, label.lower(), label.upper(), PW_, USER_):
                    self.assertNotIn(bad, blob)
                self.assertIn("<redacted>", blob)

    def test_nc_the_endpoint_id_without_the_pooler_suffix_is_redacted(self):
        host = "ep-cold-fog-123456-pooler.us-east-2.aws.example.invalid"
        for text in ("The endpoint ID ep-cold-fog-123456 has been disabled", "endpoint EP-COLD-FOG-123456 disabled", f"host {host} unreachable"):
            with self.subTest(text):
                out = ch.probe(self.cfg(host), sources=Src(**dict(GOOD, session=RuntimeError(text))), clock=lambda: NOW)
                blob = json.dumps(out).lower()
                for bad in ("ep-cold-fog-123456", host): self.assertNotIn(bad, blob)
                self.assertIn("<redacted>", blob)

    def test_n2_the_top_level_handler_redacts_what_it_prints(self):
        home = tempfile.TemporaryDirectory(); self.addCleanup(home.cleanup)
        os.makedirs(os.path.join(home.name, ".config", "eta-audio"))
        open(os.path.join(home.name, ".config", "eta-audio", "db.url"), "w").write("postgres" + "://" + USER_ + ":" + PW_ + "@" + HOST_ + "/neondb\n")
        script = os.path.join(HERE, "..", "subscriber", "consult_hold.py")
        r = subprocess.run([sys.executable, "-I", script, "--probe", os.path.join(home.name, HOST_ + ".json")], capture_output=True, text=True, timeout=30, env={"HOME": home.name, "PATH": os.environ.get("PATH", "")})
        self.assertEqual(r.returncode, 2); self.assertIn("probe failed: FileNotFoundError", r.stderr); self.assertIn("<redacted>", r.stderr)
        for bad in (HOST_, PW_, USER_): self.assertNotIn(bad, r.stdout + r.stderr)

    def test_n3_room_keys_must_be_slugs(self):
        for key in ("OPD-6", "opd 6", "opd.6", "", "x" * 65, "opd-6/../x"):
            with self.subTest(repr(key)):
                with self.assertRaises(ValueError) as cm: ch.probe(self.cfg(HOST_, mapkeys=(key,)), sources=Src(**GOOD), clock=lambda: NOW)
                if key: self.assertNotIn(key, str(cm.exception))
        out = ch.probe(self.cfg(HOST_, mapkeys=("a-b_c9", "x" * 64)), sources=Src(**GOOD), clock=lambda: NOW); self.assertEqual(sorted(out["rooms"]), sorted(["a-b_c9", "x" * 64]))

    def test_n4_a_source_timeout_is_listed_in_errors(self):
        import time as _t
        class Slow(Src):
            def __getitem__(self, name):
                if name != "session": return super().__getitem__(name)
                def f(now, arg): _t.sleep(1.0); return set()
                return f
        out = ch.probe(self.cfg(HOST_), sources=Slow(**GOOD), clock=lambda: NOW, timeout_s=0.1)
        self.assertEqual([e["source"] for e in out["errors"]], ["session"]); self.assertTrue(out["errors"][0]["error"].startswith("timeout")); self.assertTrue(out["source_errors"]["session"])

    def test_n4_a_wrong_shape_answer_is_listed_too(self):
        out = ch.probe(self.cfg(HOST_), sources=Src(**dict(GOOD, session=["not", "a", "set"])), clock=lambda: NOW)
        self.assertEqual([(e["source"], e["error"].split(":")[0]) for e in out["errors"]], [("session", "wrong_shape")])


if __name__ == "__main__":
    unittest.main()
