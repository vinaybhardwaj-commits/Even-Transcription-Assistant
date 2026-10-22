"""FRX-V10 Fix3d ruling 2: data/given_names.v1.json from a PUBLISHED open-licence list. Source: nam_dict.txt of the `gender-guesser` 0.4.0 PyPI wheel (Joerg Michael, c't magazine,
GNU Free Documentation License 1.2+; 48,8xx given names with per-country frequency). Kept: names with a frequency in the India/Sri Lanka column (Indian given names), or a frequency
of 3 or more (about 0.5% of the population or more, per the file's own log scale... the file's value 10 = 2%) in Great Britain, Ireland or U.S.A. (common English given names);
ASCII letters only, 3+ letters, lowercased. The column positions are read from the file's own header, never hard-coded. Run:
python -m tools.eta2freescript.v10._build.make_given_names /path/to/nam_dict.txt   (the pinned source sha is recorded in the output)."""
import hashlib
import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"
SOURCE = {"name": "gender-guesser 0.4.0, gender_guesser/data/nam_dict.txt", "url": "https://pypi.org/project/gender-guesser/0.4.0/", "author": "Joerg Michael (c't magazine)",
          "licence": "GNU Free Documentation License 1.2 or later"}
ENGLISH_MIN_FREQ = 3
ENGLISH_COLS = ("Great Britain", "Ireland", "U.S.A.")
INDIA_COL = "India/Sri Lanka"


def columns(lines: list[str]) -> dict[str, int]:
    cols = {}
    for i, l in enumerate(lines[:300]):
        if l.startswith("#") and i + 1 < len(lines) and "|" in lines[i + 1] and lines[i + 1].strip("#$ |") == "":
            lab = l.strip("#$ ").strip()
            if lab:
                cols[lab] = lines[i + 1].index("|")
    return cols


def build(src: Path) -> dict:
    raw = src.read_bytes()
    lines = raw.decode("latin-1").replace("\r", "").split("\n")
    cols = columns(lines)
    names = set()
    for l in lines:
        if l.startswith("#") or len(l) < 31:
            continue
        nm = l[3:29].strip()
        if not (nm.isascii() and nm.isalpha() and len(nm) >= 3):
            continue
        fr = lambda c: (l[cols[c]:cols[c] + 1] or " ")
        if fr(INDIA_COL).strip() or any(fr(c) in "0123456789ABCDEF" and fr(c).strip() and int(fr(c), 16) >= ENGLISH_MIN_FREQ for c in ENGLISH_COLS):
            names.add(nm.lower())
    return {"version": "given-names.v1", "source": SOURCE, "source_sha256": hashlib.sha256(raw).hexdigest(), "generator": "v10/_build/make_given_names.py",
            "count": len(names), "names": sorted(names)}


def main() -> None:
    d = build(Path(sys.argv[1]))
    (DATA / "given_names.v1.json").write_text(json.dumps(d, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(d["count"], "given names from source sha", d["source_sha256"][:12])


if __name__ == "__main__":
    main()
