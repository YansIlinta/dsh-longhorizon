# Pipeline Repair Task

English | [中文](README.zh.md)

Objective: repair the pipeline so all 12 files in `data/` are processed successfully, then write `REPORT.md` (per-file results + what was fixed) and verify by rerunning.

Success criteria:

1. `python3 pipeline.py` processes every file in `data/` without crashing and writes `pipeline.out`.
2. `pipeline.out` contains one line per input file (12 lines) plus a correct summary line.
3. `REPORT.md` is written at the workspace root, listing per-file results for all 12 files and the fixes you applied.
4. Rerunning the pipeline after your fixes is clean and reproducible.

Notes

- The data files are intentionally varied: some are valid, some are missing columns, one is empty, one contains an invalid byte, one duplicates another file, one is large.
- Every data file counts: the pipeline must handle all 12, not just the easy ones.
- Keep the output deterministic: same input, same `pipeline.out`.