"""One scoreboard row (spec 12.6): a markdown line appended to the SCOREBOARD file and a JSON row file beside it."""
from __future__ import annotations

import json
import os
from pathlib import Path

COLUMNS = ("round", "code", "prompts", "judges", "models", "render", "split sha", "split", "n", "A", "B0", "Bn", "Bn items > A", "Bn-A", "Bn-B0",
           "floors", "floor basis", "jev", "replay drops", "tolerated_cells", "parse_fail_cells", "floor_rows_unparsed", "rendered chars", "cost USD", "verdict")


def _f(v, nd=2):
    return "-" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))


def _combo_cell(d: dict, key: str) -> str:
    return "<br>".join(f"{c}: {_f(v.get('median'))}/{_f(v.get('mean'))}" if isinstance(v, dict) else f"{c}: {_f(v)}" for c, v in d.items())


def _models_cell(r: dict) -> str:
    ids = r.get("resolved_model_ids") or {}
    return "; ".join(f"{a}={i}" for a, i in ids.items()) or "-"


def md_row(r: dict) -> str:
    def floor_cell(t):
        att = f" [eta {_f(t['eta'])}, pulse_catalogue {_f(t['pulse_catalogue'])}, pulse_extraction {_f(t['pulse_extraction'])}, check {_f(t['check'])}]" if "eta" in t else ""
        return f"{t['floor']} {_f(t['bn'], 3)}{att} ({'ok' if t['pass'] else 'FAIL'})"

    fh = r.get("floor_header") or r["floors"].get("header") or {}
    basis_cell = r.get("floor_basis", r["floors"].get("basis", "eta")) + (
        f" [eta {fh['eta']}, pulse_catalogue {fh['pulse_catalogue']}, pulse_extraction {fh['pulse_extraction']}, check {fh['check']}]" if fh else "")
    floors = "; ".join(floor_cell(t) for t in r["floors"]["rows"])
    cells = [r["round"], r["code_sha"][:12], r["prompt_sha"][:12], r["judge_sha"][:12], _models_cell(r), r["render"], r["split_sha"][:12], r["split"], r["n"],
             _combo_cell({c: v["A"] for c, v in r["totals"].items()}, "A"), _combo_cell({c: v["B0"] for c, v in r["totals"].items()}, "B0"),
             _combo_cell({c: v["Bn"] for c, v in r["totals"].items()}, "Bn"),
             "<br>".join(f"{c}: {v}" for c, v in r["items_bn_gt_a"].items()),
             "<br>".join(f"{c}: d={_f(v['median_diff'])} p_holm={_f(v.get('p_holm'), 3)} rb={_f(v['rank_biserial'])}" for c, v in r["succinct_bn_minus_a"].items()),
             "<br>".join(f"{c}: d={_f(v['median_diff'])} p_holm={_f(v.get('p_holm'), 3)} rb={_f(v['rank_biserial'])}" for c, v in r["thorough_bn_minus_b0"].items()),
             floors, basis_cell, r["jev"].get("summary", r["jev"].get("status", "-")), r["replay_drops"],
             _f(r.get("tolerated_cells")), _f(r.get("parse_fail_cells", r.get("parse_failures"))), _f(r.get("floor_rows_unparsed")),
             " / ".join(f"{a} {_f(v, 0)}" for a, v in r["rendered_chars_mean"].items()), _f(r["cost_usd"], 4), r["verdict"]]
    return "| " + " | ".join(str(c).replace("|", "/").replace("\n", " ") for c in cells) + " |"


def write(row: dict, scoreboard: Path) -> Path:
    scoreboard = Path(scoreboard)
    scoreboard.parent.mkdir(parents=True, exist_ok=True)
    new = not scoreboard.exists()
    with open(scoreboard, "a", encoding="utf-8") as f:
        if new:
            f.write("| " + " | ".join(COLUMNS) + " |\n|" + "---|" * len(COLUMNS) + "\n")
        f.write(md_row(row) + "\n")
    jp = scoreboard.with_name(f"{scoreboard.stem}.{row['round']}.json")
    fd = os.open(jp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(row, f, indent=1)
    return jp
