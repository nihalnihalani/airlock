/** The hero combined flow's fixture page, simulated analysis and scripted turns (tests only). */
import type { ExecResult } from "@airlock/contracts";
import { CODE_RUNNER } from "../../src/general-handler.ts";
import { encodePng } from "../../src/png.ts";
import { okExec, type FakeAttempt, type FakePage } from "./fake-supervisor.ts";
import type { Turn } from "./general.ts";

export const HERO_HOST = "stats.airlock-fixtures.org";
export const HERO_URL = `https://${HERO_HOST}/regional-sales.html`;
export const HERO_TEXT = "Regional sales, Q3 2026\nAIRLOCK HOSTED FIXTURE: synthetic data.\nregion,revenue,target\nNorth,120,100\nSouth,80,110\nEast,95,100\nWest,130,120";
export const HERO_PAGES: Record<string, FakePage> = { [HERO_URL]: { title: "Regional sales, Q3 (Airlock hosted fixture)", text: HERO_TEXT, controls: [{ ref: "e1", role: "link", name: "Download CSV" }] } };

/** Simulates the fixture analysis.py: reads the saved page text, writes summary.json and a real PNG. */
export async function heroExec(command: string, _files: Map<string, string>, _signal?: AbortSignal, attempt?: FakeAttempt): Promise<ExecResult> {
  if (!command.startsWith(`${CODE_RUNNER} code/`)) return okExec({ stdout: `ran ${command}` });
  const text = attempt?.files.get("inputs/regions.csv");
  if (!text) return okExec({ status: "failed", exitCode: 1, stderr: "FileNotFoundError: inputs/regions.csv" });
  const rows = text.split("\n").filter((l) => /^[A-Za-z]+,\d+,\d+$/.test(l));
  const ratios = rows.map((l) => {
    const [region, revenue, target] = l.split(",");
    return { region: region!, ratio: Number(revenue) / Number(target) };
  });
  const worst = ratios.sort((a, b) => a.ratio - b.ratio)[0]!;
  attempt!.files.set("outputs/summary.json", JSON.stringify({ answer: worst.region, ratio: Number(worst.ratio.toFixed(3)) }));
  attempt!.binary.set("outputs/chart.png", encodePng(60, 40, (x) => (x < 30 ? [200, 40, 40] : [120, 120, 120])));
  return okExec({ stdout: JSON.stringify({ worst: worst.region }) });
}

export const HERO_TURNS: Turn[] = [
  { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
  { toolCalls: [{ name: "browser_observe", args: {} }] },
  { toolCalls: [{ name: "browser_screenshot", args: {} }, { name: "browser_save_text", args: { filename: "regions.csv" } }] },
  { toolCalls: [{ name: "code_write", args: { path: "code/analysis.py", content: "print('analysis')\n" } }] },
  { toolCalls: [{ name: "code_run", args: { language: "python", file: "code/analysis.py" } }] },
  { toolCalls: [{ name: "submit_result", args: { summary: "South is worst (73% of target).", outputs: ["outputs/summary.json", "outputs/chart.png"], sources: [HERO_URL] } }] },
];

