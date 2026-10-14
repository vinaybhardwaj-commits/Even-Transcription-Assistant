#!/usr/bin/env python3
# refresh-groups.py — 6590 sidebar-title refresh (v2: snapshot-fast).
# Planned renames: '<agent> · <live kind+model token (label part 2)> · <new job>'.
# dry (default) prints; --live records then executes; --rollback restores.
import json, subprocess, sys, os
ROLLBACK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ROLLBACK-REFRESH-6590.jsonl')
JOBS = {
 'diar-lab': 'voiceprint mint + voicecheck clips',
 'linker': 'PQM links + DRTPQMA + voice candidates',
 'hf-fleet': 'Hugging Face GPU fleet',
 'lab-viewer': 'lab viewer (DRT, voicecheck)',
 'lx': 'voice study pre-regs',
 'jev-audit': 'ROLE-FROM-CONTENT study',
 'jev-fix': 'Jev fixes + Jev calls',
 'reb': 'REB ingest + collector',
 'hist-bulk': 'historical backfill driver',
 'split': 'diarization backfill',
 'router-fix': 'FUSER RUN 3',
 'lid-debug': 'FUSER RUN 3 design',
 'sig-research': 'room proofs (content)',
 'surg-link': 'surgery tier nightly',
 'scribe': 'production (RECORDER/SHIP)',
 'terms': 'STT bake-off set (c)',
 'notesafe': 'med-note bench',
 'tone': 'TONE parked',
 'lab-mover': 'tape indexes',
 'vj-refuter': 'checker (voice, CAP, ROLE)',
 'eta-refuter-3': 'checker (REB, voiceprint pre-regs)',
 'eta-refuter-2': 'checker (lab viewer, CAP code)',
 'roadmap': 'roadmap + task board',
 'minibot': 'Mini room actions',
 'surg-jev': 'no-PHI helper',
}
MID_BOX = 'c33e904116170d7a433e283bad3200c8'
def wl(mid):
    args = ['--machine', mid] if mid else []
    return json.loads(subprocess.run(['herdr'] + args + ['workspace','list'], capture_output=True, text=True).stdout)['result']['workspaces']
def al(mid):
    args = ['--machine', mid] if mid else []
    return json.loads(subprocess.run(['herdr'] + args + ['agent','list'], capture_output=True, text=True).stdout)['result']['agents']
def rollback_from_record():
    import json as _j
    seen = set()
    for line in open(ROLLBACK):
        line = line.strip()
        if not line or line in seen:
            continue
        seen.add(line)
        m = _j.loads(line)
        if not m:
            continue
        mid = m.get('machine_id') or ''
        flags = ['--machine', mid] if mid else []
        r = subprocess.run(['herdr'] + flags + ['workspace', 'rename', m['ws'], m['old']], capture_output=True, text=True)
        ok = 'ok' if r.returncode == 0 else 'FAILED ' + r.stderr[:120]
        print('rollback', m['ws'], '->', m.get('old'), ok)
    return

def main():
    apply_live = '--live' in sys.argv[1:]
    roll = '--rollback' in sys.argv[1:]
    if roll:
        return rollback_from_record()
    agent_snap = { 'box': {a['name']: a for a in al(MID_BOX)}, 'mini': {a['name']: a for a in al('')} }
    ws_snap = { 'box': {w['workspace_id']: w for w in wl(MID_BOX)}, 'mini': {w['workspace_id']: w for w in wl('')} }
    plan = []
    for name, job in JOBS.items():
        mach = 'box' if name in agent_snap['box'] else 'mini' if name in agent_snap['mini'] else None
        if not mach:
            print('MISSING-LIVE', name, file=sys.stderr); continue
        a = agent_snap[mach][name]
        ws = a.get('workspace_id')
        w = ws_snap[mach].get(ws)
        old = (w or {}).get('label')
        parts = [p.strip() for p in (old or '').split('·')]
        model_tok = parts[1] if len(parts) >= 2 else 'C sonnet'
        new = f'{name} · {model_tok} · {job}'
        plan.append((name, mach, ws, old, new))
    for name, mach, ws, old, new in plan:
        print(f'{name:18} machine={mach:5} ws={ws:5} {old!r} -> {new!r}')
    if not apply_live:
        print('-- dry run: nothing executed')
        return
    seen = set()
    with open(ROLLBACK, 'a') as f:
        for name, mach, ws, old, new in plan:
            mid = MID_BOX if mach == 'box' else ''
            line = json.dumps({'machine_id': mid, 'ws': ws, 'old': old, 'new': new}) + chr(10)
            key = line
            if key in seen:
                continue
            seen.add(key)
            f.write(line)
    for name, mach, ws, old, new in plan:
        mid = MID_BOX if mach == 'box' else ''
        flags = ['--machine', mid] if mid else []
        p = subprocess.run(['herdr'] + flags + ['workspace','rename', ws, new], capture_output=True, text=True)
        if p.returncode == 0:
            print('rename ok:', ws, '->', new)
        else:
            print('RENAME FAILED', name, p.stderr[:120], file=sys.stderr)
            sys.exit(1)
if __name__ == '__main__':
    main()
