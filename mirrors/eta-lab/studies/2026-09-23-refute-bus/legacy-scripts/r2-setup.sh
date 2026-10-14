#!/bin/zsh
set -e
REPO=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
F=/Users/vinaybhardwaj/dev/_fable
O=$F/r2-setup.log
{
rm -rf $F/r2tree $F/r2base
mkdir -p $F/r2tree $F/r2base
cd $REPO
git archive 135d33e | tar -x -C $F/r2tree
git archive 8d6b6e8 | tar -x -C $F/r2base
ln -s $REPO/node_modules $F/r2tree/node_modules
ln -s $REPO/node_modules $F/r2base/node_modules
echo "--- test file counts"
echo "r2tree(135d33e): $(ls $F/r2tree/tests/unit/*.test.ts | wc -l)"
echo "r2base(8d6b6e8): $(ls $F/r2base/tests/unit/*.test.ts | wc -l)"
echo "repo(bbaba3b):   $(ls $REPO/tests/unit/*.test.ts | wc -l)"
echo "--- test files in repo but NOT in r2tree:"
comm -23 <(ls $REPO/tests/unit/ | sort) <(ls $F/r2tree/tests/unit/ | sort)
echo "--- test files in r2tree but NOT in repo:"
comm -13 <(ls $REPO/tests/unit/ | sort) <(ls $F/r2tree/tests/unit/ | sort)
echo "--- diff r2base vs r2tree test files:"
diff -rq $F/r2base/tests $F/r2tree/tests || true
} > $O 2>&1
cat $O
