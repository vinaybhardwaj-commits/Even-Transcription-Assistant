"""BF-6c: runner.py.next + the .next wrappers give each host its own label AND stack_id/sha. No service touched. python3 -m unittest test_bf6c"""
import hashlib, importlib.util, json, os, re, sys, unittest
H = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-bulk"); B = os.path.expanduser("~/oc/backfill-now"); HD = os.path.expanduser("~/eta-data/hist")
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-mining/harness"))
def load_runner(env):
    for k in ("HIST_BOX_STACKV",): os.environ.pop(k, None)
    os.environ.update(env); os.chdir(H); sys.path.insert(0, H)
    from importlib.machinery import SourceFileLoader as SFL; L = SFL("runner_next", f"{H}/runner.py.next"); s = importlib.util.spec_from_loader("runner_next", L); m = importlib.util.module_from_spec(s); L.exec_module(m); return m
def wenv(w):
    t = open(f"{B}/{w}").read(); return dict(re.findall(r"(HIST_[A-Z_0-9]+)=(\S+)", t.split("export", 1)[1].split("\n")[0])) if "export" in t else {}
SHA = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
class T(unittest.TestCase):
    def test_pins_and_default(self):
        n = SHA(f"{H}/runner.py.next")[:16]
        for w in ("run_real.sh.next", "run_c3.sh.next", "run_c4.sh.next"): self.assertIn(f"want={n}", open(f"{B}/{w}").read(), w)
        for w in ("run_real.sh", "run_c3.sh", "run_c4.sh"): self.assertIn("want=24822a9cffdedd42", open(f"{B}/{w}").read(), w)
        self.assertEqual(SHA(f"{H}/runner.py")[:16], "24822a9cffdedd42")
        r = load_runner({}); self.assertEqual(r.BOX_STACKV, f"{r.HD}/stack_versions.box.json")      # unset => today's behaviour
    def test_box(self):
        import provenance
        t = open(f"{B}/run_real.sh.next").read(); sf = re.search(r"BXSF=(\S+?);", t).group(1); pin = re.search(r"BXSHA=([0-9a-f]{64})", t).group(1)
        self.assertIn("HIST_BOX_STACKV=$BXSF", t)
        r = load_runner({"HIST_BOX_STACKV": sf}); self.assertEqual(r.BOX_STACKV, sf); sv, svsha = r.load_stack_versions(r.BOX_STACKV)
        provenance.STACK_DIR = f"{HD}/stack-box"; os.environ["HIST_STACK_VERSIONS_SHA256"] = pin; doc, h, path = provenance.published_stack_versions()
        print(f"  box: runner stamp stack_id={sv['stack_id']} sha16={svsha[:16]} | harness label={os.path.basename(path)} stack_id={doc['stack_id']} sha16={h[:16]}")
        self.assertEqual((sv["stack_id"], svsha[:16], doc["stack_id"], h[:16]), ("cf262b586718", "a497019b1d5927c8", "cf262b586718", "a497019b1d5927c8"))
    def test_c3_c4(self):
        import provenance
        for host, w, d, sid, sh16 in (("c3", "run_c3.sh.next", "stack-c3", "d275c9dc747b", "965fb3e93bdc79f8"), ("c4", "run_c4.sh.next", "stack-c4", "44f698d804e1", "861bb6615f49a14b")):
            t = open(f"{B}/{w}").read(); sf = re.search(r"(?:C3SF|C4SF)=(\S+?);", t).group(1); pin = re.search(r"(?:C3SHA|C4SHA)=([0-9a-f]{64})", t).group(1)
            r = load_runner({}); sv, svsha = r.load_stack_versions(sf)      # c3/c4 pass --stack-file; BOX_STACKV is not consulted (not :box)
            provenance.STACK_DIR = f"{HD}/{d}"; os.environ["HIST_STACK_VERSIONS_SHA256"] = pin; doc, h, path = provenance.published_stack_versions()
            print(f"  {host}: runner stamp stack_id={sv['stack_id']} sha16={svsha[:16]} | harness label={os.path.basename(path)} stack_id={doc['stack_id']}")
            self.assertEqual((sv["stack_id"], svsha[:16], doc["stack_id"]), (sid, sh16, sid))
if __name__ == "__main__": unittest.main(verbosity=2)
