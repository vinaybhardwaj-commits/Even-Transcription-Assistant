"""One module per P-SYN stratum (spec A2.1). Counts are fixed per module."""

from . import s_a, s_c, s_d, s_e, s_m, s_n, s_r, s_v

MODULES = (s_e, s_n, s_c, s_r, s_d, s_a, s_v, s_m)
EXPECTED_COUNTS = {"S-E": 54, "S-N": 54, "S-C": 12, "S-R": 30, "S-D": 20, "S-A": 10, "S-V": 54, "S-M": 18}
TOTAL = 252
