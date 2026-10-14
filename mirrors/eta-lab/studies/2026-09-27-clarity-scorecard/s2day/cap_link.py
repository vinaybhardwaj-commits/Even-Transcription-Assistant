"""CAP-1 step 1 (LINK), v2: tie each PQM consult of a day to the taped ROOM SPAN that holds it, by TIME and then CONTENT (eta-refuter-2 #3461/#3474/#3491 binding).
Never binds a room to a doctor: each consult is linked on its own evidence. Basis ladder (least circular first):
  TC   = time window + presenting complaint + the patient's name words (dpipe `presenting_complaint`, `name`: fields that are NOT scored items)
  TCD  = + diagnosis words  (diagnosis items are scored items: they become used_for_link)
  TCDM = + drug names       (diagnosis and drug items become used_for_link)
The time comes from the PQM CONSULTATION steps (queue_token_steps called_at / completed_at, via encounter-truth rows.csv): time_src = "pqm" on every link.
One link per consult TOKEN: the rows of a token that has two consult steps are merged (span = earliest called_at .. latest completed_at; Rx = the union).
THRESHOLDS are calibrated through the SAME selection the link uses (best room over all candidates, margin rules, best level): the wrong-time control (each span shifted by -150, -90, +90, +150 minutes)
is run through decide() and the thresholds are the smallest percentile pair for which the false-link rate is <= 5% (probable + confirmed) and <= 1% (confirmed). The control result is written next to the links.
used_for_link: every item (any class) whose words hit the term set that MADE the link (matched complaint, diagnosis, drug words) is flagged (cap_bundle.py).
Box only (0600 outputs). Single-threaded; run at nice 10.
"""
import csv, collections, datetime as dt, difflib, glob, json, math, os, re, sys
HOME = os.path.expanduser("~/eta-data/")
DAY = os.environ.get("CAP_DAY", "2026-09-25"); TAG = os.environ.get("CAP_TAG", "")     # W33.4b: the day is a parameter; 25 Sep with no tag is exactly CAP-1 (paths unchanged)
if DAY == "2026-09-25" and not TAG:
    OUT, RAW, ROWS = HOME + "cap/2026-09-25/", HOME + "cap/raw/", HOME + "encounter-truth/rows.csv"
else:
    OUT, RAW, ROWS = HOME + f"cap/{DAY}{TAG}/", HOME + f"cap/raw-{DAY}{TAG}/", HOME + f"cap/{DAY}{TAG}/rows.csv"
METRIC = "frac"            # "frac" = matched idf / total idf of the level's terms; "sum" = matched idf (absolute)
USE_HUB_TEXT = False        # tried on 26 Sep (complaint + history + examination text of the same Rx): NO gain; kept OFF, see CAP-1-DESIGN.md D3
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
MIN_SPEECH_S = 20.0          # a room is a candidate for a consult only if it has at least this much speech inside the consult span
PAD_S = 30.0                 # consult span = called_at - PAD .. completed_at + PAD
SHIFTS_MIN = (-150, -90, 90, 150)
MAX_FALSE = dict(any=0.05, confirmed=0.01)
LEVELS = (("TC", ("C", "N")), ("TCD", ("C", "N", "D")), ("TCDM", ("C", "N", "D", "M")))
RANK = {"confirmed": 2, "probable": 1, "none": 0}
STOP = set("this that with have from they them then were what when your about there their would could should which while being also into just like will been only some very much more than other over such these those here where who whom does done doing dont didnt cant wont okay yeah please thank thanks sir madam ma'am patient doctor tablet tablets take taking days day time week weeks month months today tomorrow again first second good well come going want need know think said".split())


HONOR = set("mister miss mrs smt shri shree master baby kumari kumar sri late".split()) - {"kumar"}      # kumar is a name part, not an honorific


def name_toks(s):
    return sorted({t for t in re.findall(r"[a-z]{4,}", (s or "").lower()) if t not in HONOR})


def toks(s):
    return [t for t in re.findall(r"[a-z]{4,}", (s or "").lower()) if t not in STOP]


def parse_t(s):
    """ISO-ish timestamps in the box files: '2026-09-25 08:58:49 +0530', '2026-09-25T08:58:49+0530', '...Z', '...+00:00'."""
    s = s.strip().replace("Z", "+00:00")
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*([+-])(\d{2}):?(\d{2})$", s)
    if not m:
        raise ValueError("unparsed timestamp")
    return dt.datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}{m.group(3)}{m.group(4)}:{m.group(5)}")


def load_windows():
    """One record per (room, window): the first ok record by file time. Searches EVERY run dir for the day's
    date-subdirectory, not just runs named for the day/day+1: hist-bulk's tier-B backlog drains can process a
    day's audio under a much later run_id (22/23 Sep's audio lives entirely under 25-Sep-dated drain runs,
    hist-bulk #4647). The date is already scoped correctly by the /{DAY}/ path segment; restricting by the
    run_id's own date was only ever a (wrong) narrowing heuristic, not a correctness requirement.
    Filenames are either c-{DAY}_... (newer) or {DAY}_... (older backlog) - verified byte-for-byte
    key-compatible JSON schema between the two (hist-bulk #4647); match either."""
    files = sorted(glob.glob(HOME + f"hist/runs/*/*/{DAY}/*{DAY}_*.json"), key=os.path.getmtime)
    got = {}
    for f in files:
        try:
            j = json.load(open(f))
        except Exception:
            continue
        if not (j.get("ok") is True and j.get("state", "done") == "done" and not j.get("error")):
            continue
        wid = j.get("window_id")
        if wid and wid not in got:
            parts = f.split("/runs/", 1)[1].split("/")
            got[wid] = dict(path=f, run_id=parts[0], rec=j, k=f.split("/runs/", 1)[1][:-5])
    return got


def load_english():
    ann = {}
    for p in sorted(glob.glob(HOME + "lab-vault/staged/annotations/translation/*/*/*-linker.json"), key=os.path.basename):
        for it in json.load(open(p))["items"]:
            ann[(it["k"], it["i"])] = it
    return ann


def segments(windows, ann):
    segs = []
    for wid, w in windows.items():
        j = w["rec"]; t0 = parse_t(j["start"]); room = j["room_id"]
        for i, s in enumerate(j.get("segments") or []):
            txt = (s.get("text") or "").strip()
            if not txt:
                continue
            a = ann.get((w["k"], i))
            segs.append(dict(room=room, window_id=wid, k=w["k"], i=i, t0=t0 + dt.timedelta(seconds=float(s.get("start_s") or 0)), t1=t0 + dt.timedelta(seconds=float(s.get("end_s") or 0)),
                             lang=(s.get("lang") or "").lower(), engine=s.get("engine"), text=txt, refused=bool(s.get("refused")), refused_reason=s.get("refused_reason"),
                             en=(a or {}).get("en"), q=(a or {}).get("q") if a else None))
    segs.sort(key=lambda s: (s["room"], s["t0"]))
    return segs


def span_text(segs_room, a, b):
    """(speech seconds, latin tokens) of a room's segments overlapping [a, b]. English segments count their own text; Indic ones count their 337b English where it exists."""
    sec = 0.0; words = []
    for s in segs_room:
        if s["t1"] < a or s["t0"] > b:
            continue
        ov = (min(s["t1"], b) - max(s["t0"], a)).total_seconds()
        if ov <= 0:
            continue
        sec += ov
        words += toks(s["text"] if s["lang"] in ("en", "english") else (s["en"] or ""))
        if s["lang"] not in ("en", "english"):
            words += toks(s["text"])          # romanised Indic and mixed text still carries Latin words
    return sec, words


def fuzzy_hit(term, words):
    for w in words:
        if abs(len(w) - len(term)) <= 3 and (w == term or difflib.SequenceMatcher(None, term, w).ratio() >= 0.82):
            return True
    return False


def merged_consults():
    """One row per consult TOKEN: span = earliest called_at .. latest completed_at; the Rx uids are the union (eta-refuter-2 #3491.2)."""
    rows = [r for r in csv.DictReader(open(ROWS)) if r["day"] == DAY and r["completed_at"]]
    by = collections.OrderedDict()
    for r in rows:
        m = by.setdefault(r["token_uid"], dict(token_uid=r["token_uid"], called=[], completed=[], rx=set(), steps=0))
        m["called"].append(parse_t(r["called_at"])); m["completed"].append(parse_t(r["completed_at"])); m["steps"] += 1
        m["rx"] |= {u for u in re.split(r"[;|, ]+", r["rx_uids"]) if u}
    return [dict(token_uid=t, called=min(m["called"]), completed=max(m["completed"]), rx=sorted(m["rx"]), steps=m["steps"]) for t, m in by.items()]


class Ctx:
    """The day's evidence: room segments, idf, per-consult term sets."""
    def __init__(self):
        self.windows = load_windows(); self.ann = load_english(); self.segs = segments(self.windows, self.ann)
        self.by_room = collections.defaultdict(list)
        for s in self.segs:
            self.by_room[s["room"]].append(s)
        self.rooms = sorted(self.by_room)
        df = collections.Counter(); self.ndoc = 0
        for wid, w in self.windows.items():
            self.ndoc += 1; words = set()
            for s in self.by_room[w["rec"]["room_id"]]:
                if s["window_id"] == wid:
                    words.update(toks(s["text"])); words.update(toks(s["en"] or ""))
            df.update(words)
        self.df = df; self._cache = {}

    def idf(self, t):
        return math.log((self.ndoc + 1) / (self.df.get(t, 0) + 1))

    def room_span(self, room, a, b):
        k = (room, a, b)
        if k not in self._cache:
            self._cache[k] = span_text(self.by_room[room], a, b)
        return self._cache[k]

    def candidates(self, terms, a, b):
        cand = {}
        for room in self.rooms:
            sec, words = self.room_span(room, a, b)
            if sec >= MIN_SPEECH_S:
                ws = set(words)
                cand[room] = dict(sec=sec, **{k: {t for t in ts if t in ws or fuzzy_hit(t, words)} for k, ts in terms.items()})
        return cand


def level_score(ctx, terms, c, keys):
    """(matched idf / total idf of the level's terms, matched term count) for one candidate room."""
    allt = set()
    for k in keys:
        allt |= set(terms[k])
    tot = sum(ctx.idf(t) for t in allt)
    m = set()
    for k in keys:
        m |= c[k]
    ms = sum(ctx.idf(t) for t in m)
    return ((ms / tot if tot > 0 else 0.0) if METRIC == "frac" else ms), len(m)


def level_tops(ctx, terms, cand):
    """Per level: the best room, its score, matched count and the margin over the second room (None if no candidate)."""
    out = {}
    for lv, keys in LEVELS:
        sc = sorted(((level_score(ctx, terms, c, keys), room) for room, c in cand.items()), key=lambda x: (x[0][0], x[0][1]), reverse=True)
        if not sc or not any(terms[k] for k in keys):
            out[lv] = None; continue
        (top, nm), room = sc[0]; second = sc[1][0][0] if len(sc) > 1 else 0.0
        out[lv] = dict(room=room, top=top, nm=nm, margin=top - second)
    return out


def decide(ctx, terms, cand, th):
    """The link decision for one span: best status over the levels, ties to the LEAST circular level. Returns (status, basis, room, top, nm, margin, matched terms)."""
    tops = level_tops(ctx, terms, cand); best = None
    for lv, keys in LEVELS:
        t = tops[lv]
        if t is None:
            st, room, top, nm, margin = "none", None, 0.0, 0, 0.0
        else:
            top, nm, margin, room = t["top"], t["nm"], t["margin"], t["room"]
            need = 0.15 if METRIC == "frac" else 0.25 * top
            st = "confirmed" if (top >= th[lv]["hi"] and nm >= 2 and margin >= need) else ("probable" if (top >= th[lv]["lo"] and nm >= 1 and margin > 0) else "none")
        cur = (RANK[st], -[x[0] for x in LEVELS].index(lv))
        if best is None or cur > best[0]:
            best = (cur, lv, st, room, top, nm, margin)
    _, lv, st, room, top, nm, margin = best
    matched = set()
    if st != "none":
        for k in dict(LEVELS)[lv]:
            matched |= cand[room][k]
    return st, (lv if st != "none" else None), (room if st != "none" else None), top, nm, margin, matched


def quantile(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))] if v else 1.0


def calibrate(ctx, recs):
    """Thresholds through the same selection: null trials = each consult's term sets against the same-length span shifted by SHIFTS_MIN. Smallest percentile pair with false-link rate <= 5% (any) and <= 1% (confirmed)."""
    trials = []
    for r in recs:
        for sh in SHIFTS_MIN:
            a2, b2 = r["a"] + dt.timedelta(minutes=sh), r["b"] + dt.timedelta(minutes=sh)
            cand = ctx.candidates(r["terms"], a2, b2)
            if cand:
                trials.append((r["terms"], cand))
    nullscores = {lv: [] for lv, _ in LEVELS}
    tops_cache = []
    for terms, cand in trials:
        tops = level_tops(ctx, terms, cand); tops_cache.append(tops)
        for lv, _ in LEVELS:
            if tops[lv] is not None:
                nullscores[lv].append(tops[lv]["top"])
    best = None
    for qlo in (0.90, 0.93, 0.95, 0.97, 0.98, 0.99, 0.995, 1.0):
        for qhi in (0.97, 0.98, 0.99, 0.995, 1.0):
            if qhi < qlo:
                continue
            th = {lv: dict(lo=quantile(nullscores[lv], qlo), hi=quantile(nullscores[lv], qhi)) for lv, _ in LEVELS}
            if qlo == 1.0:
                th = {lv: dict(lo=max(nullscores[lv] or [0]) + 1e-9, hi=max(nullscores[lv] or [0]) + 1e-9) for lv, _ in LEVELS}
            res = [decide(ctx, terms, cand, th)[0] for terms, cand in trials]
            fa = sum(1 for s in res if s != "none") / max(len(res), 1); fc = sum(1 for s in res if s == "confirmed") / max(len(res), 1)
            if fa <= MAX_FALSE["any"] and fc <= MAX_FALSE["confirmed"]:
                best = (th, dict(q_lo=qlo, q_hi=qhi, false_link_rate=round(fa, 4), false_confirmed_rate=round(fc, 4), null_trials=len(trials)))
                break
        if best:
            break
    if best is None:
        th = {lv: dict(lo=max(nullscores[lv] or [0]) + 1e-9, hi=max(nullscores[lv] or [0]) + 1e-9) for lv, _ in LEVELS}
        best = (th, dict(q_lo=None, q_hi=None, false_link_rate=0.0, false_confirmed_rate=0.0, null_trials=len(trials), note="no percentile pair met the false-link limits: nothing links"))
    return best


def main():
    ctx = Ctx()
    consults = merged_consults()
    items = [json.loads(l) for l in open(OUT + "items.jsonl")]
    main_rows = {}
    d = json.load(open(RAW + "dpipe_main.json")); c = d["cols"]
    for r in d["rows"]:
        m = dict(zip(c, r)); main_rows[m["presc_uid"]] = m
    it_by_c = collections.defaultdict(list)
    for it in items:
        it_by_c[it["consult_id"]].append(it)
    hub = {}
    if USE_HUB_TEXT and os.path.exists(RAW + "hub_history.json"):
        hd = json.load(open(RAW + "hub_history.json")); hc = hd["cols"]
        hub = {r[hc.index("uid")]: dict(zip(hc, r)) for r in hd["rows"]}
    names = {}
    if os.path.exists(RAW + "dpipe_names.json"):
        nd = json.load(open(RAW + "dpipe_names.json")); nc = nd["cols"]
        names = {r[nc.index("presc_uid")]: r[nc.index("name")] for r in nd["rows"]}       # PHI: patient name words are used ONLY to link (a non-scored field), never written to the bundle
    recs = []
    for cs in consults:
        a = cs["called"] - dt.timedelta(seconds=PAD_S); b = cs["completed"] + dt.timedelta(seconds=PAD_S)
        its = it_by_c.get(cs["token_uid"], [])
        rxs = [main_rows[u] for u in cs["rx"] if u in main_rows]
        comp = sorted({t for rx in rxs for t in toks(rx.get("presenting_complaint")) + (toks(hub.get(rx["presc_uid"], {}).get("complaints")) + toks(hub.get(rx["presc_uid"], {}).get("exam")) if USE_HUB_TEXT else [])})
        dtok = sorted({t for it in its if it["cls"] == "diagnosis" for t in toks(it["text"])})
        mtok = sorted({t for it in its if it["cls"] == "drug" for n in it.get("alt", [it["text"]]) for t in toks(n)})
        ntok = sorted({t for rx in rxs for t in name_toks(names.get(rx["presc_uid"]))})
        terms = dict(C=comp, N=ntok, D=dtok, M=mtok)
        recs.append(dict(consult=cs["token_uid"], a=a, b=b, terms=terms, n_items=len(its), steps=cs["steps"], cand=ctx.candidates(terms, a, b)))
    th, ctrl = calibrate(ctx, recs)
    links, matched_terms = [], {}
    for r in recs:
        st, lv, room, top, nm, margin, matched = decide(ctx, r["terms"], r["cand"], th)
        matched_terms[r["consult"]] = sorted(matched)
        links.append(dict(consult_id=r["consult"], status=st, basis=lv, room=room, score=round(top, 3), matched_terms=nm, margin=round(margin, 3), n_candidate_rooms=len(r["cand"]), n_items=r["n_items"],
                          has_complaint_terms=bool(r["terms"]["C"]), has_name_terms=bool(r["terms"]["N"]), time_src="pqm", evidence_src="dpipe.presenting_complaint + dpipe.name (non-scored fields)", merged_steps=r["steps"], span=[r["a"].isoformat(), r["b"].isoformat()]))
    return links, th, ctrl, matched_terms


if __name__ == "__main__":
    if not TAG and os.path.exists(OUT + "MANIFEST.sha256"):    # eta-refuter-2 #4680: generic, not hardcoded to 25 Sep. Guard is HERE (CLI entry point), not at module level,
        raise SystemExit(f"refused: {OUT} already has a MANIFEST.sha256 (a frozen bundle); set CAP_TAG for a check run")  # so cap_bundle.py can still `import cap_link as L` to regenerate an already-bundled day's package
    links, th, ctrl, matched = main()
    os.makedirs(OUT, exist_ok=True)
    with open(OUT + "links.jsonl", "w") as f:
        for l in links:
            f.write(json.dumps(l) + "\n")
    os.chmod(OUT + "links.jsonl", 0o600)
    ncand = sum(1 for l in links if l["n_candidate_rooms"] > 0)
    exp = dict(consults_with_candidate_rooms=ncand, expected_false_links_any=round(ctrl["false_link_rate"] * ncand, 1), expected_false_links_confirmed=round(ctrl["false_confirmed_rate"] * ncand, 1),
               observed_links_any=sum(1 for l in links if l["status"] != "none"), observed_links_confirmed=sum(1 for l in links if l["status"] == "confirmed"))
    json.dump(dict(thresholds=th, control=ctrl, expected=exp, shifts_min=list(SHIFTS_MIN), limits=MAX_FALSE), open(OUT + "link_thresholds.json", "w"), indent=1); os.chmod(OUT + "link_thresholds.json", 0o600)
    os.makedirs(RAW, exist_ok=True)
    json.dump(matched, open(RAW + "link_terms.json", "w")); os.chmod(RAW + "link_terms.json", 0o600)      # private: the terms that made each link (never in the bundle)
    print("control", ctrl)
    print("consults", len(links), "unique", len({l['consult_id'] for l in links}), dict(collections.Counter((l["status"], l["basis"]) for l in links)))
    byroom = collections.defaultdict(collections.Counter)
    for l in links:
        byroom[l["room"] or "none"][l["status"]] += 1
    for r_, c in sorted(byroom.items()):
        print(r_, dict(c))
