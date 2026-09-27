#!/usr/bin/env bun
/**
 * Measured model selection for Airlock (CLAUDE.md §2): runs a tool-call round trip against every
 * candidate model on Vultr Serverless Inference and recommends an AIRLOCK_MODEL.
 *
 * Usage:
 *   VULTR_INFERENCE_API_KEY=... bun scripts/probe-model.ts [model ...]
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
import { formatTable, probeModels, recommend } from "../apps/control/src/vultr-probe.ts";

async function main(): Promise<number> {
  const apiKey = process.env.VULTR_INFERENCE_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    console.error("probe-model: VULTR_INFERENCE_API_KEY is not set. Export it and run again.");
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
  const models = process.argv.slice(2).filter((m) => m.length > 0 && m.length <= 128);

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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`probe-model: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
