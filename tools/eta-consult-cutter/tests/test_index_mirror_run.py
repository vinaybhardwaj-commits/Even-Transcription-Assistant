"""index-mirror hourly hook: the run wrapper (tools/index_mirror_run.sh) and the unit files. Nothing is installed, enabled or started; the wrapper runs in --dry-run against fixtures, never --live."""
from unittest import mock
import importlib, configparser, fcntl, json, os, re, shutil, stat, subprocess, sys, tempfile, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests")); sys.path.insert(0, os.path.join(ROOT, "tools"))
import test_index_mirror as T
WRAP = os.path.join(ROOT, "tools", "index_mirror_run.sh")

def unit(name):
    cp = configparser.ConfigParser(strict=False, interpolation=None); cp.optionxform = str
    cp.read_string(open(os.path.join(ROOT, name)).read()); return cp

class Wrapper(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.deploy = f"{self.d}/deploy"; os.makedirs(f"{self.deploy}/tools")
        shutil.copy(os.path.join(ROOT, "tools", "index_mirror.py"), f"{self.deploy}/tools/index_mirror.py")
        g = lambda *a: subprocess.run(["git", "-C", self.deploy, "-c", "user.name=t", "-c", "user.email=t@t", *a], capture_output=True, check=True)
        g("init", "-q"); g("add", "."); g("commit", "-q", "-m", "x")                       # the tool refuses an unknown code_commit, so the fake deploy worktree is a git repo
        self.idx, self.blind, self.ho, self.out, self.log, self.lock = (f"{self.d}/{x}" for x in ("index.jsonl", "blind.json", "heldout.py", "out", "mirror.log", "mirror.lock"))
        with open(self.ho, "w") as fh: fh.write(T.FAKE_HO)
        with open(self.blind, "w") as fh: json.dump(dict(source="t", union_sha16="f07171dcb708d080", pairs=[["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"]]), fh)
        self.rows([T.row("a"), T.row("b")])
    def rows(self, rows):
        with open(self.idx, "w") as fh:
            for r in rows: fh.write(json.dumps(r) + "\n")
    def run_wrap(self, args=None, **env):
        e = dict(os.environ, INDEX_MIRROR_DEPLOY_DIR=self.deploy, INDEX_MIRROR_PY=sys.executable, INDEX_MIRROR_LOG=self.log, INDEX_MIRROR_LOCK=self.lock,
                 INDEX_MIRROR_ARGS=args or f"--dry-run {self.out} --index {self.idx} --blind {self.blind} --heldout {self.ho}"); e.update(env)
        return subprocess.run(["bash", WRAP], capture_output=True, text=True, env=e, timeout=60)
    def logtext(self): return open(self.log).read() if os.path.exists(self.log) else ""

    def test_a_good_run_exits_0_and_logs_one_counts_only_line(self):
        r = self.run_wrap(); self.assertEqual(r.returncode, 0, r.stderr); lines = self.logtext().splitlines(); self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^\d{4}-\d\d-\d\dT[\d:+]+ rc=0 deploy=[0-9a-f]{7,} counts \{.*\"kept\": 2"); self.assertTrue(os.path.exists(f"{self.out}/consult/index/latest.jsonl"))
        self.assertNotIn(T.NAME, self.logtext()); self.assertNotIn(T.PATH, self.logtext()); self.assertNotIn("consult_uid", self.logtext())
    def test_failures_pass_the_tools_exit_code_through_and_log_the_reason_only(self):
        os.unlink(self.blind); r = self.run_wrap(); self.assertEqual(r.returncode, 2); self.assertRegex(self.logtext(), r"rc=2 .*CONFIG ERROR")
        with open(self.blind, "w") as fh: json.dump(dict(source="t", union_sha16="f07171dcb708d080", pairs=[["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"]]), fh)
        self.rows([T.row("a", status="skipped", r2=None)]); self.assertEqual(self.run_wrap().returncode, 3)
        self.rows([T.row("a", doctor_name="Dr Secretname Leaky", flags=["Dr Secretname Leaky"])]); r = self.run_wrap(); self.assertEqual(r.returncode, 6)
        self.assertRegex(self.logtext(), r"rc=6 .*LEAK"); self.assertNotIn("ecretname", self.logtext() + r.stdout + r.stderr)
    def test_one_log_line_per_run_and_appended(self):
        self.run_wrap(); self.run_wrap(); self.assertEqual(len(self.logtext().splitlines()), 2)
    def test_a_missing_tool_in_the_deploy_worktree_is_exit_2(self):
        os.unlink(f"{self.deploy}/tools/index_mirror.py"); r = self.run_wrap(); self.assertEqual(r.returncode, 2); self.assertRegex(self.logtext(), r"rc=2 .*no tools/index_mirror.py")
    def test_a_missing_python_is_a_failure_not_a_skip(self):
        r = self.run_wrap(INDEX_MIRROR_PY=f"{self.d}/no-python"); self.assertNotEqual(r.returncode, 0); self.assertRegex(self.logtext(), r"rc=12[67] ")
    def test_a_held_lock_skips_with_exit_0_and_does_not_touch_the_index_or_output(self):
        fd = os.open(self.lock, os.O_WRONLY | os.O_CREAT, 0o600); fcntl.flock(fd, fcntl.LOCK_EX)
        try: r = self.run_wrap()
        finally: os.close(fd)
        self.assertEqual(r.returncode, 0); self.assertIn("skip", self.logtext()); self.assertFalse(os.path.exists(self.out))
        self.assertEqual(self.run_wrap().returncode, 0); self.assertTrue(os.path.exists(self.out))                      # released: runs again
    def test_the_default_mode_is_live_and_the_unit_sets_no_override(self):
        src = open(WRAP).read(); self.assertIn('${INDEX_MIRROR_ARGS:---live}', src)
        for f in ("index-mirror.service", "index-mirror.timer"): self.assertNotIn("INDEX_MIRROR", open(os.path.join(ROOT, f)).read())
    def test_the_wrapper_uses_the_deploy_worktree_the_cutter_venv_and_prints_no_secret_path(self):
        src = open(WRAP).read(); self.assertIn("$HOME/oc/consult/cutter-deploy", src); self.assertIn("$HOME/oc/consult/cutter-venv/bin/python", src); self.assertNotIn("secrets", src); self.assertNotIn("r2_lab_results", src)
    def test_the_tool_default_key_file_is_the_lab_results_write_key(self):
        import index_mirror as M
        with mock.patch.dict(os.environ):
            os.environ.pop("CONSULT_MIRROR_CRED_FILE", None); self.assertTrue(importlib.reload(M).CRED_FILE.endswith("/.config/consult-cutter/r2_lab_results_write"))
        importlib.reload(M)

class Units(unittest.TestCase):
    def test_service_is_a_oneshot_in_the_deploy_worktree_with_no_link_to_the_cutter(self):
        u = unit("index-mirror.service"); self.assertEqual(u["Service"]["Type"], "oneshot"); self.assertEqual(u["Service"]["ExecStart"], "%h/oc/consult/cutter-deploy/tools/index_mirror_run.sh"); self.assertEqual(u["Service"]["WorkingDirectory"], "%h/oc/consult/cutter-deploy")
        self.assertNotIn("Install", u.sections())
        raw = open(os.path.join(ROOT, "index-mirror.service")).read()
        for k in ("After=", "Before=", "Requires=", "Wants=", "BindsTo=", "PartOf=", "Conflicts=", "OnFailure=", "ExecStartPost="): self.assertFalse(re.search(rf"^{k}", raw, re.M), k)
        self.assertNotIn("cutter-hourly", "\n".join(l for l in raw.splitlines() if not l.startswith("#") and not l.startswith("Description")))
        self.assertIn("TimeoutStartSec", u["Service"]); self.assertNotIn("EnvironmentFile", u["Service"]); self.assertNotIn("Environment", u["Service"])
    def test_timer_is_55_past_the_hour_08_to_22_and_not_persistent(self):
        t = unit("index-mirror.timer"); self.assertEqual(t["Timer"]["OnCalendar"], "*-*-* 08..22:55:00"); self.assertEqual(t["Timer"]["Persistent"], "false"); self.assertEqual(t["Timer"]["Unit"], "index-mirror.service"); self.assertEqual(t["Install"]["WantedBy"], "timers.target")
    def test_timer_calendar_parses_and_fires_at_xx55_only_in_the_window(self):
        if not shutil.which("systemd-analyze"): self.skipTest("no systemd-analyze")
        r = subprocess.run(["systemd-analyze", "calendar", "--iterations=40", "*-*-* 08..22:55:00"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0); times = re.findall(r"Next elapse: .*?(\d\d):(\d\d):(\d\d)|^\s+\w+ \d{4}-\d\d-\d\d (\d\d):(\d\d):(\d\d)", r.stdout, re.M)
        hm = [(a or d, b or e) for a, b, c, d, e, f in times]; self.assertTrue(hm); self.assertTrue(all(m == "55" and 8 <= int(h) <= 22 for h, m in hm), hm)
    def test_the_cutter_units_are_not_touched_and_the_timers_do_not_collide(self):
        self.assertEqual(unit("cutter-hourly.timer")["Timer"]["OnCalendar"], "*:35:00"); self.assertNotIn("index-mirror", open(os.path.join(ROOT, "cutter-hourly.service")).read())
        self.assertNotIn("index-mirror", open(os.path.join(ROOT, "cutter-hourly.timer")).read())
        r = subprocess.run(["git", "-C", ROOT, "diff", "--name-only", "ec8fa64", "--", "cutter-hourly.service", "cutter-hourly.timer", "deploy.sh", "install.sh", "systemd/cutter-alert@.service"], capture_output=True, text=True)
        if r.returncode == 0: self.assertEqual(r.stdout.strip(), "")                                                       # none of the cutter's units / deploy scripts changed since the deploy HEAD (m3-17 changes the cutter/ package itself for --windows-file, so the package is no longer in this list)
    def test_onfailure_drop_in_only_raises_an_alert(self):
        raw = open(os.path.join(ROOT, "systemd", "index-mirror.service.d-onfailure.conf")).read(); body = [l for l in raw.splitlines() if l.strip() and not l.startswith("#")]
        self.assertEqual(body, ["[Unit]", "OnFailure=cutter-alert@%n.service"])
    def test_the_install_script_copies_two_files_and_never_loads_enables_or_starts(self):
        src = open(os.path.join(ROOT, "install-index-mirror.sh")).read(); code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotIn("systemctl", code); self.assertIn("index-mirror.service", code); self.assertIn("index-mirror.timer", code)
        self.assertFalse(re.search(r"\b(enable|start|restart|daemon-reload)\b", code))
    def test_script_modes(self):
        for f in ("tools/index_mirror_run.sh", "install-index-mirror.sh"): self.assertTrue(os.stat(os.path.join(ROOT, f)).st_mode & stat.S_IXUSR, f)

if __name__ == "__main__": unittest.main()
