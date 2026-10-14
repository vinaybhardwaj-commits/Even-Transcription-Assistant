#!/usr/bin/env python3
"""ROOMSUB rev7: voice-free daily PRE-COUNT against PREREG_ROOMSUB_v1.rev7.DRAFT.md (sha16 b46d5b20e8a281c7). Replaces the rev5 script (rev5 is closed NOT TESTABLE).
CPU only. No embedding is decoded, no similarity computed, no known print opened, no audio read, no GPU. Outputs: box only, dir 0700, files 0600. Counts only on the bus.

Modes:
  --dry   the daily pre-count (pre-reg sections 2, 4, 7, 8, 10) on the NEWEST ~/eta-data/consult/encounter-windows-*.jsonl: eligible windows, usable days,
          qualification of every (doctor, room) pair, the rank and the 3 controls, the frozen-sex-table check, the negative-control checkable list,
          second-person data, and the projected first qualifying date. Writes roomsub/precount_rev7_<last-export-day>.json.
  --run   REFUSES unless env GO2=b46d5b20 (checked before anything is loaded). Even with GO2 it stops: the rev7 run (GPU extraction of the Oct windows,
          steps 0-4, P2-P5) is not written in this revision and needs its own review.
Reused UNCHANGED (sha-pinned, asserted): mine_guards 4cd327ca (exec'd up to its trailing main(): dedupe, truth_days), heldout f672c1ef + union f07171dc,
mine_centroid_multi 463042a0, mine_proposals 55d28d3b, guards.json 6e62e272, proposals.json 13443900958e1d75."""
import os, sys
if not __debug__: sys.exit("REFUSED: python -O disables the asserts")
PREREG16, GO2_VALUE = "b46d5b20e8a281c7", "b46d5b20"
if __name__ == "__main__" and "--run" in sys.argv and os.environ.get("GO2") != GO2_VALUE:   # nothing is loaded before this
    sys.exit(f"REFUSED: --run needs env GO2={GO2_VALUE} (a separate GO from consult-lead). Use --dry for the voice-free pre-count.")
os.environ.setdefault("OMP_NUM_THREADS", "2"); os.environ.setdefault("MKL_NUM_THREADS", "2"); os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
import collections, csv, datetime as dt, glob, hashlib, importlib.util, json, math

E = os.path.expanduser("~/eta-data"); CM = f"{E}/centroid-mint"; RES = f"{E}/voiceprint-rollout-hf/results/proposal"; CAND = f"{E}/voiceprint-rollout/candidates"
OUT = f"{CM}/roomsub"; EXPORT_GLOB = f"{E}/consult/encounter-windows-*.jsonl"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
MIN_SPEECH, MIN_USABLE_WIN = 15.0, 3                       # cluster >= 15 s; usable own day = >= 3 eligible windows
OWN_DAYS, M_WIN, H_DAYS, H_DAY_WIN = 4, 5, 2, 3            # section 4 OWN
A_DAYS, A_SESS, B_DAYS, B_SESS, G_N = 2, 3, 2, 20, 20      # section 4 ABSENT (B_SESS = G_N: the guard set is the first 20)
SHARE_N, SHARE_DAYS, N_CONTROLS, MIN_NEG_CHECKABLE = 10, 2, 3, 3
SEP_LO, SEP_HI, OCT_FIRST, LAST_RUN_DAY = "2026-09-19", "2026-09-29", "2026-10-02", "2026-10-31"
PINS = {f"{CM}/mine_guards.py": "4cd327ca", f"{CM}/proposals/guards.json": "6e62e272", f"{CM}/mine_centroid_multi.py": "463042a05f1aeae3",
        f"{CM}/mine_proposals.py": "55d28d3b742fcec3", f"{E}/drtpqma/heldout.py": "f672c1ef", f"{CM}/manoj_session_list.json": "f07171dc",
        f"{CM}/proposals/proposals.json": "13443900958e1d75", f"{OUT}/PREREG_ROOMSUB_v1.rev7.DRAFT.md": PREREG16, f"{OUT}/SEXTABLE_rev7.FROZEN.csv": "836b0095e0bf6c6c"}
SLUG2ROOM = {"opd-1-xqj7": "room_yh3etjpf", "opd-4-ortho-778q": "room_ux92qpws", "opd-7-y74w": "room_qyzghzaf", "opd-5-dr-salanki-wxmp": "room_4ggnkg5x",
             "cardiology-opd-gh4a": "room_bh6jtq4t", "opd-6-webcam-only-am8n": "room_pnyc9u49", "opd-3-kjpf": "room_87frpus9"}   # == tape manifest bench/<slug>/ -> room_id (7 slugs seen)
NEG_DOCTORS = {"salanki": "MFTZnXMshE91P7fHnqgX", "animesh": "mGXTEDg9o9WNR9gpZ4sY", "ankit": "F092iDIAfwXKtLCqP8HS"}   # Poornima reported separately, Manoj excluded


def f16(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
def go_ok(env): return env.get("GO2") == GO2_VALUE
def split_ab(days):
    """Odd positions (1st, 3rd, ...) = A, even positions = B; sorted ascending, no seed."""
    d = sorted(set(days)); return d[0::2], d[1::2]
def ist_day(t): return dt.datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")
def usable_days(win_by_day): return {d: n for d, n in win_by_day.items() if n >= MIN_USABLE_WIN}
def own_check(usable):
    """usable: day -> eligible windows. M = odd positions, H = even positions (>= 2 H days, each H day already >= 3 windows by construction)."""
    d = sorted(usable); M, H = split_ab(d); mw = sum(usable[x] for x in M)
    return dict(usable_days=len(d), M_days=len(M), M_win=mw, H_days=len(H), ok=len(d) >= OWN_DAYS and len(M) >= 2 and mw >= M_WIN and len(H) >= H_DAYS)
def absent_check(sess):
    """sess: list of (day, t_start, source) already filtered to D-absent days; source 'sep' or 'oct'."""
    sess = sorted(sess); days = sorted({s[0] for s in sess}); A, B = split_ab(days); As, Bs = set(A), set(B)
    a = [s for s in sess if s[0] in As]; b = [s for s in sess if s[0] in Bs]; g = b[:G_N]; octin = lambda L: any(s[2] == "oct" for s in L)
    return dict(A_days=len(A), A_sess=len(a), B_days=len(B), B_sess=len(b), A_oct=octin(a), B_oct=octin(b), G_oct=octin(g),
                ok=len(A) >= A_DAYS and len(a) >= A_SESS and len(B) >= B_DAYS and len(b) >= B_SESS and octin(a) and octin(b) and octin(g))
def share_check(others_by_day): return dict(n=sum(others_by_day.values()), days=len([d for d, n in others_by_day.items() if n > 0]), ok=sum(others_by_day.values()) >= SHARE_N and len([d for d, n in others_by_day.items() if n > 0]) >= SHARE_DAYS)
def rank_key(r): return (-r["usable_days"], -r["usable_windows"], r["uid"])
def best_room(rows):
    seen = {}
    for r in sorted(rows, key=rank_key): seen.setdefault(r["uid"], r)
    return sorted(seen.values(), key=rank_key)
def clinic_day(k, start=dt.date(2026, 10, 6)):
    d, n = start, 0
    while n < k:
        d += dt.timedelta(days=1)
        if d.weekday() != 6: n += 1
    return d


def verify_pins():
    for p, pre in PINS.items():
        h = hashlib.sha256(open(p, "rb").read()).hexdigest(); assert h.startswith(pre), f"sha mismatch {os.path.basename(p)}: {h[:16]} != {pre} (STOP)"


def load_mod(path, name):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


def load_clips(uid, ho):
    """Stored Sep clips of one doctor, METADATA only (ids, dates, rooms, speech seconds, 'has an embedding'): no embedding is kept or decoded."""
    sp = {}
    for sx in json.load(open(f"{CAND}/{uid}.json"))["sessions"]:
        a = dt.datetime.fromisoformat(sx["span_start_utc"]).astimezone(IST); b = dt.datetime.fromisoformat(sx["span_end_utc"]).astimezone(IST)
        for c in sx["candidates"]: sp[f"{sx['date']}_{c['room_id']}_{sx['token_uid']}"] = dict(a=a, b=b, tok=sx["token_uid"])
    out = []
    for f in sorted(glob.glob(f"{RES}/{uid}/embeddings/*.json")):
        d = json.load(open(f)); cid = d["clip_id"]; s = sp[cid]
        has15 = any(c.get("embedding_b64") is not None and c["total_speech_sec"] >= MIN_SPEECH for c in d["clusters"])
        out.append(dict(uid=uid, cid=cid, date=cid.split("_")[0], room="_".join(cid.split("_")[1:3]), a=s["a"], b=s["b"], tok=s["tok"], has15=has15))
    return out


def sep_blind(c, union, ho):
    """Sep clip blind test: start day, end-minus-1 s day AND the clip-id date (the three tests of the rev5 script)."""
    sd, ed = c["a"].date().isoformat(), (c["b"] - dt.timedelta(seconds=1)).date().isoformat()
    return any(ho.is_held_out(union, d, c["room"]) for d in {sd, ed, c["date"]})


def newest_export():
    fs = sorted(glob.glob(EXPORT_GLOB), key=os.path.getmtime); assert fs, f"no export matches {EXPORT_GLOB}"; return fs[-1]


def tape_index():
    tp = collections.defaultdict(list); mp = f"{E}/tapes/manifest.jsonl"
    for l in open(mp):
        if l.strip():
            x = json.loads(l); s = dt.datetime.fromisoformat(x["started_at"].replace("Z", "+00:00")).timestamp(); tp[x["room_id"]].append((s, s + x["duration_ms"] / 1000))
    return tp, f16(mp)


def load_windows(path, ho, union, tp):
    W = [json.loads(l) for l in open(path) if l.strip()]
    cov = lambda room, a, b: sum(max(0, min(b, e) - max(a, s)) for s, e in tp[room]) / (b - a)
    for r in W:
        assert r["room_slug"] in SLUG2ROOM, f"unmapped room_slug {r['room_slug']} (REFUSED)"
        r["room"] = SLUG2ROOM[r["room_slug"]]; r["day"] = ist_day(r["t_open"]); r["uid"] = r.get("consulting_doctor_uid")
        r["blind"] = bool(r["t_close"]) and any(ho.is_held_out(union, d, r["room"]) for d in {ist_day(r["t_open"]), ist_day(r["t_close"] - 1)})
        r["eligible"] = bool(r["quality"] == "clean" and r["t_close"] and r["uid"] and r["close_reason"] not in ("open", "cap_90m") and r["t_close"] - r["t_open"] >= 60
                             and cov(r["room"], r["t_open"], r["t_close"]) >= 0.5 and not r["blind"])
    el = sorted([r for r in W if r["eligible"]], key=lambda r: (r["room"], r["t_open"])); drop = set()
    for i, a in enumerate(el):                             # two-doctor overlap in one room: drop BOTH
        for b in el[i + 1:]:
            if b["room"] != a["room"] or b["t_open"] >= a["t_close"]: break
            if a["uid"] != b["uid"]: drop.add(a["consult_uid"]); drop.add(b["consult_uid"])
    for r in W:
        if r["consult_uid"] in drop: r["eligible"] = False
    return W, len(drop)


def load_sex_table():
    t = {}
    for row in csv.DictReader(open(f"{OUT}/SEXTABLE_rev7.FROZEN.csv")): t[row["doctor_uid"]] = dict(sex=row["sex"], uncertain=row["uncertain"] == "Y", name=row["doctor_name_as_in_export"])
    return t


def precount():
    verify_pins()
    ho = load_mod(f"{E}/drtpqma/heldout.py", "heldout"); union, usha = ho.load_union()
    src = open(f"{CM}/mine_guards.py").read(); assert src.rstrip().endswith("\nmain()")
    ns = {"__file__": f"{CM}/mine_guards.py", "__name__": "mine_guards_frozen"}; exec(compile(src.rsplit("\nmain()", 1)[0], f"{CM}/mine_guards.py", "exec"), ns)
    td = ns["truth_days"](); all_open = set().union(*td.values()); dedupe = ns["dedupe"]
    exp = newest_export(); exp16 = f16(exp); tp, man16 = tape_index(); W, n_overlap = load_windows(exp, ho, union, tp); sex = load_sex_table()
    E_ = [r for r in W if r["eligible"]]; last_day = max(r["day"] for r in W); first_day = min(r["day"] for r in W)
    uids = sorted(os.path.basename(p) for p in glob.glob(RES + "/*") if os.path.isdir(p))
    sep = [c for u in uids for c in load_clips(u, ho) if c["has15"] and not sep_blind(c, union, ho)]
    anyday = collections.defaultdict(set); nonclean = collections.defaultdict(set)
    for r in W:
        if r["uid"]: anyday[r["uid"]].add(r["day"])
        if r["quality"] != "clean": nonclean[r["room"]].add(r["day"])
    sep_days_n = lambda u: sum(1 for d in td.get(u, ()) if SEP_LO <= d <= SEP_HI)
    first_truth = lambda u: min(td.get(u, {"9999-12-31"}))

    def pools(D, R):
        sess = []
        if sep_days_n(D) >= 3:                                                  # B7: D must be covered by the Sep source
            pool = [c for c in sep if c["uid"] != D and c["room"] == R and SEP_LO <= c["date"] <= SEP_HI and c["date"] in all_open and c["date"] not in td.get(D, set()) and c["date"] >= first_truth(D)]
            sess += [(c["date"], c["a"].timestamp(), "sep") for c in dedupe(pool)]
        sess += [(r["day"], r["t_open"], "oct") for r in E_ if r["room"] == R and r["uid"] != D and OCT_FIRST <= r["day"] <= last_day and r["day"] not in anyday[D] and r["day"] not in nonclean[R]]
        return sess

    own = collections.defaultdict(lambda: collections.defaultdict(int)); name = {}
    for r in E_: own[(r["uid"], r["room"])][r["day"]] += 1; name[r["uid"]] = r["consulting_doctor_name"]
    rows = []
    for (u, R), win0 in own.items():
        win = usable_days(win0)
        if not win: continue
        oc = own_check(win); ab = absent_check(pools(u, R))
        oth = collections.Counter(r["day"] for r in E_ if r["room"] == R and r["uid"] != u and r["day"] in win); sh = share_check(oth)
        sx = sex.get(u); sex_ok = bool(sx) and not sx["uncertain"]
        rd = [r for r in W if r["room"] == R and r["day"] in win]
        rows.append(dict(uid=u, doc=name[u], room=ho.LABEL[R], room_id=R, usable_days=oc["usable_days"], usable_windows=sum(win.values()), eligible_days_all=len(win0), eligible_windows_all=sum(win0.values()),
                         own=dict(win), own_check=oc, absent=ab, share=sh, sex=(sx or {}).get("sex"), sex_uncertain=(sx or {}).get("uncertain", True), sex_ok=sex_ok, sep_days_of_D=sep_days_n(u),
                         other_doctor_uids_same_roomday=len({r["uid"] for r in rd if r["uid"] not in (u, None)}), multi_doctor_windows=sum(1 for r in rd if r["quality"] == "multi_doctor"),
                         unattributed_windows=sum(1 for r in rd if r["quality"] == "unattributed"), qualifies=oc["ok"] and ab["ok"] and sh["ok"] and sex_ok))
    best = best_room([r for r in rows if r["qualifies"]]); controls = best[:N_CONTROLS]
    # negative control: the frozen rev5 pair list, checkable = the section-4 ABSENT conditions at this export
    P5 = json.load(open(f"{OUT}/precount_e8dfa14d.json")); neg = []
    for r in P5["non_home_pairs_all"]:
        if r["testable"] and r["doctor"] in NEG_DOCTORS:
            ab = absent_check(pools(NEG_DOCTORS[r["doctor"]], r["room_id"])); neg.append(dict(doctor=r["doctor"], room=r["room"], n_embedded_sessions=r["n_embedded_sessions"], checkable=ab["ok"], **ab))
    n_chk = sum(1 for n in neg if n["checkable"])
    proj = project(rows, pools, last_day, W)
    status = "RUN-READY (>= 3 doctors qualify and >= 3 checkable negatives)" if len(controls) >= N_CONTROLS and n_chk >= MIN_NEG_CHECKABLE else \
             ("NOT READY: >= 3 qualify but negative checkable pairs < 3 (would be NOT TESTABLE)" if len(controls) >= N_CONTROLS else "NOT READY: fewer than 3 doctors qualify")
    if last_day > LAST_RUN_DAY: status = "PAST LAST RUN DAY (31 Oct): NOT TESTABLE if nothing qualified"
    res = dict(prereg16=PREREG16, script16=f16(__file__), union16=usha, export=os.path.basename(exp), export16=exp16, export_first_day=first_day, export_last_day=last_day, tape_manifest16=man16,
               rows=len(W), closed=sum(1 for r in W if r["t_close"]), eligible_windows=len(E_), two_doctor_overlap_dropped=n_overlap, status=status, n_qualifying_pairs=sum(1 for r in rows if r["qualifies"]),
               qualifying_doctors=len(best), controls=[dict(doc=c["doc"], room=c["room"], uid=c["uid"], usable_days=c["usable_days"], usable_windows=c["usable_windows"], sex=c["sex"]) for c in controls],
               negative_pairs=neg, negative_checkable=n_chk, negative_bar=("NOT TESTABLE (< 3 checkable)" if n_chk < MIN_NEG_CHECKABLE else "testable"), projection=proj,
               pairs=sorted(rows, key=rank_key))
    os.makedirs(OUT, mode=0o700, exist_ok=True); os.chmod(OUT, 0o700)
    p = f"{OUT}/precount_rev7_{last_day}.json"; fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: fh.write(json.dumps(res, indent=1, sort_keys=True, default=str))
    print(json.dumps({k: res[k] for k in ("prereg16", "script16", "export", "export16", "export_first_day", "export_last_day", "rows", "closed", "eligible_windows", "two_doctor_overlap_dropped",
                                          "n_qualifying_pairs", "qualifying_doctors", "negative_checkable", "negative_bar", "status")}, indent=1))
    for r in sorted(rows, key=rank_key):
        print(f"  {r['doc'][:26]:26} {r['room']:10} usable {r['usable_days']}d/{r['usable_windows']}w own={r['own_check']['ok']} abs={r['absent']['ok']} share={r['share']['ok']} sex={r['sex']}{'?' if r['sex_uncertain'] else ''} Q={r['qualifies']}")
    print("  projection:", json.dumps(proj["first_date_3_doctors"]))
    print("precount file", p, f16(p))


def project(rows, pools, last_day, W):
    """Voice-free projection (section 10): clinic days Mon-Sat, the days of the export up to the first Sunday-free window. OBSERVED model: absent days accrue at the observed Oct absent
    clinic-day rate; BEST-CASE: D away on every clinic day he does not attend. Synthetic days carry the pair's mean windows per own day and the room's mean other-doctor windows."""
    clin = [d for d in sorted({r["day"] for r in W}) if dt.date.fromisoformat(d).weekday() != 6 and d != "2026-10-02"]; n_clin = max(1, len(clin))
    room_mean = {}
    for R in {r["room_id"] for r in rows}:
        c = collections.Counter(w["day"] for w in W if w["eligible"] and w["room"] == R); room_mean[R] = max(1, round(sum(c.values()) / len(c))) if c else 1
    out = {"observed": [], "best-case": []}
    start = dt.date.fromisoformat(last_day)
    for r in best_room(rows):
        if not r["sex_ok"]: continue
        u, R = r["uid"], r["room_id"]; win = dict(r["own"]); p = sum(1 for d in win if d in clin) / n_clin
        octabs = {s[0] for s in pools(u, R) if s[2] == "oct"}; a_obs = sum(1 for d in octabs if d in clin) / n_clin
        mw = max(MIN_USABLE_WIN, round(r["usable_windows"] / r["usable_days"])); mo = round(r["share"]["n"] / max(1, r["usable_days"]))
        def own_ok_after(k):
            w2 = {**win, **{f"2099-01-{i + 1:02d}": mw for i in range(k)}}
            return own_check(w2)["ok"] and r["share"]["n"] + k * mo >= SHARE_N and r["share"]["days"] + (k if mo > 0 else 0) >= SHARE_DAYS
        k_own = next((k for k in range(31) if own_ok_after(k)), None)
        base = pools(u, R)
        k_abs = next((k for k in range(31) if absent_check(base + [(f"2099-02-{i + 1:02d}", float(i), "oct") for i in range(k) for _ in range(room_mean[R])])["ok"]), None)
        for mode, a in (("observed", a_obs), ("best-case", max(0.0, 1 - p))):
            need = lambda k, rate: None if k is None else (0 if k == 0 else (math.ceil(k / rate) if rate > 0 else None))
            to, ta = need(k_own, p), need(k_abs, a); t = None if (to is None or ta is None) else max(to, ta)
            out[mode].append(dict(doc=r["doc"], room=r["room"], k_own=k_own, k_abs=k_abs, p=round(p, 2), a=round(a, 2), t=t, date=None if t is None else clinic_day(t, start).strftime("%Y-%m-%d %a")))
    first = {}
    for mode, L in out.items():
        d = sorted([x for x in L if x["t"] is not None], key=lambda x: x["t"]); first[mode] = d[N_CONTROLS - 1]["date"] if len(d) >= N_CONTROLS else None
    return dict(first_date_3_doctors=first, per_pair=out)


def main():
    if "--run" in sys.argv:
        if not go_ok(os.environ): sys.exit(f"REFUSED: --run needs env GO2={GO2_VALUE}")
        sys.exit("--run: the rev7 run is NOT written in this revision (Oct windows need a GPU extraction under its own GO; the run code needs its own review).")
    elif "--dry" in sys.argv: precount()
    else: sys.exit(__doc__)


if __name__ == "__main__":
    main()
