#!/bin/sh
# Verify the demo artifact: REPORT.md must cover all 12 data files.
set -eu
[ -f REPORT.md ] || { echo "FAIL: REPORT.md missing"; exit 1; }
missing=0
for f in 01_basic.csv 02_basic.json 03_missing_col.csv 04_empty.csv 05_dup_of_01.csv 06_bad_utf8.json 07_missing_col.json 08_large.csv 09_basic.csv 10_basic.json 11_basic.csv 12_basic.json; do
  grep -q "$f" REPORT.md || { echo "FAIL: $f not mentioned in REPORT.md"; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1
echo "PASS: REPORT.md covers all 12 data files"