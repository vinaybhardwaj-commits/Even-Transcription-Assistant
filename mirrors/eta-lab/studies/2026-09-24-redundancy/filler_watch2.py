#!/usr/bin/env python3
"""Loop-guard before/after watch (Fable ruling 210): 25 Sep 08:05 -> 12:00 IST, then it ENDS. split-speaker.

Ticks at 08:05, 09:05, 10:05, 11:05 and a final tick at 12:00: one COUNTS-ONLY line each to eta-lab bus/FILLER-WATCH-25SEP.md.
No alarms: this is a measurement, not a monitor. Text is read in memory from production transcripts and never printed or stored.

MEASURE. Canonical repeat ratio v2, measure A (repeat_ratio_v2.py), on transcription_run.transcript_original of each window's latest run
(the run row is what remains after the whisper-shim, the router's collapse and the app's collapseAssembled). "Loop window" = at least one
measure-A loop. A window belongs to the period of its TRANSCRIPTION time (the guard runs when the row is written).
SPLIT. BEFORE = transcribed from 24 Sep 04:40 IST (whisper VAD off) until the deploy; TRANSITION = the 10 minutes after it; AFTER = from
deploy + 10 min. The deploy time is read from deploy_at.txt (ISO, IST) at every tick: scribe posts Vercel's own `ready` timestamp for the
a92ebae production deployment (loop guard 035c5b7), and I write it. If the deploy is rolled back and redone, the file is overwritten with the new
`ready` time and the split restarts. No file = no AFTER period. TRANSITION exists because a serverless deployment can keep serving from instances
that still hold the previous code for a short while after `ready` (scribe, bus #852); those windows count in neither BEFORE-vs-AFTER test and are
reported as a count. (Amended 24 Sep ~20:05 IST after scribe's note, still before any 25 Sep data; tonight's 73868e4 has NO loop-guard change, so
BEFORE simply continues through tonight's push.)

PRE-REGISTERED (written before any 25 Sep data existed; 24 Sep 19:50 IST):
 baseline  17 of 302 windows (5.6 %) carried a loop, 24 Sep 04:40 -> 19:46. Single hours ranged 0 % to 11.5 % at 20-31 windows an hour,
           so NO SINGLE HOUR IS EVIDENCE; only the pooled AFTER period is compared.
 P1  share:      loop windows / windows in AFTER  <=  2 %.  (Expected residue about 0.8 %: 2 of the 15 loops analysed on 24 Sep were number-protected.)
                 Reported with a Wilson 95 % interval and the exact one-sided Poisson probability of seeing that few loop windows at the
                 baseline rate. With fewer than 50 AFTER windows the share is reported as INSUFFICIENT and only counts are given.
 P2  mechanism:  every loop that remains in AFTER is PROTECTED by the number rule (a digit, or number words >= a third of the unit). This test
                 does not depend on sample size. On 24 Sep, 12 of 15 loop windows had UNPROTECTED loops (the guard should now collapse those).
                 Any UNPROTECTED residual loop in AFTER is the guard failing to act and is reported by count.
 Outcome is reported as PASS / FAIL per test at 12:00. A failure is reported as a failure.
 RULING 216 (Fable, 24 Sep 20:05): a92ebae is ordered live at 25 Sep 07:50 IST; the 08:05-12:00 watch is AFTER, 24 Sep's watch is BEFORE. This
 comparison is pre-registered here, before any 25 Sep data. The BEFORE figures agree with the older FILLER-WATCH.md 19:05 tick (16 of 283
 windows, 5.7 %, max hour 7.7 %): same measure, an earlier cut than the 17 of 302 above. The 07:50 time is the ORDER, not a measurement: the split
 uses Vercel's `ready` timestamp from deploy_at.txt, and if the deploy slips past 08:05 there is no AFTER period and the report says so.
"""
import argparse, datetime as dt, json, math, os, subprocess, sys, time, unicodedata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import final_layers as F          # is_number_token (the guard's own lexicon) and repeat_ratio_v2

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
R = F.R
ETA = "/home/eta/dev/Even-Transcription-Assistant"
SELECT = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
LAB = "/home/eta/dev/eta-lab-watch"
BUS = "bus/FILLER-WATCH-25SEP.md"
DEPLOY_FILE = os.path.join(HERE, "deploy_at.txt")
BASELINE_FROM = "2026-09-23T23:10:00Z"          # 04:40 IST 24 Sep
BASELINE_RATE = 17 / 302
TRANSITION = dt.timedelta(minutes=10)
SQL = f"""select d.wid, d.room_id, d.created_at, d.t from (
  select distinct on (tr.subject_id) tr.subject_id as wid, s.room_id, tr.created_at, coalesce(tr.transcript_original,'') as t
    from transcription_run tr join bench_window w on w.id = tr.subject_id join bench_session s on s.id = w.session_id
   where tr.subject_type='bench_window' and tr.error is null and tr.created_at >= timestamptz '{BASELINE_FROM}'
   order by tr.subject_id, tr.created_at desc) d"""
HEADER = "# Loop-guard before/after watch, 25 Sep 08:05 -> 12:00 IST (split-speaker, Fable ruling 210)\n\n" + \
    "\n".join((__doc__ or "").strip().split("\n")[2:]) + "\n\n"


def now_ist(): return dt.datetime.now(IST)
def parse_ist(s): return dt.datetime.fromisoformat(s).replace(tzinfo=IST) if "+" not in s and "Z" not in s else dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(IST)


def protection(unit):
    """Why a loop's unit is protected from the guard, or None if the guard should collapse it (the new number rule)."""
    if any(unicodedata.category(c).startswith("N") for tok in unit for c in tok): return "digit"
    if unit and sum(F.is_number_token(t) for t in unit) / len(unit) >= 1 / 3: return "number_words"
    return None


def classify(text):
    """-> (has_loop, has_unprotected_loop) for one transcript, counts only."""
    loops = R.phrase_loops(text) if text and text.strip() else []
    return bool(loops), any(protection(l["unit"]) is None for l in loops)


def stats(rows):
    n = len(rows); empty = sum(1 for r in rows if not r["t"].strip())
    cl = [classify(r["t"]) for r in rows]
    loop = sum(c[0] for c in cl); unprot = sum(c[1] for c in cl)
    return {"n": n, "empty": empty, "loop": loop, "unprotected": unprot, "protected_only": loop - unprot}


def wilson(k, n, z=1.96):
    if n == 0: return (0.0, 1.0)
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def poisson_cdf(k, m):
    return sum(math.exp(-m) * m ** i / math.factorial(i) for i in range(k + 1)) if m > 0 else 1.0


def fetch():
    r = subprocess.run(["node", SELECT, SQL], cwd=ETA, capture_output=True, text=True, timeout=180)
    if r.returncode != 0: raise RuntimeError(f"neon-select exit {r.returncode}")
    return [{"wid": x["wid"], "room": x["room_id"], "ts": parse_ist(x["created_at"]), "t": x["t"]} for x in json.loads(r.stdout)]


def deploy_time(override=None):
    if override: return parse_ist(override)
    try: return parse_ist(open(DEPLOY_FILE).read().strip())
    except Exception: return None


def split(rows, deploy):
    """-> (before, transition, after) by TRANSCRIPTION time. transition = [deploy, deploy + 10 min), counted in neither test."""
    if deploy is None: return list(rows), [], []
    return ([r for r in rows if r["ts"] < deploy], [r for r in rows if deploy <= r["ts"] < deploy + TRANSITION],
            [r for r in rows if r["ts"] >= deploy + TRANSITION])


def line(rows, t, deploy, final=False):
    before, transition, after = split(rows, deploy)
    b, a = stats(before), stats(after)
    pc = lambda k, n: f"{100 * k / n:.1f}%" if n else "n/a"
    s = (f"- {t:%H:%M} IST {t:%d %b} | BEFORE (24 Sep 04:40 -> {'deploy ' + format(deploy, '%d %b %H:%M') if deploy else 'now, NO DEPLOY TIME'}): "
         f"{b['n']} windows, {b['loop']} loop ({pc(b['loop'], b['n'])}), {b['unprotected']} with an unprotected loop")
    if deploy is None:
        return s + " | AFTER: none (deploy_at.txt absent)", None
    lo, hi = wilson(a["loop"], a["n"])
    mean = BASELINE_RATE * a["n"]
    p_lo = poisson_cdf(a["loop"], mean)
    s += (f" | TRANSITION ({deploy:%H:%M}-{(deploy + TRANSITION):%H:%M}, in neither pool): {len(transition)} windows"
          f" | AFTER (from {(deploy + TRANSITION):%H:%M}): {a['n']} windows, {a['loop']} loop ({pc(a['loop'], a['n'])}, Wilson95 [{100 * lo:.1f}-{100 * hi:.1f}%]), "
          f"{a['unprotected']} unprotected, {a['protected_only']} protected-only | expected at baseline {mean:.1f}, P(<= observed | no effect) = {p_lo:.3f}")
    return s, (b, a)


def verdict(b, a):
    out = []
    if a["n"] < 50: out.append(f"P1 share: INSUFFICIENT (n={a['n']} < 50): counts only, {a['loop']} loop of {a['n']}")
    else: out.append(f"P1 share <= 2%: {'PASS' if a['loop'] / a['n'] <= 0.02 else 'FAIL'} ({a['loop']}/{a['n']} = {100 * a['loop'] / a['n']:.1f}%)")
    out.append(f"P2 mechanism (no UNPROTECTED loop remains): {'PASS' if a['unprotected'] == 0 else 'FAIL'} ({a['unprotected']} windows with an unprotected loop of {a['loop']} loop windows)")
    if b["loop"]: out.append(f"context: BEFORE had {b['unprotected']} of {b['loop']} loop windows with an unprotected loop")
    return out


def git(*a, check=True): return subprocess.run(["git", *a], cwd=LAB, capture_output=True, text=True, check=check)


def publish(text, t):
    for attempt in range(4):
        git("fetch", "-q", "origin"); git("checkout", "-q", "--detach", "origin/main")
        path = os.path.join(LAB, BUS)
        if not os.path.exists(path): open(path, "w").write(HEADER)
        with open(path, "a") as f: f.write(text.rstrip("\n") + "\n")
        git("add", BUS)
        git("-c", "user.name=split-speaker (loop-guard-watch)", "-c", "user.email=noreply@anthropic.com", "commit", "-q", "-m", f"loop-guard-watch: {t:%H:%M} IST")
        # ruling 135: push only my own commit (a detached worktree off origin/main holds nobody else's)
        if git("log", "--oneline", "origin/main..HEAD", check=False).stdout.count("\n") != 1: raise RuntimeError("push refused: not exactly my one commit")
        if git("push", "-q", "origin", "HEAD:refs/heads/main", check=False).returncode == 0: return True
        time.sleep(5 + 5 * attempt)
    with open(os.path.join(HERE, "unpushed2.md"), "a") as f: f.write(text + "\n")
    return False


def selftest():
    assert protection(("take", "5", "mg")) == "digit"
    assert protection(("ek", "goli", "subah")) == "number_words"
    assert protection(("please", "do", "not", "worry", "about")) is None      # 1 of 5: the guard should collapse it
    assert protection(("one", "one", "one")) == "number_words"
    assert classify("a b c a b c a b c") == (True, True)
    assert classify("take 5 mg daily take 5 mg daily take 5 mg daily") == (True, False)
    assert classify("how long have you had this cough") == (False, False)
    assert classify("") == (False, False)
    lo, hi = wilson(0, 40); assert lo == 0.0 and 0.05 < hi < 0.12
    assert abs(poisson_cdf(0, 2.0) - math.exp(-2)) < 1e-12
    assert stats([{"t": ""}, {"t": "x y"}])["empty"] == 1
    d = dt.datetime(2026, 9, 25, 10, 0, tzinfo=IST); m = dt.timedelta(minutes=1)
    rs = [{"ts": d - m}, {"ts": d}, {"ts": d + TRANSITION - m}, {"ts": d + TRANSITION}, {"ts": d + 5 * TRANSITION}]
    b_, t_, a_ = split(rs, d)
    assert (len(b_), len(t_), len(a_)) == (1, 2, 2), (len(b_), len(t_), len(a_))     # boundaries: deploy is TRANSITION, deploy+10 min is AFTER
    assert split(rs, None) == (rs, [], [])
    return True


selftest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-09-25T08:05"); ap.add_argument("--until", default="2026-09-25T12:00")
    ap.add_argument("--once", action="store_true", help="one tick now, print, do not publish"); ap.add_argument("--deploy-at", default=None)
    a = ap.parse_args()
    start, until = parse_ist(a.start), parse_ist(a.until)
    if a.once:
        t = now_ist(); s, st = line(fetch(), t, deploy_time(a.deploy_at)); print(s)
        if st: print("\n".join(verdict(*st)))
        return
    ticks = []; k = start
    while k < until: ticks.append(k); k += dt.timedelta(hours=1)
    ticks.append(until)
    print(f"loop-guard watch: {len(ticks)} ticks {ticks[0]:%d %b %H:%M} .. {ticks[-1]:%H:%M} IST; now {now_ist():%d %b %H:%M:%S}", flush=True)
    for i, tk in enumerate(ticks):
        while now_ist() < tk: time.sleep(min(30, max(1, (tk - now_ist()).total_seconds())))
        t = now_ist()
        try:
            s, st = line(fetch(), t, deploy_time(), final=(i == len(ticks) - 1))
        except Exception as e:
            s, st = f"- {t:%H:%M} IST | QUERY FAILED ({type(e).__name__})", None
        out = s
        if i == len(ticks) - 1:
            out += "\n" + ("\n".join("  " + v for v in verdict(*st)) if st else "  NO AFTER PERIOD: no deploy time was recorded, so no before/after verdict.") + "\n- END of the 25 Sep loop-guard watch (ruling 210)."
        ok = publish(out, t); print(out, flush=True)
        if not ok: print("push failed; line kept in unpushed2.md", flush=True)
    print("END", flush=True)


if __name__ == "__main__":
    main()
