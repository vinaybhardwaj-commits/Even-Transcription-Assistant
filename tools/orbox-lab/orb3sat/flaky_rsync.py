#!/usr/bin/env python3
"""Fails the first 3 calls (rc 23), counts every call in $FLAKY_COUNT, then runs the real rsync."""
import os, sys
c = os.environ["FLAKY_COUNT"]; n = (int(open(c).read()) if os.path.exists(c) else 0) + 1
open(c, "w").write(str(n))
if n <= 3: sys.exit(23)
os.execvp("rsync", ["rsync"] + sys.argv[1:])
