"""Model selection for LINK on the WRONG-TIME CONTROL only (no capture class exists): try METRIC frac|sum x hub text off|on; report the true-time link yield at the calibrated false-link limits."""
import sys, collections
sys.path.insert(0, ".")
import cap_link as L
res = []
for metric in ("frac", "sum"):
    for hub in (False,):
        L.METRIC = metric; L.USE_HUB_TEXT = hub
        links, th, ctrl, _ = L.main()
        c = collections.Counter(l["status"] for l in links)
        print(metric, "hub" if hub else "nohub", "true-time:", dict(c), "| control:", ctrl, flush=True)
