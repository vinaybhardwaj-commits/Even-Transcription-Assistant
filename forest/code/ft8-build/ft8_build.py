"""FT8 builder: pre-prescription medical-history features, D split only.
Run: ~/.venv-forest/bin/python -I ft8_build.py [--out DIR] [--pull-cut timestamp|day]
Inputs are read-only. No network, no model calls."""
import argparse, hashlib, os, re, sys
import numpy as np
import pandas as pd

HOME = os.path.expanduser("~")
LABELS = f"{HOME}/oc/forest-lead/ft/out/ft-labels-base/labels.parquet"
PULL_A = f"{HOME}/eta-data/forest/ft8/ft8-pull-a.tsv"
PULL_A_DAY = f"{HOME}/eta-data/forest/ft8/ft8-pull-a-day.tsv"
PULL_B = f"{HOME}/eta-data/forest/ft8/ft8-pull-b.tsv"
SQL_A_DAY = f"{HOME}/oc/forest-lead/sql/ft8-pull-a-day.sql"
SQL_A = f"{HOME}/oc/forest-lead/sql/ft8-pull-a.sql"
SQL_B = f"{HOME}/oc/forest-lead/sql/ft8-pull-b.sql"
SPLIT_DIR = f"{HOME}/oc/forest-lead/ft/vendor_split"
OUT = f"{HOME}/oc/forest-lead/ft/out/ft8-clinical"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import icd_map

# --- leakage rule: strict day-level cutoff -------------------------------------------------
MIN_AGE_D = 1   # a used record must be >= 1 day before rx_date (records on the Rx day are excluded)
SENTINEL_DATE = pd.Timestamp("2000-01-01")   # a source date on or before this (e.g. 1970-01-01) is a null-date sentinel: undatable
AGG_BLOCKS = ["util", "icd", "ip", "meds"]   # pull-A aggregates: no per-record date in the pull

# columns of the pulls the builder may read; anything else (esp. OT/booking/admission/bill) is refused
PULL_A_COLS = ["prescription_uid", "n_prior_rx_all", "n_prior_rx_12m", "n_doctors_12m", "days_since_first_rx",
               "prior_rx_icd", "cond_icd", "comorb_names", "n_ip_events_pre", "bp_latest", "bp_age_d",
               "n_meds_latest_prior_rx", "pin_code",
               # day-level pull only: max source timestamp per block, and the IST midnight cut
               "src_max_ts_prior_rx", "src_max_ts_cond", "src_max_ts_comorb", "src_max_ts_ip", "src_max_ts_bp",
               "cut_ist_midnight"]
SRC_TS = ["src_max_ts_prior_rx", "src_max_ts_cond", "src_max_ts_comorb", "src_max_ts_ip", "src_max_ts_bp"]
PULL_B_COLS = ["prescription_uid", "lab", "value", "unit", "age_d", "n_pre"]
FORBIDDEN = re.compile(r"(^|_)(ot|booking|bookings|admission|admit|bill|billing|invoice|surgery_case|case_uid)(_|$)", re.I)

LABS = ["hba1c", "hb", "creat", "egfr", "tsh"]
BLOCKS = ["util", "icd", "ip", "bp", "meds"] + LABS


class CutoffViolation(AssertionError):
    pass


def load_a_b(a_path=PULL_A, b_path=PULL_B):
    a = pd.read_csv(a_path, sep="\t", dtype=str)
    b = pd.read_csv(b_path, sep="\t")
    for df, ok in ((a, PULL_A_COLS), (b, PULL_B_COLS)):
        bad = [c for c in df.columns if FORBIDDEN.search(c) or c not in ok]
        if bad:
            raise ValueError(f"pull has unexpected/forbidden columns: {bad}")
    return a, b


# --- cohort / split guard ----------------------------------------------------------------------
def load_cohort(labels_path=LABELS, guard=None):
    """Reads ONLY split=='D' rows (parquet filter): H rows are never loaded. Then every row is checked
    with split_guard; any row that maps to H is dropped and counted."""
    D = pd.read_parquet(labels_path, filters=[("split", "==", "D")])
    stats = {"n_h_read": 0, "n_labels_D": len(D), "n_dropped_guard_H": 0}
    if guard is None:
        sys.path.insert(0, SPLIT_DIR)
        import split_guard
        guard = split_guard.load()
    sets = D["cluster_key"].map(guard.set_of)
    stats["n_dropped_guard_H"] = int((sets == "H").sum())
    D = D[sets == "D"].copy()
    D["rx_date"] = pd.to_datetime(D["rx_date"]).dt.normalize()
    return D.reset_index(drop=True), stats


# --- parsers -----------------------------------------------------------------------------------
BP_RE = re.compile(r"^\s*(\d{2,3})\s*/\s*(\d{2,3})\s*$")
SBP_RANGE, DBP_RANGE = (60, 260), (30, 160)


def parse_bp(s):
    """-> (sys, dia) or (nan, nan); out-of-range / unparsable -> NaN."""
    m = BP_RE.match(s) if isinstance(s, str) else None
    if not m:
        return np.nan, np.nan, "unparsable" if isinstance(s, str) else "none"
    sy, di = int(m.group(1)), int(m.group(2))
    if not (SBP_RANGE[0] <= sy <= SBP_RANGE[1] and DBP_RANGE[0] <= di <= DBP_RANGE[1]) or sy <= di:
        return np.nan, np.nan, "implausible"
    return float(sy), float(di), "ok"


def _unit_key(u):
    u = str(u).lower().replace("µ", "u").replace("²", "2")
    return re.sub(r"[\s\[\]\.]", "", u)

# unit -> multiplier to the target unit; None = recognised as not convertible -> NaN
UNITS = {
    "hba1c": {"%": 1.0},                                                   # target %
    "hb": {"g/dl": 1.0, "gm/dl": 1.0, "g/l": 0.1},                         # target g/dL
    "creat": {"mg/dl": 1.0, "umol/l": 1 / 88.4, "umol/l.": 1 / 88.4},       # target mg/dL
    "egfr": None,                                                          # any mL/min/1.73 m2 spelling
    "tsh": None,                                                           # target mIU/L, see TSH_UNITS
}
TSH_UNITS = {"uiu/ml", "miu/l", "miu/ml", "uu/ml"}   # all numerically equal to mIU/L; mmol/L, nmol/L -> NaN
RANGES = {"hba1c": (3, 20), "hb": (3, 25), "creat": (0.2, 20), "egfr": (3, 200), "tsh": (0.005, 200)}


def harmonise_lab(lab, value, unit):
    """-> (value in target unit | nan, reason). reason in ok / unit_unknown / implausible."""
    if pd.isna(value):
        return np.nan, "none"
    k = _unit_key(unit)
    if lab == "egfr":
        mult = 1.0 if k.startswith("ml/min") else None
    elif lab == "tsh":
        mult = 1.0 if k in TSH_UNITS else None
    else:
        mult = UNITS[lab].get(k)
    if mult is None:
        return np.nan, "unit_unknown"
    v = float(value) * mult
    lo, hi = RANGES[lab]
    if not (lo <= v <= hi):
        return np.nan, "implausible"
    return v, "ok"


def ist_date(ts):
    """ISO timestamps with offset -> tz-naive IST calendar date (NaT if null)."""
    t = pd.to_datetime(ts, utc=True, errors="coerce")
    return t.dt.tz_convert("Asia/Kolkata").dt.tz_localize(None).dt.normalize()


def undatable(rx_date, age_d):
    """True where the record has no usable date: null age, or implied date (rx_date - age_d) <= SENTINEL_DATE."""
    age = pd.to_numeric(age_d, errors="coerce")
    src = pd.to_datetime(rx_date) - pd.to_timedelta(age, unit="D")
    return age.isna() | src.isna() | (src <= SENTINEL_DATE)


def select_labs(b, rx_by_uid, min_age_d=MIN_AGE_D, sentinel_guard=True):
    """Strict cutoff on RESULT date: pull B's age_d = anchor IST date - result date. Rows with age_d < min_age_d
    (resulted on or after the Rx day) are dropped; rows whose result date is null or a sentinel (<= 2000-01-01,
    e.g. 1970-01-01) are undatable, so cannot be shown to be pre-Rx, and are dropped too.
    Returns (kept, n_dropped_age, n_dropped_sentinel). sentinel_guard=False exists only for the mutant tests."""
    rx = b["prescription_uid"].map(rx_by_uid)
    sent = undatable(rx, b["age_d"]).values if sentinel_guard else np.zeros(len(b), bool)
    age_bad = (b["age_d"] < min_age_d).values & ~sent
    keep = ~sent & ~age_bad
    return b[keep].copy(), int(age_bad.sum()), int(sent.sum())


# --- builder -----------------------------------------------------------------------------------
def build(D, a, b, min_age_d=MIN_AGE_D, pull_cut="timestamp", sentinel_guard=True):
    """D: cohort (episode_id, prescription_uid, rx_date). Returns (features, audit, stats)."""
    st = {}
    a = a.drop_duplicates("prescription_uid")
    X = D[["episode_id", "prescription_uid", "rx_date"]].merge(a, on="prescription_uid", how="left", indicator=True)
    st["n_join_fail_a"] = int((X["_merge"] != "both").sum())
    X = X.drop(columns="_merge")
    for c in ["n_prior_rx_all", "n_prior_rx_12m", "n_doctors_12m", "days_since_first_rx", "n_ip_events_pre", "bp_age_d", "n_meds_latest_prior_rx"]:
        X[c] = pd.to_numeric(X[c], errors="coerce")
    F = pd.DataFrame({"episode_id": X["episode_id"]})
    A = pd.DataFrame({"episode_id": X["episode_id"], "rx_date": X["rx_date"]})

    # Rx-derived blocks. With a timestamp-level pull a prior Rx can sit on the Rx day itself; the only case
    # detectable in aggregates is "first prior Rx < 24 h before the anchor" (days_since_first_rx == 0):
    # those episodes are quarantined (treated as no prior record) and counted.
    prior = X["n_prior_rx_all"].fillna(0) > 0
    quarantine = pd.Series(False, index=X.index)
    if pull_cut == "timestamp":
        quarantine = prior & (X["days_since_first_rx"] == 0)
    st["n_quarantine_lt24h"] = int(quarantine.sum())
    prior = prior & ~quarantine
    F["ft8_has_prior_rx"] = prior.astype(int)
    F["ft8_n_prior_rx_all"] = np.where(prior, X["n_prior_rx_all"], 0)
    F["ft8_n_prior_rx_12m"] = np.where(prior, X["n_prior_rx_12m"], 0)
    F["ft8_n_doctors_12m"] = np.where(prior, X["n_doctors_12m"], 0)
    F["ft8_days_since_first_rx"] = np.where(prior, X["days_since_first_rx"], np.nan)
    # n_ip_events_pre: IP events at Even (table starts 20 Mar 2026, cut on ingest time)
    F["ft8_n_ip_events_pre"] = X["n_ip_events_pre"].fillna(0)
    F["ft8_n_meds_latest_prior_rx"] = np.where(prior, X["n_meds_latest_prior_rx"], np.nan)   # chronic vs acute NOT split
    F["ft8_has_meds"] = (prior & (X["n_meds_latest_prior_rx"] > 0)).astype(int)

    # comorbidity from prior_rx_icd (dropped for quarantined rows) U cond_icd
    codes, ncomorb = [], []
    for r_icd, c_icd, cn, q in zip(X["prior_rx_icd"], X["cond_icd"], X["comorb_names"], quarantine):
        s = set()
        if not q and isinstance(r_icd, str):
            s |= set(r_icd.split("|"))
        if isinstance(c_icd, str):
            s |= set(c_icd.split("|"))
        codes.append(icd_map.classify(s))
        ncomorb.append(len([x for x in cn.split("|") if x]) if isinstance(cn, str) else 0)
    has_icd = np.array([c["n_codes"] > 0 for c in codes])
    F["ft8_has_icd"] = has_icd.astype(int)
    F["ft8_n_icd_codes"] = np.where(has_icd, [c["n_codes"] for c in codes], np.nan)
    F["ft8_charlson_n"] = np.where(has_icd, [c["charlson_n"] for c in codes], np.nan)
    F["ft8_charlson_score"] = np.where(has_icd, [c["charlson_score"] for c in codes], np.nan)
    for f in ["dm", "htn", "ckd", "cad", "obesity"]:
        F[f"ft8_{f}"] = np.where(has_icd, [int(c["flags"][f]) for c in codes], np.nan)
    F["ft8_n_comorb_names"] = ncomorb   # sparse (named comorbidities); count only

    # BP
    parsed = [parse_bp(s) for s in X["bp_latest"]]
    dated = "src_max_ts_prior_rx" in X.columns          # day-level pull: per-block max source timestamps
    if dated:
        SD = {c[len("src_max_ts_"):]: ist_date(X[c]) for c in SRC_TS}
        st["n_src_ts_at_or_after_cut"] = int(sum(((SD[k].notna()) & (SD[k] >= X["rx_date"])).sum() for k in SD))
        age = (X["rx_date"] - SD["bp"]).dt.days.astype(float)    # calendar days, as for labs (anchor date - record date)
    else:
        age = X["bp_age_d"]
    bp_sent = undatable(X["rx_date"], age) if sentinel_guard else pd.Series(False, index=X.index)
    st["n_bp_sentinel"] = int((X["bp_latest"].notna() & bp_sent).sum())
    ok_age = (age >= min_age_d) & ~bp_sent
    st["n_bp_rows"] = int(X["bp_latest"].notna().sum())
    st["n_bp_dropped_age_lt1"] = int((X["bp_latest"].notna() & ~ok_age & ~bp_sent).sum())
    sbp = np.array([p[0] for p in parsed]); dbp = np.array([p[1] for p in parsed])
    reason = np.array([p[2] for p in parsed])
    st["n_bp_implausible_or_unparsable"] = int(((reason == "implausible") | (reason == "unparsable"))[ok_age.values].sum())
    use = ok_age.values & ~np.isnan(sbp)
    F["ft8_has_bp"] = use.astype(int)
    F["ft8_sbp"] = np.where(use, sbp, np.nan); F["ft8_dbp"] = np.where(use, dbp, np.nan)
    F["ft8_bp_age_d"] = np.where(use, age, np.nan)

    # labs
    bk, st["n_lab_dropped_age_lt1"], st["n_lab_dropped_sentinel"] = select_labs(
        b, D.set_index("prescription_uid")["rx_date"], min_age_d, sentinel_guard)
    bs = b.assign(rx=b["prescription_uid"].map(D.set_index("prescription_uid")["rx_date"]))
    st["n_lab_sentinel_episodes"] = int(bs[undatable(bs["rx"], bs["age_d"])]["prescription_uid"].nunique())
    st["lab_unit_unknown"], st["lab_implausible"] = {}, {}
    for lab in LABS:
        s = bk[bk["lab"] == lab].drop_duplicates("prescription_uid").set_index("prescription_uid")
        vals, reasons = [], []
        for uid in X["prescription_uid"]:
            if uid in s.index:
                v, r = harmonise_lab(lab, s.at[uid, "value"], s.at[uid, "unit"])
            else:
                v, r = np.nan, "none"
            vals.append(v); reasons.append(r)
        reasons = np.array(reasons); vals = np.array(vals)
        st["lab_unit_unknown"][lab] = int((reasons == "unit_unknown").sum())
        st["lab_implausible"][lab] = int((reasons == "implausible").sum())
        have = ~np.isnan(vals)
        F[f"ft8_{lab}"] = vals
        F[f"ft8_{lab}_age_d"] = np.where(have, X["prescription_uid"].map(s["age_d"]), np.nan)
        F[f"ft8_{lab}_n_pre"] = np.where(have, X["prescription_uid"].map(s["n_pre"]), np.nan)
        F[f"ft8_has_{lab}"] = have.astype(int)

    # audit: max source date per block (rx_date - age). Aggregate blocks have no per-record date in the pull.
    def src(ageser):
        return X["rx_date"] - pd.to_timedelta(ageser, unit="D")
    A["src_max_date_bp"] = src(F["ft8_bp_age_d"])
    for lab in LABS:
        A[f"src_max_date_{lab}"] = src(F[f"ft8_{lab}_age_d"])
    if dated:
        # the day-level pull carries the max source timestamp per block
        A["src_max_date_util"] = SD["prior_rx"].values
        A["src_max_date_meds"] = SD["prior_rx"].values            # meds count is on the latest prior Rx
        A["src_max_date_ip"] = SD["ip"].values
        A["src_max_date_icd"] = pd.concat([SD["prior_rx"], SD["cond"]], axis=1).max(axis=1).values   # prior_rx_icd U cond_icd
        A["src_max_date_comorb"] = SD["comorb"].values
        A["used_comorb"] = (F["ft8_n_comorb_names"] > 0).values
    else:
        for blk in ["util", "icd", "ip", "meds"]:
            A[f"src_max_date_{blk}"] = pd.NaT   # aggregate in pull A; per-record date not available
    A["agg_blocks_cut_level"] = pull_cut
    A["agg_dates_available"] = dated
    # which blocks actually feed a feature for this episode (assert_cutoff needs a date for each)
    A["used_util"] = (F["ft8_has_prior_rx"] == 1).values
    A["used_icd"] = (F["ft8_has_icd"] == 1).values
    A["used_ip"] = (F["ft8_n_ip_events_pre"] > 0).values
    A["used_meds"] = (F["ft8_has_prior_rx"] == 1).values
    A["used_bp"] = (F["ft8_has_bp"] == 1).values
    for lab in LABS:
        A[f"used_{lab}"] = (F[f"ft8_has_{lab}"] == 1).values
    A["quarantined_lt24h"] = quarantine.values
    return F, A, st


def assert_cutoff(audit, min_age_d=MIN_AGE_D):
    """Every USED block must have a source date, and it must be a real date strictly before rx_date
    (<= rx_date - min_age_d days) and after the sentinel floor (> 2000-01-01).
    - a used block with no source date FAILS, except the pull-A aggregates (util/icd/ip/meds), which carry no
      per-record date: those pass only when audit.agg_blocks_cut_level == 'day' (the pull's SQL cuts at
      the IST midnight of the anchor date; checked statically by sql_strict_violations / test_pull_a_is_day_level);
    - a source date at/after the cutoff, or a sentinel date, FAILS.
    Raises CutoffViolation listing counts per problem."""
    bad = {}
    # the day exemption for undated aggregates holds only when the pull carries no per-block source dates
    day = audit["agg_blocks_cut_level"].eq("day") & ~audit["agg_dates_available"].astype(bool)
    cutoff = audit["rx_date"] - pd.Timedelta(days=min_age_d)
    for u in [c for c in audit.columns if c.startswith("used_")]:
        blk = u[len("used_"):]
        d = pd.to_datetime(audit[f"src_max_date_{blk}"])
        used = audit[u].astype(bool)
        undated = used & d.isna() & ~(day & (blk in AGG_BLOCKS))
        late = used & d.notna() & (d > cutoff)
        sent = used & d.notna() & (d <= SENTINEL_DATE)
        for name, m in (("undated", undated), ("at_or_after_cutoff", late), ("sentinel_date", sent)):
            if int(m.sum()):
                bad[f"{blk}:{name}"] = int(m.sum())
    if bad:
        raise CutoffViolation(f"cutoff violations: {bad}")
    return True


def sql_strict_violations(sql):
    """Static check on a pull SQL (cohort VALUES list ignored): every upper-bound date predicate against the anchor
    (c.t / c.d / d) must be a strict '<'. Returns offending lines: any '<=' / reversed '>=' against the anchor,
    or a body with no strict predicate at all."""
    body = [l for l in sql.splitlines() if not l.startswith("('") and not l.startswith("--")]
    bad = [l.strip()[:120] for l in body if re.search(r"<=|[\s)]c\.[tdm]\s*>|[\s)]d\s*>", l)]
    if not any(re.search(r"<\s*c\.[tdm]\b|\bcd\s*<|<\s*d\b", l.replace('"', "")) for l in body):
        bad.append("no strict predicate found")
    return bad


def day_level_violations(sql):
    """The day-level pull A must compare every upper bound with the anchor's IST midnight (c.m), never the
    anchor timestamp (c.t). Returns offending lines (empty = day-level)."""
    body = [l for l in sql.splitlines() if not l.startswith("('") and not l.startswith("--")]
    bad = [l.strip()[:120] for l in body if re.search(r"<\s*c\.t\b", l.replace(" ", " "))]
    if not any(re.search(r"<\s*c\.m\b", l) for l in body):
        bad.append("no predicate against c.m (IST midnight)")
    return bad


def sha12(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--pull-cut", default="timestamp", choices=["timestamp", "day"])
    ap.add_argument("--pull-a", default=None, help="default: ft8-pull-a-day.tsv for --pull-cut day, else ft8-pull-a.tsv")
    ns = ap.parse_args()
    os.makedirs(ns.out, exist_ok=True)
    D, s1 = load_cohort()
    a, b = load_a_b(ns.pull_a or (PULL_A_DAY if ns.pull_cut == "day" else PULL_A))
    F, A, s2 = build(D, a, b, pull_cut=ns.pull_cut)
    try:
        assert_cutoff(A)
        s2["cutoff_check"] = "pass"
    except CutoffViolation as e:
        if ns.pull_cut == "day":
            raise
        s2["cutoff_check"] = f"FAIL (known, timestamp-level pull A): {e}"
        print("WARN", s2["cutoff_check"])
    assert len(F) == len(D) and F.episode_id.is_unique
    for name, df in (("features_ft8.parquet", F), ("features_ft8_audit.parquet", A)):
        p = os.path.join(ns.out, name); df.to_parquet(p, index=False); os.chmod(p, 0o600)
    import json
    st = {**s1, **s2, "pull_cut": ns.pull_cut, "pull_a": os.path.basename(ns.pull_a or (PULL_A_DAY if ns.pull_cut == "day" else PULL_A))}
    p = os.path.join(ns.out, "build_stats.json"); json.dump(st, open(p, "w"), indent=1, default=int); os.chmod(p, 0o600)
    print(st)


if __name__ == "__main__":
    main()
