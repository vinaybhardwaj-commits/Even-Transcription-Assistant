#!/usr/bin/env python3
"""Nightly analysis index (ruling 184 A6): one row per transcript file in the box's vault-layout roots.

Writes, ONCE per date (the vault is write-once; a same-date rerun is refused, tomorrow's file picks up new rows):
  <staged>/index/chunks-<YYYYMMDD>.jsonl       start/end of the audio chunks the cut used (for the viewer's ▶ when a file has no source_chunks)
  <staged>/index/search-<YYYYMMDD>.jsonl       full text per window (the viewer searches it in the browser)
  <staged>/index/windows-<YYYYMMDD>.jsonl      and, when pyarrow is importable,
  <staged>/index/windows-<YYYYMMDD>.parquet
vault-push then carries them to the vault. Run with the venv python for Parquet:
  ~/.local/share/lab-vault/venv/bin/python build-index.py [--date YYYYMMDD]

has_surgery_candidate is null (unknown) unless LAB_SURGERY_FLAGS points at a JSON list of window_ids;
doctor is null until the VOICE-LINKAGE links exist. Unknown is never written as false.
"""
import argparse, hashlib, json, os, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
ROOTS = [Path(p) for p in os.environ.get("LAB_VAULT_ROOTS", "").split(":") if p] or [HOME / "eta-data/hist", HOME / "eta-data/hist-mining", HOME / "eta-data/lab-vault/staged"]
STAGED = Path(os.environ.get("LAB_VAULT_STAGED", HOME / "eta-data/lab-vault/staged"))
FLAGS = os.environ.get("LAB_SURGERY_FLAGS")
IST = timezone(timedelta(hours=5, minutes=30))
FILES = []  # (key, parsed doc) of every file rows() saw, reused for the search index
COLS = ["key", "sha256", "run_id", "producer", "room_id", "ist_date", "window_id", "start", "end", "doctor", "languages", "dominant_language",
        "n_turns", "n_words", "has_english", "has_surgery_candidate", "ok", "provenance_complete", "incomplete_reason", "no_signal", "no_signal_rule", "provenance_hash"]


RULE_ALIASES = {"no_signal_v1": "exact_zero_by_size_v1"}  # hist-bulk's name for the same rule/list (hist-bulk #1326, #1315)


def no_signal_marks():
    """run_id -> (rule, set(window_ids)) from write-once addenda (manifests/<run>.addendum.json).
    Convention: addendum.no_signal = {rule, window_ids}. Legacy shape written before the convention existed (hist-bulk, 23:10-23:19):
    addendum.no_signal_window_ids + addendum.rule."""
    out = {}
    for root in ROOTS:
        for p in sorted((root / "manifests").glob("*.addendum.json")) if (root / "manifests").exists() else []:
            try:
                d = json.loads(p.read_text()); a = d["addendum"]; run = d["provenance"]["run_id"]
                ns = a.get("no_signal")
                if isinstance(ns, dict) and isinstance(ns.get("window_ids"), list):
                    rule, ids = str(ns.get("rule")), ns["window_ids"]
                elif isinstance(a.get("no_signal_window_ids"), list):
                    rule, ids = str(a.get("rule") or "exact_zero_by_size_v1"), a["no_signal_window_ids"]
                else:
                    continue
                rule = RULE_ALIASES.get(rule.split(" ")[0].rstrip(":;,."), rule)
                out.setdefault(run, (rule, set()))[1].update(x for x in ids if isinstance(x, str))
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
    return out


def no_signal_corrections():
    """window_id -> 'near_silence' | 'undetermined' | 'transcribed_unconfirmed' from ANY run's addendum and from annotations/correction files (owners' write-once corrections of the NO_SIGNAL mark):
    addendum.near_silence_full_chunk_window_ids (a full-length chunk at 711-716 B/s: real low-level signal) and
    addendum.short_chunk_off_band_window_ids (short chunks are not judged by size alone), addendum.transcribed_unconfirmed_window_ids
    (transcribed, came back empty, exact-zero mark unconfirmed). Window ids embed the room, so they are global."""
    out = {}
    for root in ROOTS:
        for p in sorted((root / "manifests").glob("*.addendum.json")) if (root / "manifests").exists() else []:
            try:
                a = json.loads(p.read_text())["addendum"]
            except (OSError, ValueError, KeyError, TypeError):
                continue
            for key, kind in (("near_silence_full_chunk_window_ids", "near_silence"), ("short_chunk_off_band_window_ids", "undetermined"),
                              ("transcribed_unconfirmed_window_ids", "transcribed_unconfirmed")):
                if isinstance(a.get(key), list):
                    for w in a[key]:
                        if isinstance(w, str): out[w] = out[w] if out.get(w) in ("near_silence", "transcribed_unconfirmed") else kind
    # ruling 341: kind=correction annotation files (annotations/correction/<room>/<date>/<stamp>-<producer>.json, items {k, status}) are the
    # successor of the addendum carriers; they override the addenda, and among themselves the later stamp wins (a new file supersedes an older one)
    files = []
    for root in ROOTS:
        base = root / "annotations" / "correction"
        files += [p for p in base.glob("*/*/*.json")] if base.exists() else []
    for p in sorted(files, key=lambda q: q.name):
        try:
            d = json.loads(p.read_text())
            items = d["items"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not isinstance(items, list) or d.get("kind") != "correction":
            continue
        for it in items:
            if isinstance(it, dict) and isinstance(it.get("k"), str) and it.get("status") in ("near_silence", "undetermined", "transcribed_unconfirmed"):
                out[it["k"].rsplit("/", 1)[-1]] = it["status"]
    return out


def provenance_overrides():
    """(run_id, window_id) -> reason, from write-once addenda carrying addendum.provenance_complete_override = {provenance_complete: false, reason, window_ids}
    (refuter-2 #2264/#2308: records the runner stamped complete=true although the harness's own incompleteness note was lost). The records are
    immutable, so the correction lives only in the addendum; only a FALSE override is honoured (an addendum can lower completeness, never raise it)."""
    out = {}
    for root in ROOTS:
        for p in sorted((root / "manifests").glob("*.addendum.json")) if (root / "manifests").exists() else []:
            try:
                d = json.loads(p.read_text()); run = d["provenance"]["run_id"]; o = d["addendum"]["provenance_complete_override"]
                if o.get("provenance_complete") is not False or not isinstance(o.get("window_ids"), list):
                    continue
                reason = o.get("reason") if isinstance(o.get("reason"), str) and o.get("reason").strip() else "provenance overridden by an addendum"
                for w in o["window_ids"]:
                    if isinstance(w, str):
                        out[(run, w)] = reason[:300]
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
    return out


def rows(surgery):
    marks = no_signal_marks(); corr = no_signal_corrections(); ovr = provenance_overrides()
    for root in ROOTS:
        for p in sorted((root / "runs").glob("*/*/*/*.json")) if (root / "runs").exists() else []:
            if p.name.startswith(".") or ".attempt" in p.name:
                continue
            raw = p.read_bytes()
            try:
                d = json.loads(raw)
                prov = d["provenance"]
            except Exception:
                continue  # not a vault-shaped file; the uploader/Worker will report it
            segs = d.get("segments") if isinstance(d.get("segments"), list) else []
            segs = [s for s in segs if isinstance(s, dict)]
            langs = sorted({s.get("lang") for s in segs if s.get("lang")} | {t.get("lang") for t in d.get("language_timeline") or [] if t.get("lang")})
            wid = d.get("window_id") or p.stem
            FILES.append((p.relative_to(root).as_posix(), d))
            yield {
                "key": p.relative_to(root).as_posix(), "sha256": hashlib.sha256(raw).hexdigest(),
                "run_id": prov.get("run_id"), "producer": prov.get("producer"), "room_id": d.get("room_id") or p.parent.parent.name, "ist_date": p.parent.name,
                "window_id": wid, "start": d.get("start"), "end": d.get("end"), "doctor": d.get("doctor"),
                "languages": langs, "dominant_language": d.get("dominant_language"),
                "n_turns": len(segs), "n_words": sum(len((s.get("text") or "").split()) for s in segs),
                "has_english": any(s.get("text_en") for s in segs) or bool(d.get("transcript_en")),
                "has_surgery_candidate": None if surgery is None else wid in surgery,
                "ok": d.get("ok"), "provenance_complete": (False if (prov.get("run_id"), wid) in ovr else prov.get("provenance_complete")), "incomplete_reason": ovr.get((prov.get("run_id"), wid)) or (prov.get("incomplete_reason") if isinstance(prov.get("incomplete_reason"), str) else None),
                "no_signal": True if ((wid in marks.get(prov.get("run_id"), (None, set()))[1] or d.get("state") == "no_signal") and wid not in corr) else None,
                "no_signal_rule": (marks[prov["run_id"]][0] if wid in marks.get(prov.get("run_id"), (None, set()))[1] else RULE_ALIASES.get(str(d.get("rule")).split(" ")[0].rstrip(":;,."), str(d.get("rule")) if isinstance(d.get("rule"), str) else "exact_zero_by_size_v1")) if ((wid in marks.get(prov.get("run_id"), (None, set()))[1] or d.get("state") == "no_signal") and wid not in corr) else None,
                "provenance_hash": hashlib.sha256(json.dumps(prov, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            }


def chunk_timing():
    """r2_key -> {started_at, ended_at, duration_ms} from the producers' own chunk inventories."""
    out = {}
    def add(c):
        if c.get("r2_key") and c.get("started_at") and c.get("ended_at") and c["r2_key"] not in out:
            dur = c.get("duration_ms")
            if dur is None:
                dur = int(round((datetime.fromisoformat(c["ended_at"].replace("Z", "+00:00")) - datetime.fromisoformat(c["started_at"].replace("Z", "+00:00"))).total_seconds() * 1000))
            out[c["r2_key"]] = {"r2_key": c["r2_key"], "started_at": c["started_at"], "ended_at": c["ended_at"], "duration_ms": dur}
    try:
        for inv in json.loads((HOME / "eta-data/hist/inventory.json").read_text()):
            for c in inv.get("chunks", []): add(c)
    except (OSError, ValueError): pass
    try:
        for chunks in json.loads((HOME / "eta-data/hist-mining/link3_chunks.json").read_text()).values():
            for c in chunks: add(c)
    except (OSError, ValueError): pass
    return out


def chunk_rows(root_files):
    """Timing for the chunks the cut ACTUALLY used (cut.chunk_keys), for files whose provenance has no source_chunks of its own.
    Returns (rows, unknown_keys)."""
    timing, want = chunk_timing(), set()
    for key, d in root_files:
        if (d.get("provenance") or {}).get("source_chunks"): continue
        ck = (d.get("cut") or {}).get("chunk_keys")
        if isinstance(ck, list): want.update(k for k in ck if isinstance(k, str))
    return [timing[k] for k in sorted(want) if k in timing], sorted(k for k in want if k not in timing)


def search_rows(root_files):
    """One row per window file with the full text, for the viewer's client-side search."""
    for key, d in root_files:
        segs = d.get("segments") if isinstance(d.get("segments"), list) else []
        segs = [s for s in segs if isinstance(s, dict)]
        text = d.get("transcript_native") or " ".join((s.get("text") or "") for s in segs)
        en = d.get("transcript_en") or " ".join((s.get("text_en") or "") for s in segs)
        yield {"key": key, "window_id": d.get("window_id"), "room_id": d.get("room_id") or key.split("/")[2], "ist_date": key.split("/")[3], "run_id": d["provenance"].get("run_id"), "text": text, "text_en": en.strip()}


# ---------------------------------------------------------------- view index (ruling 328)
# One small row per transcript file for the viewer's Days list: room NAME, IST time, language, word count, first words, status.
# Derived data only; a new immutable file per build: index/view-<YYYYMMDDHHMM>.jsonl (12 digits sorts after the 8-digit daily files).
import re
ACRONYMS = {"opd", "ipd", "ot", "icu", "er", "ct", "mri", "nicu", "ed", "gh"}


def pretty_room(slug):
    """'opd-5-dr-salanki-wxmp' -> 'OPD 5 Dr Salanki' (drops the 4-char id suffix the app appends to the room name)."""
    parts = re.sub(r"-[a-z0-9]{4}$", "", slug).split("-")
    return " ".join(t.upper() if t in ACRONYMS else t.capitalize() for t in parts if t)


def room_maps():
    """(room_id -> slug, session_id -> slug) from the producers' own chunk inventories (bench/<room-slug>/<date>/<session>/chunk_N)."""
    by_room, by_session = {}, {}
    def add(room_id, c):
        m = re.match(r"bench/([^/]+)/", c.get("r2_key") or "")
        if m:
            if room_id: by_room.setdefault(room_id, m.group(1))
            if c.get("session_id"): by_session.setdefault(c["session_id"], m.group(1))
    try:
        for inv in json.loads((HOME / "eta-data/hist/inventory.json").read_text()):
            for c in inv.get("chunks", []): add(inv.get("room_id"), c)
    except (OSError, ValueError): pass
    try:
        for chunks in json.loads((HOME / "eta-data/hist-mining/link3_chunks.json").read_text()).values():
            for c in chunks: add(c.get("room_id"), c)
    except (OSError, ValueError): pass
    return by_room, by_session


def to_ist(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(IST)
    except (AttributeError, ValueError):
        return None


def view_row(key, d, prov, marks, by_room, by_session, corr=None, ovr=None):
    payload = d.get("payload") if isinstance(d.get("payload"), dict) else {}
    segs = d.get("segments") if isinstance(d.get("segments"), list) else (payload.get("segments") if isinstance(payload.get("segments"), list) else [])
    segs = [x for x in segs if isinstance(x, dict)]
    good = [x for x in segs if not x.get("refused") and isinstance(x.get("text"), str) and x["text"].strip()]
    words = [w for x in good for w in x["text"].split()]
    wid = d.get("window_id") or Path(key).stem
    run = prov.get("run_id")
    flagged = wid in marks.get(run, (None, set()))[1] or d.get("state") == "no_signal"
    state = d.get("state") or payload.get("state")
    ok = d.get("ok") if "ok" in d else payload.get("ok")
    untested = (corr or {}).get(wid)
    if untested: status, flagged = "untested", False   # the owners corrected the exact-zero mark: not confirmed, not transcribed
    elif flagged: status = "no_signal"
    elif ok is False or state == "failed": status = "failed"
    elif words: status = "text"
    elif segs: status = "refused"
    else: status = "no_text"
    keys = ((d.get("cut") or {}).get("chunk_keys")) or prov.get("source_audio_keys") or []
    audio_key = next((k for k in keys if isinstance(k, str)), "")
    slug = None
    m = re.match(r"bench/([^/]+)/", audio_key)
    if m: slug = m.group(1)
    room_id = d.get("room_id") or key.split("/")[2]
    slug = slug or by_room.get(room_id)
    if not slug:
        ms = re.match(r"clips/(bs_[a-z0-9]+)/", audio_key)
        slug = by_session.get(ms.group(1)) if ms else None
        if not slug and ms: slug = None
    engines = [x.get("engine") for x in segs if x.get("engine")]
    st, en = to_ist(d.get("start")), to_ist(d.get("end"))
    return {
        "key": key, "run_id": run, "producer": prov.get("producer"), "window_id": wid, "room_id": room_id,
        "room_name": pretty_room(slug) if slug else room_id, "ist_date": key.split("/")[3],
        "start": d.get("start"), "end": d.get("end"),
        "t0": st.strftime("%H:%M") if st else None, "t1": en.strftime("%H:%M") if en else None,
        "lang": d.get("dominant_language") or payload.get("dominant_language"),
        "engine": max(set(engines), key=engines.count) if engines else None,
        "n_words": len(words), "n_lines": len(good), "n_refused": sum(1 for x in segs if x.get("refused")),
        "first_words": " ".join(words[:12]), "status": status, "no_signal": True if flagged else None, "untested_kind": untested,
        "has_audio": bool(audio_key), "complete": False if (ovr or {}).get((prov.get("run_id"), wid)) else prov.get("provenance_complete"),
    }


def build_view(out_dir, stamp):
    """Write <out_dir>/view-<stamp>.jsonl (write-once) from every vault-layout run file under the roots. Returns (rows, path) or (None, path) if it exists."""
    target = out_dir / f"view-{stamp}.jsonl"
    if target.exists():
        return None, target
    marks, (by_room, by_session), rows_out, corr, ovr = no_signal_marks(), room_maps(), [], no_signal_corrections(), provenance_overrides()
    for root in ROOTS:
        for p in sorted((root / "runs").glob("*/*/*/*.json")) if (root / "runs").exists() else []:
            if p.name.startswith(".") or ".attempt" in p.name:
                continue
            try:
                d = json.loads(p.read_bytes()); prov = d["provenance"]
                if not isinstance(d, dict) or not isinstance(prov, dict): continue
            except Exception:
                continue
            rows_out.append(view_row(p.relative_to(root).as_posix(), d, prov, marks, by_room, by_session, corr, ovr))
    rows_out.sort(key=lambda r: r["key"])
    body = "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in rows_out).encode()
    out_dir.mkdir(parents=True, exist_ok=True)
    prev = sorted(out_dir.glob("view-*.jsonl"))
    if prev and prev[-1].read_bytes() == body:  # nothing new since the last build: do not add another permanent object
        return rows_out, prev[-1]
    tmp = target.with_name(f".{target.name}.tmp"); tmp.write_bytes(body); os.chmod(tmp, 0o600); tmp.rename(target)
    return rows_out, target


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--date", default=datetime.now(IST).strftime("%Y%m%d"))
    ap.add_argument("--view-only", action="store_true", help="write only index/view-<YYYYMMDDHHMM>.jsonl (the viewer's Days list); safe to run hourly")
    ap.add_argument("--stamp", default=datetime.now(IST).strftime("%Y%m%d%H%M")); a = ap.parse_args()
    if a.view_only:
        vrows, target = build_view(STAGED / "index", a.stamp)
        if vrows is None:
            print(f"{target.name} already written; write-once", file=sys.stderr); return 1
        import collections
        print(json.dumps({"view": target.name, "rows": len(vrows), "by_status": dict(collections.Counter(r["status"] for r in vrows)),
                          "rooms_named": sum(1 for r in vrows if not r["room_name"].startswith("room_") and not r["room_name"].startswith("bs_"))}))
        return 0
    out = STAGED / "index"; out.mkdir(parents=True, exist_ok=True)
    jl = out / f"windows-{a.date}.jsonl"
    if jl.exists():
        print(f"{jl.name} already written; write-once, not rebuilding", file=sys.stderr); return 1
    surgery = set(json.loads(Path(FLAGS).read_text())) if FLAGS and Path(FLAGS).exists() else None
    data = sorted(rows(surgery), key=lambda r: r["key"])
    body = "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in data).encode()
    tmp = jl.with_name(f".{jl.name}.tmp"); tmp.write_bytes(body); os.chmod(tmp, 0o600)
    pq_note = "no pyarrow"
    try:
        import pyarrow as pa, pyarrow.parquet as pq
        pt = out / f"windows-{a.date}.parquet"
        ptmp = pt.with_name(f".{pt.name}.tmp")
        pq.write_table(pa.Table.from_pylist(data, schema=pa.schema([
            ("key", pa.string()), ("sha256", pa.string()), ("run_id", pa.string()), ("producer", pa.string()), ("room_id", pa.string()),
            ("ist_date", pa.string()), ("window_id", pa.string()), ("start", pa.string()), ("end", pa.string()), ("doctor", pa.string()),
            ("languages", pa.list_(pa.string())), ("dominant_language", pa.string()), ("n_turns", pa.int64()), ("n_words", pa.int64()),
            ("has_english", pa.bool_()), ("has_surgery_candidate", pa.bool_()), ("ok", pa.bool_()), ("provenance_complete", pa.bool_()), ("incomplete_reason", pa.string()), ("no_signal", pa.bool_()), ("no_signal_rule", pa.string()),
            ("provenance_hash", pa.string())])), ptmp, compression="zstd")
        os.chmod(ptmp, 0o600); ptmp.rename(pt); pq_note = pt.name
    except ImportError:
        pass
    sbody = "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in sorted(search_rows(FILES), key=lambda r: r["key"])).encode()
    if len(sbody) > 45 * 1024 * 1024:
        raise SystemExit("search index over 45 MB: shard it by date before it hits the 50 MB vault cap")
    crows, cunknown = chunk_rows(FILES)
    cbody = "".join(json.dumps(r, sort_keys=True) + "\n" for r in crows).encode()
    cj = out / f"chunks-{a.date}.jsonl"; ctmp = cj.with_name(f".{cj.name}.tmp"); ctmp.write_bytes(cbody); os.chmod(ctmp, 0o600); ctmp.rename(cj)
    sj = out / f"search-{a.date}.jsonl"; stmp = sj.with_name(f".{sj.name}.tmp"); stmp.write_bytes(sbody); os.chmod(stmp, 0o600); stmp.rename(sj)
    build_view(out, a.date + "0005" if False else datetime.now(IST).strftime("%Y%m%d%H%M"))
    tmp.rename(jl)  # windows jsonl last: its presence means the snapshot is complete
    print(json.dumps({"rows": len(data), "jsonl": jl.name, "parquet": pq_note, "search": sj.name, "search_bytes": len(sbody), "chunks": len(crows), "chunks_without_timing": len(cunknown)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
