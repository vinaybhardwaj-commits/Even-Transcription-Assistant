#!/usr/bin/env python3
"""spine_recon (Spine S4): per IST date, reconcile spine encounters against the consult stage ledger and the daily_recon output. Read-only on every input.
Output is COUNTS AND REASON CODES ONLY (no id, name, text or path of any record) to the local JSON named by --out. R2 upload happens only with --upload (never default).

  python3 spine_recon.py --date YYYY-MM-DD --spine SPINE.json --out OUT.json [--eta-data DIR] [--ledger FILE] [--daily-recon FILE] [--expect pulse=17,pqm=0] [--upload --cred FILE --bucket NAME]

SPINE.json is an export of the day's spine rows, made by the caller from read-only SELECTs (no database client lives here):
  {"encounters": [{"encounter_id", "status", "reason", "anchor_proxy", "proxies": [..], "flags": [..]}],          -- spine_encounter where ist_date = DATE (flags = the text[] column, S0 R3; proxies from spine_signal)
   "links":      [{"encounter_id", "key_kind", "value", "active"}],                                              -- spine_link for those encounters
   "signal_counts": {"pulse": 17, ...},                                                                          -- spine_signal by proxy for the date (optional)
   "artefacts":  [{"encounter_id", "stage", "status"}]}                                                          -- spine_artefact (optional)
LEDGER (assumed shape, UNVERIFIED: consult_ledger.py is withheld from the mirror): <eta-data>/consult-stage-ledger.jsonl, one JSON object per line with consult_uid, a date
(ist_date, else the IST date of ts / t_close / t_open, else a bare date | day) and either "stages": {stage: state} or "stage" + "state". The last line per (uid, stage) wins.
Mapping rule: every ledger consult_uid maps to exactly 1 confirmed encounter. Every other outcome is a diff with a reason code:
  missing_uid | split (one uid, several encounters) | not_confirmed:<status> | merged_uids (one encounter holds several uids; informational, not a failure).
Extras (a live spine encounter no ledger uid reaches) are listed by proxy plus reason. An ambiguous encounter is counted and shown, never hidden (R1).
Gate FAILS (gate="fail", "gate_reasons" = closed codes, exit 1; the report is still written) when: ledger_uids == 0 | ledger_bad_lines > 0 | ledger_undated_lines > 0 |
matched uids < 95% of ledger uids | two_uids_one_encounter (listed by encounter_id in "two_uids_encounters") | any diff | a stage or proxy mismatch.
The ledger date is the IST date of ts / t_close / t_open (never UTC). Flags (ambiguous, multi_machine, pulse_overlap, clamped, clamp_failed, covered_by_pulse) are counted and shown (R1).
Exit 0 when the report is written and the gate passes, 1 when it is written and the gate fails, 2 on a bad argument or an unreadable/corrupt input, 4 when --upload failed."""
import argparse, collections, datetime as dt, json, os, re, sys

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
CODE = re.compile(r"^[a-z0-9_:\-]{1,40}$")
DIGITS8 = re.compile(r"[0-9]{8}")
FLAGS = ("ambiguous", "multi_machine", "pulse_overlap", "clamped", "clamp_failed", "covered_by_pulse")
MATCH_FLOOR = 0.95
DONE_STATES = ("done", "ok", "written", "sealed", "ready")


class BrokenInput(Exception):
    pass


def code(v, default="other"):
    """A closed-vocabulary label or `default`: free text can never reach the output."""
    s = str(v).strip().lower() if v is not None else ""
    return s if CODE.match(s) and not DIGITS8.search(s) else default


def read_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as e:
        raise BrokenInput(f"{what}: {type(e).__name__}")


def ist_date_of(v):
    try:
        t = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(IST).date().isoformat()


def line_date(r):
    """IST date only: an explicit ist_date wins, then the IST date of an instant (ts / t_close / t_open), and only then a bare date / day (whose zone is unknown)."""
    def plain(k):
        return r[k] if isinstance(r.get(k), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", r[k]) else None
    if plain("ist_date"):
        return plain("ist_date")
    for k in ("ts", "t_close", "t_open"):
        if r.get(k):
            d = ist_date_of(r[k])
            if d:
                return d
    return plain("date") or plain("day")


def load_ledger(path, date):
    """(stages, bad, undated): stages = {uid: {stage: state}} for `date`, last line per (uid, stage)."""
    stages, bad, undated = {}, 0, 0
    try:
        fh = open(path, encoding="utf-8")
    except OSError as e:
        raise BrokenInput(f"ledger: {type(e).__name__}")
    with fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                r = json.loads(raw)
            except ValueError:
                bad += 1
                continue
            if not isinstance(r, dict) or not r.get("consult_uid"):
                bad += 1
                continue
            d = line_date(r)
            if d is None:
                undated += 1
                continue
            if d != date:
                continue
            uid = str(r["consult_uid"])
            slot = stages.setdefault(uid, {})
            if isinstance(r.get("stages"), dict):
                for s, st in r["stages"].items():
                    slot[code(s)] = code(st if not isinstance(st, dict) else st.get("state"))
            elif r.get("stage") is not None:
                slot[code(r["stage"])] = code(r.get("state", r.get("status")))
    return stages, bad, undated


def load_spine(path):
    j = read_json(path, "spine")
    if not isinstance(j, dict) or not isinstance(j.get("encounters"), list) or not isinstance(j.get("links"), list):
        raise BrokenInput("spine: bad shape")
    return j


def resolve(enc, eid):
    """Follow merged_into to the survivor (bounded)."""
    for _ in range(10):
        e = enc.get(eid)
        if not e or e.get("status") != "merged" or not e.get("merged_into"):
            return eid
        eid = e["merged_into"]
    return eid


def reconcile(date, ledger, spine, daily=None, expect=None, ledger_bad=0, ledger_undated=0):
    """Pure. Counts and reason codes only."""
    enc = {e["encounter_id"]: e for e in spine["encounters"] if isinstance(e, dict) and e.get("encounter_id")}
    uid_to_enc = collections.defaultdict(set)
    for l in spine["links"]:
        if not isinstance(l, dict):
            raise BrokenInput("spine: bad link")
        if l.get("key_kind") == "consult_uid" and l.get("active", True):
            eid = resolve(enc, l.get("encounter_id"))
            if eid in enc:
                uid_to_enc[str(l["value"])].add(eid)
    diffs = collections.Counter()
    mapped = 0
    enc_uids = collections.defaultdict(set)
    for uid in ledger:
        es = uid_to_enc.get(uid, set())
        for e in es:
            enc_uids[e].add(uid)
        if not es:
            diffs["missing_uid"] += 1
        elif len(es) > 1:
            diffs["split"] += 1
        else:
            st = enc[next(iter(es))].get("status")
            if st == "confirmed":
                mapped += 1
            else:
                diffs["not_confirmed:" + code(st)] += 1
    merged_uids = sum(1 for us in enc_uids.values() if len(us) > 1)
    reached = {e for e, us in enc_uids.items() if us}
    extras = collections.Counter()
    live = [e for e in enc.values() if e.get("status") in ("candidate", "confirmed")]
    for e in live:
        if e["encounter_id"] in reached:
            continue
        proxy = code(e.get("anchor_proxy"), "") or "+".join(sorted(code(p) for p in (e.get("proxies") or []))) or "none"
        reason = code(e.get("reason"), "") or ("weak_only" if not ({"pulse", "pqm"} & set(e.get("proxies") or [])) else "no_ledger_row")
        extras[(proxy, reason, code(e.get("status")))] += 1
    flag_counts = {f: sum(1 for e in live if f in (e.get("flags") or [])) for f in FLAGS}
    # per-stage: ledger state histogram, and the spine's artefact histogram when supplied
    led_stage = collections.defaultdict(collections.Counter)
    for slot in ledger.values():
        for s, st in slot.items():
            led_stage[code(s)][code(st)] += 1
    sp_stage = collections.defaultdict(collections.Counter)
    has_art = isinstance(spine.get("artefacts"), list)
    if has_art:
        for a in spine["artefacts"]:
            sp_stage[code(a.get("stage"))][code(a.get("status"))] += 1
    stage_match = {}
    for s in sorted(set(led_stage) | set(sp_stage)):
        led_done = sum(n for st, n in led_stage[s].items() if st in DONE_STATES)
        stage_match[s] = {"ledger_done": led_done, "spine_ok": sp_stage[s].get("ok") if has_art else None,
                          "equal": (led_done == sp_stage[s].get("ok", 0)) if has_art else None}
    sc = {code(k): int(v) for k, v in (spine.get("signal_counts") or {}).items() if isinstance(v, (int, float))}
    proxy_check = None
    if expect:
        proxy_check = {k: {"expected": v, "spine": sc.get(k, 0), "equal": sc.get(k, 0) == v} for k, v in sorted(expect.items())}
    dr = None
    if daily is not None:
        if not isinstance(daily, dict):
            raise BrokenInput("daily_recon: bad shape")
        rooms = daily.get("rooms") or []
        if not isinstance(rooms, list) or not all(isinstance(r, dict) for r in rooms) or not isinstance(daily.get("day") or {}, dict):
            raise BrokenInput("daily_recon: bad shape")
        dr = {"present": True, "pqm_visits": int((daily.get("day") or {}).get("pqm_visits", 0)), "pulse_windows": sum(int(r.get("pulse_windows", 0)) for r in rooms),
              "clips_cut": sum(int(r.get("clips_cut", 0)) for r in rooms), "alerts": len(daily.get("alerts") or []), "ledger_uids": len(ledger)}
        dr["clips_cut_minus_ledger_uids"] = dr["clips_cut"] - dr["ledger_uids"]
    else:
        dr = {"present": False}
    two = sorted(e for e, us in enc_uids.items() if len(us) > 1)
    reasons = []
    if not ledger:
        reasons.append("ledger_empty")
    if ledger_bad:
        reasons.append("ledger_bad_lines")
    if ledger_undated:
        reasons.append("ledger_undated_lines")
    if ledger and mapped < MATCH_FLOOR * len(ledger):
        reasons.append("matched_below_floor")
    if two:
        reasons.append("two_uids_one_encounter")
    if diffs:
        reasons.append("diffs")
    if not all(m["equal"] in (True, None) for m in stage_match.values()):
        reasons.append("stage_mismatch")
    if proxy_check is not None and not all(c["equal"] for c in proxy_check.values()):
        reasons.append("proxy_mismatch")
    gate_ok = not reasons
    return {
        "date": date,
        "ledger_uids": len(ledger),
        "mapped_to_one_confirmed": mapped,
        "diffs": dict(sorted(diffs.items())),
        "merged_uids_encounters": merged_uids,
        "encounters": dict(collections.Counter(code(e.get("status")) for e in enc.values())),
        "ambiguous_encounters": flag_counts["ambiguous"],
        "flag_counts": flag_counts,
        "two_uids_encounters": two,
        "gate_reasons": reasons,
        "ledger_bad_lines": ledger_bad,
        "ledger_undated_lines": ledger_undated,
        "extras": [{"proxy": p, "reason": r, "status": s, "count": n} for (p, r, s), n in sorted(extras.items())],
        "extras_total": sum(extras.values()),
        "ledger_stage_states": {s: dict(c) for s, c in sorted(led_stage.items())},
        "stage_match": stage_match,
        "spine_signal_counts": sc,
        "proxy_check": proxy_check,
        "daily_recon": dr,
        "gate": "pass" if gate_ok else "fail",
        "gate_note": "clinic day required: a non-clinic day proves nothing" if gate_ok else "see gate_reasons / diffs / stage_match / proxy_check",
    }


def write_atomic(path, text):
    tmp = f"{path}.tmp"
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def r2_client(cred_file):
    try:
        lines = [x.strip() for x in open(cred_file).read().splitlines() if x.strip()]
    except OSError:
        raise BrokenInput("cred unreadable")
    if len(lines) < 3:
        raise BrokenInput("cred shape")
    import boto3
    return boto3.client("s3", aws_access_key_id=lines[0], aws_secret_access_key=lines[1], endpoint_url=lines[2], region_name="auto")


def parse_expect(s):
    out = {}
    for part in filter(None, (s or "").split(",")):
        k, _, v = part.partition("=")
        if not v.isdigit():
            raise BrokenInput("--expect shape")
        out[code(k)] = int(v)
    return out


def main(argv=None, client=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--date", required=True)
    ap.add_argument("--spine", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--eta-data", default=os.path.expanduser("~/eta-data"))
    ap.add_argument("--ledger")
    ap.add_argument("--daily-recon")
    ap.add_argument("--expect")
    ap.add_argument("--upload", action="store_true", help="PUT enc/spine-recon/<date>.json to R2; off by default")
    ap.add_argument("--cred")
    ap.add_argument("--bucket")
    a = ap.parse_args(argv)
    try:
        dt.date.fromisoformat(a.date)
        ledger, bad, undated = load_ledger(a.ledger or f"{a.eta_data}/consult-stage-ledger.jsonl", a.date)
        spine = load_spine(a.spine)
        dpath = a.daily_recon or f"{a.eta_data}/consult/recon/{a.date}.json"
        daily = read_json(dpath, "daily_recon") if os.path.exists(dpath) else None
        rep = reconcile(a.date, ledger, spine, daily, parse_expect(a.expect), bad, undated)
    except (BrokenInput, ValueError) as e:
        print(f"BROKEN INPUT: {e}", file=sys.stderr)
        return 2
    body = json.dumps(rep, indent=1, sort_keys=True) + "\n"
    write_atomic(a.out, body)
    print(f"{a.date}: gate={rep['gate']} ledger_uids={rep['ledger_uids']} mapped={rep['mapped_to_one_confirmed']} diffs={sum(rep['diffs'].values())} extras={rep['extras_total']}")
    if a.upload:
        try:
            if not (a.bucket and (client or a.cred)):
                raise BrokenInput("--upload needs --bucket and --cred")
            (client or r2_client(a.cred)).put_object(Bucket=a.bucket, Key=f"enc/spine-recon/{a.date}.json", Body=body.encode(), ContentType="application/json")
        except BrokenInput as e:
            print(f"UPLOAD REFUSED: {e}; local output written", file=sys.stderr)
            return 4
        except Exception as e:
            print(f"UPLOAD FAILED ({type(e).__name__}); local output written", file=sys.stderr)
            return 4
    return 0 if rep["gate"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
