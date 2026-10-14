#!/usr/bin/env python3
"""Nightly analysis index (ruling 184 A6): one row per transcript file in the box's vault-layout roots.

Writes, ONCE per date (the vault is write-once; a same-date rerun is refused, tomorrow's file picks up new rows):
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
        "n_turns", "n_words", "has_english", "has_surgery_candidate", "ok", "provenance_complete", "provenance_hash"]


def rows(surgery):
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
                "ok": d.get("ok"), "provenance_complete": prov.get("provenance_complete"),
                "provenance_hash": hashlib.sha256(json.dumps(prov, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            }


def search_rows(root_files):
    """One row per window file with the full text, for the viewer's client-side search."""
    for key, d in root_files:
        segs = d.get("segments") if isinstance(d.get("segments"), list) else []
        segs = [s for s in segs if isinstance(s, dict)]
        text = d.get("transcript_native") or " ".join((s.get("text") or "") for s in segs)
        en = d.get("transcript_en") or " ".join((s.get("text_en") or "") for s in segs)
        yield {"key": key, "window_id": d.get("window_id"), "room_id": d.get("room_id") or key.split("/")[2], "ist_date": key.split("/")[3], "run_id": d["provenance"].get("run_id"), "text": text, "text_en": en.strip()}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--date", default=datetime.now(IST).strftime("%Y%m%d")); a = ap.parse_args()
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
            ("has_english", pa.bool_()), ("has_surgery_candidate", pa.bool_()), ("ok", pa.bool_()), ("provenance_complete", pa.bool_()),
            ("provenance_hash", pa.string())])), ptmp, compression="zstd")
        os.chmod(ptmp, 0o600); ptmp.rename(pt); pq_note = pt.name
    except ImportError:
        pass
    sbody = "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in sorted(search_rows(FILES), key=lambda r: r["key"])).encode()
    if len(sbody) > 45 * 1024 * 1024:
        raise SystemExit("search index over 45 MB: shard it by date before it hits the 50 MB vault cap")
    sj = out / f"search-{a.date}.jsonl"; stmp = sj.with_name(f".{sj.name}.tmp"); stmp.write_bytes(sbody); os.chmod(stmp, 0o600); stmp.rename(sj)
    tmp.rename(jl)  # windows jsonl last: its presence means the snapshot is complete
    print(json.dumps({"rows": len(data), "jsonl": jl.name, "parquet": pq_note, "search": sj.name, "search_bytes": len(sbody)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
