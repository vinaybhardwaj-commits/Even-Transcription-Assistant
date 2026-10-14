#!/usr/bin/env python3
"""diagrig: generate | inject | score | run | proof | budget.
  diagrig generate --suite nightly --tts fake|google|elevenlabs --out DIR [--cache DIR]
  diagrig inject   --suite-dir DIR --machine NAME --stt-url URL [--diarize-url URL] --out DIR
  diagrig score    --suite-dir DIR --results DIR --machine NAME [--target-sha S] [--json F]
  diagrig run      (generate + inject + score; lands under ~/eta-data/diag-rig/runs/<UTC>-<machine>/ 0700)
  diagrig proof    (ffmpeg timing proof, tone at t=100 s, +-50 ms)
Never runs on the production Mini before refuter PASS + Fable's word; schedule (nightly 23:30 IST, never clinic hours) is set by
the operator, not this file. Digital path only here; the acoustic runner is a later stage."""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate  # noqa: E402
import inject    # noqa: E402
import score     # noqa: E402

ROOT = os.path.expanduser("~/eta-data/diag-rig")
CANARY_WORD = "supercalifragilisticexpialidocious"


def cmd_generate(a):
    m = generate.build_suite(a.suite, a.out, a.tts, a.cache or os.path.join(ROOT, "tts-cache"))
    print(json.dumps({k: m[k] for k in ("suite", "tts_mode", "chars_used", "manifest_sha256", "phraseset_sha")} | {"n": len(m["items"])}))


def cmd_inject(a):
    if a.router_local:
        ps = inject.inject_router_local(a.suite_dir, a.out, a.router_local, a.only, machine=a.machine, shadow_sravaani=a.shadow_sravaani)
        print("injected", len(ps), "via local router", a.router_local)
        return
    ps = inject.inject_suite(a.suite_dir, a.out, a.machine, a.stt_url, a.diarize_url, a.only)
    print("injected", len(ps))


def cmd_score(a):
    rep = score.build_report(a.suite_dir, a.results, a.machine, a.target_sha)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(rep, f, indent=1)
        os.chmod(a.json, 0o600)
    print(score.report_md(rep))


def ist_hour(now=None):
    t = time.gmtime((now if now is not None else time.time()) + 5.5 * 3600)
    return t.tm_hour + t.tm_min / 60


def nightly_ok(now=None):
    """--nightly runs only after clinic close: 23:00-06:00 IST (schedule is 23:30). Manual runs are not gated by this."""
    h = ist_hour(now)
    return h >= 23 or h < 6


def cmd_run(a):
    if a.nightly and not nightly_ok():
        sys.exit("--nightly refused: outside 23:00-06:00 IST (never during clinic hours)")
    run = os.path.join(ROOT, "runs", time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + a.machine)
    os.makedirs(run, mode=0o700)
    os.environ.setdefault("DIAGRIG_EL_V3_LANGS", "kn,te")      # eleven_v3 for kn/te (SraVaani read it 26-27 Sep); cache makes repeat runs free
    generate.build_suite(a.suite, os.path.join(run, "stimuli"), a.tts, a.cache or os.path.join(ROOT, "tts-cache"))
    if a.router_local:
        inject.inject_router_local(os.path.join(run, "stimuli"), os.path.join(run, "results"), a.router_local, machine=a.machine, shadow_sravaani=a.shadow_sravaani)
    else:
        inject.inject_suite(os.path.join(run, "stimuli"), os.path.join(run, "results"), a.machine, a.stt_url, a.diarize_url)
    rep = score.build_report(os.path.join(run, "stimuli"), os.path.join(run, "results"), a.machine, a.target_sha)
    rp = os.path.join(run, "report.json")
    with open(rp, "w") as f:
        json.dump(rep, f, indent=1)
    os.chmod(rp, 0o600)
    print(score.report_md(rep))
    print("run dir:", run)


def cmd_budget(a):
    """Local ledger only (no network): characters spent so far across backends against the 60,000 first-run cap."""
    import tts
    cache = a.cache or os.path.join(ROOT, "tts-cache")
    p = os.path.join(cache, "chars-total.json")
    import wavio
    used = wavio.jload(p)["chars"] if os.path.exists(p) else 0
    print(json.dumps(dict(chars_used=used, cap=tts.BUDGET_CHARS, left=tts.BUDGET_CHARS - used, suite_cost_chars=__import__("phrases").total_chars())))


def cmd_voices(a):
    """google: READ-ONLY voices:list for the five language codes (no synthesis). elevenlabs: prints the fixed premade ids from code, NO network."""
    import urllib.request, subprocess, tts
    if a.vendor == "google":
        tok = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, check=True).stdout.strip()
        for lc in sorted(tts.GOOGLE_LANGCODE.values()):
            req = urllib.request.Request("https://texttospeech.googleapis.com/v1/voices?languageCode=" + lc, headers={"Authorization": "Bearer " + tok})
            with urllib.request.urlopen(req, timeout=60) as r:
                names = sorted(v["name"] for v in json.loads(r.read()).get("voices", []))
            print(lc, len(names), " ".join(names))
    else:
        # No network: the ElevenLabs key lacks voices_read/user_read (401), so ids are fixed in tts.VOICES and quota is the local ledger.
        for lang, m in sorted(tts.VOICES["elevenlabs"].items()):
            print(lang, " ".join("%s=%s" % kv for kv in sorted(m.items())), "model", tts.el_model(lang))


def cmd_proof(a):
    os.makedirs(a.out, mode=0o700, exist_ok=True)
    r = inject.timing_proof(a.out)
    print(json.dumps(r))
    sys.exit(0 if r["pass_"] else 1)


def main(argv=None):
    p = argparse.ArgumentParser(prog="diagrig")
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate"); g.add_argument("--suite", default="nightly"); g.add_argument("--tts", default="fake", choices=["fake", "google", "elevenlabs"])
    g.add_argument("--out", required=True); g.add_argument("--cache"); g.set_defaults(f=cmd_generate)
    i = sub.add_parser("inject"); i.add_argument("--suite-dir", required=True); i.add_argument("--machine", default="box")
    i.add_argument("--stt-url"); i.add_argument("--diarize-url"); i.add_argument("--only"); i.add_argument("--shadow-sravaani", help="SraVaani /inference URL for the shadow column (loopback)"); i.add_argument("--router-local", help="loopback router URL, e.g. http://127.0.0.1:8083 (box twin): production-shape /route/job via the pinned harness node_route.py"); i.add_argument("--out", required=True); i.set_defaults(f=cmd_inject)
    s = sub.add_parser("score"); s.add_argument("--suite-dir", required=True); s.add_argument("--results", required=True); s.add_argument("--machine", required=True)
    s.add_argument("--target-sha"); s.add_argument("--json"); s.set_defaults(f=cmd_score)
    r = sub.add_parser("run"); r.add_argument("--suite", default="nightly"); r.add_argument("--router-local"); r.add_argument("--shadow-sravaani"); r.add_argument("--tts", default="elevenlabs", choices=["fake", "google", "elevenlabs"])
    r.add_argument("--machine", required=True); r.add_argument("--stt-url"); r.add_argument("--diarize-url"); r.add_argument("--target-sha"); r.add_argument("--cache"); r.add_argument("--nightly", action="store_true"); r.set_defaults(f=cmd_run)
    b = sub.add_parser("budget"); b.add_argument("--cache"); b.set_defaults(f=cmd_budget)
    v = sub.add_parser("voices"); v.add_argument("vendor", choices=["google", "elevenlabs"]); v.set_defaults(f=cmd_voices)
    q = sub.add_parser("proof"); q.add_argument("--out", required=True); q.set_defaults(f=cmd_proof)
    a = p.parse_args(argv)
    a.f(a)


if __name__ == "__main__":
    main()
