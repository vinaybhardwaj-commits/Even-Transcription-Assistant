"""index-mirror/01: the R2 index mirror (tools/index_mirror.py). No network, no credential read: a fake client stands in for R2."""
import contextlib, hashlib, io, json, os, stat, sys, tempfile, unittest
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import index_mirror as M

FAKE_HO = 'LABEL = {"room_bbbbbbbb": "OPDB", "room_cccccccc": "OPDC"}\ndef load_union(): return {"2026-09-28 OPDB", "2026-09-23 OPDC"}, "f07171dcb708d080"\n'
PQM_KEYS = {"boundary_source", "room_source", "pqm_step_uid", "pqm_called", "pqm_completed", "consult_offset_s", "room_confidence"}   # m3-17: carried by PQM rows only
NAME, PATH = "Dr Fixture Doctorname", "/home/example/eta-data/consult/clips/2026-10-03/room-x/uid"
def row(uid, status="cut", r2="mirrored", day="2026-10-03", room="room_aaaaaaaa", **kw):
    r = dict(consult_uid=uid, window_id=7, ist_date=day, room_id=room, room_slug="opd-1-abcd", span_start="2026-10-03 16:03:43.351", span_end="2026-10-03 16:21:01.100", span_end_epoch=1791024661.1,
             t_open="2026-10-03 16:04:43.351", t_close="2026-10-03 16:20:46.100", minutes=17.3, bytes={"consult.flac": 1, "doctor.flac": 2}, quality="clean", flags=["doctor_like_group"], coverage=1.0,
             voice_isolated=False, doctor_uid="aaaaaaaaaaaaaaaaaaaa", doctor_identified=True, cut_at="2026-10-09T08:20:51+0530", code_commit="ec8fa64", signature={"start": 1.5, "doctor": "aaaaaaaaaaaaaaaaaaaa"},
             status=status, doctor_name=NAME, path=PATH, bytes_total=3, consult_zero_ratio=0.004, vi_frame_share=0.5, gating_source="x", rule="explicit_close+15s", doctor_split_failed=False, unembedded_s=0,
             future_unknown_key="zzz-secret-marker", close_reason="url_clear", computed_at="2026-10-05T10:07:07+00:00")
    if r2: r["r2"] = dict(status=r2, bucket="eta-audio", prefix=f"consult-clips/2026-10-03/room-x/{uid}", files=4, at="2026-10-09T08:21:00+0530", deleted_stale=["a"])
    r.update(kw); return r

class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.idx = f"{self.d}/index.jsonl"; self.blind = f"{self.d}/blind.json"
        self.ho = f"{self.d}/heldout.py"
        with open(self.ho, "w") as fh: fh.write(FAKE_HO)
        self.cfg(["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"])
    def cfg(self, *pairs, sha="f07171dcb708d080"):
        with open(self.blind, "w") as fh: json.dump(dict(source="t", union_sha16=sha, pairs=list(pairs)), fh)
    def write(self, rows, raw=None):
        with open(self.idx, "w") as fh:
            for r in rows: fh.write(json.dumps(r) + "\n")
            if raw: fh.write(raw)
    def refused(self, rows):
        self.write(rows)
        with self.assertRaises(M.LeakError): M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")
    def build(self, rows, **kw):
        self.write(rows, kw.pop("raw", None)); latest, man, c = M.build(self.idx, self.blind, heldout_py=self.ho, commit="abc1234"); return [json.loads(x) for x in latest.decode().splitlines()], json.loads(man), c, latest, man

class Selection(Base):
    def test_latest_row_per_uid_wins(self):
        rows, _, c, _, _ = self.build([row("u1", r2="mirrored"), row("u1", r2="pending_mirror"), row("u2", r2="pending_no_credential"), row("u2", r2="mirrored", cut_at="2026-10-09T09:00:00+0530")])
        self.assertEqual([r["consult_uid"] for r in rows], ["u2"]); self.assertEqual(rows[0]["cut_at"], "2026-10-09T09:00:00+0530"); self.assertEqual(c["not_mirrored"], 1)
    def test_only_cut_and_mirrored(self):
        rows, _, c, _, _ = self.build([row("a"), row("b", status="skipped", r2=None), row("c", status="error", r2=None), row("d", status="deferred_long", r2=None), row("e", r2="pending_mirror"), row("f", r2="pending_no_credential"), row("g", r2=None)])
        self.assertEqual([r["consult_uid"] for r in rows], ["a"]); self.assertEqual((c["not_cut"], c["not_mirrored"], c["kept"], c["uids"]), (3, 3, 1, 7))
    def test_mirrored_without_bucket_or_prefix_is_not_listed(self):
        r = row("a"); del r["r2"]["prefix"]; r2 = row("b"); r2["r2"]["bucket"] = ""
        rows, _, c, _, _ = self.build([r, r2, row("c")]); self.assertEqual([x["consult_uid"] for x in rows], ["c"]); self.assertEqual(c["no_r2_key"], 2)
    def test_blind_pair_is_skipped_only_for_that_pair(self):
        rows, _, c, _, _ = self.build([row("a", day="2026-09-28", room="room_bbbbbbbb"), row("b", day="2026-09-28", room="room_aaaaaaaa"), row("c", day="2026-10-01", room="room_bbbbbbbb"), row("d", day="2026-09-23", room="room_cccccccc")])
        self.assertEqual([r["consult_uid"] for r in rows], ["b", "c"]); self.assertEqual(c["blind"], 2)
    def test_blind_applies_to_the_latest_row_even_if_an_older_row_was_not_blind(self):
        rows, _, _, _, _ = self.build([row("a", day="2026-10-01"), row("a", day="2026-09-28", room="room_bbbbbbbb")]); self.assertEqual(rows, [])
    def test_voice_isolated_rows_are_mirrored_with_the_flag(self):
        rows, _, c, _, _ = self.build([row("a", voice_isolated=True), row("b")]); self.assertEqual({r["consult_uid"]: r["voice_isolated"] for r in rows}, {"a": True, "b": False}); self.assertEqual(c["voice_isolated"], 1)
    def test_sorted_by_uid_and_deterministic(self):
        a = self.build([row("z"), row("m"), row("a")]); b = self.build([row("a"), row("z"), row("m")])
        self.assertEqual([r["consult_uid"] for r in a[0]], ["a", "m", "z"]); self.assertEqual(a[3], b[3])
    def test_half_written_and_junk_lines_are_skipped_and_counted(self):
        rows, _, c, _, _ = self.build([row("a")], raw='{"consult_uid": "b", "status": "cu\nnot json\n[1,2]\n{"no_uid": 1}\n'); self.assertEqual([r["consult_uid"] for r in rows], ["a"]); self.assertEqual(c["bad_lines"], 4)

class Allowlist(Base):
    def test_exact_allowlist_and_r2_subset(self):
        rows, _, _, _, _ = self.build([row("a")]); r = rows[0]
        self.assertEqual(set(r), set(M.ALLOW) - PQM_KEYS); self.assertEqual(set(r["r2"]), {"bucket", "prefix", "files", "at"})
        for k in ("doctor_name", "path", "bytes_total", "consult_zero_ratio", "future_unknown_key", "close_reason", "computed_at", "status"): self.assertNotIn(k, r)
        for k in ("status", "deleted_stale"): self.assertNotIn(k, r["r2"])
    def test_spec_item_4_field_list_is_exact(self):
        self.assertEqual(set(M.ALLOW), set("consult_uid window_id ist_date room_id room_slug span_start span_end span_end_epoch t_open t_close minutes bytes quality flags coverage voice_isolated doctor_uid doctor_identified cut_at code_commit signature r2 boundary_source room_source pqm_step_uid pqm_called pqm_completed consult_offset_s room_confidence".split()))   # spec item 4 + m3-17
        self.assertEqual(M.R2_ALLOW, ("bucket", "prefix", "files", "at"))
    def test_doctor_name_and_path_never_appear_in_either_output_file(self):
        _, _, _, latest, man = self.build([row("a"), row("b", voice_isolated=True)])
        for blob in (latest, man): self.assertNotIn(NAME.encode(), blob); self.assertNotIn(PATH.encode(), blob); self.assertNotIn(b"doctor_name", blob); self.assertNotIn(b'"path"', blob); self.assertNotIn(b"zzz-secret-marker", blob)
    def test_no_non_allowlisted_key_leaks_at_any_top_level_position(self):
        extra = {f"k{i}": f"leak{i}" for i in range(20)}; extra.update(doctor_name=NAME, path=PATH, r2_path="x", Doctor_Name="x", DOCTOR_NAME="x")
        rows, _, _, latest, _ = self.build([row("a", **extra)])
        self.assertEqual(set(rows[0]) - set(M.ALLOW), set()); self.assertNotIn(b"leak", latest)
    def test_the_runtime_guard_fires_if_the_projection_ever_leaks(self):
        orig = M.project
        leaky = lambda r: dict(orig(r), doctor_name=r["doctor_name"])
        self.write([row("a")])
        with mock.patch.object(M, "project", leaky), self.assertRaises(AssertionError): M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")
        leaky_r2 = lambda r: dict(orig(r), r2=dict(r["r2"]))
        with mock.patch.object(M, "project", leaky_r2), self.assertRaises(AssertionError): M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")
        leaky_val = lambda r: dict(orig(r), room_slug="x " + r["doctor_name"] + " y")
        leaky_abs = lambda r: dict(orig(r), room_slug="at " + r["path"])
        with mock.patch.object(M, "project", leaky_val), self.assertRaises(AssertionError): M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")
        with mock.patch.object(M, "project", leaky_abs), self.assertRaises(AssertionError): M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")
    def test_missing_signature_is_omitted_not_null_and_a_list_signature_passes_through(self):
        r = row("a"); del r["signature"]; rows, _, _, _, _ = self.build([r, row("b", signature=[1.5, "url_clear", "uid"])])
        self.assertNotIn("signature", rows[0]); self.assertEqual(rows[1]["signature"], [1.5, "url_clear", "uid"])

class Manifest(Base):
    def test_manifest_keys_rows_and_sha(self):
        rows, man, _, latest, manb = self.build([row("a"), row("b")])
        self.assertEqual(set(man), {"generated_at", "rows", "sha256", "code_commit"}); self.assertEqual(man["rows"], 2); self.assertEqual(man["sha256"], hashlib.sha256(latest).hexdigest()); self.assertEqual(man["code_commit"], "abc1234")
        self.assertRegex(man["generated_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$"); self.assertTrue(latest.endswith(b"\n")); self.assertEqual(len(latest.decode().splitlines()), 2)
    def test_empty_selection_gives_an_empty_body_with_its_hash(self):
        rows, man, _, latest, _ = self.build([row("a", status="skipped", r2=None)]); self.assertEqual((rows, latest, man["rows"]), ([], b"", 0)); self.assertEqual(man["sha256"], hashlib.sha256(b"").hexdigest())

class EmptyUnion(Base):
    EMPTY_HO = 'LABEL = {}\ndef load_union(): return set(), "%s"\n'
    def ho_with(self, body):
        with open(self.ho, "w") as fh: fh.write(body)
    def test_nonempty_union_still_passes_and_returns_pairs(self):
        self.assertEqual(M.load_blind(self.blind, self.ho), {("2026-09-28", "room_bbbbbbbb"), ("2026-09-23", "room_cccccccc")})
    def test_empty_union_with_pinned_sha_returns_empty_set_whatever_the_config_holds_and_logs_one_line(self):
        self.ho_with(self.EMPTY_HO % "f07171dcb708d080")
        for content in ("keep", None, "", "not json", '{"pairs": []}'):
            if content is None: os.unlink(self.blind)
            elif content != "keep": open(self.blind, "w").write(content)
            err = io.StringIO()
            with contextlib.redirect_stderr(err): self.assertEqual(M.load_blind(self.blind, self.ho), set())
            self.assertEqual(err.getvalue().strip(), "blind union empty: no room-days withheld")
    def test_empty_union_with_wrong_sha_is_a_config_error(self):
        self.ho_with(self.EMPTY_HO % "0000000000000000")
        with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
    def test_heldout_that_cannot_be_loaded_is_a_config_error_even_with_a_good_config(self):
        os.unlink(self.ho)
        with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
        self.ho_with("this is not python(")
        with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
    def test_nonempty_union_with_empty_or_missing_config_still_fails(self):
        for content in (None, '{"pairs": []}'):
            if content is None: os.unlink(self.blind)
            else: open(self.blind, "w").write(content)
            with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
    def test_dry_run_with_empty_union_includes_rows_from_the_formerly_blind_days(self):
        self.ho_with(self.EMPTY_HO % "f07171dcb708d080"); self.write([row("a", day="2026-09-28", room="room_bbbbbbbb"), row("b", day="2026-09-23", room="room_cccccccc"), row("c")]); o = f"{self.d}/out"
        err = io.StringIO(); out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err): rc = M.main(["--dry-run", o, "--index", self.idx, "--blind", self.blind, "--heldout", self.ho])
        self.assertEqual(rc, 0); self.assertIn('"blind": 0', out.getvalue()); self.assertIn("blind union empty", err.getvalue())
        self.assertEqual(sorted(json.loads(l)["consult_uid"] for l in open(f"{o}/consult/index/latest.jsonl")), ["a", "b", "c"])

class Config(Base):
    def test_blind_config_missing_empty_or_malformed_is_a_hard_error(self):
        self.write([row("a")])
        for content in (None, "", "{}", '{"pairs": []}', '{"pairs": [["2026-09-28"]]}', '{"pairs": [["2026-09-28", 5]]}', "not json", '{"pairs": "x"}'):
            if content is None: os.unlink(self.blind)
            else: open(self.blind, "w").write(content)
            with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
            out = f"{self.d}/out"; err = io.StringIO()
            with contextlib.redirect_stderr(err): self.assertEqual(M.main(["--dry-run", out, "--index", self.idx, "--blind", self.blind, "--heldout", self.ho]), 2)
            self.assertFalse(os.path.exists(out))
    def test_missing_index_is_exit_2(self):
        with contextlib.redirect_stderr(io.StringIO()): self.assertEqual(M.main(["--dry-run", f"{self.d}/o", "--index", f"{self.d}/none.jsonl", "--blind", self.blind, "--heldout", self.ho]), 2)
    def test_the_real_blind_file_matches_the_public_repo_constant(self):
        if not os.path.exists(M.BLIND_FILE): self.skipTest("no box config")
        d = json.load(open(M.BLIND_FILE)); self.assertEqual(len(d["pairs"]), 14); self.assertEqual(d["union_sha16"], "f07171dcb708d080")
        with contextlib.redirect_stderr(io.StringIO()): self.assertEqual(M.load_blind(), set())       # 10 Oct: the live heldout.py union is empty (marker f07171dc kept): nothing withheld, whatever the config file lists
    def test_no_blind_pair_is_hard_coded_in_the_tool(self):
        src = open(M.__file__).read(); self.assertNotIn("room_zzzzzzzz", src); self.assertNotIn("2026-09-28", src)

class DryRun(Base):
    def run_main(self, args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out): rc = M.main(args)
        return rc, out.getvalue()
    def test_dry_run_writes_both_files_prints_counts_and_touches_no_credential_or_network(self):
        self.write([row("a"), row("b", status="skipped", r2=None)]); o = f"{self.d}/out"
        with mock.patch.object(M, "r2_client", side_effect=AssertionError("credential/client used in dry-run")), mock.patch.object(M, "put_both", side_effect=AssertionError("PUT in dry-run")):
            rc, text = self.run_main(["--dry-run", o, "--index", self.idx, "--blind", self.blind, "--heldout", self.ho, "--cred", f"{self.d}/must-not-be-opened"])
        self.assertEqual(rc, 0); self.assertIn("rows 1", text); self.assertIn('"kept": 1', text)
        d = f"{o}/consult/index"; self.assertEqual(sorted(os.listdir(d)), ["latest.jsonl", "manifest.json"])
        self.assertEqual(stat.S_IMODE(os.stat(f"{d}/latest.jsonl").st_mode), 0o600); self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700)
        self.assertEqual(json.load(open(f"{d}/manifest.json"))["sha256"], hashlib.sha256(open(f"{d}/latest.jsonl", "rb").read()).hexdigest())
    def test_counts_line_has_numbers_only(self):
        self.write([row("a")]); _, text = self.run_main(["--dry-run", f"{self.d}/o", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho])
        c = json.loads(text.splitlines()[0].split("counts ", 1)[1]); self.assertTrue(all(isinstance(v, int) for v in c.values())); self.assertNotIn("a", text.replace("rows", "").replace("dry-run wrote", "").split("counts")[0])
    def test_must_pick_exactly_one_mode(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): M.main(["--index", self.idx])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): M.main(["--dry-run", "x", "--live"])
    def test_zero_rows_is_refused_unless_allowed(self):
        self.write([row("a", status="skipped", r2=None)])
        with contextlib.redirect_stderr(io.StringIO()): rc, _ = self.run_main(["--dry-run", f"{self.d}/o", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho])
        self.assertEqual(rc, 3); self.assertFalse(os.path.exists(f"{self.d}/o"))
        rc, _ = self.run_main(["--dry-run", f"{self.d}/o", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho, "--allow-empty"]); self.assertEqual(rc, 0)

class Fake:
    def __init__(self, fail_on=None): self.calls, self.fail_on = [], fail_on
    def put_object(self, **kw):
        if self.fail_on == len(self.calls) + 1: raise RuntimeError("boom (endpoint hidden)")
        self.calls.append(kw)

class Live(Base):
    def go(self, rows, client, extra=()):
        self.write(rows); err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err): rc = M.main(["--live", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho, *extra], client=client)
        return rc, err.getvalue()
    def test_two_puts_latest_first_then_manifest_with_matching_sha(self):
        f = Fake(); rc, _ = self.go([row("a"), row("b")], f); self.assertEqual(rc, 0)
        self.assertEqual([(c["Bucket"], c["Key"]) for c in f.calls], [("eta-lab-results", "consult/index/latest.jsonl"), ("eta-lab-results", "consult/index/manifest.json")])
        self.assertEqual(json.loads(f.calls[1]["Body"])["sha256"], hashlib.sha256(f.calls[0]["Body"]).hexdigest()); self.assertEqual(json.loads(f.calls[1]["Body"])["rows"], 2)
        self.assertEqual(len(f.calls), 2)                                               # single PUT each: no multipart, no retry loop
    def test_failed_first_put_means_the_manifest_is_not_written(self):
        f = Fake(fail_on=1); rc, err = self.go([row("a")], f); self.assertEqual((rc, f.calls), (4, [])); self.assertIn("UPLOAD FAILED", err); self.assertNotIn("endpoint", err)
    def test_failed_manifest_put_is_exit_4(self):
        f = Fake(fail_on=2); rc, _ = self.go([row("a")], f); self.assertEqual((rc, len(f.calls)), (4, 1))
    def test_zero_rows_makes_no_put(self):
        f = Fake(); rc, _ = self.go([row("a", status="skipped", r2=None)], f); self.assertEqual((rc, f.calls), (3, []))
    def test_bad_blind_config_makes_no_put(self):
        f = Fake(); os.unlink(self.blind); self.write([row("a")])
        with contextlib.redirect_stderr(io.StringIO()): rc = M.main(["--live", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho], client=f)
        self.assertEqual((rc, f.calls), (2, []))
    def test_missing_credential_file_is_exit_2_and_wrong_bucket_line_is_refused(self):
        rc, _ = self.go([row("a")], None, ["--cred", f"{self.d}/nope"]); self.assertEqual(rc, 2)
        cf = f"{self.d}/cred"; open(cf, "w").write("A\nB\nhttps://x\neta-audio\n"); rc, _ = self.go([row("a")], None, ["--cred", cf]); self.assertEqual(rc, 2)
        open(cf, "w").write("A\nB\n"); rc, _ = self.go([row("a")], None, ["--cred", cf]); self.assertEqual(rc, 2)
    def test_credential_constants_point_at_the_lab_results_write_key_and_bucket(self):
        self.assertTrue(M.CRED_FILE.endswith("/.config/consult-cutter/r2_lab_results_write")); self.assertEqual(M.BUCKET, "eta-lab-results"); self.assertEqual((M.KEY_LATEST, M.KEY_MANIFEST), ("consult/index/latest.jsonl", "consult/index/manifest.json"))

class NestedLeak(Base):
    """refuter must-fix 1: allowed values (signature, bytes, flags, ...) are copied whole, so the guard must look inside them, fail closed."""
    def test_nested_doctor_name_key_at_any_depth_and_any_case(self):
        self.refused([row("a", signature={"start": 1, "doctor_name": "x"})])
        self.refused([row("a", signature={"a": {"b": [{"Doctor_Name": 1}]}})])
        self.refused([row("a", bytes={"consult.flac": 1, "DOCTOR_NAME": 2})])
    def test_nested_path_key_relative_or_absolute(self):
        self.refused([row("a", bytes={"path": PATH})]); self.refused([row("a", bytes={"path": "2026-10-03/room/uid"})]); self.refused([row("a", signature=[{"x": {"PATH": 1}}])])
    def test_an_absolute_box_path_as_any_value_is_refused(self):
        self.refused([row("a", flags=[PATH])]); self.refused([row("a", flags=["/etc/x"])]); self.refused([row("a", quality="in /home/example/x")])
    def test_another_rows_doctor_name_inside_an_allowed_value(self):
        self.refused([row("a", doctor_name="Dr Alpha Firstdoc"), row("b", doctor_name="Dr Beta Seconddoc", flags=["note Dr Alpha Firstdoc here"])])
    def test_names_from_rows_that_are_not_cut_or_not_the_latest_still_count(self):
        self.refused([row("old", doctor_name="Dr Ghost Onlyinold"), row("old", doctor_name="Dr Other Newone"), row("b", status="skipped", r2=None, doctor_name="Dr Skip Skipped"), row("c", flags=["x dr skip skipped x"])])
        self.refused([row("old", doctor_name="Dr Ghost Onlyinold"), row("old", doctor_name="Dr Other Newone"), row("c", flags=["Dr Ghost Onlyinold"])])
    def test_name_with_quote_or_apostrophe_or_backslash_cannot_hide_in_json_escaping(self):
        for nm in ('Dr "Bob" Quoted', "Dr Neil O'Brien", "Dr Back\\slash Name", "Dr Ünï Cödé"):
            self.refused([row("a", doctor_name=nm), row("b", flags=["prefix " + nm + " suffix"])]); self.refused([row("a", doctor_name=nm, flags=[nm])])
    def test_case_and_spacing_do_not_hide_a_name(self):
        self.refused([row("a", doctor_name="Dr Alpha  Firstdoc", flags=["DR   alpha firstDOC"])])
    def test_a_clean_row_with_nested_values_passes(self):
        self.write([row("a", doctor_name="Dr Alpha Firstdoc"), row("b", doctor_name="Dr Beta Seconddoc")]); rows = M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")[2]; self.assertEqual(rows["kept"], 2)
    def test_the_guard_walks_decoded_strings_and_keys_directly(self):
        r = row("a", doctor_name='Dr "Q" Name'); p = M.project(r); p["flags"] = ['x Dr "Q" Name y']
        with self.assertRaises(AssertionError): M.leak_check([(r, p)], ['Dr "Q" Name'])
        M.leak_check([(r, M.project(r))], ['Dr "Q" Name'])

class Folding(Base):
    """refuter r2 must-fix 1: NFKD + casefold + every non-alphanumeric removed, on both sides."""
    NFC = "Dr Zoë Müller-Åkesson"
    def test_nfd_written_name_is_caught_whichever_form_is_stored(self):
        import unicodedata as u
        self.refused([row("a", doctor_name=u.normalize("NFC", self.NFC), flags=[u.normalize("NFD", self.NFC)])])
        self.refused([row("a", doctor_name=u.normalize("NFD", self.NFC), flags=[u.normalize("NFC", self.NFC)])])
        self.refused([row("a", doctor_name=self.NFC, flags=["Dr Zoe Muller-Akesson"])])                     # accents dropped entirely
    def test_underscore_joined_name(self): self.refused([row("a", doctor_name="Dr Xavier Yellow", flags=["dr_xavier_yellow"])])
    def test_hyphen_joined_name(self): self.refused([row("a", doctor_name="Dr Xavier Yellow", quality="x-dr-xavier-yellow-y")])
    def test_dot_joined_name(self): self.refused([row("a", doctor_name="Dr Xavier Yellow", signature={"k": "Dr.Xavier.Yellow"})])
    def test_mixed_separators_case_and_compat_forms(self):
        self.refused([row("a", doctor_name="Dr Xavier Yellow", flags=["DR / xavier _ . - YELLOW"])])
        self.refused([row("a", doctor_name="Dr Xavier Yellow", flags=["ＤＲ　Ｘａｖｉｅｒ　Ｙｅｌｌｏｗ"])])        # fullwidth (NFKD)
    def test_name_used_as_a_key_is_caught(self): self.refused([row("a", doctor_name="Dr Xavier Yellow", signature={"dr_xavier_yellow": 1})])
    def test_a_full_name_in_a_room_slug_is_not_let_through_by_the_slug_override(self):
        self.write([row("a", doctor_name="Dr Xavier Yellow", room_slug="opd-dr-xavier-yellow"), row("b")]); err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(M.main(["--dry-run", f"{self.d}/o", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho, "--accept-slug-names", "1"]), 6)
        self.assertFalse(os.path.exists(f"{self.d}/o")); self.assertNotIn("avier", err.getvalue())
    def test_the_three_char_floor_still_applies_on_the_folded_name(self):
        self.write([row("a", doctor_name="A.B", flags=["a b ab"]), row("b", doctor_name="Dr", flags=["dr"])]); self.assertEqual(M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")[2]["kept"], 2)
    def test_unrelated_text_is_not_a_false_positive(self):
        self.write([row("a", doctor_name="Dr Xavier Yellow", flags=["xavier", "yellow", "dr x", "start_at_previous_window_close"])]); self.assertEqual(M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")[2]["kept"], 1)

class TitleStripped(Base):
    """refuter r3 must-fix: the most likely real leak is the name WITHOUT its title; compare the title-stripped form too (5+ folded characters)."""
    def test_name_without_its_title_in_flags_quality_signature_and_keys(self):
        nm = "Dr Fixture Doctorname"
        for kw in (dict(flags=["Fixture Doctorname"]), dict(flags=["fixture-doctorname"]), dict(quality="fixture_doctorname"), dict(signature={"k": "Fixture.Doctorname"}), dict(signature={"fixture doctorname": 1}), dict(flags=["FIXTUREDOCTORNAME"])):
            self.refused([row("a", doctor_name=nm, **kw)])
    def test_every_leading_title_form_is_stripped(self):
        for nm in ("Dr. Fixture Doctorname", "DR FIXTURE DOCTORNAME", "Doctor Fixture Doctorname", "Prof Fixture Doctorname", "Prof. Dr. Fixture Doctorname", "Mr Fixture Doctorname", "Mrs. Fixture Doctorname", "Ms Fixture Doctorname", "Dr.Fixture Doctorname", "Dr  Dr Fixture Doctorname"):
            self.refused([row("a", doctor_name=nm, flags=["fixture doctorname"])])
    def test_the_full_form_is_still_compared(self):
        self.refused([row("a", doctor_name="Dr Fixture Doctorname", flags=["dr fixture doctorname"])])
    def test_a_title_in_the_middle_is_not_stripped_and_a_title_only_name_is_ignored(self):
        self.assertEqual(M.name_forms(["Fixture Dr Doctorname"]), {"fixturedrdoctorname"}); self.assertEqual(M.name_forms(["Dr", "Dr."]), set())
    def test_forms_floors_3_for_the_full_name_5_for_the_stripped_one(self):
        self.assertEqual(M.name_forms(["Dr Abcd"]), {"drabcd"})                       # stripped "abcd" (4) is below the floor
        self.assertEqual(M.name_forms(["Dr Abcde"]), {"drabcde", "abcde"})
        self.assertEqual(M.name_forms(["Abc"]), {"abc"}); self.assertEqual(M.name_forms(["Ab"]), set())
    def test_short_stripped_names_do_not_abort_on_random_ids(self):
        import random
        rnd = random.Random(7); alpha = "abcdefghijklmnopqrstuvwxyz0123456789"
        rows = [row("".join(rnd.choice(alpha) for _ in range(20)), r2="mirrored") for _ in range(300)]
        for r in rows: r["flags"] = ["".join(rnd.choice(alpha) for _ in range(20))]; r["window_id"] = rnd.randint(1, 10 ** 6)
        rows[0]["doctor_name"] = "Dr Xyz"; rows[1]["doctor_name"] = "Dr Qwer"          # stripped forms of 3 and 4 characters: below the floor, not compared
        self.write(rows); self.assertEqual(M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")[2]["kept"], 300)
    def test_a_name_with_title_that_leaks_with_title_only_is_still_caught(self):
        self.refused([row("a", doctor_name="Prof Fixture Doctorname", flags=["PROF. FIXTURE DOCTORNAME"])])
    def test_known_limits_are_not_detected_and_are_documented(self):
        # reversed order, a name split across two fields and look-alike (Cyrillic) letters are KNOWN LIMITS (need intent to produce); asserted so a future change is a conscious one
        self.write([row("a", doctor_name="Dr Fixture Doctorname", flags=["Doctorname Fixture"]), row("b", doctor_name="Dr Fixture Doctorname", flags=["Fixture"], quality="Doctorname"), row("c", doctor_name="Dr Fixture Doctorname", flags=["Fіxture Doctorname"])])
        self.assertEqual(M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")[2]["kept"], 3)

class KeyPaths(Base):
    """refuter r2 nit: any key containing path, or doctor name in camel case, at any depth."""
    def test_keys_containing_path_at_any_depth_and_case(self):
        for k in ("clip_path", "ClipPath", "audio-path", "pathname", "paths", "file.PATH.x", "doctorName", "Doctor-Name", "doctor name", "DOCTOR_NAME", "dr_name", "doctor_full_name", "name", "Name", "filename", "rename", "NAMES", "dr.name"):
            self.refused([row("a", bytes={"consult.flac": 1, k: "rel/x"})]); self.refused([row("a", signature={"o": [{"i": {k: 1}}]})])
    def test_no_allowlisted_field_is_removed_by_the_name_and_path_key_rule(self):
        for k in (*M.ALLOW, *M.R2_ALLOW, "consult.flac", "doctor.flac", "others.flac", "timeline.json", "cov", "day", "doctor", "end", "mode", "print", "room", "rule", "search_end", "start", "t_close"):
            fk = M.fold(k); self.assertFalse(any(w in fk for w in M.NEVER_KEY_PARTS), k)
        self.write([row("a")]); out = M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")[0]; self.assertEqual(set(json.loads(out)), set(M.ALLOW) - PQM_KEYS)      # every allowlisted field is still emitted (the three m3-17 keys only exist on PQM rows)
    def test_legit_nested_keys_of_the_real_index_are_not_blocked(self):
        self.write([row("a", signature={k: 1 for k in "cov day doctor end mode print room rule search_end start t_close".split()}, bytes={"consult.flac": 1, "doctor.flac": 2, "others.flac": 3, "timeline.json": 4})])
        self.assertEqual(M.build(self.idx, self.blind, heldout_py=self.ho, commit="x")[2]["kept"], 1)

class LeakExit(Base):
    def go(self, rows, mode):
        self.write(rows); f = Fake(); err, out = io.StringIO(), io.StringIO()
        args = ["--dry-run", f"{self.d}/o"] if mode == "dry" else ["--live"]
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out): rc = M.main([*args, "--index", self.idx, "--blind", self.blind, "--heldout", self.ho], client=f)
        return rc, out.getvalue() + err.getvalue(), f
    def test_a_leak_exits_6_with_a_message_and_no_content_nothing_written_no_put(self):
        rows = [row("a", doctor_name="Dr Secretname Leaky", flags=["Dr Secretname Leaky"])]
        for mode in ("dry", "live"):
            rc, text, f = self.go(rows, mode); self.assertEqual(rc, 6); self.assertIn("LEAK", text); self.assertNotIn("ecretname", text); self.assertNotIn("Traceback", text)
            self.assertEqual(f.calls, []); self.assertFalse(os.path.exists(f"{self.d}/o"))
    def test_every_guard_kind_maps_to_6(self):
        for r in (row("a", signature={"path": 1}), row("a", flags=["/etc/x"]), row("a", bytes={"clip_path": 1}), row("a", doctor_name="Dr Zed Ytterbium", flags=["dr_zed_ytterbium"])):
            self.assertEqual(self.go([r], "dry")[0], 6)
    def test_leak_error_is_an_assertion_error_and_exit_6_is_documented(self):
        self.assertTrue(issubclass(M.LeakError, AssertionError)); self.assertIn("6 the leak guard fired", M.__doc__)
    def test_clean_run_is_still_exit_0(self): self.assertEqual(self.go([row("a")], "dry")[0], 0)

class SlugGuard(Base):
    """nit 3: room_slug is kept by the spec; fail closed if it shares a token with any doctor_name, report the count only."""
    def go(self, rows, *extra):
        self.write(rows); err = io.StringIO(); out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err): rc = M.main(["--dry-run", f"{self.d}/o", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho, *extra])
        return rc, out.getvalue(), err.getvalue()
    def test_slug_with_a_name_token_is_refused_with_a_count_and_no_output(self):
        rc, out, err = self.go([row("a", doctor_name="Dr Fixture Whoever", room_slug="opd-5-dr-fixture-abcd"), row("b", room_slug="opd-5-dr-fixture-abcd"), row("c")])
        self.assertEqual(rc, 5); self.assertIn('"slug_name_rows": 2', out); self.assertFalse(os.path.exists(f"{self.d}/o")); self.assertNotIn("alanki", out + err)
    def test_accepting_exactly_that_count_is_the_leads_call_and_any_other_count_refuses(self):
        rows = [row("a", doctor_name="Dr Fixture Whoever", room_slug="opd-5-dr-fixture-abcd"), row("b", room_slug="opd-5-dr-fixture-abcd"), row("c")]
        self.assertEqual(self.go(rows, "--accept-slug-names", "2")[0], 0); self.assertEqual(self.go(rows, "--accept-slug-names", "1")[0], 5); self.assertEqual(self.go(rows, "--accept-slug-names", "3")[0], 5)
    def test_skip_env_overrides_only_the_slug_refusal(self):
        rows = [row("a", doctor_name="Dr Fixture Whoever", room_slug="opd-5-dr-fixture-abcd"), row("b", room_slug="opd-5-dr-fixture-abcd"), row("c")]
        with mock.patch.dict(os.environ, {"INDEX_MIRROR_SKIP_SLUG_GUARD": "1"}): rc, out, err = self.go(rows)
        self.assertEqual(rc, 0); self.assertIn('"slug_name_rows": 2', out); self.assertIn('"slug_guard_skipped": 1', out); self.assertNotIn("alanki", out + err)
        with mock.patch.dict(os.environ, {"INDEX_MIRROR_SKIP_SLUG_GUARD": "0"}): self.assertEqual(self.go(rows)[0], 5)
    def test_skip_env_does_not_bypass_the_leak_guard(self):
        with mock.patch.dict(os.environ, {"INDEX_MIRROR_SKIP_SLUG_GUARD": "1"}):
            rc, out, err = self.go([row("a", doctor_name="Dr Fixture Whoever", room_slug="opd-5-dr-fixture-whoever-abcd")])
        self.assertEqual(rc, 6); self.assertFalse(os.path.exists(f"{self.d}/o"))
    def test_titles_short_tokens_and_unrelated_slugs_do_not_match(self):
        rc, out, _ = self.go([row("a", doctor_name="Dr Al Bo", room_slug="opd-1-dr-abcd"), row("b", doctor_name="Doctor Zed", room_slug="doctor-opd")]); self.assertEqual(rc, 0); self.assertIn('"slug_name_rows": 0', out)
    def test_the_count_is_zero_on_the_clean_fixture_and_present_in_counts(self):
        rc, out, _ = self.go([row("a")]); self.assertEqual(rc, 0); self.assertIn("slug_name_rows", out)

class BlindSanity(Base):
    """refuter must-fix 2: a wrong-but-valid config must not silently mirror held-out room-days."""
    def bad(self, *pairs, sha="f07171dcb708d080"):
        self.cfg(*pairs, sha=sha)
        with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
    def test_reversed_pairs_are_refused(self): self.bad(["room_bbbbbbbb", "2026-09-28"], ["room_cccccccc", "2026-09-23"])
    def test_one_reversed_pair_among_good_ones_is_refused(self): self.bad(["2026-09-28", "room_bbbbbbbb"], ["room_cccccccc", "2026-09-23"])
    def test_bad_date_formats(self):
        for d in ("2026-9-28", "28-09-2026", "2026-13-45", "2026-02-30", "2026/09/28", "2026-09-28T00:00", " 2026-09-28", "2026-09-28\n"): self.bad([d, "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"])
    def test_bad_room_formats(self):
        for r in ("bbbbbbbb", "ROOM_bbbbbbbb", "room_", "room_bb bb", "opd-1", "room-bbbbbbbb"): self.bad(["2026-09-28", r], ["2026-09-23", "room_cccccccc"])
    def test_duplicate_pairs_are_refused(self): self.bad(["2026-09-28", "room_bbbbbbbb"], ["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"])
    def test_wrong_or_missing_union_sha_is_refused(self):
        self.bad(["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"], sha="0000000000000000"); self.bad(["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"], sha=None)
    def test_pairs_that_do_not_match_the_cutter_union_are_refused(self):
        self.bad(["2026-09-28", "room_bbbbbbbb"])                                                       # a pair missing
        self.bad(["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"], ["2026-09-24", "room_cccccccc"])      # an extra pair
        self.bad(["2026-09-29", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"])                      # a stale date
        self.bad(["2026-09-28", "room_dddddddd"], ["2026-09-23", "room_cccccccc"])                      # an unlabelled room
    def test_a_heldout_module_with_another_sha_or_missing_or_broken_is_refused(self):
        self.cfg(["2026-09-28", "room_bbbbbbbb"], ["2026-09-23", "room_cccccccc"])
        with open(self.ho, "w") as fh: fh.write(FAKE_HO.replace("f07171dcb708d080", "1111111111111111"))
        with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
        with open(self.ho, "w") as fh: fh.write("raise RuntimeError('x')\n")
        with self.assertRaises(M.ConfigError): M.load_blind(self.blind, self.ho)
        with self.assertRaises(M.ConfigError): M.load_blind(self.blind, f"{self.d}/none.py")
    def test_a_wrong_config_makes_main_exit_2_with_no_output_and_no_put(self):
        self.cfg(["room_bbbbbbbb", "2026-09-28"], ["room_cccccccc", "2026-09-23"]); self.write([row("a", day="2026-09-28", room="room_bbbbbbbb")]); f = Fake()
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(M.main(["--dry-run", f"{self.d}/o", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho]), 2)
            self.assertEqual(M.main(["--live", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho], client=f), 2)
        self.assertFalse(os.path.exists(f"{self.d}/o")); self.assertEqual(f.calls, [])
    def test_room_format_is_checked_on_its_own_even_if_the_union_would_agree(self):
        with open(self.ho, "w") as fh: fh.write('LABEL = {"BAD room": "OPDB", "room_cccccccc": "OPDC"}\ndef load_union(): return {"2026-09-28 OPDB", "2026-09-23 OPDC"}, "f07171dcb708d080"\n')
        self.bad(["2026-09-28", "BAD room"], ["2026-09-23", "room_cccccccc"])
    def test_the_good_config_still_loads(self): self.assertEqual(M.load_blind(self.blind, self.ho), {("2026-09-28", "room_bbbbbbbb"), ("2026-09-23", "room_cccccccc")})

class CodeCommit(Base):
    def test_unknown_code_commit_fails_closed_with_no_output_and_no_put(self):
        self.write([row("a")]); f = Fake(); err = io.StringIO()
        with mock.patch.object(M, "code_commit", return_value=None), contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(M.main(["--dry-run", f"{self.d}/o", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho]), 2)
            self.assertEqual(M.main(["--live", "--index", self.idx, "--blind", self.blind, "--heldout", self.ho], client=f), 2)
        self.assertIn("code_commit", err.getvalue()); self.assertFalse(os.path.exists(f"{self.d}/o")); self.assertEqual(f.calls, [])
    def test_empty_string_commit_is_unknown_too(self):
        self.write([row("a")])
        with mock.patch.object(M, "code_commit", return_value=""), self.assertRaises(M.ConfigError): M.build(self.idx, self.blind, heldout_py=self.ho)
    def test_a_known_commit_lands_in_the_manifest_and_the_real_one_is_not_null(self):
        self.write([row("a")]); self.assertEqual(json.loads(M.build(self.idx, self.blind, heldout_py=self.ho, commit="abc1234")[1])["code_commit"], "abc1234")
        self.assertRegex(M.code_commit() or "", r"^[0-9a-f]{7,}$")

@unittest.skipUnless(os.environ.get("CUTTER_LIVE_TESTS") == "1" and os.path.exists(M.INDEX) and os.path.exists(M.BLIND_FILE), "real index / blind config not on this machine")
class RealIndex(unittest.TestCase):
    def test_no_doctor_name_or_box_path_of_the_real_index_reaches_the_output(self):
        latest, man, c = M.build()
        rows = [json.loads(l) for l in open(M.INDEX) if l.strip().startswith("{")]
        text = latest.decode() + man.decode()
        for r in rows:
            v = r.get("doctor_name")
            if isinstance(v, str) and len(v) >= 4: self.assertNotIn(v, text, "doctor_name")
            v = r.get("path")
            if isinstance(v, str) and v.startswith("/"): self.assertNotIn(v, text, "path")      # the index path is relative (the tail of r2.prefix, kept by the spec); an absolute box path must never appear
        self.assertNotIn(os.path.expanduser("~"), text); self.assertNotIn('"path"', text); self.assertNotIn('"doctor_name"', text)
        for ln in latest.decode().splitlines(): self.assertEqual(set(json.loads(ln)) - set(M.ALLOW), set())
        blind = M.load_blind()
        for ln in latest.decode().splitlines(): j = json.loads(ln); self.assertNotIn((j["ist_date"], j["room_id"]), blind); self.assertEqual(j["r2"].keys() - set(M.R2_ALLOW), set())
        self.assertEqual(c["kept"], len(latest.decode().splitlines()))

if __name__ == "__main__": unittest.main()
