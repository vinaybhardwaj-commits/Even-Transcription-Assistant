"""Entry point: python -m steward.run [--force] [--out FILE] [--cap USD] [--date YYYY-MM-DD]"""
from __future__ import annotations
import argparse
import json
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from . import agent, config, phi, poster, report as rpt, spend


def build_doc(started, ended, model, res, summary, items, dropped, status, ledger_run_cost=0.0) -> dict:
    return {"run": {"id": str(uuid.uuid4()), "started_at": started.isoformat(timespec="seconds"),
                    "ended_at": ended.isoformat(timespec="seconds"), "mode": "advise", "model": model,
                    "tokens_in": res["tokens_in"], "tokens_out": res["tokens_out"],
                    "cost_usd": round(ledger_run_cost, 6),
                    "summary_md": summary, "status": status},
            "items": items, "dropped": dropped}


def main(argv=None, client=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="ignore the ENABLED flag file (manual runs)")
    ap.add_argument("--out", help="write to this file instead of the dated steward folder")
    ap.add_argument("--cap", help="per-run cap in USD, finite, 0 < cap <= 2.00 (default 1.00)")
    ap.add_argument("--date", help="IST 'today' override (YYYY-MM-DD)")
    a = ap.parse_args(argv)

    if not a.force and not spend.enabled():
        print("steward: disabled (no ENABLED flag file)")
        return 0
    try:
        run_cap = config.parse_cap(a.cap, config.MAX_RUN_CAP, "run cap") if a.cap is not None else config.run_cap_usd()
        daily = config.daily_cap_usd()
    except ValueError as e:
        print(f"steward: refused: {e}", file=sys.stderr)
        return 2
    model = phi.assert_model_ok(config.model_id())
    today = a.date or spend.ist_today()
    yesterday = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    lp = config.ledger_path()
    try:
        lock = spend.RunLock(lp)
        lock.__enter__()
    except RuntimeError as e:
        print(f"steward: refused: {e}", file=sys.stderr)
        return 5
    try:
        return _run(a, client, model, today, yesterday, lp, daily, run_cap)
    finally:
        lock.__exit__()


def _run(a, client, model, today, yesterday, lp, daily, run_cap) -> int:
    ledger = spend.Ledger(lp, daily, run_cap)
    if client is None:
        from .llm import BedrockConverse
        client = BedrockConverse(model)
    started = datetime.now(spend.IST)
    res = agent.run_agent(client, ledger, today, yesterday, model)
    summary, items, dropped, status = "", [], [], res["status"]
    if res["report"]:
        rr = res["report"]
        shape = {k: (type(v).__name__, len(v) if hasattr(v, "__len__") else None) for k, v in rr.items()}
        print("steward: report shape", shape)
    if res["report"]:
        try:
            summary, items, dropped = rpt.validate(res["report"])
        except phi.PhiGuardError as e:
            keep = status
            status, summary = "phi_rejected", f"Summary withheld by the phi guard ({e})."
            if keep == "truncated":
                status = "truncated"
    elif not summary:
        summary = f"No report produced ({status})."
    ended = datetime.now(spend.IST)
    doc = build_doc(started, ended, model, res, summary, items, dropped, status, ledger.run_spent)
    phi.check_deep({"s": doc["run"]["summary_md"], "i": [(i["title"], i["body_md"]) for i in items]})
    out = Path(a.out) if a.out else config.out_root() / today / f"run-{started.strftime('%Y%m%dT%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2))
    print(f"steward: {status} items={len(items)} dropped={len(dropped)} cost_usd={doc['run']['cost_usd']} out={out}")
    print(poster.post_run(doc))
    if status == "truncated":
        return 4  # reply cut off at max_tokens; parsed items (if any) are kept in the file
    if status == "cap" and not items:
        return 3  # cut off by the cap before a report: a minimal report (status cap, no items) was written
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
