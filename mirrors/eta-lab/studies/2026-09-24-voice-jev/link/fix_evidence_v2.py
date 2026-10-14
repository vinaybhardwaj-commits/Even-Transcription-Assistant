#!/usr/bin/env python3
"""vj-link: batch-1 evidence text v2 (vj-refuter E1-E4, refute/23). IDs, clips and tiers unchanged; only `evidence` changes, UNIFORMLY on all cards (nothing tier-specific, so the text leaks no tier):
 E1  the Jev line is dropped (Jev calls any recurring voice the doctor; report field only).
 E2  a voice-timing gap under 15 points is said plainly: no timing difference.
 E3  one line on every card: the doctor is proposed from queue timing, which is only weakly reliable (a shifted-time control finds similar pairings).
 E4  one line on every card: what production's own voice matcher says about THIS voice (share of its turns labelled 'clinician' in that room-day, and whether production names a clinician for the room-day).
Reads the tier key only to map card -> (room-day, voice); does not write it.  Usage: fix_evidence_v2.py   (box)"""
import json, os, re, subprocess
BOX = os.path.expanduser("~/eta-data/voice-linkage"); NAME = os.environ.get("BATCH", "batch1"); B = f"{BOX}/{NAME}"; K = json.load(open(f"{BOX}/{NAME}-key/key.json")); D = f"{BOX}/{os.environ.get('TREE', 'dtree')}"
HELPER = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")
def neon(sql):
    r = subprocess.run(["node", HELPER, sql], cwd=REPO, capture_output=True, text=True, timeout=300)
    if r.returncode: raise SystemExit("neon-select failed: " + r.stderr[:200])
    return json.loads(r.stdout)
rts = {}
def role_map(rd):
    if rd not in rts:
        rows = neon(f"SELECT source_ref, role, clinician_id FROM room_turn_speaker WHERE room_day_id='{rd}'")
        rts[rd] = {r["source_ref"]: r for r in rows}
    return rts[rd]
n = 0
for k in K:
    if not k.get("card_id") or k.get("kind") == "pair": continue
    cf = f"{B}/links/{k['card_id']}.json"; card = json.load(open(cf)); rd = k["rep"][0]; c = str(k["rep"][1])
    L = json.load(open(f"{D}/link-{rd}.json")); T = json.load(open(f"{D}/turns-{rd}.json"))["turns"]; core = L["core_turn_idx"][c]
    rm = role_map(rd); labelled = [rm.get(T[i]["source_ref"]) for i in core]; labelled = [x for x in labelled if x]
    clin = sum(1 for x in labelled if x["role"] == "clinician")
    docs = {x["clinician_id"] for x in rm.values() if x["role"] == "clinician" and x["clinician_id"]}
    ev = [e for e in card["evidence"] if not e.startswith("Jev")]                                   # E1
    rxf = f"{D}/rx-{L['date']}.json"
    if os.path.exists(rxf) and os.path.getsize(rxf) <= 5:   # no production transcript on this day: the Rx step could not run
        ev = [("Prescriptions: not checked, because there is no transcript for this day." if e.startswith("Prescriptions") else e) for e in ev]
    for i, e in enumerate(ev):                                                                        # E2
        m = re.match(r"Voice timing: this voice is heard in (\d+)% of the busy minutes when the doctor is in a queue consult, and in (\d+)% of the busy minutes when they are not", e)
        if m and abs(int(m.group(1)) - int(m.group(2))) < 15:
            ev[i] = f"Voice timing: no clear timing difference: this voice is heard in {m.group(1)}% of the busy minutes when the doctor is in a queue consult and in {m.group(2)}% when they are not."
    ev = [e for e in ev if not e.startswith(("The doctor is proposed from", "Production's own voice matcher"))]
    ev.append("The doctor is proposed from queue timing, which is only weakly reliable: a control with the doctors' times shifted to the wrong hours finds pairings like this one just as often.")           # E3 (uniform)
    if not labelled: ev.append("Production's own voice matcher has no label for this voice's turns in this room-day.")                 # E4 (uniform)
    else: ev.append(f"Production's own voice matcher labels {round(100 * clin / len(labelled))}% of this voice's turns as a clinician" + (f", and it names {len(docs)} clinician{'s' if len(docs) != 1 else ''} in this room-day." if docs else " (it names no clinician in this room-day)."))
    card["evidence"] = ev; json.dump(card, open(cf, "w"), indent=1); n += 1
print("evidence v2 written on", n, "link cards")
