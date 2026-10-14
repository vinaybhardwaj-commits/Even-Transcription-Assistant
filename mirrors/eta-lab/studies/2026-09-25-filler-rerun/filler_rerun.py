#!/usr/bin/env python3
"""Filler-text watch RERUN (ruling 210, diar-lab): before/after for the loop guard (train a92ebae, loop-guard 035c5b7). COUNTS ONLY, no transcript text anywhere.
Runs at 08:05, 09:05, 10:05, 11:05, 12:05 IST on the anchor day (default: tomorrow) and appends ONE line each to eta-lab bus/FILLER-WATCH.md (pushed from its own temp worktree).
Same measures as the 24 Sep watch (repeat_measure: canonical loop = repeat-ratio v2 measure A, B repeated sentences, filler-only, empty; latest run per window).
Each line compares IDENTICAL clock spans [08:00 IST, run time) on three days: anchor day (loop guard expected ON), anchor-1 (VAD off, no guard = the 24 Sep watch's 'today'),
anchor-2 (VAD on, no guard). usage: filler_rerun.py [--anchor-date YYYY-MM-DD] [--times 08:05,...] [--dry-run] [--no-wait]"""
import argparse, datetime as dt, json, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import repeat_measure_local as RM
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
ETA = "/home/eta/dev/Even-Transcription-Assistant"; SELECT = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
REPO = os.path.expanduser("~/dev/eta-lab"); WT = "/tmp/wt-filler-rerun"; BUS = "bus/FILLER-WATCH.md"
ap = argparse.ArgumentParser(); ap.add_argument("--anchor-date"); ap.add_argument("--times", default="08:05,09:05,10:05,11:05,12:05")
ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--no-wait", action="store_true"); a = ap.parse_args()
now = lambda: dt.datetime.now(IST)
anchor = dt.date.fromisoformat(a.anchor_date) if a.anchor_date else (now() + dt.timedelta(days=1)).date()

def sql(t_end):
    """Latest run per window inside each day's span [08:00 IST, t_end time-of-day IST); period label d0 (anchor), d1 (anchor-1), d2 (anchor-2)."""
    spans = []
    for i, name in enumerate(("d0", "d1", "d2")):
        day = anchor - dt.timedelta(days=i)
        s = dt.datetime.combine(day, dt.time(8, 0), tzinfo=IST); e = dt.datetime.combine(day, t_end, tzinfo=IST)
        spans.append((name, s.isoformat(), e.isoformat()))
    case = " ".join(f"when tr.created_at >= timestamptz '{s}' and tr.created_at < timestamptz '{e}' then '{n}'" for n, s, e in spans)
    where = " or ".join(f"(tr.created_at >= timestamptz '{s}' and tr.created_at < timestamptz '{e}')" for n, s, e in spans)
    return f"""select d.period, d.room_id, d.wid, d.t from (select distinct on (tr.subject_id, per) case {case} end as period, case {case} end as per,
       s.room_id, tr.subject_id as wid, coalesce(tr.transcript_original,'') as t
       from transcription_run tr join bench_window w on w.id = tr.subject_id join bench_session s on s.id = w.session_id
      where tr.subject_type = 'bench_window' and tr.error is null and ({where})
      order by tr.subject_id, per, tr.created_at desc) d"""

def fetch(t_end):
    r = subprocess.run(["node", SELECT, sql(t_end)], cwd=ETA, capture_output=True, text=True, timeout=300)
    if r.returncode != 0: raise RuntimeError(f"neon-select exit {r.returncode}")
    return json.loads(r.stdout)

def fmt(res, t, t_end):
    g = lambda d, k: d.get(k, 0)
    def part(name, label):
        o = res.get(name, {}); n = g(o, "windows"); loops = g(o, "a_loop_windows")
        return (f"{label} windows {n} empty {g(o,'empty')} filler-only {g(o,'filler_only')} loop windows {loops} ({100*loops/n:.1f}%)" if n else f"{label} windows 0") + \
               (f" agg repeat_ratio {100*g(o,'aggregate_repeat_ratio'):.2f}% B-runs {g(o,'b_run_windows')}" if n else "")
    rooms = ",".join(f"{r}:{n}" for n, r in sorted(((n, r) for r, n in res.get("d0", {}).get("rooms", {}).items()), reverse=True)) or "-"
    return (f"- {t:%H:%M} IST {anchor:%d %b} RERUN span 08:00-{t_end:%H:%M} | AFTER {part('d0', anchor.strftime('%d %b') + ' (loop guard expected ON)')}"
            f" | BEFORE {part('d1', (anchor - dt.timedelta(days=1)).strftime('%d %b') + ' (VAD off, no guard)')}"
            f" | VAD-on ref {part('d2', (anchor - dt.timedelta(days=2)).strftime('%d %b'))} | rooms with loop windows (after) {rooms}")

def git(*args, cwd=WT, check=True): return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=check)

def publish(line, t):
    if not os.path.isdir(WT): git("worktree", "add", "-q", "--detach", WT, "origin/main", cwd=REPO)
    for k in range(4):
        git("fetch", "-q", "origin"); git("checkout", "-q", "--detach", "origin/main")
        with open(os.path.join(WT, BUS), "a") as f: f.write(line + "\n")
        git("add", BUS); git("-c", "user.name=diar-lab (filler-rerun)", "-c", "user.email=noreply@anthropic.com", "commit", "-q", "-m", f"filler-rerun: {t:%H:%M} IST")
        if git("push", "-q", "origin", "HEAD:refs/heads/main", check=False).returncode == 0: return True
        time.sleep(5 + 5 * k)
    open(os.path.join(HERE, "unpushed.md"), "a").write(line + "\n"); return False

for hm in a.times.split(","):
    h, m = map(int, hm.split(":")); when = dt.datetime.combine(anchor, dt.time(h, m), tzinfo=IST)
    if not a.no_wait:
        while now() < when: time.sleep(20)
    t = when if a.no_wait else now(); t_end = dt.time(h, m)
    try: line = fmt(RM.measure(fetch(t_end)), t, t_end)
    except Exception as e: line = f"- {hm} IST {anchor:%d %b} RERUN QUERY FAILED ({type(e).__name__})"
    print(line, flush=True)
    if not a.dry_run: publish(line, t)
