// Sample model-written Node analysis (same hero task as the Python profile):
//   /opt/airlock/run.sh code/analyze_regions.mjs   (cwd /workspace, --network none, --permission)
// Reads inputs/regions.csv (SYNTHETIC fixture); writes outputs/summary.json and outputs/report.md.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { sum, linearRegression } from "simple-statistics";

const raw = readFileSync("inputs/regions.csv");
const rows = parse(raw, { columns: true, cast: (v, ctx) => (ctx.column === "revenue" ? Number(v) : v) });
const regions = [...new Set(rows.map((r) => r.region))];
const byRegion = Object.fromEntries(regions.map((reg) => {
  const rs = rows.filter((r) => r.region === reg).sort((a, b) => a.month.localeCompare(b.month));
  const slope = linearRegression(rs.map((r, i) => [i, r.revenue])).m;
  return [reg, { total: sum(rs.map((r) => r.revenue)), monthlyTrend: Math.round(slope) }];
}));
const ranked = regions.sort((a, b) => byRegion[a].total - byRegion[b].total);
const worst = ranked[0];

mkdirSync("outputs", { recursive: true });
const summary = {
  task: "worst-performing region by total revenue",
  input: { path: "inputs/regions.csv", sha256: createHash("sha256").update(raw).digest("hex"), rows: rows.length },
  worstRegion: worst,
  worstTotal: byRegion[worst].total,
  regions: byRegion,
  method: "sum(revenue) per region; lowest total is worst; trend = least-squares slope per month",
  runtime: `node ${process.version}`,
};
writeFileSync("outputs/summary.json", JSON.stringify(summary, null, 2) + "\n");
writeFileSync("outputs/totals.csv", stringify(ranked.map((r) => [r, byRegion[r].total, byRegion[r].monthlyTrend]), { header: true, columns: ["region", "total", "monthlyTrend"] }));
writeFileSync("outputs/report.md", `# Worst-performing region (SYNTHETIC data)\n\n**${worst}**: total ${byRegion[worst].total}, trend ${byRegion[worst].monthlyTrend}/month.\n`);
console.log(JSON.stringify({ worstRegion: worst, worstTotal: byRegion[worst].total }));
