"""Regression pin for the 455.A note-4 fix (eta-refuter #3827 nit).

The note-4 change makes the python filter order reapable panes on the
UNROUNDED idle value (matching the jq implementation), rounding only at
output. The vendored fixture carries only clean idle values, so the
byte-identity test cannot catch a revert of the sort to the rounded value.
This test pins the fixed behavior on the exact divergence case: two panes
within 0.05 idle minutes of each other.

If this test fails, the sort in idle_reaper_filter.reapable() was reverted
to keying on the rounded idle_minutes - restore the _idle_full ordering.
"""

import json
import time
import unittest

import idle_reaper_filter as f


class Note4UnroundedOrder(unittest.TestCase):
    def test_unrounded_order_matches_jq(self):
        # 180.04 and 180.01 both display as 180.0; on the rounded value the
        # sort would tie-break alphabetically (a-agent first). The fixed
        # filter must order the LONGER idle first, like jq does.
        now = time.time()
        doc = {
            "agents": [
                {"agent": "a-agent", "pane": "w1:p1", "agent_status": "idle",
                 "last_activity": now - 180.01 * 60},
                {"agent": "b-agent", "pane": "w2:p2", "agent_status": "idle",
                 "last_activity": now - 180.04 * 60},
            ]
        }
        rows = f.reapable(json.loads(json.dumps(doc)), now, minutes=60)
        self.assertEqual([r["agent"] for r in rows], ["b-agent", "a-agent"])
        # output stays rounded per the row schema
        self.assertEqual([r["idle_minutes"] for r in rows], [180.0, 180.0])

    def test_row_schema_unchanged(self):
        # the private _idle_full ordering key must not leak into the rows
        now = time.time()
        doc = {"agents": [{"agent": "x", "pane": "w9:p9",
                           "agent_status": "idle",
                           "last_activity": now - 120 * 60}]}
        rows = f.reapable(json.loads(json.dumps(doc)), now, minutes=60)
        self.assertEqual(set(rows[0].keys()),
                         {"agent", "pane", "idle_minutes", "last_activity"})


if __name__ == "__main__":
    unittest.main()
