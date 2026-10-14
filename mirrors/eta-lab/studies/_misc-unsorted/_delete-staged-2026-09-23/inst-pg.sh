#!/bin/zsh
python3 -c "import psycopg2" 2>/dev/null && { echo "psycopg2 present"; exit 0; }
pip3 install --quiet psycopg2-binary 2>&1 | tail -3
python3 -c "import psycopg2; print('psycopg2 now present')" 2>&1 | tail -2
