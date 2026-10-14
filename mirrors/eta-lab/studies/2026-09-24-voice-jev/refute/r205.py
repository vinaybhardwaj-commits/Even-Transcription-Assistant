"""AS vjscore: apply ruling 205 LITERALLY to the 46 held not_me answers: 'not me' = speaker is not V; counts as cannot-tell unless the
window's roster has V as the ONLY doctor present. V is on no production/PQM roster for any VP window, so all 46 -> cannot_tell (excluded)."""
import json, hashlib
rows = [json.loads(l) for l in open("/srv/vj-truth/vp_pending_notme.jsonl") if l.strip()]
out = [{**r, "r205": "cannot_tell (V not the only doctor on the roster)", "is_doctor": None, "source": "vpilot_notme_r205_excluded"} for r in rows]
b = ("\n".join(json.dumps(x, sort_keys=True) for x in out) + "\n").encode(); open("/srv/vj-truth/vp_notme_r205.jsonl", "wb").write(b)
print("held", len(rows), "-> not-doctor 0, cannot_tell", len(out), "sha12", hashlib.sha256(b).hexdigest()[:12])
