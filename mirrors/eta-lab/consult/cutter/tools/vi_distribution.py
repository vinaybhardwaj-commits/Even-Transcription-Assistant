"""m3-08b: distribution of vi_frame_share (share of gated 20 ms frames, audio-13 definition) on the OPD 4/5 clips vs an equally large, evenly spread sample of the other rooms' clips. Read-only: re-cuts spans from the tape mirror into a temp file and deletes it."""
import json, os, statistics, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cutter import config as C, gating as G, store as SO, tape as T
from tools.retro_tag import vi_for_row

def main():
    rows = sorted((r for r in SO.read_index().values() if r.get("status") == "cut"), key=lambda r: r["span_start"])
    vi = [r for r in rows if G.is_macos26_room(r["room_slug"])]; other = [r for r in rows if not G.is_macos26_room(r["room_slug"])]
    k = len(vi); step = max(1, len(other) // k); sample = other[::step][:k]
    by = T.load_manifest(); wd = f"{C.E}/consult/cutter-work"; os.makedirs(wd, mode=0o700, exist_ok=True); out = {}
    for name, grp in (("OPD4/5", vi), ("other rooms (sample)", sample)):
        v = [(r["room_slug"][:6], r["ist_date"], vi_for_row(r, by, wd)) for r in grp]; x = sorted(a[0] for _, _, a in v if a[0] is not None)
        out[name] = dict(n=len(grp), measured=len(x), min=x[0], p25=x[len(x) // 4], median=statistics.median(x), p75=x[3 * len(x) // 4], max=x[-1], ge_0p3=sum(a >= G.VI_SHARE_MIN for a in x), ge_0p1=sum(a >= 0.1 for a in x),
                         speech_share_median=statistics.median(a[1] for _, _, a in v if a[1] is not None), values=x)
    print(json.dumps(out, indent=1))

if __name__ == "__main__": main()
