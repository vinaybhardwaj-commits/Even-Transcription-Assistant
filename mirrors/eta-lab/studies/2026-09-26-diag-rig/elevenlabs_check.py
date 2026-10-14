#!/usr/bin/env python3
"""DIAG-RIG helper: ElevenLabs read-only checks. The API key is read from
~/.claude/secrets/elevenlabs_key INSIDE this process only - never printed,
never on argv, never copied. Prints quota/usage numbers only (428b).
Subcommands: subscription | voices | doclang (doclang fetches the models doc
pages and greps language support)."""
import json, sys, urllib.request, os

KEY_PATH = os.path.expanduser("~/.claude/secrets/elevenlabs_key")


def hdr():
    try:
        raw = open(KEY_PATH).read().strip()
    except FileNotFoundError:
        sys.exit("KEY ABSENT: %s does not exist (V may not have saved it yet)" % KEY_PATH)
    except PermissionError:
        sys.exit("KEY UNREADABLE by this user (mode?): check with ls -l from an allowed pane")
    if not raw:
        sys.exit("KEY EMPTY")
    if raw[0] in "\"'" and raw[-1] in "\"'" and len(raw) > 2:
        raw = raw[1:-1].strip()
    return {"xi-api-key": raw}


def diag():
    st = os.stat(KEY_PATH)
    s = open(KEY_PATH, "r", errors="replace").read()
    t = s.strip()
    q = t and (t[0] in "\"'") and (t[-1] in "\"'") and len(t) > 2
    body = t[1:-1] if q else t
    print("size:", st.st_size, "mode:", oct(st.st_mode & 0o777), "len_stripped:", len(t), "len_unwrapped:", len(body))
    print("quote_wrapped:", bool(q), "| has_space:", " " in body, "| sk_prefix:", body.startswith("sk_"))
    print("alnum_underscore_share:", round(sum(c.isalnum() or c == "_" for c in body) / max(len(body), 1), 3))
    return 0


def models():
    d = get("https://api.elevenlabs.io/v1/models")
    rows = []
    for m in d:
        langs = m.get("description", "")
        name = m.get("model_id", "?")
        rows.append((name, m.get("name", ""), len(langs)))
        print(name, "|", m.get("name", ""), "| desc_len", len(langs))
    return rows


def get(url):
    req = urllib.request.Request(url, headers=hdr())
    return json.load(urllib.request.urlopen(req, timeout=25))


def subscription():
    d = get("https://api.elevenlabs.io/v1/user/subscription")
    for k in ("tier", "character_count", "character_limit", "next_character_count_reset_unix", "status"):
        print(k, "=", d.get(k))
    return d


def voices():
    d = get("https://api.elevenlabs.io/v1/voices?page_size=100")
    out = []
    for v in d.get("voices", []):
        labels = v.get("labels") or {}
        out.append((v["voice_id"], v.get("name"), labels.get("language"), labels.get("accent")))
    print("voices:", len(out))
    for r in sorted(out, key=lambda x: x[0])[:60]:
        print(r)
    return out


def doclang():
    for url in ("https://elevenlabs.io/docs/capabilities/text-to-speech",):
        req = urllib.request.Request(url, headers={"User-Agent": "diag-rig-inventory/0"})
        body = urllib.request.urlopen(req, timeout=25).read().decode("utf-8", "replace")
        low = body.lower()
        for lang in ("hindi", "kannada", "telugu", "tamil", "english", "multilingual"):
            print(lang, "mentioned" if lang in low else "NOT-MENTIONED")
    return 0


if __name__ == "__main__":
    {"subscription": subscription, "voices": voices, "doclang": doclang, "diag": diag, "models": models}[sys.argv[1]]()
