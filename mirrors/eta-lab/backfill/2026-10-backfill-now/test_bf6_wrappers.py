"""BF-6 B: the box and c3 wrappers pin their OWN measured stack file. No service touched, no audio. python3 -m unittest test_bf6_wrappers"""
import glob, hashlib, json, os, re, subprocess, sys, unittest
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-mining/harness"))
B = os.path.expanduser("~/oc/backfill-now"); HD = os.path.expanduser("~/eta-data/hist")
CASES = {"box": (f"{B}/run_real.sh", "BXSF", "BXSHA", "stack-box", "stack_versions.box-bf6.json"), "c3": (f"{B}/run_c3.sh", "C3SF", "C3SHA", "stack-c3", "stack_versions.c3-bf6.json")}
def pins(w, sf, sha):
    t = open(w).read(); return re.search(sf + r"=(\S+?);", t).group(1), re.search(sha + r"=([0-9a-f]{64})", t).group(1), t
class T(unittest.TestCase):
    def test_pins_and_label(self):
        import provenance
        for k, (w, sf, sha, d, base) in CASES.items():
            with self.subTest(k):
                f, pin, t = pins(w, sf, sha); self.assertEqual(os.path.basename(f), base); self.assertEqual(hashlib.sha256(open(f, "rb").read()).hexdigest(), pin)
                self.assertEqual(os.listdir(f"{HD}/{d}"), [base]); self.assertEqual(os.path.realpath(f"{HD}/{d}/{base}"), os.path.realpath(f))
                self.assertIn(f"HIST_STACK_VERSIONS_DIR={HD}/{d} HIST_STACK_VERSIONS_SHA256=${sha}".replace(HD, "/home/eta/eta-data/hist"), t)
                provenance.STACK_DIR = f"{HD}/{d}"; os.environ["HIST_STACK_VERSIONS_SHA256"] = pin
                doc, h, path = provenance.published_stack_versions()           # the harness's own selection: this is what becomes notes.stack_versions_file
                self.assertEqual((os.path.basename(path), h), (base, pin)); self.assertEqual(doc["stack_id"], hashlib.sha256(json.dumps({"stack": doc["stack"], "guards": doc["guards"]}, sort_keys=True).encode()).hexdigest()[:12])
                print(f"  {k}: notes.stack_versions_file={os.path.basename(path)} sha16={h[:16]} stack_id={doc['stack_id']}")
    def test_wrapper_refuses_on_sha_mismatch(self):
        for k, (w, sf, sha, d, base) in CASES.items():
            with self.subTest(k):
                f, pin, t = pins(w, sf, sha); bad = t.replace(pin, "0" * 64, 1); tmp = f"{B}/.t_{k}.sh"; open(tmp, "w").write(bad)
                try: r = subprocess.run(["bash", tmp, "--no-such-mode"], capture_output=True, text=True, timeout=30)
                finally: os.unlink(tmp)
                self.assertEqual(r.returncode, 3); self.assertIn("REFUSED", r.stdout + r.stderr)
    def test_syntax_and_runner_pin_unchanged(self):
        for k, (w, *_r) in CASES.items(): self.assertEqual(subprocess.run(["bash", "-n", w]).returncode, 0)
        self.assertIn("want=24822a9cffdedd42", open(CASES["box"][0]).read())
if __name__ == "__main__": unittest.main(verbosity=2)
