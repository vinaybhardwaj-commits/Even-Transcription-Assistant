#!/bin/zsh
sleep 52
date; grep -aE "Test Files|Tests  |^test=" /tmp/rel0921-test2.log | tail -4; grep -a " FAIL " /tmp/rel0921-test2.log | cut -c1-140 | head -6
