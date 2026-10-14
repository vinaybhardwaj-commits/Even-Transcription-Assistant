#!/usr/bin/env python3
"""J-A — hallucination detector prompt trial, through the even-jev MCP server itself.

The state is built and piped straight into ~/dev/even-jev-mcp/run.sh over JSON-RPC, exactly the
pattern the jev-decisions skill documents. The transcript text therefore never enters the agent's
context, any log, the report or the ledger: only window ids, probabilities, usage and latency come
back out. V has cleared transcript text to the vendor; this keeps it off everything else.

Labels are free and by construction: closed-hours (21:00-07:00 IST) = noise, V-affirmed = speech.
"""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q

RUN = os.path.expanduser('~/dev/even-jev-mcp/run.sh')
OUT = '/Users/vinaybhardwaj/dev/scratch/ja-trial-results.json'
PROMPT_VERSION = 'jev-noise-v1'

# 4-6 candidate wordings. One atomic judgement each, criteria describe situations, escape included
# on the choice. No worked examples inside any instruction.
QUESTIONS = {
    'a1_people_talking': {'type': 'noul',
        'instructions': 'The state holds the machine transcript of one fifteen-minute window of audio from a single room. Decide whether it is a record of people who were actually speaking in that room.',
        'criteria': {
            'true': 'Speakers take turns, a later line responds to an earlier one, and what is being discussed changes as the window goes on.',
            'false': 'Nothing is answered by anything else. A small set of phrases returns over and over, or the lines carry no subject that could belong to a particular room at a particular time.'}},
    'a2_asr_on_noise': {'type': 'noul',
        'instructions': 'The state holds the output of an automatic speech recogniser that ran continuously over one window of room audio. The recogniser emits words whether or not anyone spoke. Decide whether this output came from noise or silence rather than from speech.',
        'criteria': {
            'true': 'The output loops through a few phrases for its whole length, or fills the window with generic filler that names nothing and asks nothing, which is what a recogniser emits when it is fed room tone, a fan, an air conditioner or traffic.',
            'false': 'The output names things and people in the room, asks and answers questions, and carries information that only somebody present could supply.'}},
    'a3_repetition': {'type': 'noul',
        'instructions': 'Decide whether the transcript in the state is dominated by repetition.',
        'criteria': {
            'true': 'The same phrase or a small rotating set of phrases accounts for most of the window, returning with little or nothing new between the repeats.',
            'false': 'Repeated phrases are the ordinary ones of conversation and most of the window is not repetition.'}},
    'a4_topic_coherence': {'type': 'noul',
        'instructions': 'Decide whether the transcript in the state follows a subject that develops over the window.',
        'criteria': {
            'true': 'A subject is raised and then taken further: details are added, questions answered, or the matter settled and another begun.',
            'false': 'No subject is carried. Lines sit next to each other without building on one another, or the content wanders with nothing established.'}},
    'a5_worth_keeping': {'type': 'noul',
        'instructions': 'The state holds a transcript that may be kept as the record of what was said in a room during this window. Decide whether it is worth keeping.',
        'criteria': {
            'true': 'Somebody who was not present could learn from it what happened in the room and what the people in it wanted.',
            'false': 'Somebody who was not present would learn nothing specific about this room or this window from it.'}},
    'a6_kind': {'type': 'choice',
        'instructions': 'The state holds a machine transcript of one window of room audio. Say what produced it.',
        'criteria': {
            'real_speech': 'People were speaking in the room and the recogniser wrote down what they said, errors and all.',
            'recogniser_on_noise': 'Nobody was speaking. The recogniser produced words from room tone, machinery, traffic or silence.',
            'mixed': 'Part of the window holds real speech and the rest is the recogniser producing words with nobody speaking.',
            'cannot_tell': 'The transcript does not settle which of the above happened.'}},
}

def frames(state):
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "ja-trial", "version": "1"}}}
    ready = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "jev_ask", "arguments": {"state": state, "questions": QUESTIONS}}}
    return "\n".join(json.dumps(x) for x in (init, ready, call)) + "\n"

def ask(state):
    t0 = time.time()
    p = subprocess.run([RUN], input=frames(state), capture_output=True, text=True, timeout=180)
    ms = int((time.time() - t0) * 1000)
    for line in p.stdout.splitlines():
        try: m = json.loads(line)
        except ValueError: continue
        if m.get("id") == 2:
            c = m.get("result", {}).get("content") or []
            for part in c:
                if part.get("type") == "text":
                    return json.loads(part["text"]), ms
            return m.get("result"), ms
    return {"error": (p.stderr or "")[-300:]}, ms

rows = q.q("""
select jt.window_id, jt.english, jt.source, jt.char_count,
       round((jt.char_count::numeric)/nullif((w.end_ms-w.start_ms)/1000.0,0),2) as cps,
       extract(hour from to_timestamp(w.start_ms/1000.0) at time zone 'Asia/Kolkata') as h
  from jev_window_text jt join bench_window w on w.id=jt.window_id
 where jt.window_id = any($1)""", [[x['window_id'] for x in json.load(open('/tmp/ja-fixture-meta.json'))]])['rows']
meta = {x['window_id']: x for x in json.load(open('/tmp/ja-fixture-meta.json'))}

out = []
for i, r in enumerate(sorted(rows, key=lambda x: x['window_id']), 1):
    wid = r['window_id']; h = float(r['h'])
    label = 'noise' if (h >= 21 or h < 7) else 'speech'
    state = {"window": "W1", "chars_per_second": float(r['cps']), "transcript_english": r['english']}
    ans, ms = ask(state)
    if 'answers' not in ans:
        print("%2d %-40s %-6s ERROR %s" % (i, wid, label, str(ans)[:120])); continue
    a = ans['answers']
    vals = {k: (a[k]['noul'] if a[k]['type'] == 'noul' else a[k]['choice']) for k in QUESTIONS}
    probs = {k: a[k].get('probabilities') for k in QUESTIONS if a[k]['type'] == 'choice'}
    out.append({'window_id': wid, 'label': label, 'cps': float(r['cps']), 'source': r['source'],
                'chars': int(r['char_count']), 'vals': vals, 'choice_probs': probs,
                'input_tokens': ans['usage']['input_tokens'], 'latency_ms': ms})
    print("%2d %-40s %-6s " % (i, wid, label) + " ".join(
        "%s=%s" % (k.split('_')[0], ("%.2f" % v) if isinstance(v, float) else v) for k, v in vals.items()), flush=True)

fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f: json.dump({'prompt_version': PROMPT_VERSION, 'questions': QUESTIONS, 'rows': out}, f, indent=1)
tok = sum(r['input_tokens'] for r in out)
print("\nscored %d windows | input tokens %d | cost $%.5f | median latency %d ms"
      % (len(out), tok, tok * 42e-9, sorted(r['latency_ms'] for r in out)[len(out)//2] if out else 0))
