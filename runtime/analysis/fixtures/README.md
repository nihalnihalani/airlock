# Demo fixtures (SYNTHETIC)

- `regions.csv` — **synthetic, hand-made data for the local demo only** (`region,month,revenue`,
  4 regions x 6 months, every region name prefixed `Synthetic-`). It is not real revenue data and
  must never be presented as a live source. `Synthetic-West` is constructed to be the
  worst-performing region (lowest total and a declining trend).
- `analyze_regions.py` — the sample "model-written" analysis for the hero task (doc 40 Stage 3):
  finds the worst-performing region and writes `outputs/summary.json` and `outputs/chart.png`.
- `refusal.py` — a hostile sample that writes outputs the collector must refuse: an SVG, a symlink
  to `/etc/passwd`, a symlinked directory, a hard link to an input, a fake PNG, an oversized PNG
  header. Only `outputs/ok.txt` may be collected.
