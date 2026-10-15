"""Blind room-days (R3/W51 held-out union, sha8 f07171dc): never decoded, emitted as `withheld`."""
import importlib.util
import os

HELDOUT = os.path.expanduser("~/eta-data/drtpqma/heldout.py")


def blind_room_days():
    """-> set of (room_id, ist_day) from the shared heldout.py predicate. Names only; no content is read."""
    sp = importlib.util.spec_from_file_location("heldout", HELDOUT)
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    union, _sha = m.load_union()
    label2room = {v: k for k, v in m.LABEL.items()}
    out = set()
    for entry in union:
        day, label = entry.split(" ", 1)
        out.add((label2room[label], day))
    return out
