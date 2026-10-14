"""tag.py — ruling 146.2 English tags. Same rule as lab-mover's tag_english.py (studies/2026-09-24-stt-parity): english_dominant = dominant_language in {en, english} OR (native transcript non-empty AND
Indic-script share < 10%); indic_script_share = Indic chars / len(text). PLUS english_span_share = English seconds / total seconds of the router's language_timeline spans (lab-mover: 'a fine addition')."""
import re
INDIC = re.compile(r"[ऀ-෿]")

def _spans(tl):
    """The router's LIVE output (and my window records) hold language_timeline as a LIST of {start_s, end_s, lang, engine, chars}; the STORED production metrics_json holds {"spans": [...]}. Accept both (v1 read only the dict shape and returned None on every real window: hist-bulk #621)."""
    if isinstance(tl, dict): tl = tl.get("spans")
    return [x for x in (tl or []) if isinstance(x, dict)] if isinstance(tl, list) else []

def retag_dir(d, min_age_s=60):
    """Recompute english_span_share (and the other tags) IN PLACE for every window record in d whose english_span_share is None. Atomic, keeps 0600, skips files younger than min_age_s (a running job may still be writing)."""
    import glob, json, os, time
    n = 0
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        if time.time() - os.path.getmtime(f) < min_age_s: continue
        try: r = json.load(open(f))
        except Exception: continue
        if not isinstance(r, dict) or "language_timeline" not in r or r.get("english_span_share") is not None: continue
        r.update(tag(r.get("dominant_language"), r.get("transcript_native"), r.get("language_timeline")))
        with open(f + ".tmp", "w") as h: json.dump(r, h, ensure_ascii=False)
        os.chmod(f + ".tmp", 0o600); os.replace(f + ".tmp", f); n += 1
    return n

def tag(dominant_language, transcript_native, language_timeline):
    lang = (dominant_language or "").lower(); txt = transcript_native or ""
    share = round(len(INDIC.findall(txt)) / max(1, len(txt)), 3)
    spans = _spans(language_timeline)
    tot = sum(max(0.0, float(s.get("end_s", 0)) - float(s.get("start_s", 0))) for s in spans)
    en = sum(max(0.0, float(s.get("end_s", 0)) - float(s.get("start_s", 0))) for s in spans if str(s.get("lang") or "").lower() in ("en", "english"))
    return {"indic_script_share": share, "english_dominant": bool(lang in ("en", "english") or (txt.strip() and share < 0.10)),
            "english_span_share": round(en / tot, 3) if tot > 0 else None}


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        live = [{"start_s": 0, "end_s": 30, "lang": "kn", "engine": "x", "chars": 5}, {"start_s": 30, "end_s": 90, "lang": "en", "engine": "y", "chars": 9}]      # the router's real shape (a list)
        assert tag("en", "hello", live)["english_span_share"] == 0.667, tag("en", "hello", live)
        assert tag("en", "hello", {"spans": live})["english_span_share"] == 0.667      # the stored production shape
        assert tag("en", "hello", [])["english_span_share"] is None and tag("en", "hello", None)["english_span_share"] is None and tag("en", "hello", "junk")["english_span_share"] is None
        assert tag("en", "hello", [{"lang": "en"}, "x", 3])["english_span_share"] is None      # spans without bounds carry no seconds
        import tempfile, json, os
        with tempfile.TemporaryDirectory() as d:
            json.dump({"dominant_language": "kn", "transcript_native": "यह परीक्षण", "language_timeline": live, "english_span_share": None}, open(f"{d}/a.json", "w"))
            assert retag_dir(d, min_age_s=0) == 1 and json.load(open(f"{d}/a.json"))["english_span_share"] == 0.667 and retag_dir(d, min_age_s=0) == 0
            assert oct(os.stat(f"{d}/a.json").st_mode & 0o777) == "0o600" and retag_dir(d, min_age_s=3600) == 0
        print("selftest OK: list shape (real router output) and dict-spans shape (stored), empty/junk timelines -> None, retag_dir idempotent, 0600, skips young files")
