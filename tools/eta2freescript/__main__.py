"""CLI.

  python -m tools.eta2freescript run --consult <uid> --data DIR [--out OUT] [--client bedrock|gateway|replay --replay DIR]
  python -m tools.eta2freescript run --all --data DIR [--workers 5]
  python -m tools.eta2freescript eval --data DIR --out OUT [--judge opus] [--force]
  python -m tools.eta2freescript aggregate --out OUT
  python -m tools.eta2freescript validate FILE...
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import STAGE_A_VERSION, STAGE_B_VERSION
from .ingest import list_consults, load_consult
from .models import UsageLedger, make_client
from .phi_guard import PhiGuardError, assert_phi_safe


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--data", type=Path, required=True, help="folder with one sub-folder per consult uid (see ingest.py)")
    p.add_argument("--out", type=Path, help="output folder (default <data>/_eta2freescript)")
    p.add_argument("--client", default="bedrock", choices=("bedrock", "gateway", "replay"))
    p.add_argument("--replay", type=Path, help="stored model outputs DIR/<uid>/{stageA.json,stageB.txt,judge.json} (--client replay)")
    p.add_argument("--workers", type=int, default=5)
    p.add_argument("--english", default="auto", choices=("auto", "on", "off"), help="use the English pass (auto: if present)")
    p.add_argument("--no-role-track", action="store_true", help="ignore role.json and infer roles (A/B the role track)")


def _uids(a) -> list[str]:
    if getattr(a, "consult", None):
        return a.consult
    return list_consults(a.data)


def _client(a, out: Path):
    kind = "replay" if a.replay and a.client == "bedrock" else a.client
    return make_client(kind, UsageLedger(out / "usage.jsonl"), a.replay)


def cmd_run(a) -> int:
    from .pipeline import Options, run_consult
    out = a.out or a.data / "_eta2freescript"
    client = _client(a, out)
    try:
        assert_phi_safe(*client.resolve(a.model))
    except PhiGuardError as e:
        print(e, file=sys.stderr)
        return 2
    opts = Options(model=a.model, stage_a=f"stageA-{a.stage_a_version}", stage_b=f"stageB-{a.stage_b_version}", stage_b_enabled=not a.no_stage_b)

    def one(uid):
        try:
            c = load_consult(a.data, uid, english=a.english, use_role_track=not a.no_role_track)
            return run_consult(c, client, out, opts)
        except Exception as e:  # one consult failing must not stop the batch; the error is reported, never swallowed
            return {"uid": uid, "error": f"{type(e).__name__}: {str(e)[:200]}"}

    bad = 0
    with ThreadPoolExecutor(max(1, a.workers)) as ex:
        for lg in ex.map(one, _uids(a)):
            if lg.get("error"):
                bad += 1
                print(lg["uid"], "ERROR", lg["error"], flush=True)
                continue
            bad += not lg["final_valid"]
            print(lg["uid"], f"valid={lg['final_valid']} note={lg['note_source']} roles={lg['speaker_source']}"
                  f" completion_required={lg['completion_required']} boundary={'suspected' if lg['boundary']['suspected'] else 'clean'}",
                  f"-> {out / lg['uid'] / 'artifact.json'}" if lg["written"] else "(not written)", flush=True)
    return 1 if bad else 0


def cmd_eval(a) -> int:
    from .eval.judge import judge_one, metrics, write_rows
    out = a.out or a.data / "_eta2freescript"
    client = _client(a, out)
    try:
        assert_phi_safe(*client.resolve(a.judge))
    except PhiGuardError as e:
        print(e, file=sys.stderr)
        return 2

    def one(uid):
        ap = out / uid / "artifact.json"
        if not ap.exists():
            return {"uid": uid, "skip": "no artifact (run the pipeline first)"}
        art = json.loads(ap.read_text(encoding="utf-8"))
        logp = out / uid / "artifact.validation.json"
        log = json.loads(logp.read_text(encoding="utf-8")) if logp.exists() else {}
        try:
            c = load_consult(a.data, uid, english=a.english, use_role_track=not a.no_role_track)
            rec = judge_one(c, art, client, out, a.judge, a.force)
        except Exception as e:
            return {"uid": uid, "skip": f"judge failed: {type(e).__name__}: {str(e)[:200]}"}
        if rec is None:
            return {"uid": uid, "skip": "no signed.json"}
        return metrics(rec, art, log)

    with ThreadPoolExecutor(max(1, a.workers)) as ex:
        res = list(ex.map(one, _uids(a)))
    rows = [r for r in res if "skip" not in r]
    for r in res:
        if "skip" in r:
            print(r["uid"], "SKIP", r["skip"])
    write_rows(rows, out / "eval" / "results.csv")
    print(len(rows), "rows ->", out / "eval" / "results.csv")
    return 0


def cmd_aggregate(a) -> int:
    from .eval.aggregate import aggregate
    print(json.dumps(aggregate(a.out), indent=1))
    return 0


def cmd_validate(a) -> int:
    from .validate import main
    return main([str(p) for p in a.files])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tools.eta2freescript")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="transcript (+ role track) -> artifact")
    _common(r)
    g = r.add_mutually_exclusive_group(required=True)
    g.add_argument("--consult", nargs="+", metavar="UID")
    g.add_argument("--all", action="store_true")
    r.add_argument("--model", default="sonnet")
    r.add_argument("--stage-a-version", default=STAGE_A_VERSION)
    r.add_argument("--stage-b-version", default=STAGE_B_VERSION)
    r.add_argument("--no-stage-b", action="store_true", help="deterministic note_text only")
    r.set_defaults(fn=cmd_run)
    e = sub.add_parser("eval", help="judge artifacts against signed notes")
    _common(e)
    e.add_argument("--consult", nargs="+", metavar="UID")
    e.add_argument("--judge", default="opus")
    e.add_argument("--force", action="store_true")
    e.set_defaults(fn=cmd_eval)
    g2 = sub.add_parser("aggregate", help="pool eval results into headline.json")
    g2.add_argument("--out", type=Path, required=True)
    g2.set_defaults(fn=cmd_aggregate)
    v = sub.add_parser("validate", help="validate artifact files")
    v.add_argument("files", nargs="+", type=Path)
    v.set_defaults(fn=cmd_validate)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
