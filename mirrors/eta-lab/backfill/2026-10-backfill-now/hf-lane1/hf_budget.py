"""hf_budget.py — HF-1 budget gate for the lane-1 launcher. Fed from HF's own billed data (GET /api/settings/billing/usage-v2 + HfApi.list_jobs), NEVER from hf_ledger.py.
FAIL CLOSED: snapshot() raises BudgetUnavailable if usage-v2 or the job list cannot be read; gate() then refuses. Read-only: creates nothing on HF. Token read in-process, never printed.
Rules (ORDERS-HF-1 item 6) — refuse if: lane-1 billed+committed(+this launch) > LANE_CAP_USD (60); today's (IST) billed+committed(+this launch) > DAY_CAP_USD (80);
balance_usd (V's figure, required for --launch) - committed(+this launch) < MIN_BALANCE_USD (15).
Committed = open jobs x flavor rate x timeout (full timeout, conservative; the timeout of a job we did not launch is unknown, so COMMIT_TIMEOUT_MIN is assumed for it)."""
import json, math, os, urllib.request
from datetime import datetime, timedelta, timezone

LANE_CAP_USD, DAY_CAP_USD, MIN_BALANCE_USD = 60.0, 80.0, 15.0
COMMIT_TIMEOUT_MIN = 45
LANE_JOB_PREFIX = "whisper3_hf_job"
OPEN_STAGES = ("RUNNING", "UPDATING", "SCHEDULING", "QUEUED", "PENDING")
IST = timezone(timedelta(hours=5, minutes=30)); UTC = timezone.utc

class BudgetUnavailable(RuntimeError): pass

def _token(): return open(os.path.expanduser("~/.cache/huggingface/token")).read().strip()

def billed_since(start, now=None, token=None):
    """HF-billed USD (jobs + spaces) between start and now (usage-v2; epoch SECONDS)."""
    now = now or datetime.now(UTC)
    try:
        r = urllib.request.Request(f"https://huggingface.co/api/settings/billing/usage-v2?startDate={int(start.timestamp())}&endDate={int(now.timestamp())}", headers={"Authorization": "Bearer " + (token or _token())})
        u = json.load(urllib.request.urlopen(r, timeout=30))["usage"]
        return u["jobs"]["usedMicroUsd"] / 1e6 + sum(i["totalCostMicroUSD"] for i in u["Spaces"]) / 1e6
    except Exception as e:
        raise BudgetUnavailable(f"usage-v2 unreadable: {type(e).__name__}") from None

def flavor_rates(api):
    try: return {h.name: float(h.unit_cost_usd) * 60 for h in api.list_jobs_hardware()}   # USD per HOUR
    except Exception as e: raise BudgetUnavailable(f"hardware rates unreadable: {type(e).__name__}") from None

def snapshot(api=None, now=None, billed_fn=billed_since):
    """-> dict(today_billed, lane_billed, committed_all, committed_lane, open_jobs). Raises BudgetUnavailable on any read failure."""
    from huggingface_hub import HfApi
    now = now or datetime.now(UTC); api = api or HfApi(token=_token())
    try:
        ns = api.whoami()["name"]; jobs = list(api.list_jobs(namespace=ns))
    except Exception as e: raise BudgetUnavailable(f"job list unreadable: {type(e).__name__}") from None
    rate = flavor_rates(api)
    day0 = now.astimezone(IST).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    today = billed_fn(day0, now)
    lane_billed = committed_all = committed_lane = 0.0; n_open = 0
    for j in jobs:
        fl = str(j.flavor).split(".")[-1].lower().replace("_", "-"); hr = rate.get(fl, rate.get(str(j.flavor)))
        if hr is None: raise BudgetUnavailable(f"no rate for flavor {j.flavor}")
        name = (j.labels or {}).get("name", ""); is_lane = name.startswith(LANE_JOB_PREFIX)
        if j.status.stage in OPEN_STAGES:
            c = hr * COMMIT_TIMEOUT_MIN / 60.0; committed_all += c; committed_lane += c if is_lane else 0.0; n_open += 1
        elif is_lane and j.durations and j.durations.running_secs:
            lane_billed += math.ceil(j.durations.running_secs / 60) * hr / 60.0
    return {"today_billed": today, "lane_billed": lane_billed, "committed_all": committed_all, "committed_lane": committed_lane, "open_jobs": n_open}

def gate(snap, new_cost_usd, balance_usd=None, require_balance=True):
    """-> (ok, [reasons]). new_cost_usd = this launch's committed cost (jobs x rate x timeout)."""
    why = []
    if snap["lane_billed"] + snap["committed_lane"] + new_cost_usd > LANE_CAP_USD:
        why.append(f"lane-1 cap: billed {snap['lane_billed']:.2f} + committed {snap['committed_lane']:.2f} + new {new_cost_usd:.2f} > {LANE_CAP_USD:.0f}")
    if snap["today_billed"] + snap["committed_all"] + new_cost_usd > DAY_CAP_USD:
        why.append(f"daily cap: billed today {snap['today_billed']:.2f} + committed {snap['committed_all']:.2f} + new {new_cost_usd:.2f} > {DAY_CAP_USD:.0f}")
    if balance_usd is None:
        if require_balance: why.append("--balance-usd is required for --launch")
    elif balance_usd - snap["committed_all"] - new_cost_usd < MIN_BALANCE_USD:
        why.append(f"balance floor: {balance_usd:.2f} - committed {snap['committed_all']:.2f} - new {new_cost_usd:.2f} < {MIN_BALANCE_USD:.0f}")
    return (not why), why

def check_launch(n_jobs, rate_usd_h, timeout_min, balance_usd, snapshot_fn=snapshot):
    """Fail closed wrapper: any read failure => (False, [reason])."""
    try: snap = snapshot_fn()
    except BudgetUnavailable as e: return False, [f"FAIL CLOSED: {e}"], None
    ok, why = gate(snap, n_jobs * rate_usd_h * timeout_min / 60.0, balance_usd, True)
    return ok, why, snap
