"""One scoreboard row (spec 12.6): a markdown line appended to the SCOREBOARD file and a JSON row file beside it."""
from __future__ import annotations

import json
import os
from pathlib import Path

COLUMNS = ("round", "code", "prompts", "judges", "render", "split sha", "split", "n", "A", "B0", "Bn", "Bn items > A", "Bn-A", "Bn-B0",
           "floors", "jev", "replay drops", "rendered chars", "cost USD", "verdict")


def _f(v, nd=2):
    return "-" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))


def _combo_cell(d: dict, key: str) -> str:
    return "<br>".join(f"{c}: {_f(v.get('median'))}/{_f(v.get('mean'))}" if isinstance(v, dict) else f"{c}: {_f(v)}" for c, v in d.items())


def md_row(r: dict) -> str:
    floors = "; ".join(f"{t['floor']} {_f(t['bn'], 3)} ({'ok' if t['pass'] else 'FAIL'})" for t in r["floors"]["rows"])
    cells = [r["round"], r["code_sha"][:12], r["prompt_sha"][:12], r["judge_sha"][:12], r["render"], r["split_sha"][:12], r["split"], r["n"],
             _combo_cell({c: v["A"] for c, v in r["totals"].items()}, "A"), _combo_cell({c: v["B0"] for c, v in r["totals"].items()}, "B0"),
             _combo_cell({c: v["Bn"] for c, v in r["totals"].items()}, "Bn"),
             "<br>".join(f"{c}: {v}" for c, v in r["items_bn_gt_a"].items()),
             "<br>".join(f"{c}: d={_f(v['median_diff'])} p_holm={_f(v.get('p_holm'), 3)} rb={_f(v['rank_biserial'])}" for c, v in r["succinct_bn_minus_a"].items()),
             "<br>".join(f"{c}: d={_f(v['median_diff'])} p_holm={_f(v.get('p_holm'), 3)} rb={_f(v['rank_biserial'])}" for c, v in r["thorough_bn_minus_b0"].items()),
             floors, r["jev"].get("summary", r["jev"].get("status", "-")), r["replay_drops"],
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
