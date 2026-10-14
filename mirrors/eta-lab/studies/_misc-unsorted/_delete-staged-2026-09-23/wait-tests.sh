#!/bin/zsh
for i in {1..25}; do
  grep -aq "^test=" /tmp/rel0921-test.log && break
  sleep 10
done
date
grep -aE "Test Files|Tests  |test=" /tmp/rel0921-test.log | tail -4
grep -a " FAIL " /tmp/rel0921-test.log | head -5
