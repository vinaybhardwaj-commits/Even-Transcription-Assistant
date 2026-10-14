#!/usr/bin/env python3
"""Ruling 116: of today's canonical-loop windows, how many still carry loop text in the FINAL stored transcript, and why did the
app's guard (lib/stt/assembled-collapse.ts) miss them? Counts, ids and categories only; text stays in memory."""
import json, os, re, subprocess, sys, unicodedata
sys.path.insert(0, "/home/eta/dev/eta-lab-watch/studies/2026-09-24-redundancy")
import repeat_ratio_v2 as R
import repeat_measure as M

HERE = os.path.dirname(os.path.abspath(__file__))
NUMBERS = frozenset(json.load(open(os.path.join(HERE, "number-words.json")))["words"])
# assembled-collapse.ts constants and rules, ported for CLASSIFICATION (the guard itself is not re-run):
MAX_PHRASE_WORDS, MIN_WORD_CHARS, MIN_PHRASE_CHARS = 8, 3, 8
PUNCT = re.compile(r"[!-/:-@\[-`{-~।॥]")
JOINER = re.compile(r"[-/]")


def is_number_token(word):
    raw = (word or "").lower()
    for part in [raw, *JOINER.split(raw)]:
        w = PUNCT.sub("", part).strip()
        if not w:
            continue
        if any(unicodedata.category(c) in ("Nd", "Nl", "No") for c in w) or w in NUMBERS:
            return True
    return False


def why_guard_missed(raw, loop):
    """The first reason, in guard order, that assembled-collapse could not remove this loop; 'guard_should_have_caught' if none."""
    unit = loop["unit"]
    reasons = []
    if loop["n"] > MAX_PHRASE_WORDS:
        reasons.append("unit_longer_than_8_words")
    if any(is_number_token(w) for w in unit):
        reasons.append("unit_contains_number")
    if len(" ".join(PUNCT.sub("", w) for w in unit)) < MIN_PHRASE_CHARS:
        reasons.append("unit_shorter_than_8_chars")
    a, b = loop["span"]
    if "\n" in raw[a:b]:
        reasons.append("loop_crosses_a_line_break")
    return reasons or ["guard_should_have_caught"]


def sql(q):
    r = subprocess.run(["node", M.SELECT, q], cwd=M.ETA, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(f"neon-select exit {r.returncode}")
    return json.loads(r.stdout)


def main():
    rows = {x["wid"]: x for x in M.fetch() if x["period"] == "today"}
    loops_by_w = {w: R.phrase_loops(x["t"]) for w, x in rows.items() if x["t"].strip()}
    loop_ws = [w for w, l in loops_by_w.items() if l]
    out = {"windows_today": len(rows), "loop_windows": len(loop_ws), "run_row": {}, "turns": {}}

    # ── LAYER 1: the run row's transcript = router text AFTER shim + router collapse + the app's collapseAssembled ──
    cat_loops, cat_windows, redundant = {}, {}, 0
    per_window = []
    for w in loop_ws:
        raw = rows[w]["t"]
        wcats = set()
        for l in loops_by_w[w]:
            rs = why_guard_missed(raw, l)
            for r in rs:
                cat_loops[r] = cat_loops.get(r, 0) + 1
            wcats.add(rs[0])
            redundant += l["redundant_chars"]
        cat_windows[tuple(sorted(wcats))] = cat_windows.get(tuple(sorted(wcats)), 0) + 1
        per_window.append((w, len(raw), sum(l["redundant_chars"] for l in loops_by_w[w]) / len(raw)))
    out["run_row"] = {
        "loop_windows_still_carrying_loops_after_all_guards": len(loop_ws),
        "loops_by_reason_the_guard_could_not_remove_them (a loop can have several)": cat_loops,
        "windows_by_first_reason": {"+".join(k): v for k, v in cat_windows.items()},
        "redundant_chars": redundant,
        "window_ratio_range": [round(min(p[2] for p in per_window), 3), round(max(p[2] for p in per_window), 3)] if per_window else None,
        "windows_with_ratio_ge_0.10": sum(p[2] >= 0.10 for p in per_window),
    }

    # ── LAYER 2: the timed turns (stt_turn cues, from whisper's own segments) and their mark-only loop flags ──────────
    ids = ",".join("'%s'" % w for w in loop_ws)
    turns = sql(f"""
      select w.id wid, (c.payload->>'start_ms')::bigint s, c.payload->>'text' t,
             coalesce(r.in_run, false) in_run
        from bench_window w
        join cue c on c.session_id = w.session_id and c.type = 'stt_turn'
             and (c.payload->>'start_ms')::bigint >= w.start_ms and (c.payload->>'end_ms')::bigint <= w.end_ms
        left join room_turn_repeat_run r on r.window_id = w.id and r.source_ref = c.source_ref
       where w.id in ({ids})""")
    by_w = {}
    for x in turns:
        by_w.setdefault(x["wid"], []).append(x)
    t_out = {"windows_with_turns": len(by_w), "turns": len(turns), "turns_flagged_in_run": sum(bool(x["in_run"]) for x in turns)}
    t_loop_windows = t_flagged_windows = 0
    for w, xs in by_w.items():
        xs.sort(key=lambda x: int(x["s"]))
        text = " ".join((x["t"] or "") for x in xs)
        if R.phrase_loops(text):
            t_loop_windows += 1
        if any(x["in_run"] for x in xs):
            t_flagged_windows += 1
    t_out["windows_whose_turn_text_carries_a_canonical_loop"] = t_loop_windows
    t_out["windows_with_any_turn_flagged_in_run"] = t_flagged_windows
    out["turns"] = t_out
    # ids only, for follow-up
    out["loop_window_ids"] = loop_ws
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
