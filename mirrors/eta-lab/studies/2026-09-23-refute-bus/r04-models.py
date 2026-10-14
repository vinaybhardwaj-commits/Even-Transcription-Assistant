import json, glob, os, collections
sessions = {
 "eta-refuter":"e5d1ef49-11d1-4be8-b60e-e84c4013a41b","fleet":"51df0efe-55e7-4a7a-afae-f4a920a646e6",
 "lx":"59f6f674-d26e-4e34-b26b-4f8b0afaf2a3","scribe":"decbfc3a-582a-43f0-9cce-c6d195def34e",
 "scribe3":"aef14449-cd2b-4a1a-a38e-fbf4658ec178","split-speaker":"2f5b94c5-8b78-4006-9ea0-0a11a0163b0c",
 "yoga-drain":"e1b3dec9-64dc-45a8-ad34-919cb26e081b","minibot":"b015950d-b85b-4027-9cf6-127fb31c0e1a",
 "minibot-2":"3290ce50-1144-4b87-81c3-283aa8f79caa","refuter-gate":"cd27eb2f-cba4-4792-814b-0898515e0165",
 "eta-assistant":"7b267c55-9d09-4574-8781-946206d65db7"}
home=os.path.expanduser("~")
for name,sid in sessions.items():
    fs=glob.glob(f"{home}/.claude/projects/*/{sid}.jsonl")
    if not fs: print(name,"NOFILE"); continue
    last=[]; perm=None
    for line in open(fs[0],encoding="utf-8",errors="replace"):
        try: o=json.loads(line)
        except Exception: continue
        if o.get("type")=="assistant":
            m=(o.get("message") or {}).get("model")
            if m: last.append((o.get("timestamp",""),m))
        if "permissionMode" in o: perm=o.get("permissionMode")
    tail=last[-1] if last else None
    before=[x for x in last if x[0] < "2026-09-23T04:43:26"]  # 10:13:26 IST = 04:43:26Z
    after=[x for x in last if x[0] >= "2026-09-23T04:43:26"]
    print(f"{name:14s} last={tail} before10:13={collections.Counter(m for _,m in before[-20:]).most_common(2)} after={collections.Counter(m for _,m in after).most_common(3)} permMode={perm}")
