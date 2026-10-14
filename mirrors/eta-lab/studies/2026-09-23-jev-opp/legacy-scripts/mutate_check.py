#!/usr/bin/env python3
import subprocess, sys, os

PATH = "/Users/vinaybhardwaj/dev/eta-qwen-out-wt/lib/note-generation.ts"
MARK = "\n// MUTATION-CHECK: qwen2.5 reintroduced on purpose\n"

with open(PATH, "r", encoding="utf-8") as f:
    original = f.read()

with open(PATH, "w", encoding="utf-8") as f:
    f.write(original + MARK)

env = dict(os.environ)
env["PATH"] = "/opt/homebrew/bin:" + env.get("PATH", "/usr/bin:/bin")

try:
    r = subprocess.run(
        ["/opt/homebrew/bin/npx", "vitest", "run", "tests/unit/qwen-out-guard.test.ts"],
        cwd="/Users/vinaybhardwaj/dev/eta-qwen-out-wt",
        capture_output=True, text=True, timeout=90, env=env,
    )
    print("EXIT CODE:", r.returncode)
    print(r.stdout[-3000:])
    print(r.stderr[-2000:])
finally:
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(original)
    print("REVERTED")
