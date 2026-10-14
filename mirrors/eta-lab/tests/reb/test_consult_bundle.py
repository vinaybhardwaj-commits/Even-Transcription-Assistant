import contextlib
import io
import json
import os
import stat
import tempfile
import unittest

from kit.reb import consult_bundle as cb
from tests.reb.test_export_consult_audit import Store, seg


def put(s, d, layer, engine, version, segs=(), extras=None, config=None, status="ok", fin="2026-10-10T10:00:00Z", mtime=None, text_marker=None):
    """Like Store.track, but also sets config and returns the manifest-relative path; mtime pins the file's mtime."""
    s.track(d, layer, engine, version, list(segs), extras, status, fin)
    m = json.load(open(os.path.join(d, "manifest.json")))
    rel = m["tracks"][-1]["path"]
    full = os.path.join(s.root, rel)
    body = json.load(open(full))
    if config is not None:
        body["config"] = config
    json.dump(body, open(full, "w"))
    if mtime is not None:
        os.utime(full, (mtime, mtime))
    return rel


class T(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.s = Store(self._td.name)

    def b(self, uid):
        self.s.flush()
        return cb.bundle(uid, root=self.s.root, index=self.s.index, caa_path=self.s.caa)

    def test_all_slots_and_missing_null(self):
        d = self.s.scope("u1")
        paths = {}
        paths["stt"] = put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "t")])
        paths["translate"] = put(self.s, d, "translate", "sarvam-saaras-v3", "v1")
        paths["diar_sarvam"] = put(self.s, d, "diar", "sarvam-saaras-v3", "v1")
        paths["diar_nemotron"] = put(self.s, d, "diar", "nemotron", "v1")
        paths["role_llm"] = put(self.s, d, "role", "llm-roles", "v1")
        paths["role_judge"] = put(self.s, d, "role", "text-judge", "v1")
        paths["acoustics"] = put(self.s, d, "acoustics", "room_profile_acoustics", "v1")
        self.s.cut_row("u1", 1, 2)
        b = self.b("u1")
        self.assertEqual((b["consult_uid"], b["source"], b["scope_path"]), ("u1", "cutter", "2026-10-10/room_aaaaaaaa/_consults/u1"))
        self.assertEqual(b["cutter_row"]["doctor_uid"], "DOC1")
        self.assertEqual(b["manifest"]["window_id"], "consult-u1")
        for slot, p in paths.items():
            self.assertEqual(b["tracks"][slot]["path"], p)
        self.assertEqual(b["tracks"]["stt"]["track"]["segments"][0]["text"], "t")   # the stored JSON, untransformed
        self.assertIsNone(b["tracks"]["role_caa"])
        self.assertIsNone(b["tracks"]["parts"])

    def test_status_ok_only_and_newest_by_created_at_then_mtime(self):
        d = self.s.scope("u2")
        put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "old")], {"created_at": "2026-10-10T08:00:00Z"})
        new = put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "new")], {"created_at": "2026-10-10T09:00:00Z"}, fin="2026-10-10T01:00:00Z")   # finished_at older: created_at rules
        put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "bad")], {"created_at": "2026-10-10T12:00:00Z"}, status="failed")
        put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "empty")], {"created_at": "2026-10-10T13:00:00Z"}, status="empty")
        # no created_at: the mtime (2026-10-11) decides between these two
        a = put(self.s, d, "diar", "nemotron", "v1", extras=None, mtime=1791900000)
        z = put(self.s, d, "diar", "nemotron", "v2", extras=None, mtime=1791800000)
        self.s.cut_row("u2", 1, 2)
        b = self.b("u2")
        self.assertEqual(b["tracks"]["stt"]["path"], new)
        self.assertEqual(b["tracks"]["diar_nemotron"]["path"], a)
        self.assertNotEqual(b["tracks"]["diar_nemotron"]["path"], z)

    def test_cutter_never_caa_version_but_caa_consult_may(self):
        d = self.s.scope("u3")
        put(self.s, d, "stt", "sarvam-saaras-v3", "caa", [seg(1, 2, "caa")], {"created_at": "2026-10-10T23:00:00Z"})
        v1 = put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "mine")], {"created_at": "2026-10-10T01:00:00Z"})
        put(self.s, d, "role", "caa-labels", "caa")
        self.s.cut_row("u3", 1, 2)
        b = self.b("u3")
        self.assertEqual(b["tracks"]["stt"]["path"], v1)
        self.assertIsNone(b["tracks"]["role_caa"])
        d2 = self.s.scope("c1", date="2026-09-10")
        c = put(self.s, d2, "stt", "sarvam-saaras-v3", "caa", [seg(1, 2, "x")])
        r = put(self.s, d2, "role", "caa-labels", "caa")
        tr = put(self.s, d2, "translate", "sarvam-mayura-v1", "caa")
        self.s.caa_rows.append({"consult_uid": "c1", "room": "OPD 1", "doctor_uid": "D", "t0_utc_ms": "1", "t1_utc_ms": "2", "sarvam_done": "y"})
        b = self.b("c1")
        self.assertEqual((b["source"], b["cutter_row"]), ("caa", None))
        self.assertEqual((b["tracks"]["stt"]["path"], b["tracks"]["role_caa"]["path"], b["tracks"]["translate"]["path"]), (c, r, tr))

    def test_unparseable_track_skipped_and_counted(self):
        d = self.s.scope("bj")
        good = put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "ok")], {"created_at": "2026-10-10T08:00:00Z"})
        bad = put(self.s, d, "stt", "sarvam-saaras-v3", "v2", [seg(1, 2, "x")], {"created_at": "2026-10-10T09:00:00Z"})
        put(self.s, d, "acoustics", "room_profile_acoustics", "v1")
        open(os.path.join(self.s.root, bad), "w").write("[1, 2")
        open(os.path.join(self.s.root, [e for e in json.load(open(os.path.join(d, "manifest.json")))["tracks"] if e["layer"] == "acoustics"][0]["path"]), "w").write("[]")   # valid JSON, not an object
        self.s.cut_row("bj", 1, 2)
        b = self.b("bj")
        self.assertEqual(b["tracks"]["stt"]["path"], good)
        self.assertIsNone(b["tracks"]["acoustics"])
        self.assertEqual(b["unparseable_tracks"], 2)
        self.assertEqual(cb.counts(b)["unparseable_tracks"], 2)

    def test_parts_only_clef_plus_jev(self):
        d = self.s.scope("u4")
        put(self.s, d, "parts", "clef-jev", "v0-provisional", config={"clef_mode": "jev-only"}, extras={"created_at": "2026-10-10T20:00:00Z"})
        good = put(self.s, d, "parts", "clef-jev", "v0-provisional", config={"clef_mode": "clef+jev"}, extras={"created_at": "2026-10-10T10:00:00Z"})
        self.s.cut_row("u4", 1, 2)
        self.assertEqual(self.b("u4")["tracks"]["parts"]["path"], good)
        d = self.s.scope("u5")
        put(self.s, d, "parts", "clef-jev", "v0-provisional", config={"clef_mode": "jev-only"})
        self.s.cut_row("u5", 1, 2)
        self.assertIsNone(self.b("u5")["tracks"]["parts"])

    def test_refuses_unknown_and_ambiguous(self):
        self.s.scope("a1", date="2026-10-10")
        self.s.scope("a1", date="2026-10-11")
        self.s.cut_row("a1", 1, 2, date="2026-10-12")
        self.s.scope("orphan")   # a scope, but in neither the index nor the CAA manifest
        for uid in ("ghost", "a1", "orphan"):
            with self.assertRaises(cb.ScopeError):
                self.b(uid)

    def test_cli_counts_only_out_private_store_untouched(self):
        d = self.s.scope("cli1")
        put(self.s, d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "secret words here")])
        put(self.s, d, "role", "llm-roles", "v1")
        self.s.cut_row("cli1", 1, 2)
        self.s.flush()
        before = sorted((r, f, os.stat(os.path.join(r, f)).st_mtime_ns) for r, _, fs in os.walk(self.s.root) for f in fs)
        out = os.path.join(self._td.name, "b.json")
        buf = io.StringIO()
        args = ["--uid", "cli1", "--root", self.s.root, "--index", self.s.index, "--caa-manifest", self.s.caa]
        with contextlib.redirect_stdout(buf):
            self.assertEqual(cb.main(args), 0)
            self.assertEqual(cb.main(args + ["--out", out]), 0)
        shown = buf.getvalue()
        for needle in ("secret words", "cli1", "DOC1", "room_aaaaaaaa"):
            self.assertNotIn(needle, shown)
        first = json.loads(shown.splitlines()[0])
        self.assertEqual(first["layers_found"], 2)
        self.assertEqual(first["tracks"]["role_caa"], None)
        self.assertEqual(first["tracks"]["stt"], "1")   # the cfg8 slot of stt.sarvam-saaras-v3__v1__1.json in the fake store
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        self.assertEqual(json.load(open(out))["tracks"]["stt"]["track"]["segments"][0]["text"], "secret words here")
        after = sorted((r, f, os.stat(os.path.join(r, f)).st_mtime_ns) for r, _, fs in os.walk(self.s.root) for f in fs)
        self.assertEqual(before, after)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(cb.main(["--uid", "ghost"] + args[2:]), 2)
        self.assertNotIn("ghost", err.getvalue())


if __name__ == "__main__":
    unittest.main()
