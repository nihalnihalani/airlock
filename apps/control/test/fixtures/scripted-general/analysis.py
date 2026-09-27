"""Scripted diagnostic (NOT model-written): the analysis the general-hero script runs.

Runs as /opt/airlock/run.sh code/analysis.py with cwd /workspace and no network. Reads the page text
saved by browser_save_text (inputs/regions.csv: page text whose CSV block starts at the
"region,revenue,target" header), finds the region with the lowest revenue/target ratio, and writes
outputs/summary.json (with the "answer" field the completion checks require) and outputs/chart.png.
"""

import csv
import hashlib
import io
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

src = Path("inputs/regions.csv")
text = src.read_text(encoding="utf-8")
lines = text.splitlines()
start = next(i for i, line in enumerate(lines) if line.strip() == "region,revenue,target")
rows = []
for line in lines[start:]:
    if not line.strip() or line.count(",") != 2:
        break
    rows.append(line.strip())
data = list(csv.DictReader(io.StringIO("\n".join(rows))))
ratios = {r["region"]: float(r["revenue"]) / float(r["target"]) for r in data}
worst = min(ratios, key=ratios.get)

out = Path("outputs")
out.mkdir(exist_ok=True)
summary = {
    "answer": worst,
    "metric": "revenue / target",
    "ratios": {k: round(v, 3) for k, v in sorted(ratios.items())},
    "input": {"path": str(src), "sha256": hashlib.sha256(src.read_bytes()).hexdigest(), "rows": len(data)},
}
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

fig, ax = plt.subplots(figsize=(6, 3.5), dpi=100)
regions = sorted(ratios)
ax.bar(regions, [ratios[r] * 100 for r in regions], color=["#c0392b" if r == worst else "#7f8c8d" for r in regions])
ax.axhline(100, color="#333", linewidth=0.8)
ax.set_ylabel("Revenue as % of target")
ax.set_title("Revenue vs target by region (fixture data)")
fig.tight_layout()
fig.savefig(out / "chart.png", format="png")
print(json.dumps({"worst": worst, "ratio": round(ratios[worst], 3)}))
