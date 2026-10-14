"""link3_nameleak.py: the name-leak check harness for the link-3 TRANSLATED stratum (linker #1100 piece B, ruling 211a).

After machine translation and de-identification, humans count the personal names still readable in the turns. Under v7.15a the draw is a FULL
READ (--n = the eligible count; the seed then chooses nothing); the original protocol drew 20 turns (seeds 27 and 28). ANY miss fails the gate: fix
the redactor, regenerate deid.json, then re-read the FULL eligible set of the new file (v7.15a N2 step 4; no seed-28 sample), with a new draw into
a NEW out dir and both readers locking fresh counts. This file draws the turns, writes the review sheet and, once the humans have filled in counts,
summarises them and compares the two readers' counts.

  python3 link3_nameleak.py draw    [--seed 27] [--n 20] [--mt-dir D] [--out-dir D]
  python3 link3_nameleak.py summary --draw DRAW.json --counts COUNTS.json --second COUNTS2.json --second-sha256 HEX [--out SUMMARY.json]

INPUT (box only, never git; frozen by linker #1100). mt/translated.json: list of {item, room, i, lang, en, q, dropped}. mt/deid.json: the same
records plus en_deid. The mt dir defaults to ~/eta-data/surgical-chain/p1/mt/ (or $ETA_MT_DIR, or --mt-dir).

DRAW. Eligible turns = records with q == "ok" whose `dropped` is not true, in stable (item, room, i) order, BEFORE any random choice, so the draw depends on
the seed and the set of turns and never on file order. The choice is a partial Fisher-Yates over random.Random(seed).random(): its stream is
the same on every Python 3 version, where random.sample / shuffle have changed. Chosen turns are written in (item, room, i) order.
  * q must be exactly "ok" (linker #1122): the order is translate, de-id, name-leak, screen, so `dropped` is not set yet, and a garbled or
    untranslatable turn would take a slot of the 20 that piece C drops anyway. A missing or unknown q is NOT eligible (as in piece C: unflagged).
  * A record with no `dropped` key counts as ELIGIBLE. `dropped` is set by piece C, which runs after this check, so at draw time it is usually
    absent. draw.json records the eligible count and a sha256 of the eligible keys, so a later re-draw over a file C has since marked is visible.
  * translated.json and deid.json must agree: same keys, and `en` identical (de-id must not touch the translation the human compares against).
  * Fewer than --n eligible turns is a weak gate: exit 3 (nothing written) unless --allow-short.

OUTPUT (all box only, 0600 files in a 0700 dir; default <mt-dir>/nameleak-seed<seed>/):
  draw.json            seed, n, eligible count + sha256, sha256 of both input files, the chosen turn keys "item|room|i"
  review_sheet.txt     en beside en_deid, one block per turn
  counts_template.json {turn_key: null}. The human replaces each null with the number of names still readable in the en_deid column.
STDOUT carries counts and turn keys (ids) only. No transcript text reaches stdout, stderr, logs or git. EVERY write is refused inside a git work tree
(refuter-2 #1219 F-B2; there is no override flag), and if git cannot be asked the answer is "inside" (fail closed).

SUMMARY. BOTH readers are mandatory (v7.15 M4.3; refuter-2 #1219 F-B1). Each counts file must hold EXACTLY the drawn keys, each a non-negative int.
A missing key or a null is "never looked", not "zero": the run stops with exit 2. --second-sha256 must equal the sha256 of the second reader's
counts file as that reader posted it on the bus BEFORE any summary was made; without that pin nothing proves the second labels were locked first and
the independent check would be optional. Reports per-turn counts, the total, per-turn agree/disagree between the two readers and both totals. The summary carries
deid_sha256 / translated_sha256 / eligible_sha256 copied from draw.json, so a gate can check that the counts were made on the deid.json it is
about to score (a re-de-identified file changes the hash).
EXIT  0 = no name missed by either reader | 1 = GATE FAILED (a total is > 0 in either file) | 2 = bad or incomplete input, a wrong --second-sha256,
or a write refused inside a git work tree | 3 = draw too short.
"""
import argparse, hashlib, itertools, json, os, random, re, subprocess, sys, textwrap

DEFAULT_MT = os.path.expanduser("~/eta-data/surgical-chain/p1/mt/")
COL = 58
# The reviewer's instruction, QUOTED from the frozen texts and never paraphrased (refuter-2 #1375: an earlier sheet carried a role list,
# "(patient, relative, doctor, staff)", that no pre-registration contained, and two readers counted differently under it).
# Line 1: a quoted FRAGMENT of v7.15a N2 step 2 (the words inside the quotation marks are verbatim; the lead-in is this tool's). Lines 2-3: v7.15b R2 (P1-PREREG-v7.15b.md, caccf9a), which requires the re-read sheet to quote its definition VERBATIM.
# If any of these texts is amended, change the lines to the new wording verbatim (a new dated version).
FROZEN_DEFINITION = (
    'What to write for each turn, in the frozen wording: "counts of missed names per turn, missed transliterated names included".   [v7.15a N2 step 2]',
    "From the re-read onward, a name is any readable name of a person, whatever the role: patient, relative, doctor, staff, any other individual, "
    "and a public figure.   [v7.15b R2]",
    "A brand, a place, a drug, a day or a month is not a person's name. A garbled token that does not function as a name in its context is not "
    "counted, and is listed by turn key in the reader's notes.   [v7.15b R2]",
)


class InputError(Exception):
    """Raised with a COUNT-ONLY message; never with record content."""


class GitTreeError(InputError):
    """A write was refused because its target is inside a git work tree."""


def inside_git(path):
    """True if `path` (which need not exist yet) lies inside a git work tree. FAIL CLOSED: if git cannot be asked, or answers anything but a clean
    'not a git repository', the answer is True. A `.git` entry (directory or worktree file) in any ancestor also counts, independent of git itself."""
    probe = os.path.dirname(os.path.abspath(path))
    while not os.path.isdir(probe):                       # git errors on a directory that does not exist yet, which would read as "not in git"
        parent = os.path.dirname(probe)
        if parent == probe:
            return True
        probe = parent
    d = probe
    while True:
        if os.path.lexists(os.path.join(d, ".git")):
            return True
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    try:
        r = subprocess.run(["git", "-C", probe, "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True,
                           env=dict(os.environ, LC_ALL="C", LANG="C"))
    except OSError:
        return True
    if r.returncode == 0:
        return r.stdout.strip() == "true"
    return "not a git repository" not in r.stderr


def refuse_in_git(path):
    if inside_git(path):
        raise GitTreeError("refusing to write inside a git work tree (these files hold real text or labels); choose a box path outside every repo")


def turn_key(r):
    return f"{r['item']}|{r['room']}|{r['i']}"


def sort_key(r):
    return (r["item"], r["room"], r["i"])


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_records(path, need_deid):
    """Read and validate a records file. Every complaint is a count, never a value."""
    try:
        with open(path) as f:
            recs = json.load(f)
    except (OSError, ValueError) as e:
        raise InputError(f"{os.path.basename(path)}: unreadable ({type(e).__name__})")
    if not isinstance(recs, list):
        raise InputError(f"{os.path.basename(path)}: not a list")
    bad = 0
    for r in recs:
        ok = (isinstance(r, dict) and isinstance(r.get("item"), str) and isinstance(r.get("room"), str)
              and isinstance(r.get("i"), int) and not isinstance(r.get("i"), bool) and isinstance(r.get("en"), str)
              and (not need_deid or isinstance(r.get("en_deid"), str))
              and ("dropped" not in r or isinstance(r["dropped"], bool)))
        bad += not ok
    if bad:
        raise InputError(f"{os.path.basename(path)}: {bad} of {len(recs)} records missing or mistyping item/room/i/en"
                         + ("/en_deid" if need_deid else "") + " or with a non-bool dropped")
    keys = [turn_key(r) for r in recs]
    dup = len(keys) - len(set(keys))
    if dup:
        raise InputError(f"{os.path.basename(path)}: {dup} duplicate (item, room, i) keys")
    return recs


def cross_check(translated, deid):
    """deid.json must be translated.json plus en_deid: same keys, same `en`."""
    t = {turn_key(r): r["en"] for r in translated}
    d = {turn_key(r): r["en"] for r in deid}
    only_t, only_d = len(t.keys() - d.keys()), len(d.keys() - t.keys())
    changed = sum(1 for k in t.keys() & d.keys() if t[k] != d[k])
    if only_t or only_d or changed:
        raise InputError(f"translated.json vs deid.json disagree: {only_t} keys only in translated, {only_d} only in deid, "
                         f"{changed} with a different `en`")


def eligible(deid):
    """Records with q == "ok" that are not dropped, in stable (item, room, i) order. A missing `dropped` is eligible (see the docstring)."""
    return sorted((r for r in deid if r.get("q") == "ok" and r.get("dropped") is not True), key=sort_key)


def pick(pool, n, seed):
    """Partial Fisher-Yates over random.Random(seed).random(). `pool` must already be in stable order. Returns the chosen records in (item, room, i) order."""
    rng = random.Random(seed)
    pool = list(pool)
    n = min(n, len(pool))
    for j in range(n):
        k = j + int(rng.random() * (len(pool) - j))
        pool[j], pool[k] = pool[k], pool[j]
    return sorted(pool[:n], key=sort_key)


def keys_sha(keys):
    return hashlib.sha256("\n".join(keys).encode()).hexdigest()


def sheet(chosen, header):
    """en beside en_deid, wrapped to COL columns. Box only: this is the one file that holds turn text."""
    out = list(header) + [""]
    for n, r in enumerate(chosen, 1):
        out.append(f"#{n:02d}  {turn_key(r)}   lang={r.get('lang', '?')}")
        left = textwrap.wrap(r["en"], COL) or [""]
        right = textwrap.wrap(r["en_deid"], COL) or [""]
        out.append(f"{'EN (translated)':<{COL}} | EN_DEID (count names left here)")
        out.append("-" * COL + "-+-" + "-" * COL)
        for a, b in itertools.zip_longest(left, right, fillvalue=""):
            out.append(f"{a:<{COL}} | {b}")
        out.append("")
    return "\n".join(out) + "\n"


def write_private(path, text):
    """0600, created fresh (an existing file is never silently replaced: a draw is evidence)."""
    refuse_in_git(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def draw(mt_dir, out_dir, seed, n, allow_short):
    tpath, dpath = os.path.join(mt_dir, "translated.json"), os.path.join(mt_dir, "deid.json")
    translated, deid = load_records(tpath, False), load_records(dpath, True)
    cross_check(translated, deid)
    pool = eligible(deid)
    if len(pool) < n and not allow_short:
        raise SystemExit(_short(len(pool), n))
    chosen = pick(pool, n, seed)
    keys = [turn_key(r) for r in chosen]
    meta = dict(seed=seed, n_requested=n, n_drawn=len(chosen), eligible=len(pool), eligible_sha256=keys_sha([turn_key(r) for r in pool]),
                records_in_deid=len(deid), records_q_ok=sum(r.get("q") == "ok" for r in deid), records_q_not_ok=sum(r.get("q") != "ok" for r in deid),
                records_without_dropped_key=sum("dropped" not in r for r in deid),
                translated_sha256=sha256_file(tpath), deid_sha256=sha256_file(dpath), short=len(chosen) < n, keys=keys)
    refuse_in_git(os.path.join(out_dir, "draw.json"))
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    os.chmod(out_dir, 0o700)
    header = [f"NAME-LEAK REVIEW  seed {seed}  {len(chosen)} of {len(pool)} eligible turns",
              *FROZEN_DEFINITION,
              "Read the EN_DEID column. Write the number per turn into counts_template.json (copy it to counts.json). 0 is a claim you looked; leave nothing null."]
    write_private(os.path.join(out_dir, "draw.json"), json.dumps(meta, indent=1) + "\n")
    write_private(os.path.join(out_dir, "review_sheet.txt"), sheet(chosen, header))
    write_private(os.path.join(out_dir, "counts_template.json"), json.dumps({k: None for k in keys}, indent=1) + "\n")
    print(f"draw seed={seed}: {len(chosen)} of {len(pool)} eligible turns (q == ok and not dropped; {meta['records_q_not_ok']} of {len(deid)} records "
          f"are q != ok, {meta['records_without_dropped_key']} have no `dropped` key); files in {out_dir}")
    print("keys: " + " ".join(keys))
    return meta


def _short(have, want):
    print(f"only {have} eligible turns for a draw of {want}: pass --allow-short to draw them all (a weaker gate). Nothing written.", file=sys.stderr)
    return 3


def load_counts(path, keys):
    try:
        with open(path) as f:
            c = json.load(f)
    except (OSError, ValueError) as e:
        raise InputError(f"{os.path.basename(path)}: unreadable ({type(e).__name__})")
    if not isinstance(c, dict):
        raise InputError(f"{os.path.basename(path)}: not an object")
    missing, extra = len(set(keys) - c.keys()), len(c.keys() - set(keys))
    unfilled = sum(1 for k in keys if k in c and c[k] is None)
    badtype = sum(1 for k in keys if k in c and c[k] is not None and (not isinstance(c[k], int) or isinstance(c[k], bool) or c[k] < 0))
    if missing or extra or unfilled or badtype:
        raise InputError(f"{os.path.basename(path)}: {missing} drawn turns missing, {extra} keys not in the draw, {unfilled} still null, "
                         f"{badtype} not a non-negative integer. A null or missing turn is 'never looked', not zero")
    return {k: c[k] for k in keys}


HEX64 = re.compile(r"[0-9a-f]{64}")


def summarise(draw_path, counts_path, second_path, second_sha256):
    if not isinstance(second_sha256, str) or not HEX64.fullmatch(second_sha256):
        raise InputError("--second-sha256 must be 64 lowercase hex characters")
    actual = sha256_file(second_path) if os.path.isfile(second_path) else None
    if actual is None:
        raise InputError(f"{os.path.basename(second_path)}: unreadable (not a file)")
    if actual != second_sha256:
        raise InputError("the second reader's counts file does not match --second-sha256: these are not the labels that reader locked")
    with open(draw_path) as f:
        meta = json.load(f)
    keys = meta["keys"]
    first = load_counts(counts_path, keys)
    second = load_counts(second_path, keys)
    s = dict(seed=meta["seed"], n_turns=len(keys), counts_sha256=sha256_file(counts_path), second_counts_sha256=actual, deid_sha256=meta["deid_sha256"], translated_sha256=meta["translated_sha256"],
             eligible_sha256=meta["eligible_sha256"], per_turn=first, total_missed=sum(first.values()),
             turns_with_a_miss=sum(v > 0 for v in first.values()))
    s.update(second_per_turn=second, second_total_missed=sum(second.values()),
             agree=[k for k in keys if first[k] == second[k]], disagree=[k for k in keys if first[k] != second[k]])
    s["gate"] = "PASS" if s["total_missed"] == 0 and s["second_total_missed"] == 0 else "FAIL"
    return s


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("draw")
    d.add_argument("--seed", type=int, default=27)
    d.add_argument("--n", type=int, default=20)
    d.add_argument("--mt-dir", default=os.environ.get("ETA_MT_DIR", DEFAULT_MT))
    d.add_argument("--out-dir")
    d.add_argument("--allow-short", action="store_true")
    s = sub.add_parser("summary")
    s.add_argument("--draw", required=True)
    s.add_argument("--counts", required=True)
    s.add_argument("--second", required=True)
    s.add_argument("--second-sha256", required=True)
    s.add_argument("--out")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "draw":
            out = a.out_dir or os.path.join(a.mt_dir, f"nameleak-seed{a.seed}")
            draw(a.mt_dir, out, a.seed, a.n, a.allow_short)
            return 0
        s = summarise(a.draw, a.counts, a.second, a.second_sha256)
        if a.out:
            write_private(a.out, json.dumps(s, indent=1) + "\n")
    except InputError as e:
        print(f"input error: {e}", file=sys.stderr)
        return 2
    except FileExistsError:
        print("refusing to overwrite an existing draw/summary file: a draw is evidence, use a new --out-dir/--out", file=sys.stderr)
        return 2
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 3
    print(f"name-leak summary seed={s['seed']}: {s['n_turns']} turns, missed {s['total_missed']} in {s['turns_with_a_miss']} turns")
    print("per turn: " + " ".join(f"{k}={v}" for k, v in s["per_turn"].items()))
    print(f"second reader (sha256 pinned): missed {s['second_total_missed']}; agree on {len(s['agree'])} turns, disagree on {len(s['disagree'])}"
          + (": " + " ".join(s["disagree"]) if s["disagree"] else ""))
    print(f"GATE {s['gate']}" + ("" if s["gate"] == "PASS" else ": a name was missed. Fix the redactor, regenerate deid.json, then re-read the FULL eligible set of the new file (v7.15a N2 step 4)"))
    return 0 if s["gate"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
