#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
L=~/dev/_fable/scratch/jev-mut.log
cd /tmp/refute-jev || exit 1
unset OPENROUTER_API_KEY OPENROUTER_API_KEY_FILE
export OPENROUTER_API_URL=http://127.0.0.1:9/never
T="tests/unit/jev-translate.test.ts tests/unit/jev-english.test.ts"
run() { npx vitest run $=T 2>&1 | grep -E "Tests |Test Files|FAIL|✗|×" | head -8; }
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
mut M1_no_zdr lib/openrouter.ts "${P}s=s.replace('provider: { zdr: true, data_collection: \"deny\" },','');open(f,'w').write(s)"
mut M2_typed_label lib/openrouter.ts "${P}s=s.replace('model: typeof b.model === \"string\" && b.model ? b.model : args.model,','model: args.model,');open(f,'w').write(s)"
mut M3_source_as_english lib/jev/translate.ts "${P}s=s.replace('return { status: \"failed\", reason };','return { status: \"ok\", english: original, model: \"x\", latency_ms: 0, input_chars };');open(f,'w').write(s)"
mut M4_nonstring_coerced lib/openrouter.ts "${P}s=s.replace('if (typeof content !== \"string\") throw new OpenRouterError(\"openrouter_bad_response\");','const _c = String(content); if (false) throw 0;').replace('if (!content.trim())','if (!String(content).trim())').replace('content: content.trim(),','content: String(content).trim(),');open(f,'w').write(s)"
mut M5_key_in_error lib/openrouter.ts "${P}s=s.replace('throw new OpenRouterError(\`openrouter_unreachable:\${(e as { name?: string } | null)?.name ?? \"Error\"}\`);','throw new OpenRouterError(\`openrouter_unreachable:\${String((e as Error)?.message)}\`);');open(f,'w').write(s)"
mut M6_no_fallback lib/jev/translate.ts "${P}s=s.replace('return [primary, ...fallback.filter((m) => m !== primary)];','return [primary];');open(f,'w').write(s)"
echo "=== ALL DONE" >> $L
git status --short >> $L
