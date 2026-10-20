#!/usr/bin/env python3
"""Surgery funnel F1 join (S1-S5 per patient-episode). Plan .bc/FUNNEL-28OCT-PLAN.md (A1-A8), brief .bc/FUNNEL-F1-JOIN-BRIEF.md,
gate .bc/GATE-RULING-FOREST-FUNNEL-18OCT.md. Read-only on every input; outputs 0600 in a 0700 directory, on the lab box only.

Rules this code enforces:
  * the RD-0 split is read ONLY through split_guard.load(pinned_list_sha256=...) and the seed pin is checked against LOCK.json;
  * S5 labelling is convert-lead's p3a_counts.py, imported (sha-checked), not reimplemented; only the episode grouping is re-keyed
    from patient_grp to the RD-0 cluster key (one surgery credited once per cluster);
  * S2/S3/S4 are credited by the credit-cluster rule (forest-lead ruling 19 Oct, F1): a link on ANY Rx of the cluster counts for the latest episode Rx on or
    before the link date, once, if inside [episode Rx day, +90 d] and on or before the S5 event; episode-Rx-only is the sensitivity line;
  * pending (< 94 days at the read date, no event) is never a loss and is out of every S5 denominator;
  * ambiguous episodes (contact_hash shared by >1 patient, or cluster in the 10e2 shared-phone set) are counted, stay in S1/S5 totals,
    and are out of every S2/S3/S4 rate;
  * S4 primary = Pulse surgery_cases booking form (V ruling 19 Oct; PRESCRIBED and CANCELLED cases are not bookings), db16 lead status
    secondary and never rescues an Rx whose only Pulse cases are PRESCRIBED/CANCELLED; the Daily Dash API is never called. S4 coverage
    starts at --s4-from; the Rx-link part of it at --s4-rx-from; earlier Rx days are "no S4 source", never 0%.
The counts files carry counts only: no key, no id (the admin-only doctor file carries a shortened doctor id).
"""
import argparse
import collections
import contextlib
import csv
import datetime as dt
import hashlib
import io
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SPLIT_DIR = os.path.join(HERE, "..", "2026-10-16-runo-linkage", "split")
P3A_SHA12 = "490f5dc17bd3"
MATURE_DAYS = 94
S4_FROM = None                  # first Rx day the Pulse S4 source covers (date); run() sets it from --s4-from, None = no Pulse file
S4_RX_FROM = None               # first Rx day whose S4 is also seen through Rx links (date); run() sets it from --s4-rx-from
S4_WINDOW = 90                  # booking window, days after the Rx day (inclusive)
S4_EXCLUDED_STATUS = ("PRESCRIBED", "CANCELLED")
RATES_FROM = "2026-01"          # Dec 2025 has no leads: S2/S3/S4 rates start Jan 2026 (A3)
S4_NEEDED = ("lsq_stage", "ot_booked_on", "crm_won_on", "crm_booking_amount_pos")


class FunnelError(RuntimeError):
    pass


def _split_guard():
    if SPLIT_DIR not in sys.path:
        sys.path.insert(0, SPLIT_DIR)
    import split_guard
    return split_guard


# ---------------------------------------------------------------- inputs
def read_tsv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def load_cohort(path):
    rows = read_tsv(path)
    seen = set()
    for r in rows:
        if r["prescription_uid"] in seen:
            raise FunnelError("duplicate prescription_uid in cohort")
        seen.add(r["prescription_uid"])
        if r.get("flagged", "true") != "true":
            raise FunnelError("unflagged row in cohort")
    return rows


def load_clusters(path):
    m = {}
    for r in read_tsv(path):
        m[r["patient_key"].strip().lower()] = r["cluster_key"].strip().lower()
    return m


def _outcome_cols(header, line):
    """A 07b row without flag_proc_names (a second plan_of_management row repeats the Rx with another list; p3a does not read it)."""
    cols = header.split("\t")
    vals = line.split("\t")
    return [v for c, v in zip(cols, vals) if c != "flag_proc_names"]


def load_p3a(convert_dir, s5_files=None, expected_sha12=P3A_SHA12):
    """Import p3a_counts.py (sha-checked) over the given 07b-shaped files; returns (its per-Rx `out` list (r, d, ev, excl), n duplicate rows dropped).
    The module reads data/07b.tsv relative to cwd and prints a table at import, so it is exec'd in a temp dir with stdout
    swallowed. Its `elapsed` is relative to its own hard-coded READ and is ignored; the caller recomputes from the read date."""
    src_path = os.path.join(os.path.expanduser(convert_dir), "p3a_counts.py")
    src = open(src_path, "rb").read()
    if hashlib.sha256(src).hexdigest()[:12] != expected_sha12:
        raise FunnelError("p3a_counts.py sha mismatch; refusing (labelling rules must be the reviewed ones)")
    files = s5_files or [os.path.join(os.path.expanduser(convert_dir), "data", "07b.tsv")]
    header, body, seen, n_dup = None, [], {}, 0
    for p in files:
        lines = open(p).read().splitlines()
        if header is None:
            header = lines[0]
        elif lines[0] != header:
            raise FunnelError("S5 chunk header differs")
        for ln in lines[1:]:
            if not ln.strip():
                continue
            uid = ln.split("\t", 1)[0]
            if uid in seen:
                if _outcome_cols(header, seen[uid]) != _outcome_cols(header, ln):
                    raise FunnelError("prescription_uid repeated with different outcome content in S5 input")
                n_dup += 1          # 07b carries duplicate rows (29 on the 15 Oct cut) that differ only in flag_proc_names; the first is kept
                continue
            seen[uid] = ln
            body.append(ln)
    old = os.getcwd()
    with tempfile.TemporaryDirectory() as td:
        os.mkdir(os.path.join(td, "data"), 0o700)
        fd = os.open(os.path.join(td, "data", "07b.tsv"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(header + "\n" + "\n".join(body) + "\n")
        ns = {"__name__": "p3a_counts"}
        os.chdir(td)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                try:
                    exec(compile(src, src_path, "exec"), ns)
                except IndexError:
                    # trailing median print on an input with no positive episode; `out` is already built
                    if "out" not in ns:
                        raise
        finally:
            os.chdir(old)
    return ns["out"], n_dup


def load_s23(path):
    """f1-s23-s4.tsv (new pull) or the older 09.tsv. Returns (uid -> row, availability flags)."""
    with open(path, newline="") as f:
        rd = csv.DictReader(f, delimiter="\t")
        cols = set(rd.fieldnames or [])
        rows = [r for r in rd if r.get("prescription_uid")]
    by = {}
    for r in rows:
        by.setdefault(r["prescription_uid"], r)      # first row wins; duplicates are not expected
    avail = {
        "hash_ambiguity": "n_distinct_patients_per_contact_hash" in cols,
        "first_call_day": "first_call_day" in cols,
        "s4": all(c in cols for c in S4_NEEDED),
        "department": "speciality" in cols,
    }
    return by, avail


def load_key_set(path, col="patient_key"):
    return {r[col].strip().lower() for r in read_tsv(path)}


def load_edge_keys(path):
    ks = set()
    for r in read_tsv(path):
        ks.add(r["key_a"].strip().lower())
        ks.add(r["key_b"].strip().lower())
    return ks


# ---------------------------------------------------------------- build
def _d(s):
    return dt.date.fromisoformat(s[:10]) if s and s[:10] not in ("None", "NULL") else None


class Db16LeadStatus:
    """S4 source 2 (secondary): db16 rh_surgery_leads status fields. A lead emits at most one link: its earliest dated booking field
    (ot_booked_on, crm_won_on), dated that day; only a lead with no dated field and a positive booking amount emits an undated link dated by its Rx. Visible only through a lead. Source protocol for a cluster-crediting source:
    `name`, `available` and `cluster_links(ck, rx_list, s23) -> (links, would_links, blocked_rx)`; a source without it is read per episode Rx
    through `lookup(uid, cluster_key, rx_day, lead) -> (booked, days_to_book, label)`. V ruled 19 Oct that the primary source is the Pulse
    surgery booking form; the Daily Dash API is a demo and is never called from this code."""
    name = "db16_lead_status"

    def __init__(self, avail):
        self.available = avail["s4"]

    def links(self, rx_list, s23):
        out = []
        for ist, uid in rx_list:
            lead = s23.get(uid)
            if lead is None:
                continue
            dated = [d for d in (_d(lead.get(k) or "") for k in ("ot_booked_on", "crm_won_on")) if d]
            if dated:           # one lead, one link: the earliest dated booking field (R4-1)
                out.append({"d": min(dated), "rx": uid, "src": self.name, "case": None, "dateless": False, "lead": lead})
            elif (lead.get("crm_booking_amount_pos") or "").lower() in ("true", "t", "1"):
                out.append({"d": _d(ist), "rx": uid, "src": self.name, "case": None, "dateless": True, "lead": lead})
        return out


class PulseBooking:
    """S4 primary: Pulse surgery_cases (f1-s4-pulse-booking.sql). Cases with status PRESCRIBED (auto-created from the Rx, never moved on)
    or CANCELLED are not bookings: they credit nothing by any path, are counted by split and month (`excluded`), and an Rx whose only
    Pulse cases are of those statuses is `blocked` (the db16 secondary must not rescue it). Duplicate case rows (SQL fan-out) are
    dropped and counted. A case with an Rx (rx_uid) is a link on that Rx ('pulse_rx_link') dated by its created_day; an Rx-linked case with
    no created_day is counted and ignored. A case with no Rx (manual booking) is matched by individual -> RD-0 cluster
    ('pulse_individual_window'). Which episode a link credits is decided by build() (credit-cluster rule); `used` holds the credited cases and
    `dropped` the Rx-linked cases no episode could take. rx_cluster (Rx uid -> cluster) and split_of (cluster -> H/D) only label the counts;
    cover_from (date) = first Rx day with an S4 source."""
    name = "pulse_booking_form"

    def __init__(self, rows, clusters, rx_cluster=None, split_of=None, cover_from=None):
        self.available = True
        self.cover_from = cover_from
        self.clusters, self.rx_cluster, self.split_of = clusters, rx_cluster or {}, split_of
        self.by_rx, self.by_cluster, self.used, self.blocked = collections.defaultdict(list), collections.defaultdict(list), set(), set()
        self.tally = collections.Counter()
        self.excluded = collections.Counter()       # (status, split, month) -> cases
        self.dropped = collections.Counter()        # (kind, split) -> cases
        self._dropped_seen = set()
        self._valid_rx = collections.defaultdict(list)      # every non-excluded Rx-linked case, with or without a day
        self._case = {}
        seen = {}
        for r in rows:
            cid = r.get("case_uid") or ""
            if not cid:
                self.tally["no_case_uid"] += 1
                continue
            if cid in seen:
                self.tally["duplicate_case_rows"] += 1
                if seen[cid] != (r.get("rx_uid") or "", r.get("status") or "", r.get("created_day") or ""):
                    self.tally["duplicate_case_rows_differing"] += 1
                continue
            seen[cid] = (r.get("rx_uid") or "", r.get("status") or "", r.get("created_day") or "")
            self.tally["cases"] += 1
            self._case[cid] = r
            status = (r.get("status") or "").strip().upper()
            if status in S4_EXCLUDED_STATUS:
                self.tally[status.lower()] += 1
                self.excluded[(status, self._split(r), (r.get("created_day") or "")[:7] or "no_day")] += 1
                if r.get("rx_uid"):
                    self.blocked.add(r["rx_uid"])
                continue
            if r.get("rx_uid"):
                self._valid_rx[r["rx_uid"]].append(r)
                if not _d(r.get("created_day") or ""):
                    self.drop("rx_link_empty_day", cid)
                    continue
                self.by_rx[r["rx_uid"]].append(r)
            else:
                self.tally["no_rx_manual"] += 1
                ck = clusters.get((r.get("individual_key") or "").strip().lower())
                if ck:
                    self.by_cluster[ck].append(r)

    def _split(self, r):
        ck = self.rx_cluster.get(r.get("rx_uid") or "") or self.clusters.get((r.get("individual_key") or "").strip().lower())
        return self.split_of(ck) if (ck and self.split_of) else "unresolved"

    def drop(self, kind, cid):
        if cid not in self._dropped_seen:
            self._dropped_seen.add(cid)
            self.dropped[(kind, self._split(self._case[cid]))] += 1

    def valid_on_rx(self, uid):
        return self._valid_rx.get(uid, [])

    def blocks(self, uid):
        return uid in self.blocked

    def links(self, cluster_key, rx_list):
        out = []
        for ist, uid in rx_list:
            for r in self.by_rx.get(uid, []):
                out.append({"d": _d(r["created_day"]), "rx": uid, "src": "pulse_rx_link", "case": r["case_uid"], "dateless": False, "lead": None})
        for r in self.by_cluster.get(cluster_key, []):
            d = _d(r.get("created_day") or "")
            if d:
                out.append({"d": d, "rx": None, "src": "pulse_individual_window", "case": r["case_uid"], "dateless": False, "lead": None})
        return out


class S4Chain:
    """Primary Pulse booking, then db16 lead status as secondary. Links come from both; a db16 link on an Rx whose only Pulse cases are
    PRESCRIBED/CANCELLED is withheld (Pulse wins) and returned as a would-link so the block can be counted. An Rx day before the primary's
    cover_from has no S4 source (build() reads `cover_from`)."""
    def __init__(self, primary, secondary):
        self.primary, self.secondary = primary, secondary
        self.available = bool((primary and primary.available) or secondary.available)
        self.name = "chain"

    def _pulse(self):
        return self.primary if (self.primary and self.primary.available) else None

    @property
    def cover_from(self):
        p = self._pulse()
        return p.cover_from if p else None

    @property
    def miss_label(self):
        p = self._pulse()
        return p.name if p else self.secondary.name

    def cluster_links(self, ck, rx_list, s23):
        pulse = self._pulse()
        links, would, blocked_rx = [], [], []
        if pulse:
            links += pulse.links(ck, rx_list)
            blocked_rx = [(ist, uid) for ist, uid in rx_list if pulse.blocks(uid)]
        if self.secondary.available:
            for l in self.secondary.links(rx_list, s23):
                (would if (pulse and pulse.blocks(l["rx"])) else links).append(l)
        return links, would, blocked_rx


def _credit_pass(eps, rxs, ck, s23, links, own_only, on_miss=None):
    """Credit-cluster rule (forest-lead ruling 19 Oct, F1). A link (S2/S3: a lead on an Rx, dated by that Rx; S4: a Pulse case or db16
    booking date) on ANY Rx of the cluster is credited to exactly one episode, the latest episode Rx on or before the link date, and only
    if the link date is inside [that episode's Rx day, +S4_WINDOW] and on or before its S5 event day. own_only keeps just the links that sit on
    the target episode's own Rx (manual Pulse cases sit on no Rx and always count): the episode-Rx-only sensitivity. Returns per episode
    {'s3': [(lead, link Rx uid)], 's2': [...], 's4': [links]}; on_miss(link, kind) is told about links nobody could take."""
    res = [{"s2": [], "s3": [], "s4": []} for _ in eps]
    days = [_d(e[0]) for e in eps]

    def target(link_d):         # by DAY for every link kind; eps are sorted by (consult_ist, uid), so the last match is the latest same-day Rx (R4-2)
        t = None
        for i in range(len(eps)):
            if days[i] <= link_d:
                t = i
        return t

    def take(link_d, rx_uid):
        t = target(link_d)
        if t is None or not 0 <= (link_d - days[t]).days <= S4_WINDOW:
            return None, "rx_link_outside_window"
        if own_only and rx_uid is not None and eps[t][1] != rx_uid:
            return None, "not_own_rx"
        if eps[t][3] and link_d > _d(eps[t][3]):
            return None, "rx_link_after_s5_event"
        return t, ""

    for ist, uid, _r, _pk in rxs:
        lead = s23.get(uid)
        if lead is None:
            continue
        t, _ = take(_d(ist), uid)
        if t is not None:
            res[t]["s3"].append((lead, uid))
            if int(lead.get("n_log_after") or 0) >= 1:
                res[t]["s2"].append((lead, uid))
    for l in links:
        t, why = take(l["d"], l["rx"])
        if t is not None:
            res[t]["s4"].append(l)
        elif on_miss and l["case"] and l["rx"] and why != "not_own_rx":
            on_miss(l, why)
    return res


def _s4_from_links(links):
    """Winning source (Pulse Rx link, then Pulse individual+window, then db16) and days to book from the earliest dated link of it."""
    for src in ("pulse_rx_link", "pulse_individual_window", "db16_lead_status"):
        got = [l for l in links if l["src"] == src]
        if got:
            dated = [l for l in got if not l["dateless"]]
            return True, src, dated
    return False, None, []


def build(cohort, clusters, guard, p3a_out, s23, avail, phone_keys, phone_source, read_date, transcripts=None, s4_source=None):
    """One row per patient-episode. See module doc for the episode rule. S2/S3/S4 are credited by the credit-cluster rule (_credit_pass); the
    episode-Rx-only result is kept in the _ep_* columns for the sensitivity line. s4_source: S4Chain, or any object with the Db16LeadStatus
    protocol docstring (a source without `cluster_links` is read per episode Rx and has no sensitivity difference)."""
    s4_source = s4_source or S4Chain(None, Db16LeadStatus(avail))
    o_by = {o["r"]["prescription_uid"]: o for o in p3a_out}
    by_cluster = collections.defaultdict(list)
    for r in cohort:
        pk = r["patient_key"].strip().lower()
        ck = clusters[pk]
        by_cluster[ck].append((r["consult_ist"], r["prescription_uid"], r, pk))
    rows, diag = [], collections.Counter()
    pulse = getattr(s4_source, "primary", None)
    for ck in sorted(by_cluster):
        rxs = sorted(by_cluster[ck], key=lambda t: (t[0], t[1]))
        split = guard.set_of(ck)
        amb_phone = any(pk in phone_keys for *_, pk in rxs) or ck in phone_keys
        episodes, seen_ev = [], {}
        for ist, uid, r, pk in rxs:
            o = o_by.get(uid)
            if o and o["ev"] and not o["excl"] and o["ev"] not in seen_ev:
                seen_ev[o["ev"]] = uid
                episodes.append((ist, uid, r, o["ev"]))
            elif o and o["excl"]:
                diag["rx_event_excluded_R1R2R4"] += 1
            elif not o:
                diag["rx_without_outcome_row"] += 1
        if not episodes:
            ist, uid, r, pk = rxs[0]
            episodes.append((ist, uid, r, None))
        diag["rx_not_episode"] += len(rxs) - len(episodes)
        rx_list = [(t[0], t[1]) for t in rxs]
        cluster_mode = s4_source.available and hasattr(s4_source, "cluster_links")
        links, would, blocked_rx = s4_source.cluster_links(ck, rx_list, s23) if cluster_mode else ([], [], [])
        miss = None
        if pulse:
            miss = lambda l, why: pulse.drop(why, l["case"])      # noqa: E731
        prim = _credit_pass(episodes, rxs, ck, s23, links, False, miss)
        epo = _credit_pass(episodes, rxs, ck, s23, links, True)
        wd = _credit_pass(episodes, [], ck, {}, would, False) if would else None
        blocked_vd = set()          # episodes where a valid-but-dropped case sat next to a blocking PRESCRIBED/CANCELLED case on the same Rx (R4-3)
        blocked_ep = set()          # episodes a PRESCRIBED/CANCELLED-only Rx would have fed (latest episode Rx at or before it, inside its window)
        for bist, buid in blocked_rx:
            t = [i for i, e in enumerate(episodes) if _d(e[0]) <= _d(bist)]
            if t and 0 <= (_d(bist) - _d(episodes[t[-1]][0])).days <= S4_WINDOW:
                blocked_ep.add(t[-1])
            if t and pulse and any(c["case_uid"] in pulse._dropped_seen for c in pulse.valid_on_rx(buid)):
                blocked_vd.add(t[-1])
        for i, (ist, uid, r, ev) in enumerate(episodes):
            rx_day = _d(ist)
            o = o_by.get(uid)
            own_lead = s23.get(uid)

            s3l, s2l = prim[i]["s3"], prim[i]["s2"]
            s3, s2 = bool(s3l), bool(s2l)
            leads = [l for l, _u in s3l]
            lead = (own_lead if own_lead is not None and any(u == uid for _l, u in s3l) else (leads[0] if leads else None))
            days_to_call = None
            if s2 and avail["first_call_day"]:
                fc = [_d(l.get("first_call_day") or "") for l, _u in s2l]
                fc = [d for d in fc if d]
                if fc:
                    days_to_call = (min(fc) - rx_day).days
            s4_note = ""
            ep_s4 = None
            if not s4_source.available:
                s4, s4_src, days_to_book = None, "none_pull_pending", None
                ep_s4 = None
            elif cluster_mode:
                cf = s4_source.cover_from
                if cf and rx_day < cf:
                    s4, days_to_book, s4_src = None, None, "no_s4_source"
                else:
                    s4, src, dated = _s4_from_links(prim[i]["s4"])
                    days_to_book = (min(l["d"] for l in dated) - rx_day).days if dated else None
                    ep_s4 = _s4_from_links(epo[i]["s4"])[0]
                    if s4:
                        s4_src = src
                        if pulse:
                            for l in prim[i]["s4"]:
                                if l["case"]:
                                    pulse.used.add(l["case"])
                    else:
                        s4_src = s4_source.miss_label
                        if i in blocked_ep:
                            s4_note = "blocked_db16_would_book" if (wd and wd[i]["s4"]) else "blocked"
            else:
                s4, days_to_book, s4_src = s4_source.lookup(uid, ck, rx_day, own_lead)
                ep_s4 = s4
                s4_note = getattr(s4_source, "last_note", "")
            age = (read_date - rx_day).days
            if ev:
                s5 = "done"
            else:
                s5 = "pending" if age < MATURE_DAYS else "not_done_final"
            reasons = []
            win = [l for l in prim[i]["s4"] if l["src"] == s4_src] if s4 else []       # only the winning source's links can make an episode ambiguous
            cred_leads = leads + [l["lead"] for l in win if l["lead"] is not None]
            if any(avail["hash_ambiguity"] and int(l.get("n_distinct_patients_per_contact_hash") or 0) > 1 for l in cred_leads):
                reasons.append("contact_hash_shared")
            if amb_phone:
                reasons.append(phone_source)
            mature = age >= MATURE_DAYS
            eid = "ep-" + hashlib.sha256(f"{ck}|{uid}".encode()).hexdigest()[:12]
            rows.append({
                "episode_id": eid, "cluster_key": ck, "split": split, "rx_month": ist[:7],
                "department": ((lead.get("speciality") or "").strip() or "unknown") if (s3 and avail["department"]) else "unknown",
                "doctor_uid": (o["r"].get("doctor_uid") if o else "") or "",
                "s1_pitched": True,
                "s1_transcript": None if transcripts is None else r["consult_uid"] in transcripts,
                "s2_counselled": s2, "s3_lead": s3, "s4_booked": s4, "s4_source": s4_src,
                "s5_done": s5 == "done", "s5_status": s5,
                "days_to_call": days_to_call, "days_to_book": days_to_book,
                "days_to_done": (_d(ev) - rx_day).days if ev else None,
                "ambiguous": bool(reasons), "ambiguity_reason": "+".join(reasons),
                "_mature": mature,      # not an output column: the S5 rate denominator is Rx aged >= 94 d (p3a "matured")
                "_rx_day": rx_day, "_s4_open": age <= S4_WINDOW,        # S4 window still open at the read date (S4-pending)
                "_s4_note": s4_note, "_blocked_valid_dropped": i in blocked_vd,
                # episode-Rx-only result of the same rule (sensitivity line)
                "_ep_s2": bool(epo[i]["s2"]), "_ep_s3": bool(epo[i]["s3"]), "_ep_s4": ep_s4 if s4 is not None else None,
            })
    if pulse:
        cohort_rx = {r["prescription_uid"] for r in cohort}
        for uid, cs in pulse.by_rx.items():
            if uid not in cohort_rx:
                for c in cs:
                    pulse.drop("rx_link_non_cohort_rx", c["case_uid"])
    return rows, diag


COLUMNS = ["episode_id", "cluster_key", "split", "rx_month", "department", "doctor_uid", "s1_pitched", "s1_transcript",
           "s2_counselled", "s3_lead", "s4_booked", "s4_source", "s5_done", "s5_status",
           "days_to_call", "days_to_book", "days_to_done", "ambiguous", "ambiguity_reason"]


def _cell(v):
    return "" if v is None else ("true" if v is True else "false" if v is False else str(v))


def write_rows(rows, out_dir, date):
    """0600 file in a 0700 dir. Parquet when pyarrow exists; this box has none and no installs are allowed, so TSV with the
    same columns is written instead (convert with pyarrow where it exists)."""
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    os.chmod(out_dir, 0o700)
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
        path = os.path.join(out_dir, f"f1-{date}.parquet")
        tbl = pa.table({c: [r[c] for r in rows] for c in COLUMNS})
        pq.write_table(tbl, path)
        os.chmod(path, 0o600)
        return path
    except ImportError:
        path = os.path.join(out_dir, f"f1-{date}.tsv")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("\t".join(COLUMNS) + "\n")
            for r in rows:
                f.write("\t".join(_cell(r[c]) for c in COLUMNS) + "\n")
        os.chmod(path, 0o600)
        return path


# ---------------------------------------------------------------- counts
def _frac(k, n):
    return f"{k}/{n} ({100*k/n:.0f}%)" if n else f"{k}/0"


def stats(rows):
    """Per-group numbers. S2/S3/S4 rates: non-ambiguous episodes from Jan 2026 only. S5: pending out of the denominator.
    S4 rate: with a Pulse file, `full` = Rx day >= S4_RX_FROM (Rx links and window both covered), `early` = [S4_FROM, S4_RX_FROM)
    (individual+window only, a lower bound), earlier Rx days have no S4 source and are in neither. Episodes whose 90-day booking
    window is still open at the read date are out of every S4 denominator (S4-pending), never a miss."""
    n = len(rows)
    pend = sum(r["s5_status"] == "pending" for r in rows)
    amb = [r for r in rows if r["ambiguous"]]
    elig = [r for r in rows if not r["ambiguous"] and r["rx_month"] >= RATES_FROM]
    s3 = [r for r in elig if r["s3_lead"]]
    if S4_FROM is None:
        full, early, nosrc = elig, [], []
    else:
        full = [r for r in elig if r["_rx_day"] >= S4_RX_FROM]
        early = [r for r in elig if S4_FROM <= r["_rx_day"] < S4_RX_FROM]
        nosrc = [r for r in elig if r["_rx_day"] < S4_FROM]
    s4_known = all(r["s4_booked"] is not None for r in full + early)
    closed = lambda L: [r for r in L if not r["_s4_open"]]       # noqa: E731
    f_cl, e_cl = closed(full), closed(early)
    booked = [r for r in full + early if r["s4_booked"]]
    mature = [r for r in rows if r["_mature"]]
    s4m = [r for r in booked if r["_mature"]]
    return {
        "n": n, "patients": len({r["cluster_key"] for r in rows}), "pending": pend, "ambiguous": len(amb),
        "elig": len(elig),
        "s3": (len(s3), len(elig)),
        "s2": (sum(r["s2_counselled"] for r in elig), len(elig)),
        "s2_of_s3": (sum(r["s2_counselled"] for r in s3), len(s3)),
        "s4": (sum(bool(r["s4_booked"]) for r in f_cl), len(f_cl)) if s4_known else None,
        "s4_open": len(full) - len(f_cl),
        "s4_early": (sum(bool(r["s4_booked"]) for r in e_cl), len(e_cl)) if s4_known else None,
        "s4_early_open": len(early) - len(e_cl),
        "s4_nosrc": len(nosrc),
        "s4_of_s3": (sum(bool(r["s4_booked"]) for r in f_cl if r["s3_lead"]), sum(r["s3_lead"] for r in f_cl)) if s4_known else None,
        "s4_src": dict(collections.Counter(r["s4_source"] for r in rows if r["s4_booked"])),
        "s5": (sum(r["s5_done"] for r in mature), len(mature)),
        "s4_s5": (sum(r["s5_done"] for r in s4m), len(s4m)) if s4_known else None,
        "s4_pending": sum(r["s5_status"] == "pending" for r in booked) if s4_known else None,
        "young_done": sum(r["s5_done"] and not r["_mature"] for r in rows),
        "amb_s2": sum(r["s2_counselled"] for r in amb), "amb_s3": sum(r["s3_lead"] for r in amb),
        "amb_s4": sum(bool(r["s4_booked"]) for r in amb),
        "amb_s5_done": sum(r["s5_done"] for r in amb),
        "s1_patients_s5": len({r["cluster_key"] for r in rows if r["s5_done"]}),
        "ep_s2": (sum(r["_ep_s2"] for r in elig), len(elig)),
        "ep_s3": (sum(r["_ep_s3"] for r in elig), len(elig)),
        "ep_s4": (sum(bool(r["_ep_s4"]) for r in f_cl), len(f_cl)) if s4_known else None,
        "ep_s4_early": (sum(bool(r["_ep_s4"]) for r in e_cl), len(e_cl)) if s4_known else None,
        "pulse_blocked": sum(r["_s4_note"].startswith("blocked") for r in rows),
        "pulse_blocked_db16": sum(r["_s4_note"] == "blocked_db16_would_book" for r in rows),
        "pulse_blocked_valid_dropped": sum(r["_blocked_valid_dropped"] for r in rows),
    }


HEAD = ("| group | episodes | patients | pending | ambiguous | S3 lead / eligible | S2 call / eligible | S2 call / S3 | "
        "S4 booked / eligible, 90-day window closed (S3 leads only in brackets; S4-pending = window open) | "
        "S4 early: lower bound: individual+window plus any Rx-link/db16 credited via credit-cluster | S5 done / matured >=94 d (pending out) | S4->S5 done / booked-matured (booked-pending) |")
SEP = "|" + "---|" * 12


def _line(label, s):
    if s["s4"]:
        s4 = f"{_frac(*s['s4'])} (S3 only: {_frac(*s['s4_of_s3'])}; S4-pending {s['s4_open']})"
        if s["s4_nosrc"]:
            s4 += f"; no S4 source {s['s4_nosrc']}"
    else:
        s4 = "n/a (S4 pull pending)"
    if s["s4_early"] and s["s4_early"][1] + s["s4_early_open"]:
        early = f"{_frac(*s['s4_early'])} (S4-pending {s['s4_early_open']})"
    else:
        early = "-"
    if s["s4_nosrc"] and not (s["s4"] and s["s4"][1] + s["s4_open"]) and not (s["s4_early"] and s["s4_early"][1] + s["s4_early_open"]):
        s4 = early = f"no S4 source ({s['s4_nosrc']} eligible episodes before --s4-from)"
    s45 = f"{_frac(*s['s4_s5'])} ({s['s4_pending']} pending)" if s["s4_s5"] else "n/a (S4 pull pending)"
    return (f"| {label} | {s['n']} | {s['patients']} | {s['pending']} | {s['ambiguous']} | {_frac(*s['s3'])} | {_frac(*s['s2'])} | "
            f"{_frac(*s['s2_of_s3'])} | {s4} | {early} | {_frac(*s['s5'])} ({s['pending']} pending; {s['young_done']} young done not in rate) | {s45} |")


def _table(rows, keyfn, order=None):
    groups = collections.defaultdict(list)
    for r in rows:
        groups[keyfn(r)].append(r)
    keys = order or sorted(groups)
    return [HEAD, SEP] + [_line(k, stats(groups[k])) for k in keys if k in groups]


def _short_ids(ids):
    n = 8
    while True:
        m = {i: i[:n] for i in ids}
        if len(set(m.values())) == len(ids) or n >= 40:
            return m
        n += 2


def _s4_cover_notes(meta):
    if not meta.get("pulse"):
        return ["S4 coverage: no Pulse file in this run; S4 is the db16 lead-status source only, over all rate months."]
    return [f"S4 coverage: --s4-from {meta['s4_from']} (first Pulse surgery_cases row); --s4-rx-from {meta['s4_rx_from']} (first Rx-linked case). "
            "V verified 402 bookings / 212 Rx-linked since 1 Oct 2026.",
            f"From {meta['s4_rx_from']} the S4 rate sees Rx links and the individual+window match. From {meta['s4_from']} to the day before that, S4 is a lower bound "
            "(labelled 'S4 early'): the individual+window match, plus any Rx-link or db16 booking that the credit-cluster rule credits to that episode from a later Rx. Before --s4-from there is no S4 source: shown as 'no S4 source', never 0%.",
            f"S4 window = {S4_WINDOW} days after the Rx day; an episode whose window is still open at the read date is out of every S4 denominator "
            "and shown as S4-pending, never a miss. An episode whose S5 is already done before age 90 stays S4-pending until it is 90 days old (conservative). Every link needs its date inside that window relative to the episode Rx it is credited to (credit-cluster rule, below).",
            "Assumptions not verified: individual_key (md5 of individual_uid) equals the cohort patient_key; the dpipe_prescription_pipeline column "
            "names (presc_url, presc_uid) and the tombstone:surgery_cases uid column in the Pulse SQL are unchecked until gating-lead runs it."]


def _pulse_sections(rows, meta):
    """Counts only. Excluded statuses, db16 blocks, window drops and the non-episode-Rx sensitivity, always per split."""
    L = []
    ex = meta.get("pulse_excluded")
    if ex is not None:
        L += ["", "## Pulse cases excluded from S4 (status PRESCRIBED or CANCELLED; credit nothing by any path)",
              "| status | split | month (case created) | cases |", "|---|---|---|---|"]
        for (st, sp, mo), c in sorted(ex.items()):
            L.append(f"| {st} | {sp} | {mo} | {c} |")
        for st in S4_EXCLUDED_STATUS:
            for sp in ("H", "D", "unresolved"):
                L.append(f"| {st} total | {sp} | all | {sum(c for (a, b, _), c in ex.items() if a == st and b == sp)} |")
        dr = meta.get("pulse_dropped", {})
        L += ["", "## Pulse cases ignored for S4 (Rx-linked, per split; rx_link_non_cohort_rx = the case sits on an Rx outside the cohort, counted as dropped)", "| reason | split | cases |", "|---|---|---|"]
        for kind in ("rx_link_empty_day", "rx_link_outside_window", "rx_link_after_s5_event", "rx_link_non_cohort_rx"):
            for sp in ("H", "D", "unresolved"):
                L.append(f"| {kind} | {sp} | {dr.get((kind, sp), 0)} |")
        L += ["", "## Pulse status vs db16 (per split)",
              "Block rule: an Rx with ANY PRESCRIBED/CANCELLED Pulse case withholds db16 for that Rx, even when it also has a valid case that was dropped "
              "(window, S5 event, empty day). Pulse wins: db16 is not consulted. Changing this rule is forest-lead's decision (OPEN).",
              "| split | episodes | of which db16 would have booked (not credited) | episodes where a valid-but-dropped case sat next to a blocking case |", "|---|---|---|---|"]
        for sp in ("H", "D"):
            s = stats([r for r in rows if r["split"] == sp])
            L.append(f"| {sp} | {s['pulse_blocked']} | {s['pulse_blocked_db16']} | {s['pulse_blocked_valid_dropped']} |")
    L += ["", "## Credit rule and sensitivity (episode-Rx-only), per split",
          "Rule (forest-lead ruling 19 Oct, F1: credit-cluster). An S2/S3/S4 link on any Rx of the same RD-0 cluster key counts for the episode if its date is in "
          f"[episode Rx date, episode Rx date + {S4_WINDOW} d] and on or before the S5 event date (if any). Each link is credited to one episode only: the latest episode Rx "
          "on or before the link date. A lead is dated by the Rx it sits on; a Pulse case by its created day; a db16 booking by its booking date. "
          "An ambiguous link (contact hash shared) stays excluded from the rates wherever it sits. PRESCRIBED/CANCELLED never credit and block db16 on that Rx. "
          "Sensitivity = the same rule counting only links that sit on the episode's own Rx (manual Pulse cases sit on no Rx and count in both). "
          "Bases are the rate populations of each stage (non-ambiguous, from Jan 2026; S4: window closed, covered), identical on both sides.",
          "| split | stage | primary (credit-cluster) | sensitivity (episode Rx only) |", "|---|---|---|---|"]
    for sp in ("H", "D"):
        s = stats([r for r in rows if r["split"] == sp])
        for lab, a_, b_ in (("S2", "s2", "ep_s2"), ("S3", "s3", "ep_s3"), ("S4", "s4", "ep_s4"), ("S4 early", "s4_early", "ep_s4_early")):
            if s[a_] is None or s[b_] is None:
                L.append(f"| {sp} | {lab} | n/a | n/a |")
            else:
                L.append(f"| {sp} | {lab} | {_frac(*s[a_])} | {_frac(*s[b_])} |")
    return L


def counts_md(rows, meta):
    L = ["# F1 funnel counts (counts only; no keys, no ids)", ""]
    if meta["provisional"]:
        L += ["**PROVISIONAL. Missing inputs: " + ", ".join(meta["provisional"]) + ".** Rates are not final; do not quote.", ""]
    L += [f"Read date {meta['read_date']}; S5 evidence cut {meta['s5_cut']}; cohort {meta['n_rx']} flagged Rx; lock {meta['lock_id']}.",
          "Every rate and stage count is within one split (H or D); H and D are never pooled in any rate. The Data notes at the end are pooled data-quality counts, not rates. Rates are descriptive (A2); H is not used for any design.",
          "Episode = p3a rule keyed on the RD-0 cluster key: one surgery credited once per cluster to its earliest flagged Rx; a cluster with no surviving event contributes its earliest flagged Rx.",
          f"Dec 2025 has no leads, so S2/S3/S4 rates start {RATES_FROM} (Dec 2025 episodes stay in S1 and S5).",
          "S2 call = at least one Runo call on the lead's contact after the lead day; S2 is a subset of S3 (calls are found through the lead), so S2 is also shown as a share of S3.",
          "S4 = Pulse surgery_cases booking form (primary, V ruling 19 Oct), db16 lead status secondary; a booking made elsewhere is invisible. PRESCRIBED and CANCELLED Pulse cases are not bookings and credit nothing. Daily Dash is never called.",
          *_s4_cover_notes(meta),
          "Pending = Rx younger than 94 days at the read date with no event; never a loss; out of every S5 denominator.",
          "S5 rate denominator = episodes whose credited Rx is >= 94 days old (p3a 'matured'), so an early done does not inflate the rate; young done episodes are counted in the stage counts and shown as 'young done not in rate'.",
          f"Ambiguous (contact_hash shared by >1 patient, or cluster in the shared-phone set [{meta['phone_source']}]): counted, kept in S1/S5, out of S2/S3/S4 rates.",
          ""]
    L += ["## Split totals", HEAD, SEP]
    for sp in ("H", "D"):
        L.append(_line(sp, stats([r for r in rows if r["split"] == sp])))
    L += ["", "## Ambiguous episodes per stage (counted here, excluded from rates)", "| split | ambiguous | with S2 | with S3 | with S4 | S5 done |", "|---|---|---|---|---|---|"]
    for sp in ("H", "D"):
        s = stats([r for r in rows if r["split"] == sp])
        L.append(f"| {sp} | {s['ambiguous']} | {s['amb_s2']} | {s['amb_s3']} | {s['amb_s4']} | {s['amb_s5_done']} |")
    for sp in ("H", "D"):
        sub = [r for r in rows if r["split"] == sp]
        s = stats(sub)
        L += ["", f"## Split {sp}: stage counts", "| stage | episodes | patients (clusters) |", "|---|---|---|"]
        for lab, fl in (("S1 pitched", lambda r: True), ("S2 counselled", lambda r: r["s2_counselled"]), ("S3 lead", lambda r: r["s3_lead"]),
                        ("S4 booked", lambda r: bool(r["s4_booked"])), ("S5 done", lambda r: r["s5_done"])):
            sel = [r for r in sub if fl(r)]
            if lab == "S4 booked" and all(r["s4_booked"] is None for r in sub):
                L.append(f"| {lab} | n/a (S4 pull pending) | n/a |")
                continue
            L.append(f"| {lab} (all, ambiguous included) | {len(sel)} | {len({r['cluster_key'] for r in sel})} |")
        L += ["", f"### Split {sp}: by month"] + _table(sub, lambda r: r["rx_month"])
        L += ["", f"### Split {sp}: by department"] + _table(sub, lambda r: r["department"])
    L += _pulse_sections(rows, meta)
    L += ["", "## S4 booked by source (episodes, all ambiguity, per split)", "| split | pulse_rx_link | pulse_individual_window (manual, no Rx) | db16_lead_status only |", "|---|---|---|---|"]
    for sp in ("H", "D"):
        c = collections.Counter(r["s4_source"] for r in rows if r["split"] == sp and r["s4_booked"])
        L.append(f"| {sp} | {c['pulse_rx_link']} | {c['pulse_individual_window']} | {c['db16_lead_status']} |")
    L += ["", "S4 primary = Pulse surgery booking form (surgery_cases). S4 rates only cover Rx days from --s4-from (see the coverage note at the top). The Daily Dash API is not used.",
          "", "## Data notes (pooled data-quality counts across H and D, not rates)"] + [f"- {k}: {v} (pooled data-quality count, not a rate)" for k, v in sorted(meta["diag"].items())]
    return "\n".join(L) + "\n"


def doctor_md(rows, meta):
    ids = _short_ids(sorted({r["doctor_uid"] for r in rows if r["doctor_uid"]}))
    L = ["# F1 funnel by doctor. ADMIN-ONLY. Not for doctor-facing use.", "",
         "Doctor id shortened. Same definitions as F1-COUNTS.md; H and D separate.", ""]
    for sp in ("H", "D"):
        sub = [r for r in rows if r["split"] == sp]
        L += [f"## Split {sp}"] + _table(sub, lambda r: ids.get(r["doctor_uid"], "unknown"), None) + [""]
    return "\n".join(L)


def write_text(path, text):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(path, 0o600)


# ---------------------------------------------------------------- main
def run(a):
    read_date = dt.date.fromisoformat(a.read_date)
    if read_date > dt.date.fromisoformat(a.s5_cut):
        raise FunnelError("read date is after the S5 evidence cut: unobserved windows would read as losses; refusing")
    s4_from, s4_rx_from = dt.date.fromisoformat(a.s4_from), dt.date.fromisoformat(a.s4_rx_from)
    if s4_from > s4_rx_from:
        raise FunnelError("--s4-from is after --s4-rx-from")
    sg = _split_guard()
    guard = sg.load(a.lock_dir, pinned_list_sha256=a.list_pin)
    if guard.seed_sha256 != a.seed_pin:
        raise FunnelError("seed pin does not match LOCK.json")
    cohort = load_cohort(a.cohort)
    clusters = load_clusters(a.clusters)
    p3a_out, n_dup = load_p3a(a.convert_dir, a.s5, a.p3a_sha12)
    s23, avail = load_s23(a.s23)
    missing = []
    if a.phone_keys:
        phone_keys, phone_source = load_key_set(a.phone_keys), "shared_phone_10e2"
    else:
        phone_keys, phone_source = load_edge_keys(a.phone_edges), "shared_phone_edges_partial"
        missing.append("10e2 key list (using 10d2 edges only, understates the shared-phone set)")
    if not avail["hash_ambiguity"]:
        missing.append("n_distinct_patients_per_contact_hash (contact_hash ambiguity not computed)")
    pulse = None
    global S4_FROM, S4_RX_FROM
    if a.s4_pulse and os.path.exists(a.s4_pulse):
        prow = read_tsv(a.s4_pulse)
        rx_cluster = {r["prescription_uid"]: clusters[r["patient_key"].strip().lower()] for r in cohort}
        pulse = PulseBooking(prow, clusters, rx_cluster, guard.set_of, cover_from=s4_from)
        S4_FROM, S4_RX_FROM = s4_from, s4_rx_from
    else:
        S4_FROM = S4_RX_FROM = None
        missing.append("Pulse surgery_cases booking pull f1-s4-pulse (S4 primary source)")
    if not avail["s4"]:
        missing.append("db16 lead-status fields (secondary S4 source absent)")
    if not avail["first_call_day"]:
        missing.append("first_call_day (days_to_call empty)")
    if not avail["department"]:
        missing.append("speciality (department = unknown)")
    if a.s5 is None:
        missing.append("S5 refresh to the read date (07b cut 15 Oct)")
    if missing and not a.allow_provisional:
        raise FunnelError("inputs missing: " + "; ".join(missing) + " (pass --allow-provisional to run anyway)")
    transcripts = None
    if a.transcripts:
        transcripts = {ln.strip() for ln in open(a.transcripts) if ln.strip()}
    else:
        missing.append("consult-transcript id list (s1_transcript empty)")
    chain = S4Chain(pulse, Db16LeadStatus(avail))
    rows, diag = build(cohort, clusters, guard, p3a_out, s23, avail, phone_keys, phone_source, read_date, transcripts, s4_source=chain)
    if pulse:
        for k, v in sorted(pulse.tally.items()):
            diag["pulse_" + k] = v
        diag["pulse_cases_credited_to_an_episode"] = len(pulse.used)
        diag["pulse_s4_from"], diag["pulse_s4_rx_from"] = str(S4_FROM), str(S4_RX_FROM)
    meta = {"provisional": missing, "read_date": a.read_date, "s5_cut": a.s5_cut, "n_rx": len(cohort),
            "lock_id": guard.lock_id, "phone_source": phone_source, "diag": diag,
            "pulse": bool(pulse), "s4_from": str(S4_FROM), "s4_rx_from": str(S4_RX_FROM)}
    if pulse:
        meta["pulse_excluded"], meta["pulse_dropped"] = dict(pulse.excluded), dict(pulse.dropped)
    diag["episodes"] = len(rows)
    diag["s5_duplicate_rows_dropped"] = n_dup
    diag["cohort_rx_with_no_lead_row"] = sum(1 for r in cohort if r["prescription_uid"] not in s23)
    out = write_rows(rows, os.path.expanduser(a.out_dir), a.date or a.read_date)
    cdir = os.path.expanduser(a.counts_dir)
    write_text(os.path.join(cdir, "F1-COUNTS.md"), counts_md(rows, meta))
    write_text(os.path.join(cdir, "F1-COUNTS-BY-DOCTOR-ADMIN-ONLY.md"), doctor_md(rows, meta))
    return out, rows, meta


def parser():
    h = os.path.expanduser("~")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cohort", default=f"{h}/eta-data/forest/split-input/10.tsv")
    p.add_argument("--clusters", default=f"{h}/eta-data/forest/split/clusters-2026-10-18.tsv")
    p.add_argument("--lock-dir", default=f"{h}/eta-data/forest/split")
    p.add_argument("--list-pin", required=True)
    p.add_argument("--seed-pin", required=True)
    p.add_argument("--convert-dir", default=f"{h}/oc/convert-lead")
    p.add_argument("--p3a-sha12", default=P3A_SHA12)
    p.add_argument("--s5", nargs="*", default=None, help="07b-shaped files (the f1-s5-* chunks); default the 15 Oct 07b")
    p.add_argument("--s5-cut", default="2026-10-15")
    p.add_argument("--s23", default=f"{h}/oc/forest-lead/funnel/in/f1-s23-s4.tsv")
    p.add_argument("--s4-from", default="2026-06-26", help="first Rx day with a Pulse S4 source (first surgery_cases row)")
    p.add_argument("--s4-rx-from", default="2026-09-25", help="first Rx day whose S4 is also seen through Rx links (first Rx-linked case)")
    p.add_argument("--s4-pulse", default=f"{h}/oc/forest-lead/funnel/in/f1-s4-pulse.tsv", help="f1-s4-pulse-booking.sql output (S4 primary)")
    p.add_argument("--phone-keys", default=None, help="f1-10e2-keys.tsv (patient_key column)")
    p.add_argument("--phone-edges", default=f"{h}/oc/forest-lead/data/10d2-edges-phone.tsv")
    p.add_argument("--transcripts", default=None, help="one consult_uid per line")
    p.add_argument("--read-date", default="2026-10-15")
    p.add_argument("--date", default=None)
    p.add_argument("--out-dir", default=f"{h}/eta-data/forest/funnel")
    p.add_argument("--counts-dir", default=f"{h}/oc/forest-lead/funnel")
    p.add_argument("--allow-provisional", action="store_true")
    return p


if __name__ == "__main__":
    a = parser().parse_args()
    try:
        path, rows, meta = run(a)
    except Exception as e:
        # messages of our own and the guard's errors carry counts only; anything else (KeyError etc.) may quote a key, so type only
        own = isinstance(e, (FunnelError, _split_guard().GuardError))
        print(f"FAIL {type(e).__name__}" + (f": {e}" if own else ""), file=sys.stderr)
        sys.exit(2)
    print(f"ok episodes={len(rows)} out={path} provisional={bool(meta['provisional'])}")
