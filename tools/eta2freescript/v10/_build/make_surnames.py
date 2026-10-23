"""FRX-V10 Fix3f c: data/surnames.v1.json from the US Census Bureau 2010 surname file (Names_2010Census.csv in names.zip, https://www2.census.gov/topics/genealogy/2010surnames/names.zip;
a US government work, public domain). Kept: surnames with count >= 100 (a suppressed "(S)" count is dropped), ASCII letters only, 3+ letters, lowercased. Run:
python -m tools.eta2freescript.v10._build.make_surnames /path/to/Names_2010Census.csv   (the source sha is recorded in the output; sha of the list is in C7)."""
import csv
import hashlib
import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"
SOURCE = {"name": "US Census Bureau, Frequently Occurring Surnames from the 2010 Census, Names_2010Census.csv", "url": "https://www2.census.gov/topics/genealogy/2010surnames/names.zip",
          "licence": "public domain (US government work)"}
MIN_COUNT = 100
FREQUENT_COUNT = 1000  # a surname borne by 1,000+ people in 2010; used only to decide whether a sentence-initial ordinary English word is read as a word (Patient, Pain, Chest: under 1,000) or as a name (Khan, Singh, Honey, Rose)


def build(src: Path) -> dict:
    raw = src.read_bytes()
    names, frequent = set(), set()
    for row in csv.DictReader(raw.decode("utf-8-sig").splitlines()):
        nm, cnt = row["name"].strip(), row["count"].strip()
        if cnt.isdigit() and int(cnt) >= MIN_COUNT and nm.isascii() and nm.isalpha() and len(nm) >= 3:
            names.add(nm.lower())
            if int(cnt) >= FREQUENT_COUNT:
                frequent.add(nm.lower())
    return {"version": "surnames.v1", "source": SOURCE, "source_sha256": hashlib.sha256(raw).hexdigest(), "min_count": MIN_COUNT, "frequent_min_count": FREQUENT_COUNT, "frequent": sorted(frequent), "generator": "v10/_build/make_surnames.py",
            "count": len(names), "names": sorted(names)}


def main() -> None:
    d = build(Path(sys.argv[1]))
    (DATA / "surnames.v1.json").write_text(json.dumps(d, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(d["count"], "surnames from source sha", d["source_sha256"][:12])


if __name__ == "__main__":
    main()
