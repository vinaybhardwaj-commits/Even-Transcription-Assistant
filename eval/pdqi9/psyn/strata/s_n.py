"""S-N (54): same 9 x 3 x 2 grid; consult clean, defect in the code-built note twin (twin.py)."""

from ..core import base_consult
from .common import new_builder, scenario, standard_roster, wrong_doctor
from .s_e import grid

STRATUM, PREFIX, N = "S-N", "SN", 54


def generate(seed, pool):
    out = []
    for i, (item, level, mode, cs) in enumerate(grid()):
        sb = new_builder(PREFIX, i, STRATUM, seed, pool, mode, cs)
        sb.split_cell = f"{item}|{mode}"
        sc = scenario(sb, i)
        D, P, pd = standard_roster(sb)
        base_consult(sb, sc, doctor=D, patient=P)
        sb.pdqi = {"rubric": "pdqi9-note@2", "defect_in": "twin", "target_item": item,
                   "planted_level": level, "defect_code": None if level == 5 else [f"note_{item}_L{level}"],
                   "off_target": "clean_baseline"}
        sb.tag(f"pdqi:{item}:L{level}")
        out.append(sb.finish({"wrong_doctor": wrong_doctor(sb, pd)}))
    assert len(out) == N
    return out
