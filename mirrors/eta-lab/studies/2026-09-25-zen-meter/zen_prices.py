#!/usr/bin/env python3
"""zen_prices.py — writes board/ZEN-PRICES.md from OpenCode's local model catalogue (provider `opencode` = Zen), plus the access results in access.json.
Prices are USD per 1M tokens. Cross-checked 25 Sep against https://opencode.ai/docs/zen/ (its sample rows match the catalogue exactly; the docs page lists only a sample, so the full table is the catalogue's).
Zen bills tokens x these prices; it returns token counts only, no cost field. Usage: zen_prices.py [OUT.md] [CATALOGUE.json] [ACCESS.json]"""
import datetime as dt, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def num(x):
    return "" if x is None else ("%g" % x)


def rows(catalogue):
    z = catalogue["opencode"]["models"]; out = []
    for mid, v in z.items():
        c = v.get("cost") or {}; lim = v.get("limit") or {}
        free = c.get("input", 0) == 0 and c.get("output", 0) == 0
        tier = ""
        if c.get("tiers"):
            t = c["tiers"][0]; tier = "over %dK ctx: %s in / %s out" % (t["tier"]["size"] // 1000, num(t.get("input")), num(t.get("output")))
        out.append({"id": mid, "name": v.get("name", mid), "in": c.get("input"), "out": c.get("output"), "cr": c.get("cache_read"), "cw": c.get("cache_write"), "ctx": lim.get("context"), "free": free, "tier": tier,
                    "proto": (v.get("provider") or {}).get("npm", "openai-compatible").replace("@ai-sdk/", "")})
    return sorted(out, key=lambda r: (not r["free"], r["out"] or 0, r["id"]))


def render(catalogue, access, now):
    rs = rows(catalogue)
    L = ["# Zen prices (USD per 1M tokens)", "",
         "Generated %s IST by `studies/2026-09-25-zen-meter/zen_prices.py` from OpenCode's model catalogue (provider `opencode`, %d models). Cross-checked against https://opencode.ai/docs/zen/ on 25 Sep 2026: the docs' sample rows (GPT 6 Astra, Claude Opus 5.5, Claude Sonnet 5, Gemini 3.8 Flash, DeepSeek V4 Flash) match the catalogue exactly; the docs list only a sample, so the rest is the catalogue's word." % (now.astimezone(dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M"), len(rs)), "",
         "**Cost = tokens x price.** Zen replies carry token counts only (no cost field, no balance header), so every dollar figure in the spend meter is COMPUTED; the Zen console balance is the only ground truth. Top-up fee per the docs: 4.4% + $0.30 per transaction, passed on at cost (record the credit actually added). The docs also say auto-reload recharges $20 when the balance falls below $5, which V can customise or disable (r407: no auto-recharge).", "",
         "Free models (`*free`, big-pickle): non-patient work only (ZDR may not cover them; r407a).", "",
         "## Access on V's account (measured)", "", "| model | status | detail | via |", "|---|---|---|---|"]
    L += ["| %s | **%s** | %s | %s |" % (k, v["status"], v["detail"], v["via"]) for k, v in access.items() if not k.startswith("_")]
    L += ["", access.get("_note", ""), "", "## All models, free first then by output price", "",
          "| model | in | out | cache read | cache write | context | protocol | tier / note |", "|---|---|---|---|---|---|---|---|"]
    for r in rs:
        L.append("| %s%s | %s | %s | %s | %s | %s | %s | %s |" % (r["id"], " (free)" if r["free"] else "", num(r["in"]), num(r["out"]), num(r["cr"]), num(r["cw"]), ("%dK" % (r["ctx"] // 1000)) if r["ctx"] else "", r["proto"], r["tier"]))
    return "\n".join(L) + "\n"


def main(argv):
    out = argv[1] if len(argv) > 1 else os.path.join(HERE, "..", "..", "board", "ZEN-PRICES.md")
    cat = json.load(open(argv[2] if len(argv) > 2 else os.path.expanduser("~/.cache/opencode/models.json")))
    acc = json.load(open(argv[3] if len(argv) > 3 else os.path.join(HERE, "access.json")))
    open(out, "w").write(render(cat, acc, dt.datetime.now(dt.timezone.utc))); print("wrote", out); return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
