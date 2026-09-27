/**
 * Hero-task dataset (synthetic). Variant "a" is byte-identical to the CSV block of
 * apps/control/test/fixtures/scripted-general/regional-sales.html (lowest revenue/target: South);
 * variant "b" changes the numbers (lowest: North) to show that changing inputs changes outputs.
 */
import variantA from "../data/regional-sales-a.csv" with { type: "text" };
import variantB from "../data/regional-sales-b.csv" with { type: "text" };

export const DATASETS = { a: variantA, b: variantB } as const;
export type Variant = keyof typeof DATASETS;

export function parseVariant(value: string | null): Variant | null {
  if (value === null || value === "" || value === "a") return "a";
  if (value === "b") return "b";
  return null;
}

export function parseCsv(text: string): string[][] {
  return text.split("\n").filter((line) => line !== "").map((line) => line.split(","));
}
