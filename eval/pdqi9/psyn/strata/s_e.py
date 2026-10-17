"""S-E (54): 9 PDQI items x 3 levels (1/3/5) x 2 language modes; defect in the consult."""

from ..core import base_consult
from .common import LEVELS, PDQI_ITEMS, new_builder, scenario, standard_roster, wrong_doctor

STRATUM, PREFIX, N = "S-E", "SE", 54

# Consult defects per item and level; level 5 is clean.
DEFECTS = {
    "up_to_date": {3: {"outdated": 1}, 1: {"outdated": 2}},
    "accurate": {3: {"misstatements": 1}, 1: {"misstatements": 2}},
    "thorough": {3: {"omit_exam": True}, 1: {"omit_exam": True, "omit_history": True, "omit_counselling": True}},
    "useful": {3: {"digressions": 1}, 1: {"digressions": 3}},
    "organized": {3: {"disorder": 1}, 1: {"disorder": 2}},
    "comprehensible": {3: {"jargon": True}, 1: {"jargon": True, "abbreviate": True}},
    "succinct": {3: {"repeat_plan": 1}, 1: {"repeat_plan": 3}},
    "synthesized": {3: {"no_reasoning": True}, 1: {"no_assessment": True}},
    "internally_consistent": {3: {"contradictions": 1}, 1: {"contradictions": 2}},
}


def grid():
    for ii, item in enumerate(PDQI_ITEMS):
        for level in LEVELS:
            for mode in ("en", "cs"):
                yield item, level, mode, ("hi" if ii % 2 == 0 else "kn")


def generate(seed, pool):
    out = []
    for i, (item, level, mode, cs) in enumerate(grid()):
        sb = new_builder(PREFIX, i, STRATUM, seed, pool, mode, cs)
        sb.split_cell = f"{item}|{mode}"
        sc = scenario(sb, i)
        D, P, pd = standard_roster(sb)
        opts = DEFECTS[item].get(level, {})
        base_consult(sb, sc, doctor=D, patient=P, opts=opts)
        sb.pdqi = {"rubric": "pdqi9-encounter", "defect_in": "consult", "target_item": item,
                   "planted_level": level, "defect_code": sorted(opts) or None, "off_target": "clean_baseline"}
        sb.tag(f"pdqi:{item}:L{level}")
        out.append(sb.finish({"wrong_doctor": wrong_doctor(sb, pd)}))
    assert len(out) == N
    return out
