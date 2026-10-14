"""export_consult_audit.py: consult-audit S6 exporter (ORDER 18A). One JSONL line per consult_uid: window, turns (text), roles, optional rx. READ-ONLY on the REB store, the cutter index and the CAA manifest.

    python3 -m kit.reb.export_consult_audit --uids FILE --out FILE [--rx FILE] [--surrogate-map FILE]

Line: {encounter_id, source, doctor_uid, room, window{t0,t1,complete}, turns[{turn_id, role, t0, t1, text_en, text_native, lang}], rx}
  encounter_id  consult_uid, unless it holds a run of 8+ digits: then a random opaque surrogate ("enc-<16 hex>") kept in --surrogate-map (0600, JSON {uid: surrogate}); an existing map is reused, so reruns are stable. A uid that needs a surrogate with no --surrogate-map is REFUSED (exit 2, before anything is read or written).
  source        cutter (uid in the cutter index) | caa (uid not in the index, found in in/caa/sep-caa-cuts-manifest.csv).
  cutter        doctor_uid, room_id and the window come from the LATEST index row of the uid. t0/t1 = span_start/span_end (the clip's own span; IST strings in the index) in ms UTC.
                window.complete: the index carries NO complete/truncated field, so it is derived: true when status == "cut" and none of TRUNC_FLAGS is in the row's flags, else false.
  caa           doctor_uid from the manifest row, room = the REB scope's room_id (path), t0/t1 = the manifest's t0_utc_ms/t1_utc_ms, complete = null. A uid with several manifest rows: the row whose t0/t1 equal the REB
                consult manifest's, else the sarvam_done == y row, else the first (counted caa_multi_row).
  turns         the newest ok stt.sarvam-saaras-v3 track (extras.created_at, else file mtime; created_key) of the uid's consult scope (version caa only for source caa), in time order; segments with empty text are dropped. text_native = stt text, lang = stt lang,
                text_en = the translate-track segment at the same index (equal t0/t1) else with the same t0/t1 ("index"), else the stt text when lang starts with "en" ("stt_en"), else the gap-fill track's segment with the same t0/t1 ("gapfill": translate.sarvam-mayura-v1 version gapfill-v1, written by translate_gapfill), else the STRICT overlap ("overlap": translate segments overlapping the turn, never one matched to another stt turn, each with >= 50% of its own duration inside the turn, joined in time order), else null.
  role          per TURN, first hit of: (1) the role.llm-roles segment that overlaps the turn most (its segments carry the per-utterance fixes), (2) the llm-roles per-speaker map, (3) the role.text-judge map,
                (4) the role.caa-labels segment that overlaps most, (5) the caa-labels map, (6) unknown. Mapped: doctor | patient | attender,attendant -> attendant | everything else -> unknown.
                Turns are counted by the source that gave the role (roles_by_source: llm_segment, llm_map, judge_map, caa_segment, caa_map, none).
  rx            the --rx entry for the uid (JSONL, one object per line with consult_uid, or one JSON object {uid: entry}), passed through as given without its consult_uid key (encounter_id is the key); null when absent.
Stdout also carries text_en_by {index, overlap, stt_en, null}, null_text_en (turns and consults left null: no translate track at all vs a translate track with no overlap) and counts.surrogates_reissued. --dry writes nothing.
--drop-untranslated: turns whose text_en is null are left out of the line (turn_ids keep their gaps; a consult left with no turn keeps its line with turns []); stdout adds dropped_turns_by_role {doctor, patient, attendant, unknown}, dropped_consults (consults that lost >= 1 turn) and consults_emptied. The text_en_by counts still count every turn, dropped or not.
Skipped (counted by reason, nothing written): not_found, ambiguous_scope, no_scope, no_stt. Files are 0600. Stdout carries counts only: no text, no ids.
"""
import argparse
import collections
import csv
import datetime
import glob
import json
import os
import re
import secrets
import sys

from . import reb
from . import sarvam_lane as sl

CAA_MANIFEST = "/home/eta/oc/palimpsest/in/caa/sep-caa-cuts-manifest.csv"
STT_ENGINE = "sarvam-saaras-v3"
TRANSLATE_ENGINES = ("sarvam-saaras-v3", "sarvam-mayura-v1")
GAPFILL_ENGINE, GAPFILL_VERSION = "sarvam-mayura-v1", "gapfill-v1"
ROLE_SOURCES = (("llm-roles", "llm"), ("text-judge", "judge"), ("caa-labels", "caa"))
TRUNC_FLAGS = ("tape_truncated", "search_tape_truncated")
ROLE_NAME = {"doctor": "doctor", "patient": "patient", "attender": "attendant", "attendant": "attendant"}
LONG_DIGITS = re.compile(r"\d{8,}")
SKIP_REASONS = ("not_found", "ambiguous_scope", "no_scope", "no_stt")
COUNTERS = ("uids", "lines", "skipped", "caa_multi_row", "rx_rows", "scope_room_mismatch", "unparseable_tracks")


class SurrogateMapRequired(RuntimeError):
    pass


def read_uids(path):
    out, seen = [], set()
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("{"):
                line = str(json.loads(line).get("consult_uid") or "")
            if line and line not in seen:
                seen.add(line)
                out.append(line)
    return out


def read_rx(path):
    """-> {consult_uid: entry}. JSONL (an object with consult_uid per line) or one JSON object keyed by uid. Later lines win."""
    if not path:
        return {}
    raw = open(path).read()
    stripped = raw.lstrip()
    if stripped.startswith("{") and "\n" not in stripped.strip():
        d = json.loads(stripped)
        if "consult_uid" not in d:
            return {str(k): v for k, v in d.items()}
    out = {}
    for line in raw.splitlines():
        line = line.strip()
        if line:
            d = json.loads(line)
            if isinstance(d, dict) and d.get("consult_uid"):
                out[str(d["consult_uid"])] = d
    return out


def load_surrogates(path):
    """-> (map, reissued). An existing entry whose surrogate has a run of 8+ digits is replaced by a fresh one (counted)."""
    if not (path and os.path.exists(path)):
        return {}, 0
    d = json.load(open(path))
    if not isinstance(d, dict):
        raise ValueError("surrogate map is not an object")
    m = {str(k): str(v) for k, v in d.items()}
    reissued = 0
    for k in sorted(m):
        if LONG_DIGITS.search(m[k]):
            m[k] = new_surrogate(set(m.values()))
            reissued += 1
    return m, reissued


def write_private(path, text):
    """Atomic 0600 write (tmp in the same dir, then rename)."""
    tmp = f"{path}.tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def new_surrogate(used):
    """A random opaque id with NO run of 8+ digits (it must never look like the ids it replaces)."""
    while True:
        v = "enc-" + secrets.token_hex(8)
        if v not in used and not LONG_DIGITS.search(v):
            return v


def encounter_id(uid, smap):
    if not LONG_DIGITS.search(uid):
        return uid
    if uid not in smap:
        smap[uid] = new_surrogate(set(smap.values()))
    return smap[uid]


def scan_scopes(root):
    """-> {consult_uid: [(ist_date, room_id, consult_dir)]} over reb/<date>/<room>/_consults/<uid>/manifest.json."""
    out = collections.defaultdict(list)
    for p in glob.glob(os.path.join(root, "*", "*", "_consults", "*", "manifest.json")):
        d = os.path.dirname(p)
        uid = os.path.basename(d)
        room = os.path.basename(os.path.dirname(os.path.dirname(d)))
        date = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(d))))
        out[uid].append((date, room, d))
    return out


def read_caa_manifest(path=CAA_MANIFEST):
    out = collections.defaultdict(list)
    if os.path.exists(path):
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                out[r["consult_uid"]].append(r)
    return out


def window_cutter(row):
    t0 = sl._ist_ms(row["span_start"])
    t1 = sl._ist_ms(row["span_end"])
    complete = row.get("status") == "cut" and not (set(row.get("flags") or []) & set(TRUNC_FLAGS))
    return {"t0": t0, "t1": t1, "complete": bool(complete)}


def created_key(body, path):
    """The ONE ordering rule for choosing among a layer's tracks (contract section 5): extras.created_at when it parses, else the file's mtime (UTC)."""
    v = (body.get("extras") or {}).get("created_at")
    if v:
        dt = reb._parse_finished_at(v)
        if dt != reb._parse_finished_at(None):
            return dt
    return datetime.datetime.fromtimestamp(os.stat(path).st_mtime, datetime.timezone.utc)


def read_track(path):
    """-> the track dict, or None when the file does not parse (or is not an object)."""
    try:
        with open(path) as f:
            body = json.load(f)
    except (ValueError, OSError):
        return None
    return body if isinstance(body, dict) else None


def latest_ok(win, layer, engines, version_ok=None, bad=None):
    """The ok track newest by created_key (ties: later manifest entry) among the window's tracks of layer/engines; None if none."""
    best, best_key = None, None
    for i, e in enumerate(win.manifest.get("tracks", [])):
        if e.get("layer") != layer or e.get("engine") not in engines or e.get("status") != "ok":
            continue
        if version_ok and not version_ok(e.get("version")):
            continue
        path = os.path.join(win.root, e["path"])
        if not os.path.exists(path):
            continue   # quarantined: never evidence here
        body = read_track(path)
        if body is None:
            if bad is not None:
                bad["unparseable_tracks"] += 1   # counted, never raised: a damaged file must not stop an export
            continue
        key = (created_key(body, path), i)
        if best_key is None or key > best_key:
            best, best_key = body, key
    return best


def _norm(r):
    return ROLE_NAME.get(r, "unknown")


def _map_of(tr):
    out = {}
    for sp, v in ((tr.get("extras") or {}).get("map") or {}).items():
        out[str(sp)] = _norm(v.get("role") if isinstance(v, dict) else v)
    return out


def _segs_of(tr):
    return [(g["t0_ms"], g["t1_ms"], _norm(g.get("role"))) for g in tr.get("segments") or [] if "t0_ms" in g and "t1_ms" in g and g.get("role") is not None]


def role_sources(win, bad=None):
    """-> dict of what each role track offers: llm_segs, llm_map, judge_map, caa_segs, caa_map (empty when the track is absent)."""
    out = {"llm_segs": [], "llm_map": {}, "judge_map": {}, "caa_segs": [], "caa_map": {}}
    tr = latest_ok(win, "role", ("llm-roles",), bad=bad)
    if tr is not None:
        out["llm_segs"], out["llm_map"] = _segs_of(tr), _map_of(tr)
    tr = latest_ok(win, "role", ("text-judge",), bad=bad)
    if tr is not None:
        out["judge_map"] = _map_of(tr)
    tr = latest_ok(win, "role", ("caa-labels",), bad=bad)
    if tr is not None:
        out["caa_segs"], out["caa_map"] = _segs_of(tr), _map_of(tr)
    return out


def best_overlap(segs, t0, t1):
    """Role of the segment overlapping [t0, t1) most (ties: the earlier segment); None when nothing overlaps."""
    best, best_ov = None, 0
    for a, b, r in segs:
        ov = min(b, t1) - max(a, t0)
        if ov > best_ov:
            best, best_ov = r, ov
    return best


def role_for(src, t0, t1, speaker):
    """-> (role, source name)."""
    r = best_overlap(src["llm_segs"], t0, t1)
    if r is not None:
        return r, "llm_segment"
    if speaker in src["llm_map"]:
        return src["llm_map"][speaker], "llm_map"
    if speaker in src["judge_map"]:
        return src["judge_map"][speaker], "judge_map"
    r = best_overlap(src["caa_segs"], t0, t1)
    if r is not None:
        return r, "caa_segment"
    if speaker in src["caa_map"]:
        return src["caa_map"][speaker], "caa_map"
    return "unknown", "none"


def _overlap(a0, a1, b0, b1):
    return min(a1, b1) - max(a0, b0)


def exact_match(tr_segs, i, seg):
    """-> index of the translate segment with the same index and time, else the first with the same time (non-blank text only), else None."""
    if i < len(tr_segs) and tr_segs[i].get("t0_ms") == seg["t0_ms"] and tr_segs[i].get("t1_ms") == seg["t1_ms"] and (tr_segs[i].get("text") or "").strip():
        return i
    for j, t in enumerate(tr_segs):
        if t.get("t0_ms") == seg["t0_ms"] and t.get("t1_ms") == seg["t1_ms"] and (t.get("text") or "").strip():
            return j
    return None


def strict_overlap(tr_segs, claimed, seg):
    """-> (text or None, refused). Candidates are translate segments overlapping the turn by > 0 ms. A candidate is REFUSED when it was already matched (index/time) to another stt turn,
    or when less than 50% of its own duration lies inside this turn. The accepted ones are joined in time order by a space."""
    ok, refused = [], 0
    for j, t in enumerate(tr_segs):
        a, b = t.get("t0_ms"), t.get("t1_ms")
        if a is None or b is None or not (t.get("text") or "").strip():
            continue
        ov = _overlap(a, b, seg["t0_ms"], seg["t1_ms"])
        if ov <= 0:
            continue
        if j in claimed or b <= a or ov < 0.5 * (b - a):
            refused += 1
            continue
        ok.append((a, b, j))
    ok.sort()
    return (" ".join((tr_segs[j].get("text") or "").strip() for _, _, j in ok) or None), refused


def build_turns(win, caa, by_role_src=None, bad=None, te=None, with_meta=False):   # bad: a Counter that gets unparseable_tracks; te: a Counter for text_en_by_* and null_*
    stt = latest_ok(win, "stt", (STT_ENGINE,), None if caa else (lambda v: v != "caa"), bad)
    if stt is None:
        return None
    # the gap-fill track (translate.sarvam-mayura-v1 version gapfill-v1) is a separate source: it must never be taken for THE translate track (its segments are not index-aligned to the stt)
    tr = latest_ok(win, "translate", TRANSLATE_ENGINES, (lambda v: v != GAPFILL_VERSION) if caa else (lambda v: v not in ("caa", GAPFILL_VERSION)), bad)
    tr_segs = (tr or {}).get("segments") or []
    gf = None if caa else latest_ok(win, "translate", (GAPFILL_ENGINE,), lambda v: v == GAPFILL_VERSION, bad)
    gap_by_time = {}
    for g in (gf or {}).get("segments") or []:
        if (g.get("text") or "").strip():
            gap_by_time.setdefault((g.get("t0_ms"), g.get("t1_ms")), g["text"].strip())
    src = role_sources(win, bad)
    # the translate segments are indexed against the stt order the track holds: keep each segment's position through the time sort
    segs = sorted(enumerate(stt.get("segments") or []), key=lambda p: (p[1]["t0_ms"], p[1]["t1_ms"], p[0]))
    claimed = {j for i, s_ in enumerate(stt.get("segments") or []) for j in [exact_match(tr_segs, i, s_)] if j is not None}   # translate segments that belong to some stt turn
    turns = []
    for i, s in segs:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        lang = s.get("lang")
        j = exact_match(tr_segs, i, s)
        en, how = ((tr_segs[j].get("text") or "").strip(), "index") if j is not None else (None, None)
        if en is None and isinstance(lang, str) and lang.lower().startswith("en"):
            en, how = text, "stt_en"
        if en is None and (s["t0_ms"], s["t1_ms"]) in gap_by_time:
            en, how = gap_by_time[(s["t0_ms"], s["t1_ms"])], "gapfill"
        if en is None:
            en, refused = strict_overlap(tr_segs, claimed, s)
            how = "overlap" if en is not None else None
            if te is not None:
                te["text_en_by_overlap_rejected"] += refused
        if te is not None:
            te["text_en_by_" + (how or "null")] += 1
            if en is None:
                cause = "no_translate_track" if tr is None else "no_overlap"
                te["null_turns_" + cause] += 1
                te["_c_" + cause] = 1   # marker: this consult has at least one such turn
        role, rsrc = role_for(src, s["t0_ms"], s["t1_ms"], str(s.get("speaker")))
        if by_role_src is not None:
            by_role_src[rsrc] += 1
        turns.append({"role": role, "t0": s["t0_ms"], "t1": s["t1_ms"], "text_en": en, "text_native": text, "lang": lang, "index": i, "speaker": str(s.get("speaker"))})
    if not turns:
        return None
    for n, t in enumerate(turns):
        t["turn_id"] = f"t{n:04d}"
    keys = ("turn_id", "role", "t0", "t1", "text_en", "text_native", "lang") + (("index", "speaker") if with_meta else ())
    return [{k: t[k] for k in keys} for t in turns]


def pick_caa_row(rows, win):
    if len(rows) == 1:
        return rows[0], False
    t0, t1 = win.manifest.get("t0_ms"), win.manifest.get("t1_ms")
    for r in rows:
        if str(r.get("t0_utc_ms")) == str(t0) and str(r.get("t1_utc_ms")) == str(t1):
            return r, True
    for r in rows:
        if r.get("sarvam_done") == "y":
            return r, True
    return rows[0], True


def export(uids, out_path, rx_path=None, smap_path=None, root=None, index_path=sl.CLIP_INDEX, caa_path=CAA_MANIFEST, dry=False, drop_untranslated=False):
    root = root or reb.DEFAULT_ROOT
    if not smap_path and any(LONG_DIGITS.search(u) for u in uids):
        # a surrogate that is not kept changes on every rerun: refuse before reading or writing anything
        raise SurrogateMapRequired("a consult_uid needs a surrogate and no --surrogate-map was given")
    cnt = collections.Counter()
    skipped = collections.Counter()
    by_source, by_conf, by_complete, by_role_src = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    index = sl.latest_rows(index_path) if os.path.exists(index_path) else {}
    caa_rows = read_caa_manifest(caa_path)
    scopes = scan_scopes(root)
    rx = read_rx(rx_path)
    smap, reissued = load_surrogates(smap_path)
    smap_before = dict(smap)
    cnt["surrogates_reissued"] = reissued
    te_total = collections.Counter()
    dropped_role, dropped_consults, emptied = collections.Counter(), 0, 0
    lines = []
    for uid in uids:
        cnt["uids"] += 1
        pending = collections.Counter()
        pend_te = collections.Counter()
        row = index.get(uid)
        if row is not None:
            source = "cutter"
        elif uid in caa_rows:
            source = "caa"
        else:
            skipped["not_found"] += 1
            continue
        sc = scopes.get(uid) or []
        if source == "cutter":
            match = [s for s in sc if s[0] == row.get("ist_date") and s[1] == row.get("room_id")]
            if sc and not match:
                cnt["scope_room_mismatch"] += 1   # the index row names another date/room than the scope(s): fall back to the scope(s) found by uid
            sc = match or sc
        if not sc:
            skipped["no_scope"] += 1
            continue
        if len(sc) > 1:
            skipped["ambiguous_scope"] += 1
            continue
        date, room_dir, d = sc[0]
        win = reb.Window(root, json.load(open(os.path.join(d, "manifest.json"))), os.path.join(d, "manifest.json"))
        turns = build_turns(win, source == "caa", pending, cnt, pend_te)
        if turns is None:
            skipped["no_stt"] += 1
            continue
        if source == "cutter":
            try:
                window = window_cutter(row)
            except (KeyError, ValueError, TypeError):
                skipped["no_scope"] += 1
                continue
            doctor, room = row.get("doctor_uid") or None, row.get("room_id") or room_dir
        else:
            r, multi = pick_caa_row(caa_rows[uid], win)
            cnt["caa_multi_row"] += int(multi)
            window = {"t0": int(r["t0_utc_ms"]), "t1": int(r["t1_utc_ms"]), "complete": None}
            doctor, room = r.get("doctor_uid") or None, room_dir
        entry = rx.get(uid)
        if isinstance(entry, dict):
            entry = {k: v for k, v in entry.items() if k != "consult_uid"}
        cnt["rx_rows"] += int(entry is not None)
        by_conf[("none" if entry is None else str((entry or {}).get("match_confidence", "missing")))] += 1
        by_source[source] += 1
        by_role_src.update(pending)
        for k, v in pend_te.items():
            te_total[("null_consults_" + k[3:]) if k.startswith("_c_") else k] += v
        by_complete[str(window["complete"]).lower() if window["complete"] is not None else "null"] += 1
        if drop_untranslated:
            # turns with no English are left out of the line (turn_ids are kept, so a gap in the ids marks a dropped turn)
            kept = [t for t in turns if t["text_en"] is not None]
            if len(kept) < len(turns):
                dropped_consults += 1
                emptied += int(not kept)
                dropped_role.update(t["role"] for t in turns if t["text_en"] is None)
            turns = kept
        lines.append(json.dumps({"encounter_id": encounter_id(uid, smap), "source": source, "doctor_uid": doctor, "room": room, "window": window, "turns": turns, "rx": entry},
                                ensure_ascii=False, sort_keys=False))
    # the map first, so no line in the output can name a surrogate that is not on disk
    if not dry:
        if smap_path and (reissued or smap != smap_before):
            write_private(smap_path, json.dumps(smap, sort_keys=True))
        write_private(out_path, "".join(l + "\n" for l in lines))
    cnt["lines"] = len(lines)
    cnt["skipped"] = sum(skipped.values())
    extra = {}
    if drop_untranslated:
        extra = {"dropped_turns_by_role": {r: dropped_role.get(r, 0) for r in ("doctor", "patient", "attendant", "unknown")}, "dropped_consults": dropped_consults, "consults_emptied": emptied}
    return {**extra, "counts": dict(cnt), "by_source": dict(by_source), "by_rx_match_confidence": dict(by_conf), "by_window_complete": dict(by_complete), "turns_by_role_source": dict(by_role_src),
            "text_en_by": {k: te_total.get("text_en_by_" + k, 0) for k in ("index", "stt_en", "gapfill", "overlap", "null", "overlap_rejected")},
            "null_text_en": {k: te_total.get(k, 0) for k in ("null_turns_no_translate_track", "null_turns_no_overlap", "null_consults_no_translate_track", "null_consults_no_overlap")}, "skipped_by_reason": dict(skipped)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--uids", required=True)
    ap.add_argument("--out")
    ap.add_argument("--dry", action="store_true", help="count only: write NOTHING (no --out file, the surrogate map is not touched)")
    ap.add_argument("--drop-untranslated", action="store_true", help="leave out the turns whose text_en is null (turn_ids are kept)")
    ap.add_argument("--rx")
    ap.add_argument("--surrogate-map")
    ap.add_argument("--root", default=None, help="REB root (default: ~/eta-data/reb)")
    ap.add_argument("--index", default=sl.CLIP_INDEX, help="cutter index.jsonl")
    ap.add_argument("--caa-manifest", default=CAA_MANIFEST)
    a = ap.parse_args(argv)
    if not a.dry and not a.out:
        ap.error("--out is required unless --dry")
    try:
        res = export(read_uids(a.uids), a.out, dry=a.dry, drop_untranslated=a.drop_untranslated, rx_path=a.rx, smap_path=a.surrogate_map, root=a.root, index_path=a.index, caa_path=a.caa_manifest)
    except SurrogateMapRequired as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    print(json.dumps(res, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
