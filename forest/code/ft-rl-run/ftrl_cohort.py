"""ft-rl-run: build the RL-2 cohort file (rl_link.load_cohort format) from the D-split
flagged episodes in labels.parquet v2 and the W1c pull (prescription_uid -> uhid_h).

Usage: ~/.venv-forest/bin/python -I ftrl_cohort.py LABELS W1C OUT_JSON
OUT is 0600 (uhid_h + dates; lab box only). rx_uid carries the episode_id so RL-2
results map back to episodes. Counts only on stdout.
"""
import json
import os
import sys

import pandas as pd


def main(labels, w1c, out):
    lab = pd.read_parquet(labels)
    lab = lab[lab.split == "D"].copy()                      # H sealed: never read past this line
    m = pd.read_csv(w1c, sep="\t", dtype=str)
    assert m.prescription_uid.is_unique, "w1c: duplicate prescription_uid"
    lab = lab.merge(m, on="prescription_uid", how="left")
    no_uhid = int(lab.uhid_h.isna().sum())
    lab = lab[lab.uhid_h.notna()]
    rows = []
    for r in lab.itertuples():
        ev = None if pd.isna(r.event_date) or r.event_date in ("", None) else str(r.event_date)[:10]
        rows.append({"uhid_h": r.uhid_h, "rx_date": pd.Timestamp(r.rx_date).date().isoformat(),
                     "rx_uid": r.episode_id, "decision_date": ev, "decision_final": ev is not None})
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(rows, f)
    os.chmod(out, 0o600)
    dup = lab.groupby(["uhid_h", lab.rx_date.dt.date]).size()
    print("cohort D episodes=%d with_uhid=%d no_uhid=%d patients=%d with_event=%d same_patient_same_rxday_groups=%d"
          % (len(lab) + no_uhid, len(rows), no_uhid, lab.uhid_h.nunique(),
             sum(r["decision_date"] is not None for r in rows), int((dup > 1).sum())))


if __name__ == "__main__":
    main(*sys.argv[1:4])
