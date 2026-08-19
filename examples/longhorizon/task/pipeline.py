#!/usr/bin/env python3
"""Pipeline for the long-horizon demo: process every file in data/ and write pipeline.out.

The original pipeline was INTENTIONALLY buggy. Repaired defects:
  1. rows missing the 'value' column / key no longer raise KeyError (skipped from totals)
  2. avg is the true average (sum / rows with a value), not the sum
  3. no off-by-one in the per-file summary count
  4. empty input files are handled instead of crashing on rows[0]
  5. files with an invalid UTF-8 byte are decoded lossily so they still parse
  6. only .csv/.json files in data/ are processed, so stray non-data files
     (e.g. _probe.txt) cannot crash the run or add a spurious line

All 12 data files must be processed; output stays deterministic.
"""

import csv
import json
import os
import sys

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pipeline.out')


def read_rows(path: str) -> list[dict]:
    """Read one data file into a list of dicts. Tolerates empty files and invalid UTF-8."""
    if path.endswith('.csv'):
        with open(path, newline='', encoding='utf-8', errors='replace') as handle:
            return list(csv.DictReader(handle))
    with open(path, encoding='utf-8', errors='replace') as handle:
        text = handle.read()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        # A replacement char (U+FFFD) from a bad byte can land in a structural spot;
        # drop those chars and retry once so the rest of the document still parses.
        payload = json.loads(text.replace('\ufffd', ''))
    return payload if isinstance(payload, list) else [payload]


def row_value(row: dict):
    """Numeric 'value' for a row, or None when the key is missing or unparseable."""
    try:
        return float(row['value'])
    except (KeyError, TypeError, ValueError):
        return None


def process_file(path: str) -> dict:
    rows = read_rows(path)
    total = 0.0
    valued = 0
    for row in rows:
        value = row_value(row)
        if value is None:
            continue  # BUG 1 fix: skip rows without a usable 'value' instead of crashing
        total += value
        valued += 1
    count = len(rows)
    # BUG 2 fix: real average, guarded for files with no usable values
    avg = total / valued if valued else 0.0
    # BUG 4 fix: empty input no longer crashes on rows[0]
    sample = rows[0].get('name', '') if rows else ''
    return {'rows': count, 'sum': total, 'avg': avg, 'sample': sample}


def main() -> int:
    # BUG 6 fix: only the intended data inputs (.csv/.json) are processed, so a
    # stray non-data file in data/ (e.g. _probe.txt) can neither crash the run
    # nor add a spurious line to pipeline.out.
    files = sorted(
        name for name in os.listdir(DATA_DIR)
        if os.path.isfile(os.path.join(DATA_DIR, name))
        and name.lower().endswith(('.csv', '.json'))
    )
    lines = []
    processed = []
    for name in files:
        path = os.path.join(DATA_DIR, name)
        result = process_file(path)
        processed.append(name)
        lines.append(f'{name}: rows={result["rows"]} sum={result["sum"]:.2f} avg={result["avg"]:.2f} sample={result["sample"]}')
    reported = len(processed)  # BUG 3 fix: no off-by-one, exactly the files processed
    lines.append(f'TOTAL FILES: {reported} | PROCESSED: {reported}')
    with open(OUT_PATH, 'w', encoding='utf-8') as out:
        out.write('\n'.join(lines) + '\n')
    print(f'wrote {OUT_PATH} (files={len(processed)})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
