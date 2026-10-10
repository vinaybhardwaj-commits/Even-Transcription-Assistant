#!/usr/bin/env python3
"""
tools/pulse-room-centroids/load.py — validate a directory of room-mic centroid JSONs and PRINT the SQL that loads them.

    python3 load.py <dir>  >  load.sql        # then a human reviews load.sql and runs it

It NEVER connects to a database and never writes a file: its only output is the SQL on stdout (and the reasons for a
refusal on stderr, exit 1). The SQL carries the vectors, which are voice biometric data at rest (0142): do not paste
it into a ticket, a log or a commit.

One JSON per Pulse doctor, EXACTLY this shape (an unknown or missing top-level key refuses the file):
    { "doctor_ref": "<20-char Pulse uid>", "embedding_model": "speechbrain/spkrec-ecapa-voxceleb", "revision": "<str>",
      "dim": 192, "embedding": [192 finite floats, L2 norm ~1], "n_segments": <int >= 1>,
      "source": { "room_id": "<str>", "window_ids": ["<window id>", ...] } }
Mapping onto pulse_doctor_voice (the pack has no day count or support): n_windows = windows_offered = the number of
DISTINCT window_ids; n_days = 1 and support = 1.0 (placeholders, listed in source.defaulted); n_segments, revision, room_id and
window_ids are kept in the `source` jsonb. Refused, for the whole directory, when ANY file: is not a JSON object; has a dim other
than 192 (or dim != len(embedding)), a non-finite value or a norm outside 1 +- 0.01; names a model other than the exact id (an
unknown model is refused); has a doctor_ref that is not a 20-char alphanumeric uid; carries a key that looks like a name
(name, email, phone, ...) at any depth; or repeats another file's doctor_ref.

The SQL is one transaction. Per doctor it is ONE statement, as lib/room-access/pulse-doctor-voice.ts writeDoctorVoice:
it retires the active row for (uid, model) with who and why, and inserts the next generation (source 'room_mic_pack').
Nothing is deleted. The row id is derived from the file's sha256, so running the same SQL twice fails on the primary key.
"""
import hashlib
import json
import math
import os
import re
import sys

MODEL = "speechbrain/spkrec-ecapa-voxceleb"
DIM = 192
NORM_TOL = 0.01
SOURCE = "room_mic_pack"
UID_RE = re.compile(r"^[A-Za-z0-9]{20}$")
NAME_KEY_RE = re.compile(r"name|email|phone|mobile|address|patient|label|speaker", re.I)
TOP_KEYS = {"doctor_ref", "embedding_model", "revision", "dim", "embedding", "n_segments", "source"}
SOURCE_KEYS = {"room_id", "window_ids"}


class PackError(Exception):
    pass


def _name_keys(node, path=""):
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if NAME_KEY_RE.search(str(k)):
                out.append(f"{path}{k}")
            out += _name_keys(v, f"{path}{k}.")
    elif isinstance(node, list) and len(node) <= 8:  # an embedding is not walked for keys
        for i, v in enumerate(node):
            out += _name_keys(v, f"{path}{i}.")
    return out


def validate(doc, fname):
    """Return the validated record, or raise PackError naming the file and the rule (never the vector)."""
    if not isinstance(doc, dict):
        raise PackError(f"{fname}: not a JSON object")
    bad = _name_keys(doc)
    if bad:
        raise PackError(f"{fname}: name-like field(s) present: {', '.join(sorted(bad))}")
    keys = set(doc)
    if keys != TOP_KEYS:
        raise PackError(f"{fname}: keys must be exactly {sorted(TOP_KEYS)} (missing {sorted(TOP_KEYS - keys)}, unknown {sorted(keys - TOP_KEYS)})")
    ref = doc["doctor_ref"]
    if not isinstance(ref, str) or not UID_RE.match(ref):
        raise PackError(f"{fname}: doctor_ref is not a 20-char Pulse uid")
    if doc["embedding_model"] != MODEL:
        raise PackError(f"{fname}: embedding_model must be exactly {MODEL}")
    rev = doc["revision"]
    if not isinstance(rev, str) or not rev.strip():
        raise PackError(f"{fname}: revision must be a non-empty string")
    emb = doc["embedding"]
    if isinstance(doc["dim"], bool) or doc["dim"] != DIM or not isinstance(emb, list) or len(emb) != DIM:
        raise PackError(f"{fname}: dim and embedding must both be {DIM}")
    for x in emb:
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
            raise PackError(f"{fname}: embedding has a non-finite or non-numeric value")
    norm = math.sqrt(sum(float(x) * float(x) for x in emb))
    if abs(norm - 1.0) > NORM_TOL:
        raise PackError(f"{fname}: embedding norm {norm:.4f} is not 1 +- {NORM_TOL}")
    nseg = doc["n_segments"]
    if isinstance(nseg, bool) or not isinstance(nseg, int) or nseg < 1:
        raise PackError(f"{fname}: n_segments must be a positive integer")
    src = doc["source"]
    if not isinstance(src, dict) or set(src) != SOURCE_KEYS:
        raise PackError(f"{fname}: source must have exactly {sorted(SOURCE_KEYS)}")
    wids = src["window_ids"]
    if not isinstance(src["room_id"], str) or not src["room_id"] or not isinstance(wids, list) \
            or not wids or not all(isinstance(w, str) and w for w in wids):
        raise PackError(f"{fname}: source needs a room_id and a non-empty list of window_ids")
    n_windows = len(set(wids))
    return {"uid": ref, "embedding": [float(x) for x in emb], "support": 1.0, "n_windows": n_windows, "n_days": 1,
            "windows_offered": n_windows, "revision": rev, "n_segments": nseg, "room_id": src["room_id"],
            "window_ids": sorted(set(wids)), "defaulted": ["n_days", "support"]}


def _q(s):
    return "'" + s.replace("'", "''") + "'"


def statement(rec, file_sha256, fname):
    """The one statement for one doctor: retire the active row, insert the next generation."""
    pid = "pdv_" + file_sha256[:12]
    source = json.dumps({"source": SOURCE, "file": fname, "file_sha256": file_sha256, "revision": rec["revision"],
                         "n_segments": rec["n_segments"], "room_id": rec["room_id"], "window_ids": rec["window_ids"],
                         "defaulted": rec["defaulted"]}, sort_keys=True)
    vec = ", ".join(repr(x) for x in rec["embedding"])
    uid, model = _q(rec["uid"]), _q(MODEL)
    return f"""WITH retired AS (
  UPDATE pulse_doctor_voice
     SET retired_at = now(), retired_by = {_q(SOURCE)}, retired_reason = {_q("superseded_by:" + pid)}
   WHERE pulse_doctor_uid = {uid} AND embedding_model = {model} AND retired_at IS NULL
  RETURNING id
), next_gen AS (
  SELECT coalesce(max(generation), 0) + 1 AS g FROM pulse_doctor_voice
   WHERE pulse_doctor_uid = {uid} AND embedding_model = {model}
)
INSERT INTO pulse_doctor_voice
  (id, pulse_doctor_uid, generation, embedding, embedding_model, embedding_dim, n_windows, n_days, windows_offered,
   support, runner_up_windows, nearest_clinician_id, nearest_score, source)
SELECT {_q(pid)}, {uid}, next_gen.g, ARRAY[{vec}]::real[], {model}, {DIM}, {rec["n_windows"]}, {rec["n_days"]},
       {rec["windows_offered"]}, {rec["support"]!r}, 0, NULL, NULL, {_q(source)}::jsonb
  FROM next_gen;"""


def build(directory):
    """Validate every *.json in `directory` and return the SQL. All-or-nothing: one bad file refuses the lot."""
    names = sorted(n for n in os.listdir(directory) if n.endswith(".json"))
    if not names:
        raise PackError("no .json files in the directory")
    recs, errors, seen = [], [], {}
    for n in names:
        with open(os.path.join(directory, n), "rb") as fh:
            raw = fh.read()
        try:
            rec = validate(json.loads(raw), n)
        except json.JSONDecodeError:
            errors.append(f"{n}: not valid JSON")
            continue
        except PackError as e:
            errors.append(str(e))
            continue
        if rec["uid"] in seen:
            errors.append(f"{n}: doctor_ref repeats {seen[rec['uid']]}")
            continue
        seen[rec["uid"]] = n
        recs.append((rec, hashlib.sha256(raw).hexdigest(), n))
    if errors:
        raise PackError("\n".join(errors))
    body = "\n".join(statement(r, h, n) for r, h, n in recs)
    return f"-- pulse_doctor_voice room-mic pack: {len(recs)} doctor(s). VOICE BIOMETRIC DATA: do not paste, log or commit.\nBEGIN;\n{body}\nCOMMIT;\n"


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: load.py <directory of pack JSONs>\n")
        return 2
    try:
        sys.stdout.write(build(argv[1]))
    except (PackError, OSError) as e:
        sys.stderr.write(f"REFUSED: {e}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
