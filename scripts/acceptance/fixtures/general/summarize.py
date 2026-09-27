"""Scripted diagnostic (NOT model-written): summarise the first CSV under inputs/.

Writes outputs/summary.json ({"answer": "<rows> rows x <columns> columns", ...}) and
outputs/columns.csv (one row per column with its non-empty count).
"""

import csv
import json
from pathlib import Path

src = sorted(Path("inputs").glob("*.csv"))[0]
with src.open(newline="", encoding="utf-8") as f:
    rows = list(csv.reader(f))
header, body = rows[0], rows[1:]
out = Path("outputs")
out.mkdir(exist_ok=True)
(out / "summary.json").write_text(json.dumps({"answer": f"{len(body)} rows x {len(header)} columns", "input": src.name, "columns": header}, indent=2) + "\n", encoding="utf-8")
with (out / "columns.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["column", "non_empty"])
    for i, name in enumerate(header):
        w.writerow([name, sum(1 for r in body if i < len(r) and r[i].strip())])
print(json.dumps({"rows": len(body), "columns": len(header)}))
