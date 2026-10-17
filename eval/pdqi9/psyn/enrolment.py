"""Pseudo-doctor pool and enrolment utterances (spec A2.1, plan 6a).

32 pseudo-doctors: 14 voice-alike pairs (PD01/PD02 ... PD27/PD28) plus four
singles (PD29-PD32). Each gets ENROL_N reading sentences built from a
non-clinical grammar; tests assert none of them overlaps any consult text.
"""

import random

from . import lexicon
from .names import make_name

N_PSEUDO_DOCTORS = 32
N_VOICE_ALIKE_PAIRS = 14
ENROL_N = 10


def pd_id(i):
    return f"PD{i:02d}"


def partner(pd):
    """Voice-alike partner of a paired pseudo-doctor, else None."""
    n = int(pd[2:])
    if n > 2 * N_VOICE_ALIKE_PAIRS:
        return None
    return pd_id(n + 1 if n % 2 else n - 1)


def build_pool(seed):
    rng = random.Random(f"psyn-enrol|{seed}")
    used = set()
    combos = [(s, v, o, t) for s in lexicon.ENROL_SUBJECTS for v in lexicon.ENROL_VERBS
              for o in lexicon.ENROL_OBJECTS for t in lexicon.ENROL_TAILS]
    picks = rng.sample(combos, N_PSEUDO_DOCTORS * ENROL_N)
    pool = []
    for i in range(1, N_PSEUDO_DOCTORS + 1):
        pd = pd_id(i)
        utts = []
        for j in range(ENROL_N):
            s, v, o, t = picks[(i - 1) * ENROL_N + j]
            utts.append({"utterance_id": f"{pd}-E{j + 1:02d}", "text": f"{s} {v} {o} {t}."})
        pool.append({
            "pseudo_doctor_id": pd,
            "display_name": "Dr " + make_name(rng, used),
            "voice_ref": f"VOICE-{pd}",
            "voice_alike_of": partner(pd),
            "enrolment": utts,
        })
    return pool
