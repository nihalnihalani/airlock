#!/usr/bin/env bun
/**
 * Measured model selection for Airlock (CLAUDE.md §2): runs a tool-call round trip against every
 * candidate model on Vultr Serverless Inference and recommends an AIRLOCK_MODEL.
 *
 * Usage:
 *   VULTR_INFERENCE_API_KEY=... bun scripts/probe-model.ts [model ...]
 *   VULTR_INFERENCE_API_KEY=... bun scripts/probe-model.ts --vision <model> [model ...]
 *     Image round trip: a generated 64x64 PNG of one random solid colour is sent as an image_url
 *     content part; the model passes only if its reply names that colour. Set AIRLOCK_MODEL_VISION=1
 *     for a model only after it passes here.
 * Env:
 *   VULTR_INFERENCE_API_KEY   required
 *   VULTR_INFERENCE_BASE_URL  only https://api.vultrinference.com/v1, unless
 *                             AIRLOCK_ALLOW_TEST_INFERENCE_URL=1 (never with AIRLOCK_PRODUCTION=1)
 *   AIRLOCK_PROBE_TIMEOUT_MS  per-model budget, default 90000
 *
 * Without model arguments every /v1/models entry that advertises tools is probed.
 * The key is read from the environment only and never printed.
 */
import { ConfigError, inferenceFetch, parseInferenceBaseUrl } from "../apps/control/src/config.ts";
import { VultrError } from "../apps/control/src/vultr-client.ts";
import { formatTable, formatVisionTable, probeModels, probeVision, recommend } from "../apps/control/src/vultr-probe.ts";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const vision = args.includes("--vision");
  const apiKey = process.env.VULTR_INFERENCE_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    console.error(`probe-model: SKIP: VULTR_INFERENCE_API_KEY is not set; no ${vision ? "image" : "tool-call"} round trip was run and nothing was measured. Export it and run again.`);
    return 2;
  }
  let baseUrl: string;
  try {
    baseUrl = parseInferenceBaseUrl(process.env.VULTR_INFERENCE_BASE_URL, { production: process.env.AIRLOCK_PRODUCTION === "1", allowTestUrl: process.env.AIRLOCK_ALLOW_TEST_INFERENCE_URL === "1" });
  } catch (err) {
    console.error(`probe-model: ${err instanceof ConfigError ? err.message : String(err)}`);
    return 2;
  }
  const timeoutRaw = Number(process.env.AIRLOCK_PROBE_TIMEOUT_MS ?? "");
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 90_000;
  const models = args.filter((m) => m !== "--vision" && m.length > 0 && m.length <= 128);
  if (vision) return visionProbe(baseUrl, apiKey, timeoutMs, models);

  console.error(`probe-model: base ${baseUrl}; ${models.length > 0 ? `${models.length} model(s) from argv` : "all tool-capable models from /models"}`);

  let rows;
  try {
    rows = await probeModels({ baseUrl, apiKey, timeoutMs, fetch: inferenceFetch(baseUrl), ...(models.length > 0 ? { models } : {}) });
  } catch (err) {
    if (err instanceof VultrError) {
      console.error(`probe-model: ${err.kind}: ${err.message}`);
      return err.kind === "auth" ? 3 : 1;
    }
    console.error(`probe-model: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(formatTable(rows));
  console.log("");
  const best = recommend(rows);
  if (!best) {
    console.log("No model completed the tool-call round trip (parsed call + used result). Do not set AIRLOCK_MODEL from this run.");
    return 1;
  }
  const runnersUp = rows
    .filter((r) => r !== best && r.ok && r.toolCallParsed && r.usedToolResult)
    .sort((x, y) => x.totalMs - y.totalMs)
    .slice(0, 3)
    .map((r) => `${r.model} (${r.totalMs} ms)`);
  console.log(`Recommended: AIRLOCK_MODEL=${best.model}   (${best.totalMs} ms round trip, ${best.tokens.input}+${best.tokens.output} tokens)`);
  if (runnersUp.length > 0) console.log(`Also passed: ${runnersUp.join(", ")}`);
  console.log("The driver appends -normalize automatically; set the bare id.");
  return 0;
}

/** `--vision`: an actual image through the pinned Vultr endpoint, per named model. */
async function visionProbe(baseUrl: string, apiKey: string, timeoutMs: number, models: string[]): Promise<number> {
  if (models.length === 0) {
    console.error("probe-model: --vision needs at least one model id (the catalog does not say which models accept images).");
    return 2;
  }
  console.error(`probe-model: vision round trip on ${baseUrl} for ${models.length} model(s)`);
  const rows = [];
  try {
    for (const model of models) rows.push(await probeVision(model, { baseUrl, apiKey, timeoutMs, fetch: inferenceFetch(baseUrl) }));
  } catch (err) {
    console.error(`probe-model: ${err instanceof VultrError ? `${err.kind}: ` : ""}${err instanceof Error ? err.message : String(err)}`);
    return err instanceof VultrError && err.kind === "auth" ? 3 : 1;
  }
  console.log(formatVisionTable(rows));
  console.log("");
  const passed = rows.filter((r) => r.ok && r.recognized).map((r) => r.model);
  if (passed.length === 0) {
    console.log("No model named the image's colour. Do not set AIRLOCK_MODEL_VISION=1 for these models.");
    return 1;
  }
  console.log(`Vision round trip passed: ${passed.join(", ")}. AIRLOCK_MODEL_VISION=1 is supported for ${passed.length === 1 ? "it" : "them"}.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`probe-model: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
