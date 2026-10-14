#!/bin/zsh
sleep 200
tail -3 /tmp/rel0921-tc.log; echo ---; grep -E "Tests |Test Files|test=|FAIL" /tmp/rel0921-test.log | tail -8
