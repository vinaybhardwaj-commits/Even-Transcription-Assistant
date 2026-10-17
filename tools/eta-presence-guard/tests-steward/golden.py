#!/usr/bin/env python3
"""Golden vectors from the reference signer (web repo lib/steward/tickets.ts) against steward-verify.
usage: golden.py <steward-verify> <steward-sign> <public.pem> <golden dir>   (test-only; dev machine, not a kiosk)"""
import glob, hashlib, json, os, subprocess, sys
from datetime import datetime, timezone

verify, sign, pem, gdir = sys.argv[1:5]
fails, n = [], 0


def ms(iso):
    return int(datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp() * 1000)


def run(ticket, signature, machine, now_ms):
    body = json.dumps({"ok": True, "key_id": "6275a79b", "tickets": [{"ticket": ticket, "signature": signature}]}, ensure_ascii=False)
    out = subprocess.run([verify, pem, machine, str(now_ms)], input=body.encode(), stdout=subprocess.PIPE).stdout.decode().splitlines()
    return out[1].split("\t") if len(out) > 1 else out


def expect(name, cond, got=None):
    global n
    n += 1
    if not cond:
        fails.append("%s: %s" % (name, got))


for f in sorted(glob.glob(os.path.join(gdir, "0[1-5]-*.json"))):
    v = json.load(open(f))
    name = os.path.basename(f)
    canon = subprocess.run([sign, "canon"], input=json.dumps(v["ticket"], ensure_ascii=False).encode(), stdout=subprocess.PIPE).stdout
    expect(name + " canonical bytes", canon.hex() == v["canonical_utf8_hex"])
    expect(name + " canonical sha256", hashlib.sha256(canon).hexdigest() == v["canonical_sha256"])
    r = run(v["ticket"], v["signature"], v["ticket"]["machine"], ms(v["expected"]["verify_at"]))
    expect(name + " verifies at verify_at", r[:1] == ["OK"], r)
    r = run(v["ticket"], v["signature"], v["ticket"]["machine"], int(datetime.now(timezone.utc).timestamp() * 1000))
    expect(name + " is expired at the real clock", r[:2] == ["BAD", "expired"], r)

for c in json.load(open(os.path.join(gdir, "06-negatives.json"))):
    r = run(c["ticket"], c["signature"], c["verify_as_machine"], ms(c["verify_at"]))
    expect("negative '%s'" % c["name"], r[:2] == ["BAD", c["expected_reason"]], r)

print("golden: %d checks, %d failed" % (n, len(fails)))
for x in fails:
    print("FAIL", x)
sys.exit(1 if fails else 0)
