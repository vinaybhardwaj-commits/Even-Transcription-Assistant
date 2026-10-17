"""Script-level dev/test split (spec A2.1).

Split by script with the seed fixed in config.json. A script's twin, truth sheet
and metadata variants live in its own directory, so they always share a split;
matched pairs (S-D, S-A) share `split_group` and move together. Within each
stratum, dev quotas are spread over `split_cell` by largest remainder so trap
types and grid cells are represented in both splits.
"""

import random
from collections import defaultdict
from fractions import Fraction


def _cell_quotas(cells, dev_n, rng):
    total = sum(cells.values())
    exact = {c: Fraction(n * dev_n, total) for c, n in cells.items()}
    q = {c: int(v) for c, v in exact.items()}
    rest = dev_n - sum(q.values())
    order = sorted(cells, key=lambda c: (-(exact[c] - q[c]), rng.random(), c))
    for c in order[:rest]:
        q[c] += 1
    return q


def assign(scripts, dev_counts, split_seed):
    """Set script['split'] in place. Returns {stratum: {'dev': n, 'test': n}}."""
    by_stratum = defaultdict(list)
    for s in scripts:
        by_stratum[s["stratum"]].append(s)
    summary = {}
    for stratum in sorted(by_stratum):
        rng = random.Random(f"psyn-split|{split_seed}|{stratum}")
        group_cells = {}
        groups = defaultdict(list)
        for s in by_stratum[stratum]:
            groups[s["split_group"]].append(s)
            group_cells.setdefault(s["split_group"], s["split_cell"])
        cells = defaultdict(int)
        for g, members in groups.items():
            cells[group_cells[g]] += len(members)
        sizes = {len(m) for m in groups.values()}
        assert len(sizes) == 1, f"{stratum}: unequal group sizes"
        gsize = sizes.pop()
        dev_n = dev_counts[stratum]
        assert dev_n % gsize == 0, f"{stratum}: dev count must be a multiple of the group size"
        cell_groups = {c: n // gsize for c, n in cells.items()}
        quotas = _cell_quotas(cell_groups, dev_n // gsize, rng)
        for cell in sorted(cell_groups):
            gids = sorted(g for g in groups if group_cells[g] == cell)
            rng.shuffle(gids)
            for n, g in enumerate(gids):
                for s in groups[g]:
                    s["split"] = "dev" if n < quotas[cell] else "test"
        dev = sum(1 for s in by_stratum[stratum] if s["split"] == "dev")
        assert dev == dev_n, (stratum, dev, dev_n)
        summary[stratum] = {"dev": dev, "test": len(by_stratum[stratum]) - dev}
    return summary
