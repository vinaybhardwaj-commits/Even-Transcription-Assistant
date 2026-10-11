# Fast tests stay offline. test-all includes the model-download smoke tests.
# Uses tools/timbre/.venv when that interpreter exists, otherwise python3.
TIMBRE := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
ROOT := $(abspath $(TIMBRE)/../..)
ifeq ($(origin PYTHON), undefined)
  ifneq ($(wildcard $(TIMBRE)/.venv/bin/python),)
    PYTHON := $(TIMBRE)/.venv/bin/python
  else
    PYTHON := python3
  endif
endif

.PHONY: test test-all
test:
	cd $(ROOT) && $(PYTHON) -m pytest -c tools/timbre/pytest.ini -m 'not slow' tools/timbre/tests -q

test-all:
	cd $(ROOT) && $(PYTHON) -m pytest -c tools/timbre/pytest.ini tools/timbre/tests -q
