#!/usr/bin/env python3
# Fake herdr for racing herdr-ctl.sh's shared scratch files. No real herdr is touched.
import json, sys, time, random
a = sys.argv[1:]
sess = "default"
if a[:1] == ["--session"]:
    sess = a[1]; a = a[2:]
names = ["a%02d" % i for i in range(12)]
if a[:2] == ["agent", "list"]:
    time.sleep(random.uniform(0.0, 0.05))
    pfx = "w" if sess == "default" else "OTHER"
    agents = [{"name": n, "pane_id": f"{pfx}{i}:p1", "agent_status": "idle",
               "cwd": "/tmp", "agent_session": {"value": f"{sess}-sid-{i}"}} for i, n in enumerate(names)]
    out = json.dumps({"result": {"agents": agents}})
    # write in two chunks to widen the truncate/partial-read window like a real pipe
    sys.stdout.write(out[: len(out)//2]); sys.stdout.flush(); time.sleep(0.02); sys.stdout.write(out[len(out)//2:])
elif a[:2] == ["pane", "read"]:
    print("  auto mode on · ← for agents")
elif a[:2] == ["pane", "process-info"]:
    print(json.dumps({"result": {"process_info": {"foreground_processes": [{"pid": 1, "cmdline": "claude --resume x"}], "foreground_process_group_id": 1}}}))
else:
    print(json.dumps({"result": {}}))
