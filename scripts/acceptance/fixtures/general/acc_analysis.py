"""Acceptance diagnostic (NOT model-written; verifier_tester). Reads the first CSV under inputs/
(columns: id,value_a,value_b), writes outputs/summary.json (answer = totals, input sha256, env var
NAMES seen inside the sandbox) and outputs/chart.png (bar chart of value_a per id)."""
import csv, hashlib, json, os
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

src = sorted(Path("inputs").glob("*.csv"))[0]
raw = src.read_bytes()
rows = list(csv.DictReader(raw.decode("utf-8").splitlines()))
a = [float(r["value_a"]) for r in rows]
b = [float(r["value_b"]) for r in rows]
out = Path("outputs"); out.mkdir(exist_ok=True)
summary = {
    "answer": f"sum_a={sum(a):.4f} sum_b={sum(b):.4f} rows={len(rows)}",
    "sum_a": round(sum(a), 4), "sum_b": round(sum(b), 4), "max_a": max(a), "rows": len(rows),
    "input": {"name": src.name, "sha256": hashlib.sha256(raw).hexdigest()},
    "env_names": sorted(os.environ.keys()),
}
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
fig, ax = plt.subplots(figsize=(6, 3.5), dpi=100)
ax.bar([r["id"] for r in rows], a)
ax.set_title("value_a per id (acceptance input)")
fig.tight_layout(); fig.savefig(out / "chart.png", format="png")
print(json.dumps({"rows": len(rows), "sum_a": round(sum(a), 4)}))
