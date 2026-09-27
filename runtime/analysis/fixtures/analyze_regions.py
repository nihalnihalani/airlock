"""Sample model-written analysis (hero task): worst-performing region + chart.

Runs as /opt/airlock/run.sh code/analyze_regions.py with cwd /workspace, --network none.
Reads inputs/regions.csv; writes outputs/summary.json and outputs/chart.png.
"""

import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

src = Path("inputs/regions.csv")
df = pd.read_csv(src)
assert list(df.columns) == ["region", "month", "revenue"], df.columns

totals = df.groupby("region")["revenue"].sum().sort_values()
worst = totals.index[0]
by_month = df.pivot(index="month", columns="region", values="revenue").sort_index()
first, last = by_month.iloc[0], by_month.iloc[-1]
change = ((last - first) / first * 100).round(1)

out = Path("outputs")
out.mkdir(exist_ok=True)
summary = {
    "task": "worst-performing region by total revenue",
    "input": {"path": str(src), "sha256": hashlib.sha256(src.read_bytes()).hexdigest(), "rows": int(len(df))},
    "months": [str(by_month.index[0]), str(by_month.index[-1])],
    "worstRegion": worst,
    "worstTotal": int(totals.iloc[0]),
    "totals": {k: int(v) for k, v in totals.items()},
    "changePercentFirstToLastMonth": {k: float(v) for k, v in change.items()},
    "method": "sum(revenue) per region; lowest total is worst",
}
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

fig, ax = plt.subplots(figsize=(7, 4), dpi=100)
colors = ["#c0392b" if r == worst else "#7f8c8d" for r in totals.index]
ax.bar(totals.index, totals.values / 1000, color=colors)
ax.set_ylabel("Total revenue (thousands)")
ax.set_title(f"Total revenue by region, {summary['months'][0]}..{summary['months'][1]} (SYNTHETIC data)")
ax.tick_params(axis="x", labelsize=8)
fig.tight_layout()
fig.savefig(out / "chart.png", format="png")
print(json.dumps({"worstRegion": worst, "worstTotal": summary["worstTotal"]}))
