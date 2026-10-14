#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
L=~/dev/_fable/scratch/jevfix-mut.log
cd ~/dev/qo-wt || exit 1
T="tests/unit/jev-translate.test.ts tests/unit/jev-english.test.ts tests/unit/routed-chat-fallback.test.ts"
run() { npx vitest run $=T 2>&1 | grep -E "Tests |Test Files|FAIL|✗|×" | head -12; }
: > $L
echo "=== BASELINE" >> $L; run >> $L
mut() {
  local name=$1 file=$2 py=$3
  cp $file $file.bak
  python3 -c "$py" $file
  if cmp -s $file $file.bak; then echo "=== $name: PATCH DID NOT APPLY" >> $L; else echo "=== $name" >> $L; run >> $L; fi
  mv $file.bak $file
}
P='import sys;f=sys.argv[1];s=open(f).read();'

# D1: neutralise the romanised-Indic veto check in verifiedEnglish
mut MD1_no_veto lib/jev/translate.ts "${P}s=s.replace('if (words.some((w) => ROMANISED_INDIC_VETO.has(w))) return false;','if (false && words.some((w) => ROMANISED_INDIC_VETO.has(w))) return false;');open(f,'w').write(s)"

# D2: clear the timer right after headers arrive, before the body is read (the old bug)
mut MD2_timer_clears_early lib/openrouter.ts "${P}s=s.replace('if (res.status !== 200) throw new OpenRouterError(\`openrouter_http_\${res.status}\`);','clearTimeout(timer); if (res.status !== 200) throw new OpenRouterError(\`openrouter_http_\${res.status}\`);');open(f,'w').write(s)"

# D3: coerce non-string content with String() instead of rejecting it (ETA-Refuter's M4)
mut MD3_coerce_nonstring lib/openrouter.ts "${P}s=s.replace('if (typeof content !== \"string\") throw new OpenRouterError(\"openrouter_bad_response\");','const _c = String(content); if (false) throw 0;').replace('if (!content.trim())','if (!String(content).trim())').replace('content: content.trim(),','content: String(content).trim(),');open(f,'w').write(s)"

# D4: remove the shared total-deadline enforcement — a later model is tried even once the budget is gone
mut MD4_no_deadline_break lib/jev/translate.ts "${P}s=s.replace('if (remaining <= 0) { codes.push(\"translate_deadline_exceeded\"); break; }','if (false) { codes.push(\"translate_deadline_exceeded\"); break; }');open(f,'w').write(s)"

echo "=== ALL DONE" >> $L
git status --short >> $L
