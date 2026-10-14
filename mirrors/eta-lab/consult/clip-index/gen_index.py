#!/usr/bin/python3
"""Build the private consult-audio index page (one self-contained HTML file, no external assets).

Reads  ~/eta-data/consult/clips/index.jsonl   (append-only; the LATEST row per consult_uid wins; only status == "cut" is listed)
       ~/eta-data/consult/clip-index/patients.json   (consult_uid -> {patient_name, ...}; built by build_patients.py)
Writes ~/eta-data/consult/clip-index/www/index.html  (atomic, 0600) and keeps www/clips as a symlink to the clips tree.
Audio is linked, never copied. Standard library only (runs on the system python3.10).
"""
import argparse, collections, datetime as dt, html, json, os, re, sys, tempfile, urllib.parse

HOME = os.path.expanduser("~")
DATA = os.path.join(HOME, "eta-data", "consult")
DEF_INDEX = os.path.join(DATA, "clips", "index.jsonl")
DEF_CLIPS = os.path.join(DATA, "clips")
DEF_PATIENTS = os.path.join(DATA, "clip-index", "patients.json")
DEF_WWW = os.path.join(DATA, "clip-index", "www")

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
NO_DOCTOR = "No doctor recorded"
UNKNOWN_PATIENT = "patient unknown"
VOICE_ISOLATION_LABEL = "Voice Isolation (OPD 4/5, 1-7 Oct)"
LONG_MIN = 30
SHORT_MIN = 2
FILES = (("Whole consult", "consult.flac", "consult"), ("Doctor only", "doctor.flac", "doctor"), ("Patient & others", "others.flac", "others"))
SAFE_PATH = re.compile(r"^[0-9A-Za-z._-]+(/[0-9A-Za-z._-]+)*$")
HM = re.compile(r"^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})")


# ---------- data ----------
def load_latest(index_path):
    """-> {consult_uid: row}; later lines overwrite earlier ones. Unparseable / partial lines are skipped."""
    latest = {}
    with open(index_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict) and r.get("consult_uid"):
                latest[r["consult_uid"]] = r
    return latest


def load_patients(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def patient_name(patients, uid):
    e = patients.get(uid)
    n = e.get("patient_name") if isinstance(e, dict) else None
    n = (n or "").strip()
    return n or UNKNOWN_PATIENT


def hm(ts):
    m = HM.match(ts or "")
    return m.group(1) if m else "--:--"


def minutes_label(m):
    try:
        n = round(float(m))
    except (TypeError, ValueError):
        return "? min"
    return "<1 min" if n < 1 else "%d min" % n


def window_start(row, entry=None):
    """IST wall-clock start of the consult window: Neon t_open (patients.json window_t_open_ist, refreshed by build_patients.py), else the t_open stored on the index row, else span_start."""
    for v in ((entry or {}).get("window_t_open_ist"), row.get("t_open"), row.get("span_start")):
        if v and HM.match(v):
            return v
    return None


def late_rx_minutes(row, entry):
    """Minutes by which the matched prescription was saved after span_end, if more than 30; else None."""
    try:
        rx = dt.datetime.fromisoformat((entry or {})["prescription_ts"])
        end = dt.datetime.fromisoformat(row["span_end"]).replace(tzinfo=IST)
        secs = (rx - end).total_seconds()
    except (KeyError, TypeError, ValueError):
        return None
    return round(secs / 60) if secs > 30 * 60 else None


def build_title(doctor_label, row, pname, entry=None):
    """<Doctor> · <HH:MM window start> · <Patient> · <HH:MM>–<HH:MM> (<n> min); IST wall-clock; range from span_start / span_end."""
    return "%s · %s · %s · %s–%s (%s)" % (doctor_label, hm(window_start(row, entry)), pname, hm(row.get("span_start")), hm(row.get("span_end")), minutes_label(row.get("minutes")))


def length_flag(row):
    """-> ('long', minutes) for >= LONG_MIN, ('short', minutes) for < SHORT_MIN, else (None, minutes or None)."""
    try:
        m = float(row.get("minutes"))
    except (TypeError, ValueError):
        return None, None
    return ("long" if m >= LONG_MIN else "short" if m < SHORT_MIN else None), m


def audio_files(row, clips_dir):
    """-> [(label, filename, kind)] for the files that exist on disk; [] if the stored path is unsafe."""
    p = row.get("path") or ""
    if not SAFE_PATH.match(p) or ".." in p.split("/"):
        return []
    out = []
    for label, fn, kind in FILES:
        if os.path.isfile(os.path.join(clips_dir, p, fn)):
            out.append((label, fn, kind))
    return out


def group_doctors(cut_rows):
    """-> ordered list of (doctor_label, [rows]); count desc, then name; the no-doctor group is always last."""
    groups = collections.OrderedDict()
    for r in cut_rows:
        key = r.get("doctor_uid") or r.get("doctor_name") or None
        groups.setdefault(key, []).append(r)
    out = []
    for key, rows in groups.items():
        if key is None:
            label = NO_DOCTOR
        else:
            names = collections.Counter(r.get("doctor_name") for r in rows if r.get("doctor_name"))
            label = names.most_common(1)[0][0] if names else str(key)
        out.append((key is None, label, rows))
    out.sort(key=lambda t: (t[0], -len(t[2]), t[1].lower()))
    return [(label, rows) for _, label, rows in out]


# ---------- rendering ----------
E = lambda s: html.escape("" if s is None else str(s), quote=True)

CSS = """
:root{--bg:#f6f5f2;--card:#fff;--ink:#1b1b1a;--mute:#6a6a66;--line:#dcdad3;--accent:#1f5fbf;--chip:#ecebe6;--ok:#1d7a3f;--warn:#a65b00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#212120;--ink:#ecebe6;--mute:#9b9a94;--line:#3a3a37;--accent:#7aa7ff;--chip:#2e2e2b;--ok:#5ec27f;--warn:#e0a24a;--bad:#ff8a80}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header,main,footer{max-width:960px;margin:0 auto;padding:0 16px}
header{padding-top:16px}
h1{font-size:1.35rem;margin:0 0 .25rem}
.meta{color:var(--mute);font-size:.9rem;margin:0 0 .75rem}
.bar{display:flex;gap:8px;align-items:center;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5;border-bottom:1px solid var(--line)}
.bar select{flex:1;min-width:0;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button:hover{border-color:var(--accent)}
#pos{color:var(--mute);font-size:.85rem;white-space:nowrap}
.menu{display:none;flex-wrap:wrap;gap:6px;margin:.6rem 0}
.menu button{padding:4px 10px;font-size:.85rem;border-radius:999px}
.menu button[aria-current=true]{background:var(--accent);border-color:var(--accent);color:#fff}
@media (min-width:700px){.menu{display:flex}.bar select{display:none}}
.doc h2{font-size:1.2rem;margin:1rem 0 .25rem}
.doc h2 small,.day h3 small{color:var(--mute);font-weight:400;font-size:.85rem}
.day h3{font-size:1rem;margin:1.25rem 0 .5rem;padding-bottom:4px;border-bottom:1px solid var(--line)}
.c{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 10px}
.c h4{font-size:.98rem;margin:0 0 4px;overflow-wrap:anywhere}
.sub{margin:0 0 4px;color:var(--mute);font-size:.85rem}
.chips{margin:0 0 6px;display:flex;flex-wrap:wrap;gap:4px}
.chip{background:var(--chip);border-radius:999px;padding:1px 8px;font-size:.75rem}
.chip.warn{color:var(--warn)}
.hide{display:none;margin:.4rem 0;font-size:.9rem}.js .hide{display:block}
.c[hidden],.day[hidden]{display:none}
.q-clean,.chip.yes{color:var(--ok)}.q-unattributed,.q-unclosed{color:var(--warn)}.q-multi_doctor,.chip.no{color:var(--bad)}
.a{margin:6px 0}
.a label{display:block;font-size:.8rem;color:var(--mute)}
.a audio{width:100%;height:40px}
.a a{font-size:.8rem;color:var(--accent)}
.none{color:var(--mute);font-size:.85rem;font-style:italic}
.foot{color:var(--mute);font-size:.8rem;margin:1rem 0}
footer{padding-bottom:32px}
.js .doc[hidden]{display:none}
"""

JS = """
(function(){
var secs=[].slice.call(document.querySelectorAll('section.doc'));
if(!secs.length)return;
document.documentElement.className+=' js';
var menu=document.getElementById('menu'),pos=document.getElementById('pos'),btns=[].slice.call(document.querySelectorAll('.menu button')),cur=0;
function pauseAll(){[].forEach.call(document.querySelectorAll('audio'),function(a){try{a.pause();}catch(e){}});}
function show(i){
  if(i<0)i=secs.length-1; if(i>=secs.length)i=0;
  if(i!==cur)pauseAll();
  cur=i;
  secs.forEach(function(s,k){s.hidden=(k!==i);});
  btns.forEach(function(b,k){b.setAttribute('aria-current',k===i?'true':'false');});
  menu.value=String(i); pos.textContent=(i+1)+' / '+secs.length;
  try{history.replaceState(null,'','#d'+i);}catch(e){}
  window.scrollTo(0,0);
}
document.getElementById('prev').addEventListener('click',function(){show(cur-1);});
document.getElementById('next').addEventListener('click',function(){show(cur+1);});
menu.addEventListener('change',function(){show(parseInt(menu.value,10)||0);});
btns.forEach(function(b,k){b.addEventListener('click',function(){show(k);});});
document.addEventListener('keydown',function(e){
  if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;
  var t=e.target,tag=t&&t.tagName;
  if(tag==='AUDIO'||tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||(t&&t.isContentEditable))return;
  if(e.key==='ArrowLeft'){show(cur-1);e.preventDefault();}
  else if(e.key==='ArrowRight'){show(cur+1);e.preventDefault();}
});
document.addEventListener('play',function(e){[].forEach.call(document.querySelectorAll('audio'),function(a){if(a!==e.target)a.pause();});},true);
[].forEach.call(document.querySelectorAll('.hidelong'),function(cb){
  cb.addEventListener('change',function(){
    var sec=cb.closest('section.doc');
    [].forEach.call(sec.querySelectorAll('.c[data-long]'),function(a){a.hidden=cb.checked;});
    [].forEach.call(sec.querySelectorAll('.day'),function(d){d.hidden=!d.querySelector('.c:not([hidden])');});
  });
});
var m=/^#d(\\d+)$/.exec(location.hash||''),start=m?parseInt(m[1],10):0;
show(start<secs.length?start:0);
})();
"""


def day_label(ist_date):
    try:
        d = dt.date.fromisoformat(ist_date)
        return d.strftime("%a %d %b %Y")
    except (TypeError, ValueError):
        return str(ist_date or "date unknown")


def render_consult(row, doctor_label, patients, clips_dir):
    uid = row["consult_uid"]
    pname = patient_name(patients, uid)
    entry = patients.get(uid) if isinstance(patients.get(uid), dict) else None
    title = build_title(doctor_label, row, pname, entry)
    chips = []
    q = row.get("quality")
    if q:
        chips.append('<span class="chip q-%s">%s</span>' % (E(re.sub(r"[^0-9A-Za-z_-]", "", str(q))), E(q)))
    di = row.get("doctor_identified")
    if di is True:
        chips.append('<span class="chip yes">doctor voice found</span>')
    elif di is False:
        chips.append('<span class="chip no">doctor voice not found</span>')
    if row.get("voice_isolated") is True:
        chips.append('<span class="chip">%s</span>' % E(VOICE_ISOLATION_LABEL))
    flag, mins = length_flag(row)
    if flag == "long":
        chips.append('<span class="chip no">long: %d min, likely not one consult (window closed by %s)</span>' % (round(mins), E(row.get("close_reason") or "unknown")))
    elif flag == "short":
        chips.append('<span class="chip warn">very short</span>')
    late = late_rx_minutes(row, entry) if pname != UNKNOWN_PATIENT else None
    if late:
        chips.append('<span class="chip no">late Rx: patient name from a prescription saved %d min after the consult</span>' % late)
    parts = ['<article class="c" id="c-%s"%s>' % (E(uid), ' data-long="1"' if flag == "long" else ""), "<h4>%s</h4>" % E(title)]
    parts.append('<p class="sub">Room: %s</p>' % E(row.get("room_slug") or "unknown"))
    if chips:
        parts.append('<p class="chips">%s</p>' % "".join(chips))
    files = audio_files(row, clips_dir)
    base = urllib.parse.quote(row.get("path") or "", safe="/")
    if not files:
        parts.append('<p class="none">audio files not found on disk</p>')
    for label, fn, kind in files:
        src = "clips/%s/%s" % (base, fn)
        dl = "%s_%s_%s.flac" % (row.get("ist_date") or "date", uid, kind)
        parts.append('<div class="a"><label>%s</label><audio controls preload="none" src="%s"></audio> <a href="%s" download="%s">download %s</a></div>'
                     % (E(label), E(src), E(src), E(dl), E(fn)))
    parts.append("</article>")
    return "".join(parts)


def render(latest, patients, clips_dir, generated_at=None):
    generated_at = generated_at or dt.datetime.now(IST)
    cut = [r for r in latest.values() if r.get("status") == "cut"]
    other = [r for r in latest.values() if r.get("status") != "cut"]
    skipped = collections.defaultdict(collections.Counter)  # doctor key -> status -> n
    for r in other:
        skipped[r.get("doctor_uid") or r.get("doctor_name") or None][r.get("status") or "unknown"] += 1
    groups = group_doctors(cut)
    dates = sorted(r["ist_date"] for r in cut if r.get("ist_date"))
    rng = "no dates" if not dates else (day_label(dates[0]) if dates[0] == dates[-1] else "%s – %s" % (day_label(dates[0]), day_label(dates[-1])))
    out = ['<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
           '<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>Consult audio index</title><style>%s</style></head><body>' % CSS,
           "<header><h1>Consult audio index</h1>",
           '<p class="meta">%d consults · %s · generated %s IST · private (Tailscale only)</p><p class="meta">Boundaries come from the Pulse page open/close; long ones usually mean the patient page was left open.</p>' % (len(cut), E(rng), E(generated_at.strftime("%d %b %Y %H:%M")))]
    if groups:
        out.append('<nav class="bar"><button id="prev" type="button" aria-label="Previous doctor">‹ Prev</button>'
                   '<select id="menu" aria-label="Doctor">%s</select>'
                   '<button id="next" type="button" aria-label="Next doctor">Next ›</button><span id="pos"></span></nav>'
                   % "".join('<option value="%d">%s (%d)</option>' % (i, E(lbl), len(rows)) for i, (lbl, rows) in enumerate(groups)))
        out.append('<div class="menu" role="navigation" aria-label="Doctors">%s</div>'
                   % "".join('<button type="button" aria-current="false">%s (%d)</button>' % (E(lbl), len(rows)) for lbl, rows in groups))
    out.append("</header><main>")
    if not groups:
        out.append('<p class="none">No cut consults yet.</p>')
    for i, (label, rows) in enumerate(groups):
        out.append('<section class="doc" id="d%d"><h2>%s <small>%d consult%s</small></h2>' % (i, E(label), len(rows), "" if len(rows) == 1 else "s"))
        out.append('<label class="hide"><input type="checkbox" class="hidelong"> hide consults over 30 min</label>')
        bydate = collections.defaultdict(list)
        for r in rows:
            bydate[r.get("ist_date") or ""].append(r)
        for d in sorted(bydate, reverse=True):
            drows = sorted(bydate[d], key=lambda r: (r.get("span_start") or "", r["consult_uid"]))
            out.append('<div class="day"><h3>%s <small>%d</small></h3>' % (E(day_label(d)), len(drows)))
            out.extend(render_consult(r, label, patients, clips_dir) for r in drows)
            out.append("</div>")
        key = None if label == NO_DOCTOR else (rows[0].get("doctor_uid") or rows[0].get("doctor_name"))
        sk = skipped.get(key)
        if sk:
            out.append('<p class="foot">Not listed (excluded): %s.</p>' % E(", ".join("%d %s" % (n, s) for s, n in sorted(sk.items()))))
        out.append("</section>")
    tot = collections.Counter(r.get("status") or "unknown" for r in other)
    out.append('</main><footer><p class="foot">All doctors: %d consults listed; excluded from this page: %s. Times are IST. Audio stays on the lab box and is linked, not copied.</p></footer>'
               % (len(cut), E(", ".join("%d %s" % (n, s) for s, n in sorted(tot.items())) or "none")))
    out.append("<script>%s</script></body></html>" % JS)
    return "".join(out)


# ---------- output ----------
def write_atomic(path, text, mode=0o600):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".index-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ensure_symlink(link, target):
    """www/clips -> clips tree. Replaces a wrong symlink atomically; refuses to replace a real file or directory."""
    if os.path.islink(link):
        if os.readlink(link) == target:
            return
        tmp = link + ".new"
        if os.path.lexists(tmp):
            os.unlink(tmp)
        os.symlink(target, tmp)
        os.replace(tmp, link)
    elif os.path.lexists(link):
        raise RuntimeError("%s exists and is not a symlink" % link)
    else:
        os.symlink(target, link)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--index", default=DEF_INDEX)
    ap.add_argument("--clips", default=DEF_CLIPS)
    ap.add_argument("--patients", default=DEF_PATIENTS)
    ap.add_argument("--www", default=DEF_WWW)
    a = ap.parse_args(argv)
    if not os.path.isfile(a.index):
        print("gen_index: %s is missing; nothing written, existing index.html left as is (exit 0)" % a.index, file=sys.stderr)
        return 0
    os.makedirs(a.www, mode=0o700, exist_ok=True)
    os.chmod(a.www, 0o700)
    latest = load_latest(a.index)
    page = render(latest, load_patients(a.patients), a.clips)
    ensure_symlink(os.path.join(a.www, "clips"), os.path.abspath(a.clips))
    write_atomic(os.path.join(a.www, "index.html"), page)
    n_cut = sum(1 for r in latest.values() if r.get("status") == "cut")
    print("index.html written: %d cut consults, %d bytes" % (n_cut, len(page.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
