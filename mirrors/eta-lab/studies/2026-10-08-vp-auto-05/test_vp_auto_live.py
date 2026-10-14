import base64, hashlib, json, os, shutil, sys, tempfile, unittest
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "2026-10-08-vp-acc"))
import prints_store as PS, vp_auto_live as L
REAL_PROV = os.path.expanduser("~/eta-data/consult/prints-provisional-06oct.json"); PIN = "68a719eac7aad1aaf281df2187f0e9f9404c7dc03110bd9107386ec61a744ad4"
rng = np.random.default_rng(5)
unit = lambda v: v / np.linalg.norm(v)
b64 = lambda v: base64.b64encode(np.asarray(v, dtype=np.float32).tobytes()).decode()
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

def human(uid, vec, name="Dr H"): return dict(doctor_uid=uid, display_name=name, centroid_192_l2=[float(x) for x in vec], status="provisional", evidence="V-ear")
def auto(uid, vec): return dict(doctor_uid=uid, display_name="Dr A", centroid_192_l2=[float(x) for x in vec], status="auto_live", minted_by="vp-auto")

class StoreBase(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="vpa_"); self.addCleanup(shutil.rmtree, self.d, True)
        self.h = human("H1aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192)))
        open(f"{self.d}/{PS.PROVISIONAL}", "w").write(json.dumps(dict(note="n", prints=[self.h]), indent=1))

class Store(StoreBase):
    def test_v001_is_byte_identical_and_the_provisional_file_is_untouched(self):
        s0 = sha(f"{self.d}/{PS.PROVISIONAL}"); r = PS.init(self.d)
        self.assertEqual((r["did"], r["version"]), ("init", 1)); self.assertEqual(sha(f"{self.d}/prints-live-v001.json"), s0); self.assertEqual(sha(f"{self.d}/{PS.PROVISIONAL}"), s0)
        self.assertTrue(os.path.islink(f"{self.d}/{PS.POINTER}")); self.assertEqual(PS.current(self.d)[0], 1)
        with self.assertRaises(SystemExit): PS.init(self.d)                                                                        # F6: never again once a pointer exists
        self.assertEqual(oct(os.stat(f"{self.d}/prints-live-v001.json").st_mode & 0o777), "0o600")
    def test_R1_add_only_an_existing_doctor_is_never_changed(self):
        PS.init(self.d); v1 = sha(f"{self.d}/prints-live-v001.json")
        self.assertIsNone(PS.add_prints([auto("H1aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192)))], self.d)); self.assertEqual(PS.current(self.d)[0], 1)        # nothing new -> no version
        n = PS.add_prints([auto("H1aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192))), auto("N1aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192)))], self.d); self.assertEqual(n, 2)
        doc = json.load(open(PS.current(self.d)[1])); byuid = {x["doctor_uid"]: x for x in doc["prints"]}
        self.assertEqual(byuid["H1aaaaaaaaaaaaaaaaaa"], self.h); self.assertEqual(byuid["N1aaaaaaaaaaaaaaaaaa"]["minted_by"], "vp-auto"); self.assertEqual(sha(f"{self.d}/prints-live-v001.json"), v1)           # H1 untouched, v001 untouched
        self.assertEqual(doc["parent_sha256"], v1)
        with self.assertRaises(ValueError): PS.add_prints([dict(doctor_uid="X", centroid_192_l2=[0.0])], self.d)
    def test_R4_rollback_removes_one_auto_print_and_refuses_a_human_one(self):
        PS.init(self.d); PS.add_prints([auto("N1aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192))), auto("N2aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192)))], self.d)
        with self.assertRaises(SystemExit): PS.rollback("H1aaaaaaaaaaaaaaaaaa", self.d)
        n = PS.rollback("N1aaaaaaaaaaaaaaaaaa", self.d); self.assertEqual(n, 3); self.assertEqual({x["doctor_uid"] for x in json.load(open(PS.current(self.d)[1]))["prints"]}, {"H1aaaaaaaaaaaaaaaaaa", "N2aaaaaaaaaaaaaaaaaa"})
        self.assertEqual(PS.versions(self.d), [1, 2, 3]); self.assertEqual(PS.current(self.d)[0], 3)
        self.assertEqual([json.loads(l)["event"] for l in open(f"{self.d}/{PS.AUDIT}")], ["init", "add", "rollback"])
        with self.assertRaises(SystemExit): PS.rollback("N1aaaaaaaaaaaaaaaaaa", self.d)
    def test_a_version_file_is_never_overwritten(self):
        PS.init(self.d)
        with self.assertRaises(FileExistsError): PS.write_new_version(self.d, 1, b"x")
    def test_the_vp_acc_pinned_file_sha_is_unchanged_by_the_store(self):
        if not os.path.exists(REAL_PROV): self.skipTest("no box file")
        self.assertEqual(sha(REAL_PROV), PIN)                                                                                       # R2: still the pinned bytes

def make_clips(root, docs, days=("2026-10-06", "2026-10-07", "2026-10-08"), per_day=2, names=None, append=False):
    """docs {uid: unit vec}; every clip: the doctor cluster (noisy copy of the vec, 60 s) + one random other-speaker cluster."""
    idx = open(f"{root}/index.jsonl", "a" if append else "w"); n = 0
    for uid, vec in docs.items():
        for day in days:
            for k in range(per_day):
                cid = f"{uid.strip()[:6]}{abs(hash(uid)) % 10**6}-{day}-{k}"; n += 1; rel = f"{day}/opd-1/{cid}"; os.makedirs(f"{root}/{rel}")
                emb = lambda v: b64(unit(v + 0.15 * unit(rng.normal(size=192))))
                tl = dict(consult_uid=cid, window=dict(quality="clean"), doctor=dict(uid=uid, name=(names or {}).get(uid, f"Dr {uid}"), source="warehouse_doctor_uid"),
                          clusters={"S0": dict(sec=60.0, emb_b64=emb(vec)), "S1": dict(sec=30.0, emb_b64=b64(unit(rng.normal(size=192))))}, turns=[dict(cluster="S0", start_s=0.0, end_s=60.0), dict(cluster="S1", start_s=60.0, end_s=90.0)])
                json.dump(tl, open(f"{root}/{rel}/timeline.json", "w"))
                idx.write(json.dumps(dict(consult_uid=cid, status="cut", path=rel, ist_date=day, room_slug="opd-1", span_start=f"{day}T10:00:00+05:30", span_end=f"{day}T10:20:00+05:30", voice_isolated=False)) + "\n")
    idx.close()

class RunJob(StoreBase):
    def setUp(self):
        super().setUp(); self.clips = tempfile.mkdtemp(prefix="vpc_"); self.runs = tempfile.mkdtemp(prefix="vpr_"); 
        self.addCleanup(shutil.rmtree, self.clips, True); self.addCleanup(shutil.rmtree, self.runs, True)
        self.hv = unit(rng.normal(size=192)); self.nv = unit(rng.normal(size=192)); self.h["centroid_192_l2"] = [float(x) for x in self.hv]
        open(f"{self.d}/{PS.PROVISIONAL}", "w").write(json.dumps(dict(note="n", prints=[self.h]), indent=1)); PS.init(self.d)
        make_clips(self.clips, {"H1aaaaaaaaaaaaaaaaaa": self.hv, "N1aaaaaaaaaaaaaaaaaa": self.nv})
        self.refs = lambda: ([], {"H1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N"), "N1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N")}); self.f0 = lambda items: (120.0, 40.0)
    def go(self, **kw): return L.run(d=self.d, clips=self.clips, runs=self.runs, f0_fn=self.f0, load_refs=self.refs, date="2026-10-08", **kw)
    def test_dry_run_lists_what_would_be_minted_and_changes_nothing(self):
        before = sha(PS.current(self.d)[1]); o = self.go(dry=True)
        self.assertTrue(o["dry_run"]); self.assertEqual([m["doctor_uid"] for m in o["minted"]], ["N1aaaaaaaaaaaaaaaaaa"]); self.assertEqual([x["doctor_uid"] for x in o["already_has_print_reported_only"]], ["H1aaaaaaaaaaaaaaaaaa"]); self.assertEqual(o["routes"]["N1aaaaaaaaaaaaaaaaaa"]["route"], "AUTO")
        self.assertEqual(PS.versions(self.d), [1]); self.assertEqual(sha(PS.current(self.d)[1]), before); self.assertTrue(json.load(open(f"{self.runs}/2026-10-08-dry.json"))["dry_run"])
        self.assertEqual(oct(os.stat(f"{self.runs}/2026-10-08-dry.json").st_mode & 0o777), "0o600")
    def test_real_run_mints_only_the_doctor_without_a_print_with_provenance(self):
        o = self.go(dry=False); self.assertEqual(o["live_version_after"], 2); doc = json.load(open(PS.current(self.d)[1])); byuid = {x["doctor_uid"]: x for x in doc["prints"]}
        self.assertEqual(byuid["H1aaaaaaaaaaaaaaaaaa"], self.h); n1 = byuid["N1aaaaaaaaaaaaaaaaaa"]
        for k in ("minted_by", "gates", "route", "window_ids", "clip_spans", "mint_date", "code_commit"): self.assertIn(k, n1)
        self.assertEqual((n1["minted_by"], n1["route"], n1["mint_date"]), ("vp-auto", "AUTO", "2026-10-08")); self.assertEqual(len(n1["window_ids"]), 6); self.assertGreater(float(np.dot(unit(np.array(n1["centroid_192_l2"])), self.nv)), 0.9)
        self.assertIn("vp-auto-05 2026-10-08:", o["summary"]); self.assertNotIn("Dr ", o["summary"])
        o2 = self.go(dry=False); self.assertEqual((o2["minted"], o2["live_version_after"]), ([], 2))                                  # second run: nothing new, no version
    def test_voice_isolated_multi_doctor_and_unembedded_clips_are_not_used_and_counted(self):
        idx = [json.loads(l) for l in open(f"{self.clips}/index.jsonl")]; idx[0]["voice_isolated"] = True
        tl = f"{self.clips}/{idx[1]['path']}/timeline.json"; t = json.load(open(tl)); t["window"]["quality"] = "multi_doctor"; json.dump(t, open(tl, "w"))
        tl = f"{self.clips}/{idx[2]['path']}/timeline.json"; t = json.load(open(tl)); t["clusters"] = {k: dict(sec=v["sec"]) for k, v in t["clusters"].items()}; json.dump(t, open(tl, "w"))
        open(f"{self.clips}/index.jsonl", "w").write("".join(json.dumps(r) + "\n" for r in idx)); o = self.go(dry=True)
        self.assertEqual(o["skipped_clips"], {"voice_isolated": 1, "multi_doctor": 1, "no_embeddings": 1})
    def test_a_doctor_with_a_sex_contradiction_is_not_minted(self):
        self.f0 = lambda items: (220.0, 40.0); o = self.go(dry=False); self.assertEqual(o["routes"]["N1aaaaaaaaaaaaaaaaaa"]["route"], "REJECT"); self.assertEqual(o["minted"], []); self.assertEqual(PS.versions(self.d), [1])


    # ---- vp-auto-05b
    def mint_with(self, sx, f0):
        self.refs = lambda: ([], sx); self.f0 = f0; return self.go(dry=False)
    def test_F1_a_mint_needs_G_sex_PASS_missing_uncertain_or_no_F0_go_to_EAR(self):
        for label, sx, f0 in (("name sex missing", {"H1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N")}, lambda items: (220.0, 40.0)),
                              ("name sex uncertain", {"H1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N"), "N1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="Y")}, lambda items: (120.0, 40.0)),
                              ("no usable F0", {"H1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N"), "N1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N")}, lambda items: (None, 0.0))):
            o = self.mint_with(sx, f0); r = o["routes"]["N1aaaaaaaaaaaaaaaaaa"]
            self.assertEqual((r["route"], o["minted"], PS.versions(self.d)), ("EAR", [], [1]), label); self.assertIn("G-sex not PASS", r["why"], label)
        o = self.mint_with({"H1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N"), "N1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N")}, lambda items: (120.0, 40.0)); self.assertEqual([m["doctor_uid"] for m in o["minted"]], ["N1aaaaaaaaaaaaaaaaaa"])        # known sex + agreeing F0 still mints
    def test_F3_a_doctor_with_a_production_print_is_reported_never_minted(self):
        uid = L.PRODUID["Ankit"]; make_clips(self.clips, {uid: unit(rng.normal(size=192))}); prod = [dict(name="Dr Ankit P Bhojani", v=unit(rng.normal(size=192)))]
        self.refs = lambda: (prod, {uid: dict(sex="M", uncertain="N"), "H1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N"), "N1aaaaaaaaaaaaaaaaaa": dict(sex="M", uncertain="N")}); o = self.go(dry=False)
        self.assertNotIn(uid, [m["doctor_uid"] for m in o["minted"]]); self.assertIn(dict(doctor_uid=uid, print_sources=["production"]), o["already_has_print_reported_only"]); self.assertEqual(o["routes"][uid]["print_sources"], ["production"])
    def test_F3_the_provisional_file_counts_too_and_all_prints_are_in_the_comparison(self):
        o = self.go(dry=True); self.assertEqual(o["routes"]["H1aaaaaaaaaaaaaaaaaa"]["print_sources"], ["live", "provisional"]); self.assertEqual(o["routes"]["N1aaaaaaaaaaaaaaaaaa"]["print_sources"], [])
    def test_F7_the_job_takes_no_gpu_lock(self):
        import inspect; self.assertNotIn("lock", " ".join(inspect.signature(L.run).parameters)); self.assertFalse(hasattr(L, "acquire_lock"))

class StoreHardening(StoreBase):
    def test_F4_uids_are_normalised_and_must_be_warehouse_uids(self):
        PS.init(self.d); v = unit(rng.normal(size=192))
        for bad in (" N1", "N1 ", ""):
            with self.assertRaises(ValueError): PS.add_prints([auto(bad, v)], self.d)
        with self.assertRaises(ValueError): PS.add_prints([auto("N9aaaaaaaaaaaaaaaaaa", v)], self.d, known_uids={"N1aaaaaaaaaaaaaaaaaa"})
        self.assertIsNone(PS.add_prints([auto("h1aaaaaaaaaaaaaaaaaa", v)], self.d, known_uids={"h1aaaaaaaaaaaaaaaaaa"}))                                              # same uid ignoring case as a human print: refused (no version)
        self.assertEqual(PS.versions(self.d), [1])
    def test_F6_init_refuses_with_a_dangling_pointer_and_never_repoints(self):
        PS.init(self.d); PS.add_prints([auto("N1aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192)))], self.d); os.remove(f"{self.d}/prints-live-v002.json")
        with self.assertRaises(SystemExit): PS.init(self.d)
        self.assertEqual(os.readlink(f"{self.d}/{PS.POINTER}"), "prints-live-v002.json")                                           # untouched
    def test_F5_an_orphaned_or_half_written_version_is_moved_aside_and_the_store_continues(self):
        PS.init(self.d); open(f"{self.d}/prints-live-v002.json", "w").write('{"prints": [')                                        # crash after writing v002, before the swap
        n = PS.add_prints([auto("N1aaaaaaaaaaaaaaaaaa", unit(rng.normal(size=192)))], self.d); self.assertEqual(n, 2)
        self.assertEqual(len(os.listdir(f"{self.d}/_to_delete")), 1); self.assertEqual({x["doctor_uid"] for x in json.load(open(PS.current(self.d)[1]))["prints"]}, {"H1aaaaaaaaaaaaaaaaaa", "N1aaaaaaaaaaaaaaaaaa"})
        open(f"{self.d}/prints-live-v003.json", "w").write("x"); self.assertEqual(PS.rollback("N1aaaaaaaaaaaaaaaaaa", self.d), 3); self.assertEqual(len(os.listdir(f"{self.d}/_to_delete")), 2)
        self.assertIn("orphan_moved_aside", [json.loads(l)["event"] for l in open(f"{self.d}/{PS.AUDIT}")])



class Hardening05c(RunJob):
    def sx_all(self, *uids): return {u: dict(sex="M", uncertain="N") for u in uids}
    def test_N1_a_name_matching_an_unmapped_or_differently_mapped_production_print_fails_closed(self):
        dg = "Dg" + "a" * 18; an = "f092iDIAfwXKtLCqP8HS"                                                              # an = the mapped Ankit uid with a lower-case first letter
        make_clips(self.clips, {dg: unit(rng.normal(size=192)), an: unit(rng.normal(size=192))}, names={dg: "Dr Darshan Gowda", an: "Ankit P Bhojani"}, append=True)
        prod = [dict(name="Darshan Gowda", v=unit(rng.normal(size=192))), dict(name="Ankit Bhojani", v=unit(rng.normal(size=192)))]
        self.refs = lambda: (prod, self.sx_all("H1" + "a" * 18, "N1" + "a" * 18, dg, an)); o = self.go(dry=False)
        self.assertNotIn(dg, [m["doctor_uid"] for m in o["minted"]]); self.assertNotIn(an, [m["doctor_uid"] for m in o["minted"]])
        self.assertTrue(o["routes"][dg]["has_print"] and any(x.startswith("unverified:") and "unmapped" in x for x in o["routes"][dg]["print_sources"]))
        self.assertTrue(any("ignoring case" in x for x in o["routes"][an]["print_sources"]))
        self.assertEqual(o["minted"], []); self.assertEqual(o["unmapped_production_print"], ["Darshan Gowda"]); self.assertIn("N1" + "a" * 18, o["mint_blocked_for"])         # L1: an unmapped production print holds every mint
    def test_N1_the_exact_mapped_uid_is_a_normal_production_source(self):
        an = L.PRODUID["Ankit"]; make_clips(self.clips, {an: unit(rng.normal(size=192))}, names={an: "Dr Ankit P Bhojani"}, append=True)
        self.refs = lambda: ([dict(name="Ankit Bhojani", v=unit(rng.normal(size=192)))], self.sx_all("H1" + "a" * 18, "N1" + "a" * 18, an)); o = self.go(dry=True)
        self.assertEqual(o["routes"][an]["print_sources"], ["production"])
    def test_N2_a_malformed_uid_skips_that_doctor_and_the_run_goes_on(self):
        bad = ["N3" + "a" * 18 + "\u200b", " N4" + "a" * 17, "short"]
        make_clips(self.clips, {b: unit(rng.normal(size=192)) for b in bad}, append=True)
        o = self.go(dry=False); self.assertEqual([m["doctor_uid"] for m in o["minted"]], ["N1" + "a" * 18]); self.assertEqual(o["skipped_clips"]["bad_uid"], 18)
        self.assertEqual(len([k for k in o["refused"]]), 3); self.assertTrue(all("20 ASCII" in v for v in o["refused"].values()))
        self.assertEqual(PS.versions(self.d), [1, 2])
    def test_N6_refused_mints_are_recorded_and_the_minted_list_is_what_was_written(self):
        v = unit(rng.normal(size=192)); r = PS.add_prints_report([auto("h1" + "a" * 18, v), auto("N5" + "a" * 18, v), auto("zz", v)], self.d)
        self.assertEqual((r["version"], r["added"]), (2, ["N5" + "a" * 18])); self.assertEqual(set(r["refused"]), {"h1" + "a" * 18, "zz"}); self.assertIn("already has a print", r["refused"]["h1" + "a" * 18])
        self.assertEqual(PS.add_prints_report([auto("h1" + "a" * 18, v)], self.d), dict(version=None, added=[], refused={"h1" + "a" * 18: r["refused"]["h1" + "a" * 18]}))
        o = self.go(dry=True); self.assertIn("refused", o); self.assertIn("refused 0", o["summary"])


class Alerts(unittest.TestCase):
    def test_N5_a_failing_daily_run_appends_an_alert_line_and_the_alert_mode_works(self):
        from unittest import mock
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); sp = f"{d}/ALERTS.jsonl"
        with mock.patch.object(L, "ALERTS", sp), mock.patch.object(L, "run", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError): L.main([])
            L.main(["--alert", "ALERT vp-auto-daily.service failed"])
        rows = [json.loads(l) for l in open(sp)]; self.assertEqual([r["source"] for r in rows], ["vp-auto-daily", "systemd"]); self.assertIn("RuntimeError: boom", rows[0]["alert"]); self.assertEqual(oct(os.stat(sp).st_mode & 0o777), "0o600")


class Hardening05cL(RunJob):
    def test_L1_while_any_production_print_is_unmapped_nothing_is_minted_and_it_is_reported(self):
        prod = [dict(name="Vinay Bhardwaj", v=unit(rng.normal(size=192)))]
        self.refs = lambda: (prod, {"H1" + "a" * 18: dict(sex="M", uncertain="N"), "N1" + "a" * 18: dict(sex="M", uncertain="N")}); o = self.go(dry=False)
        self.assertEqual((o["minted"], PS.versions(self.d)), ([], [1])); self.assertEqual(o["unmapped_production_print"], ["Vinay Bhardwaj"]); self.assertEqual(o["mint_blocked_for"], ["N1" + "a" * 18]); self.assertIn("MINT BLOCKED unmapped_production_print", o["summary"])
        self.assertIsNone(L.PRODUID["Vinay"]); self.assertIsNone(L.PRODUID["Darshan"])                                       # explicit, visible entries
        self.refs = lambda: ([], {"H1" + "a" * 18: dict(sex="M", uncertain="N"), "N1" + "a" * 18: dict(sex="M", uncertain="N")}); o = self.go(dry=False); self.assertEqual([m["doctor_uid"] for m in o["minted"]], ["N1" + "a" * 18])      # all mapped: mints as before
    def test_L2_two_new_doctors_whose_uids_differ_only_in_case_both_go_to_EAR_none_minted(self):
        a, b = "Zq" + "a" * 18, "zQ" + "a" * 18
        make_clips(self.clips, {a: unit(rng.normal(size=192)), b: unit(rng.normal(size=192))}, append=True)
        self.refs = lambda: ([], {u: dict(sex="M", uncertain="N") for u in ("H1" + "a" * 18, "N1" + "a" * 18, a, b)}); o = self.go(dry=False)
        self.assertEqual((o["routes"][a]["route"], o["routes"][b]["route"]), ("EAR", "EAR")); self.assertIn("collides case-insensitively", o["routes"][a]["why"]); self.assertEqual([m["doctor_uid"] for m in o["minted"]], ["N1" + "a" * 18])

if __name__ == "__main__": unittest.main()
