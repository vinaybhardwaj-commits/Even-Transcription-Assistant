#!/usr/bin/env python3
"""The consult cutter (m3-01): hourly (:35, systemd --user timer, installed DISABLED) cut every eligible consult window into ~/eta-data/consult/clips/<IST date>/<room_slug>/<consult_uid>/.
  python -m cutter.run --once [--since YYYY-MM-DD] [--only CONSULT_UID] [--dry-run]
  python -m cutter.run --backfill 2026-10-02 2026-10-07 [--execute]      (dry-run unless --execute; NOT to be executed before the review PASS)
Eligible = window closed >= 15 min ago, not a blind room-day, with tape (else the skip reason from room_audio_state), not already cut with the same signature (t_close, close_reason, doctor).
GPU work (pyannote 3.1 on the T4) runs in ONE worker under flock ~/gpu.lock and, only while config.GPU_WINDOW_ENABLED is True, never starts between 22:30 and 06:00 (off since 08 Oct 2026: per-job gpu.lock sharing instead). Patient audio stays under ~/eta-data (0700) and private R2."""
import argparse, datetime as dt, json, logging, os, shutil, subprocess, sys, time
from . import config as C, spanrule as S, windows as Wn, tape as T, state as ST, speak as SP, store as SO, gpu as G
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
log = logging.getLogger("cutter")
def iso(t):
    """IST timestamp with milliseconds; the rounding carries into the seconds (x.9996 s -> next second .000) (R11)."""
    ms = int(round(t * 1000)); return dt.datetime.fromtimestamp(ms // 1000, IST).strftime("%Y-%m-%d %H:%M:%S") + f".{ms % 1000:03d}"
ist_date = lambda t: dt.datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")

def span_days(a, b):
    """every IST date touched by [a, b) (b exclusive by 1 ms)."""
    d0 = dt.datetime.fromtimestamp(a, IST).date(); d1 = dt.datetime.fromtimestamp(max(a, b - 0.001), IST).date(); out = []
    while d0 <= d1: out.append(d0.isoformat()); d0 += dt.timedelta(days=1)
    return out

def alert(msg):
    """05c N5: append the alert line to the spool (0600, one JSON line) for the bus watcher; never raises."""
    try:
        fd = os.open(C.ALERTS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as fh: fh.write(json.dumps(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), source="cutter.run", alert=msg)) + "\n")
    except Exception as e: log.error("could not write the alert spool: %s", e)

def code_commit():
    try: return subprocess.run(["git", "-C", os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or None
    except Exception: return None

def load_heldout():
    import importlib.util
    s = importlib.util.spec_from_file_location("heldout", C.HELDOUT); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); u, sha = m.load_union(); return m, u, sha

def wanted(pr0, w):
    """the part of the span whose tape matters for the coverage record: the fixed span, or for the doctor-voice search the window itself plus the 30 s tail (the speculative search region beyond is not 'wanted' tape)."""
    if pr0["mode"] == "fixed": return pr0["start"], max(pr0["end"], w["t_close"])
    return pr0["start"], min(pr0["search_end"], w["t_close"] + C.VOICE_TAIL)

def window_sig(w, room_windows, ctx):
    """-> (signature, unclamped plan pr0, wanted-span coverage). The plan uses the manifest's tape bounds and the doctor's print, exactly like prepare()."""
    by = ctx["by"]; ts, te = T.bounds(by, w["room_id"], w["t_open"]); has_print = w["doctor_uid"] in ctx["prints"]
    pr = S.plan_span(w, room_windows, ts, te, has_print); pr0 = S.plan_span(w, room_windows, None, None, has_print)
    cov = T.coverage(by, w["room_id"], *wanted(pr0, w))
    return S.plan_signature(w, pr, has_print, cov, ist_date(w["t_open"])), pr0, cov

def safe_sig(w, rw, ctx):
    try: return window_sig(w, rw, ctx)[0]
    except Exception: return None

def prepare(w, room_windows, ctx, mode=None):
    """checks + plan + working audio. -> ('skip', row) | ('job', dict)."""
    base = dict(consult_uid=w["consult_uid"], ist_date=ist_date(w["t_open"]), room_slug=w["room_slug"], room_id=w["room_id"], doctor_uid=w["doctor_uid"], doctor_name=w["doctor_name"],
                window_id=w["id"], t_open=iso(w["t_open"]), t_close=iso(w["t_close"]), close_reason=w["close_reason"], quality=w["quality"], resolver_version=w["resolver_version"], computed_at=w["computed_at"],
                signature=window_sig(w, room_windows, ctx)[0], code_commit=ctx["commit"])
    ho, union = ctx["heldout"], ctx["union"]
    # R5: the SPAN's days, not only the window's: plan the widest span (no tape cap) from the manifest and skip the whole window if any IST day it touches is a blind room-day, before any tape is pulled
    pr0 = S.plan_span(w, room_windows, None, None, w["doctor_uid"] in ctx["prints"]); hi = pr0["end"] if pr0["mode"] == "fixed" else pr0["search_end"]
    if any(ho.is_held_out(union, d, w["room_id"]) for d in span_days(pr0["start"], max(hi, w["t_close"]))): return "skip", dict(base, status="skipped", skip_reason="blind_room_day")
    wmin = (w["t_close"] - w["t_open"]) / 60.0                                                                       # m3-12: a window of more than MAX_DIARIZE_MIN is mostly not one consult; no tape pull, no GPU, recorded for the index page / M1 (no boundary trimmer yet, so it is not retried)
    if wmin > C.MAX_DIARIZE_MIN:
        if (ctx.get("prev_rows", {}).get(w["consult_uid"]) or {}).get("status") == "cut": return "keep", None            # an earlier cut stays the latest row
        return "deferred_long", dict(base, status="deferred_long", window_min=round(wmin, 2), span_min=round((max(pr0["end"] if pr0["mode"] == "fixed" else pr0["search_end"], w["t_close"]) - pr0["start"]) / 60.0, 2))
    by = ctx["by"]; want = wanted(pr0, w)
    if T.coverage(by, w["room_id"], w["t_open"], w["t_close"]) < C.MIN_COVERAGE:
        T.LAST_PULL_ERROR = None
        if ctx["pull"](w["room_id"], w["t_open"] - 60, w["t_close"] + 900): by = ctx["by"] = ctx["reload_by"]()
        if T.coverage(by, w["room_id"], w["t_open"], w["t_close"]) < C.MIN_COVERAGE:
            return "skip", dict(base, status="skipped", skip_reason=ctx["no_tape_reason"](w["room_id"], w["t_open"], w["t_close"]), coverage=round(T.coverage(by, w["room_id"], *want), 3), **({"pull_error": T.LAST_PULL_ERROR} if T.LAST_PULL_ERROR else {}))
    if mode == "recut":                                                                                              # m3-15 (m3-14 F6): never replace a cut by a re-cut with LESS tape (rotated tape)
        pc = (ctx.get("prev_rows", {}).get(w["consult_uid"]) or {}).get("coverage"); wc = T.coverage(by, w["room_id"], *want)
        if pc is not None and wc + 0.005 < pc: log.warning("re-cut of %s refused: tape coverage %.3f < the original cut's %.3f", w["consult_uid"], wc, pc); return "skip", dict(base, status="skipped", skip_reason=f"recut_coverage_lower {wc:.3f} < {pc:.3f}")
    base["signature"] = window_sig(w, room_windows, ctx)[0]                                                          # after a pull the manifest (tape bounds, coverage) may have changed
    ts, te = T.bounds(by, w["room_id"], w["t_open"])
    identified = w["doctor_uid"] in ctx["prints"]; pr = S.plan_span(w, room_windows, ts, te, identified)
    if pr["prev_end"] is not None and pr["prev_end"] <= w["t_open"] and pr["start"] < pr["prev_end"] - 1e-6: raise RuntimeError("span would start inside the previous window's consult")      # N1(c) invariant
    a, b = pr["start"], (pr["end"] if pr["mode"] == "fixed" else pr["search_end"])
    span_min = (b - a) / 60.0; g = G.gate(ctx["clock"](), span_min)                                                  # R1: the clock before the job, not only at run start
    if not g["ok"] and mode != "retry": return "defer", dict(why=g["why"])                                           # (an error row being retried is cut and probed first: silence resolves without any GPU)
    pieces, cov = T.plan(by, w["room_id"], a, b); work = f"{ctx['work']}/{w['consult_uid']}.m4a"; T.cut(pieces, work, ctx["work"])
    silent, lufs = ctx["silent"](work)
    if silent:                                                                                                       # m3-05(a): digital silence is recorded, with the measured loudness, before any GPU time is spent on it; final
        os.remove(work); return "skip", dict(base, status="skipped", skip_reason="silent_audio", lufs=lufs, final=True, coverage=round(cov, 3))
    if not g["ok"]: os.remove(work); return "defer", dict(why=g["why"])
    return "job", dict(w=w, base=base, plan=pr, by=by, work=work, identified=identified, out=f"{ctx['work']}/{w['consult_uid']}.diar.json", coverage=round(cov, 3), want_coverage=round(T.coverage(by, w["room_id"], *want), 3), span_min=span_min)

def finish(job, ctx, commit=None):
    """diarizer result -> span end, labels, files, index row."""
    w, pr, base = job["w"], job["plan"], job["base"]
    res = json.load(open(job["out"]))
    if "error" in res: raise RuntimeError(res["error"])                                                              # m3-05(d): through error_row, so every error row carries attempts and the cap applies
    log.info("worker timing %s %s", w["consult_uid"], res.get("timing"))                                             # m3-12: diarize / ECAPA load / embedding seconds and the ECAPA device
    pv = ctx["prints"].get(w["doctor_uid"]) if job["identified"] else None
    lab = SP.label(res, pv); flags = list(pr["flags"]); identified = job["identified"]
    split_fail = SP.split_failed(lab, identified)                                                                    # m3-06 (M1): never put the doctor's speech into others.flac silently
    if split_fail:
        lab = SP.label(res, None); pv = None; identified = False; flags.append("doctor_split_failed"); split_fail += " (search end not extended)" if pr["mode"] == "search" else ""        # N4
    unemb = SP.unembedded_s(lab); dlike = SP.doctor_like_s(lab) if identified else 0.0
    if dlike: flags.append("doctor_like_group")                                                                      # m3-07: flag only, the group stays in others.flac
    if identified and SP.borderline(lab): flags.append("doctor_cos_borderline")                                       # N2: a group at cos 0.45-0.55 sits in others.flac
    if pr["mode"] == "search":
        last = SP.last_doctor_turn_end(res, lab["doctor_clusters"]); end, f2 = S.finalize_search_end(pr, w["t_close"], None if last is None else pr["start"] + last); flags += f2
    else: end = pr["end"]
    end_rel = end - pr["start"]
    turns = SP.turns(res, lab, pv, end_rel, pr["start"], iso); dp, op = SP.split_pieces(res, lab, end_rel, identified)
    rel = f"{ist_date(w['t_open'])}/{w['room_slug']}/{w['consult_uid']}"; final = f"{C.CLIPS}/{rel}"
    tl = dict(consult_uid=w["consult_uid"], window=dict(id=w["id"], room_id=w["room_id"], room_slug=w["room_slug"], machine=w["machine"], t_open=iso(w["t_open"]), t_close=iso(w["t_close"]), close_reason=w["close_reason"],
              quality=w["quality"], resolver_version=w["resolver_version"], computed_at=w["computed_at"]),
              doctor=dict(uid=w["doctor_uid"], name=w["doctor_name"], source=w["doctor_source"], identified=identified, print="provisional 06 Oct (V-confirmed)" if job["identified"] else None, split_failed=bool(split_fail), split_failed_reason=split_fail),
              span=dict(start_ist=iso(pr["start"]), end_ist=iso(end), minutes=round(end_rel / 60, 2), start_utc=dt.datetime.fromtimestamp(pr["start"], dt.timezone.utc).isoformat(), end_utc=dt.datetime.fromtimestamp(end, dt.timezone.utc).isoformat(),
                        t_open_rel_s=round(w["t_open"] - pr["start"], 1), t_close_rel_s=round(w["t_close"] - pr["start"], 1)),
              rule=pr["rule"], flags=flags, previous_window_close=None if pr["prev_end"] is None else iso(pr["prev_end"]), next_window_open=None if pr["next_open"] is None else iso(pr["next_open"]),
              tape_coverage=job["coverage"], tape_coverage_of_wanted_span=job["want_coverage"], clusters=lab["clusters"], labels=lab["labels"], doctor_identified=identified, doctor_split_failed=bool(split_fail), unembedded_s=unemb, doctor_like_s=dlike, turns=turns, engine=res.get("engine"),
              overlap="overlapped speech is in consult.flac only; doctor.flac / others.flac drop it", code_commit=ctx["commit"], created_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    sizes = SO.write_consult(final, job["work"], end_rel, dp, op, identified, tl, ctx["work"])
    prev_row = ctx.get("prev_rows", {}).get(w["consult_uid"])
    row = dict(base, status="cut", consult_zero_ratio=tl["consult_zero_ratio"], vi_frame_share=tl["vi_frame_share"], voice_isolated=tl["voice_isolated"], gating_source=tl["gating_source"], rule=pr["rule"], flags=flags, doctor_identified=identified, doctor_split_failed=bool(split_fail), doctor_split_failed_reason=split_fail, unembedded_s=unemb, doctor_like_s=dlike, span_start=iso(pr["start"]), span_end=iso(end), span_end_epoch=round(end, 3), minutes=round(end_rel / 60, 2),
               path=rel, coverage=job["want_coverage"], bytes=sizes, bytes_total=sum(sizes.values()), r2=dict(status="pending_mirror"), cut_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    if commit: commit(row)                                                                                           # m3-15 (re-cut): files swapped -> the NEW row is in the index at once (row and files agree) -> only then R2
    try: r2 = ctx["mirror"](final, rel)
    except Exception as e: r2 = dict(status="error", error=f"{type(e).__name__}: {str(e)[:120]}")                  # a failed upload is a status on the row (mirror_pending retries it), never a lost row
    if prev_row and prev_row.get("path") and prev_row["path"] != rel and os.path.isdir(f"{C.CLIPS}/{prev_row['path']}"):
        try: shutil.rmtree(f"{C.CLIPS}/{prev_row['path']}")                                                         # R7: t_open date / room_slug changed: no orphan dir
        except OSError as e: log.warning("old clip dir not removed: %s", e)
    stale = sorted(set((prev_row or {}).get("bytes") or {}) - set(sizes)) if prev_row and prev_row.get("path") == rel else []
    if stale and r2.get("status") == "mirrored" and ctx.get("unmirror"):                                            # m3-14 F5: the new cut has fewer files; their R2 keys go too
        gone = ctx["unmirror"](rel, stale); log.info("R2 keys no longer in the cut deleted for %s: %s", w["consult_uid"], gone); r2 = dict(r2, deleted_stale=gone)
    return dict(row, r2=r2)

def select(windows, index, now, only=None, date_from=None, date_to=None, state=None, sigfn=None, min_open=None, recut=False):
    """eligible windows to (re)process -> [(window, room windows, mode)], mode in new | retry | recheck | final.
    recut (m3-14, only together with `only`): the window is cut again with the current code whatever its row says.
    new: never processed or its signature changed (t_close / close_reason / doctor / t_open / room / neighbours). retry: an error row below the attempt cap.
    recheck / final (R4): a skipped no-tape window or a partial-tape cut is re-checked at most hourly until t_close + 24 h; the check after 24 h is the final one. Blind skips are final at once."""
    rooms = Wn.by_room(windows); out = []; state = state if state is not None else {}
    for w in sorted(windows, key=lambda w: (w["t_open"], w["id"])):
        if only and w["consult_uid"] != only: continue
        d = ist_date(w["t_open"])
        if (date_from and d < date_from) or (date_to and d > date_to): continue
        if min_open is not None and w["t_open"] < min_open: continue                                                  # N1(b): loaded for context (neighbours), not selected
        if not S.eligible(w, now): continue
        if recut and only: out.append((w, rooms[w["room_id"]], "recut")); continue                                        # m3-14: an already-cut window is cut again (live embeddings); the index stays append-only, the latest row wins
        prev = index.get(w["consult_uid"]); rw = rooms[w["room_id"]]; throttled = now - state.get(w["consult_uid"], 0) < C.RECHECK_HOURS * 3600; late = now >= w["t_close"] + C.RECHECK_WINDOW
        if prev is None or S.sig_changed(prev.get("signature"), prev, sigfn(w, rw)): out.append((w, rw, "new")); continue
        st = prev.get("status")
        if st == "error":
            if prev.get("attempts", 1) < C.MAX_ATTEMPTS and not throttled: out.append((w, rw, "retry"))
        elif st == "skipped":
            if prev.get("skip_reason") == "blind_room_day" or prev.get("final"): continue
            if late: out.append((w, rw, "final"))
            elif not throttled: out.append((w, rw, "recheck"))
        elif st == "cut":
            if prev.get("coverage", 1.0) >= 0.999 or prev.get("final"): continue
            if late: out.append((w, rw, "final"))
            elif not throttled: out.append((w, rw, "recheck"))
    return out

def wanted_span(w, rw, ctx):
    return wanted(S.plan_span(w, rw, None, None, w["doctor_uid"] in ctx["prints"]), w)

def make_ctx(now, runner=None, mirror_fn=None, pull=None, loader=None, prints=None):
    os.makedirs(f"{C.E}/consult/cutter-work", mode=0o700, exist_ok=True)
    ho, union, usha = load_heldout()
    def reload_by(): ctx["by"] = T.load_manifest(); return ctx["by"]
    ctx = dict(now=now, clock=time.time, silent=T.is_silent, commit=code_commit(), heldout=ho, union=union, union16=usha, prints=prints if prints is not None else SP.load_prints(strict=True), work=f"{C.E}/consult/cutter-work", by=T.load_manifest(), reload_by=reload_by,
               pull=pull or (lambda room, a, b: T.pull_missing(room, a, b)), no_tape_reason=lambda room, a, b: ST.no_tape_reason(room, a, b, loader=loader), mirror=mirror_fn or (lambda d, rel: SO.mirror(d, rel)), unmirror=lambda rel, names: SO.delete_remote(rel, names), runner=runner)
    return ctx

def error_row(base, msg, prev):
    n = (prev.get("attempts", 1) + 1) if prev and prev.get("signature") == base["signature"] and prev.get("status") == "error" else 1       # an old error row without a count (12895db) counts as 1
    return dict(base, status="error", skip_reason=msg, attempts=n, final=n >= C.MAX_ATTEMPTS)

def cleanup(job):
    for f in (job["work"], job["out"]):
        try: os.remove(f)
        except OSError: pass

def run_once(windows, ctx, only=None, date_from=None, date_to=None, dry=False, index_path=None, min_open=None, recut=False):
    now = ctx["now"]; index = SO.read_index(index_path); ctx["prev_rows"] = index; state = SO.read_state(ctx.get("state_path")); todo = select(windows, index, now, only, date_from, date_to, state, sigfn=lambda w, rw: window_sig(w, rw, ctx)[0], min_open=min_open, recut=recut)
    todo.sort(key=lambda t: (-dt.datetime.strptime(ist_date(t[0]["t_open"]), "%Y-%m-%d").toordinal(), t[0]["t_open"], t[0]["id"]))        # m3-12: newest IST day first (today's and the VP-ACC holdout days before the old backlog), oldest first within a day
    summary = dict(eligible=len(todo), cut=0, skipped=0, errors=0, deferred_gpu=0, deferred_long=0); rows = []
    if dry:                                                                                                          # planned spans from the current manifest, no writes at all
        for w, rw, mode in todo:
            ts, te = T.bounds(ctx["by"], w["room_id"], w["t_open"]); pr = S.plan_span(w, rw, ts, te, w["doctor_uid"] in ctx["prints"]); hi = pr["end"] if pr["mode"] == "fixed" else pr["search_end"]
            cov_w = T.coverage(ctx["by"], w["room_id"], w["t_open"], w["t_close"]); wide = S.plan_span(w, rw, None, None, w["doctor_uid"] in ctx["prints"]); hi0 = wide["end"] if wide["mode"] == "fixed" else wide["search_end"]
            blind = any(ctx["heldout"].is_held_out(ctx["union"], d, w["room_id"]) for d in span_days(wide["start"], max(hi0, w["t_close"])))                               # N2: the dry-run applies the same skips as prepare()
            would = "blind_room_day" if blind else "deferred_long (window %.0f min > %.0f)" % ((w["t_close"] - w["t_open"]) / 60.0, C.MAX_DIARIZE_MIN) if (w["t_close"] - w["t_open"]) / 60.0 > C.MAX_DIARIZE_MIN else ("no_tape_coverage_%.2f (re-checked hourly for 24 h)" % cov_w if cov_w < C.MIN_COVERAGE else None)
            rows.append(dict(consult_uid=w["consult_uid"], mode=mode, room=w["room_slug"], tape_coverage_of_window=round(cov_w, 3), **({"would_skip": would} if would else {}), close_reason=w["close_reason"], window_min=round((w["t_close"] - w["t_open"]) / 60, 1), rule=pr["rule"], start=iso(pr["start"]),
                             **({"end": iso(pr["end"])} if pr["mode"] == "fixed" else {"search_to": iso(hi), "end": "last doctor turn + 30 s, never before t_close"}), span_min_max=round((hi - pr["start"]) / 60, 1), flags=pr["flags"],
                             covers_whole_window=hi >= w["t_close"] and pr["start"] <= w["t_open"]))
        summary["consults"] = [r["consult_uid"] for r in rows]; return summary, rows
    SO.ensure_dir(C.CLIPS)                                                                                           # R6: the clips root is 0700 too (chmod an existing one)
    summary["swept_tmp"] = SO.sweep_tmp(C.CLIPS, now)                                                                # m3-05(e): stale <uid>.tmp dirs older than 1 h
    for w, rw, mode in todo:
        prev = index.get(w["consult_uid"]); base = None; job = None; state[w["consult_uid"]] = now
        try:
            if mode in ("recheck", "final") and prev and prev.get("status") == "cut":                                 # partial-tape cut: pull, and re-cut only if the coverage of the wanted span increased
                a0, b0 = wanted_span(w, rw, ctx); ctx["pull"](w["room_id"], a0 - 60, b0 + 900); by = ctx["by"] = ctx["reload_by"](); cov = T.coverage(by, w["room_id"], a0, b0)
                if cov <= prev.get("coverage", 1.0) + 0.005:
                    if mode == "final": SO.append_index(dict(prev, final=True, final_note=f"no more tape after 24 h; coverage {cov:.3f}", checked_at=time.strftime("%Y-%m-%dT%H:%M:%S%z")), index_path)
                    continue
            kind, x = prepare(w, rw, ctx, mode)
            if mode == "recut" and kind != "job":                                                                       # m3-14: nothing but a successful re-cut may replace the existing cut row (no skipped / deferred_long / defer row over it)
                log.warning("re-cut of %s not done: %s %s", w["consult_uid"], kind, (x or {}).get("skip_reason") or (x or {}).get("why") or ""); summary["skipped" if kind == "skip" else "deferred_gpu"] += 1; continue
            if kind == "keep": continue
            if kind == "deferred_long":
                summary["deferred_long"] += 1
                if not (prev and prev.get("status") == "deferred_long" and prev.get("t_close") == x["t_close"] and prev.get("close_reason") == x["close_reason"]): SO.append_index(x, index_path); rows.append(x)          # one row per change, not one per hourly run
                continue
            if kind == "skip" and mode in ("recheck", "final") and prev and prev.get("status") == "skipped" and mode == "recheck" and x.get("skip_reason") == prev.get("skip_reason"): continue          # nothing new: no extra row
            if kind == "skip" and mode == "final": x = dict(x, final=True, skip_reason=f"final after 24 h: {x['skip_reason']}")
            if kind == "skip": SO.append_index(x, index_path); rows.append(x); summary["skipped"] += 1; continue
            if kind == "defer": summary["deferred_gpu"] += 1; log.info("GPU deferred %s: %s", w["consult_uid"], x["why"]); continue
            job = x; base = job["base"]; g = G.gate(ctx["clock"](), job["span_min"])                                  # again right before the launch (the cut took time)
            if not g["ok"]: summary["deferred_gpu"] += 1; log.info("GPU deferred %s: %s", w["consult_uid"], g["why"]); continue
            rc = SP.run_job(dict(id=w["consult_uid"], audio=job["work"], out=job["out"]), g, ctx["runner"], ctx.get("lock"), ctx.get("worker_cmd"), ctx.get("wait_scale", 1.0))
            if rc == "deferred": summary["deferred_gpu"] += 1; log.info("GPU deferred %s: lock not acquired in time", w["consult_uid"]); continue
            if rc == SP.CONFIG_ERROR: alert("ALERT cutter diarization worker is not configured (CONSULT_DIARIZE_PKG_DIR / CONSULT_DIARIZE_MODULE unset): nothing can be cut")
            if rc != 0: raise RuntimeError(f"diarization worker rc={rc}")
            row = finish(job, ctx, commit=(lambda r: SO.append_index(r, index_path)) if mode == "recut" else None)
        except Exception as e:                                                      # R9: one failed window never aborts the run
            if mode == "recut":                                                                                         # m3-14: a failed re-cut never replaces the good cut row with an error row; the caller sees errors > 0 and keeps its own attempt count
                log.warning("re-cut of %s failed: %s: %s", w["consult_uid"], type(e).__name__, str(e)[:160]); summary["errors"] += 1; continue
            row = error_row(base or dict(consult_uid=w["consult_uid"], ist_date=ist_date(w["t_open"]), room_slug=w["room_slug"], room_id=w["room_id"], doctor_uid=w["doctor_uid"], signature=safe_sig(w, rw, ctx), window_id=w["id"], code_commit=ctx["commit"]),
                            f"{type(e).__name__}: {str(e)[:160]}", prev)
            log.warning("window %s failed: %s", w["consult_uid"], row["skip_reason"])
        finally:
            if job: cleanup(job)
        SO.append_index(row, index_path); rows.append(row); summary["cut" if row["status"] == "cut" else "errors"] += 1
        if row.get("status") == "cut" and (row.get("r2") or {}).get("status") == "mirrored": note_upload_success([row["consult_uid"]])                    # m3-16d M1: an upload during the cut proves R2 is up
    SO.write_state(state, ctx.get("state_path")); return summary, rows

MIRROR_MAX_ATTEMPTS = 3

def _pending_status(row): return (row.get("r2") or {}).get("status") in ("pending_no_credential", "error", "pending_mirror")

def pending_mirror_rows(index_path=None, include_parked=False):
    rows = [(uid, row) for uid, row in SO.read_index(index_path).items() if row.get("status") == "cut" and _pending_status(row) and os.path.isdir(f"{C.CLIPS}/{row['path']}")
            and (include_parked or (row["r2"].get("attempts") or 0) < MIRROR_MAX_ATTEMPTS)]
    return sorted(rows, key=lambda kv: (kv[1].get("ist_date", ""), kv[1].get("span_start", "")), reverse=True)                  # newest first

def _mirror_state_path(): return f"{C.CLIPS}/mirror-state.json"

def _read_mirror_state():
    """m3-16d M2: always a well-formed dict, whatever is on disk (wrong shape, null, numbers as text, a directory, unreadable) -> fresh state."""
    fresh = dict(zero_success_passes=0, alerted=False, solo={}, row_alerted=[])
    try:
        st = json.load(open(_mirror_state_path()))
        if not isinstance(st, dict): return fresh
        z = st.get("zero_success_passes", 0); z = z if isinstance(z, int) and not isinstance(z, bool) and z >= 0 else 0
        solo = st.get("solo") if isinstance(st.get("solo"), dict) else {}
        solo = {str(k): v for k, v in solo.items() if isinstance(v, int) and not isinstance(v, bool) and v >= 0}
        ra = st.get("row_alerted") if isinstance(st.get("row_alerted"), list) else []
        return dict(zero_success_passes=z, alerted=bool(st.get("alerted")) if isinstance(st.get("alerted"), bool) else False, solo=solo, row_alerted=[str(x) for x in ra])
    except FileNotFoundError: return fresh
    except Exception as e: log.warning("mirror-state.json unreadable (%s): treated as fresh", type(e).__name__); return fresh

def _write_mirror_state(st):
    p = _mirror_state_path(); tmp = f"{p}.{os.getpid()}.tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(st, fh); fh.flush(); os.fsync(fh.fileno())
    os.replace(tmp, p)

def note_upload_success(uids=()):
    """m3-16d M1: ANY successful upload (a mirror pass or the upload during a cut) resets the stall counter and re-arms the alert. Never raises."""
    try:
        st = _read_mirror_state(); new = dict(st, zero_success_passes=0, alerted=False, solo={k: v for k, v in st["solo"].items() if k not in set(uids)}, row_alerted=[u for u in st["row_alerted"] if u not in set(uids)])
        if new != st: _write_mirror_state(new)
    except Exception as e: log.warning("mirror-state update failed (%s): carrying on", type(e).__name__)

def _stall_check(tried, succeeded, pending_left):
    """m3-16d: a pass counts toward the STALL only if it tried >= 2 distinct rows (the probe included) and every upload failed; at MIRROR_STALL_PASSES one ALERT line "r2_mirror_stalled". A single row failing alone for MIRROR_ROW_STUCK_PASSES passes
    gets its own one-time ALERT "r2_row_stuck <consult_uid>". Any success resets and re-arms. Never raises (a telemetry counter must not stop the cutter)."""
    try:
        if not tried: return
        st = _read_mirror_state(); new = dict(st)
        if succeeded:
            new.update(zero_success_passes=0, alerted=False)
        elif len(tried) >= 2:
            z = st["zero_success_passes"] + 1; alerted = st["alerted"]
            if z >= C.MIRROR_STALL_PASSES and not alerted: alert(f"r2_mirror_stalled: {z} consecutive mirror passes in which every upload of >= 2 rows failed, {pending_left} rows pending"); alerted = True
            new.update(zero_success_passes=z, alerted=alerted)
        else:
            u = tried[0]; k = st["solo"].get(u, 0) + 1; new["solo"] = dict(st["solo"], **{u: k})
            if k >= C.MIRROR_ROW_STUCK_PASSES and u not in st["row_alerted"]: alert(f"r2_row_stuck {u}"); new["row_alerted"] = st["row_alerted"] + [u]
        if new != st: _write_mirror_state(new)
    except Exception as e: log.warning("mirror-state check failed (%s): carrying on", type(e).__name__)

def mirror_pending(ctx, index_path=None, budget_s=None, clock=time.time, include_parked=False):
    """upload every cut consult whose latest index row has r2.status pending_no_credential / error / pending_mirror and append the updated row. Newest first, bounded by budget_s (checked before EVERY upload; the rest resumes at the next run).
    Failed attempts are charged to a row (r2.attempts) ONLY when other rows of the same pass uploaded (m3-16b); at the 3rd charged failure: ONE ALERT line and the row is skipped from then on.
    m3-16c/d: after 3 consecutive errors the OLDEST untried non-parked pending row is tried before the pass is called an outage; if it uploads, R2 is up and the pass goes on (the failed rows are charged). Stall / stuck-row alerts: see _stall_check; a missing credential never counts."""
    n = 0; t0 = clock(); consecutive = 0; failed = []; tried = []; probed = False; uploaded = []
    rows = pending_mirror_rows(index_path, include_parked=include_parked); done = set(); i = 0
    while i < len(rows):
        uid, row = rows[i]; i += 1
        if uid in done: continue
        if budget_s is not None and clock() - t0 >= budget_s: break
        done.add(uid); r2 = ctx["mirror"](f"{C.CLIPS}/{row['path']}", row["path"]); tried.append(uid)
        if r2.get("status") == "pending_no_credential": return n                       # still no credential: nothing to do for any other row (and never a stalled pass)
        if r2.get("status") == "error":
            failed.append((uid, row, r2)); consecutive += 1
            if consecutive >= 3:
                if probed: break                                                         # the probe failed too: R2 itself is down
                cand = [(u, r) for u, r in reversed(rows) if u not in done and (r["r2"].get("attempts") or 0) < MIRROR_MAX_ATTEMPTS]    # oldest untried NON-parked row, in every mode
                if not cand: break
                probed = True; rows.insert(i, cand[0])                                  # tried next, through the same budget check
            continue
        consecutive = 0; probed = False; uploaded.append(uid); SO.append_index(dict(row, r2=r2, mirrored_at=time.strftime("%Y-%m-%dT%H:%M:%S%z")), index_path); n += 1
    if n > 0:                                                                           # some rows uploaded in this pass, so the rows that failed are the ones at fault
        for uid, row, r2 in failed:
            att = (row["r2"].get("attempts") or 0) + 1; SO.append_index(dict(row, r2=dict(r2, attempts=att)), index_path)
            if att == MIRROR_MAX_ATTEMPTS: log.error("R2 mirror of %s failed %d times: skipped until fixed (%s)", uid, att, r2.get("error")); alert(f"ALERT cutter R2 mirror skipped after {att} failed attempts: consult {uid}: {r2.get('error')}")
        note_upload_success(uploaded)
    _stall_check(tried, n, len(pending_mirror_rows(index_path, include_parked=include_parked)))
    return n

def acquire_run_lock(path=None):
    """R8: one cutter run at a time (timer and manual --backfill --execute can no longer interleave). -> the open lock file (keep it referenced) or None when another run holds it."""
    import fcntl
    p = path or C.RUN_LOCK; os.makedirs(os.path.dirname(p), exist_ok=True); f = open(p, "a")
    try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); return f
    except OSError: f.close(); return None

def default_since(now=None):
    """m3-07: the hourly run's range start = the floor date (2 Oct), not now - 2 days: a window that was deferred (GPU gate) or had no row yet is cut whatever its age; select() skips every window that already has a final row."""
    return dt.datetime.strptime(C.FLOOR_DATE, "%Y-%m-%d").replace(tzinfo=IST).timestamp()

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--once", action="store_true"); ap.add_argument("--since"); ap.add_argument("--only"); ap.add_argument("--recut", action="store_true", help="with --only: cut that already-cut window again with the current code"); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--mirror-only", action="store_true", help="take cutter.lock and only upload the pending R2 mirrors (no cutting, no DB, no GPU)")
    ap.add_argument("--backfill", nargs=2, metavar=("FROM", "TO")); ap.add_argument("--execute", action="store_true"); a = ap.parse_args(argv)
    if a.recut and not a.only: ap.error("--recut needs --only UID")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    if a.mirror_only:                                                                                               # m3-15: drain the R2 backlog without a cutting run
        lock = acquire_run_lock()
        if lock is None: print(json.dumps({"locked": True})); return 0
        n = mirror_pending(dict(mirror=lambda d, rel: SO.mirror(d, rel)), budget_s=C.MIRROR_BUDGET_S * 2, include_parked=True); print(json.dumps(dict(mirrored_pending=n, still_pending=len(pending_mirror_rows()), parked_after_3_failures=len(pending_mirror_rows(include_parked=True)) - len(pending_mirror_rows())))); return 0
    try: prints = SP.load_prints(strict=True)                                                                      # vp-auto-05b F2: bad prints abort the run BEFORE any cutting, loudly, no fallback; the SAME dict is used for the run (05c N3: no second read)
    except SP.PrintsError as e:
        msg = f"ALERT cutter prints invalid, run aborted before cutting: {e}"; log.error(msg); alert(msg); print(json.dumps({"aborted": "prints_invalid", "alert": msg})); return 3
    lock = acquire_run_lock()
    if lock is None: log.info("another cutter run holds %s: exiting 0", C.RUN_LOCK); print(json.dumps({"locked": True})); return 0
    now = time.time(); d_from = d_to = None; dry = a.dry_run
    if a.backfill: d_from, d_to = a.backfill; dry = not a.execute; since = dt.datetime.strptime(d_from, "%Y-%m-%d").replace(tzinfo=IST).timestamp()
    else: since = dt.datetime.strptime(a.since, "%Y-%m-%d").replace(tzinfo=IST).timestamp() if a.since else default_since(now)
    if not (a.once or a.backfill): ap.error("--once or --backfill")
    mirrored_first = 0
    if not dry and not a.only: mirrored_first = mirror_pending(dict(mirror=lambda d, rel: SO.mirror(d, rel)), budget_s=C.MIRROR_BUDGET_S)                # m3-15: the backlog first (cheap, no GPU), bounded; a run killed by the unit timeout no longer starves it
    windows = Wn.fetch(since - C.LOOKBACK_S); ctx = make_ctx(now, prints=prints)                                                     # N1(b): neighbours from 24 h before the range being cut
    summary, rows = run_once(windows, ctx, a.only, d_from, d_to, dry, min_open=since, recut=a.recut)
    if not dry and not a.only: summary["mirrored_pending"] = mirrored_first + mirror_pending(ctx, budget_s=C.MIRROR_BUDGET_S)                # m3-16 L1: a single-consult (--only / --recut) run never spends time on the backlog
    if dry:
        for r in rows: print(json.dumps(r))
    print(json.dumps(summary, default=str)); return 0

if __name__ == "__main__": sys.exit(main())
