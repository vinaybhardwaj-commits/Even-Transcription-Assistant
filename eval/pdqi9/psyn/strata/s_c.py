"""S-C (12): clean consult and clean twin; false-low baseline."""

from ..core import base_consult
from .common import new_builder, scenario, standard_roster, wrong_doctor

STRATUM, PREFIX, N = "S-C", "SC", 12


def generate(seed, pool):
    out = []
    for i in range(N):
        sb = new_builder(PREFIX, i, STRATUM, seed, pool)
        sb.split_cell = sb.lang_mode
        sc = scenario(sb, i)
        D, P, pd = standard_roster(sb)
        base_consult(sb, sc, doctor=D, patient=P)
        sb.pdqi = {"rubric": "all", "defect_in": None, "target_item": None, "planted_level": 5,
                   "defect_code": None, "off_target": "clean_baseline"}
        sb.tag("clean_control")
        out.append(sb.finish({"wrong_doctor": wrong_doctor(sb, pd)}))
    return out
