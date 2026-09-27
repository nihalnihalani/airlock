#!/usr/bin/env bun
/**
 * Checks the credentials Airlock's deployment needs, by presence and by a safe, read-only call each.
 * Never prints a key, a prefix of one, or a response body that could contain one.
 *
 *   bun scripts/check-keys.ts            reads the environment, then <repo>/.env
 *
 *   VULTR_API_KEY            GET https://api.vultr.com/v2/account          (account reachable, ACL ok)
 *                            GET https://api.vultr.com/v2/instances        (lists Airlock-labelled instances)
 *                            GET https://api.vultr.com/v2/ssh-keys         (is `airlock-hackathon` registered?)
 *   VULTR_INFERENCE_API_KEY  GET https://api.vultrinference.com/v1/models  (key accepted; is AIRLOCK_MODEL listed?)
 *   AIRLOCK_MODEL            one tiny forced tool call through the pinned base URL (tool round trip works)
 *
 * Exit 0 when every required check passes, 1 otherwise. Also reports whether the local deploy state
 * (data/deploy/state.json) and the SSH key (~/.ssh/airlock_ed25519) exist, since deploy.sh needs them.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const INFERENCE_BASE = "https://api.vultrinference.com/v1";

function fileEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    // Strip an inline comment on an unquoted value, then surrounding quotes.
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, "");
    value = value.replace(/^(["'])(.*)\1$/, "$2").trim();
    out[m[1]!] = value;
  }
  return out;
}
const FILE = fileEnv(join(ROOT, ".env"));
const get = (k: string) => (process.env[k]?.trim() || FILE[k] || "").trim();

let failures = 0;
const ok = (msg: string) => console.log(`  ok   ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const info = (msg: string) => console.log(`  --   ${msg}`);
/** A bounded, secret-free description of an HTTP failure: status plus the API's own error field if short. */
async function why(res: Response): Promise<string> {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: unknown; message?: unknown };
    const e = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
    detail = e.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 160);
  } catch {
    /* not json */
  }
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}
async function fetchT(url: string, init: RequestInit, ms = 20_000): Promise<Response> {
  return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(ms) });
}

console.log("== Vultr account API (VULTR_API_KEY)");
const vultrKey = get("VULTR_API_KEY");
if (!vultrKey) bad("VULTR_API_KEY is not set (environment or .env)");
else {
  const auth = { authorization: `Bearer ${vultrKey}` };
  try {
    const acct = await fetchT("https://api.vultr.com/v2/account", { headers: auth });
    if (acct.ok) {
      const a = ((await acct.json()) as { account?: { acls?: string[]; balance?: number; pending_charges?: number } }).account ?? {};
      ok(`account reachable; ACLs: ${(a.acls ?? []).join(", ") || "(none listed)"}`);
      if (typeof a.balance === "number") info(`balance ${a.balance}, pending charges ${a.pending_charges ?? "?"}`);
    } else bad(`GET /v2/account → ${await why(acct)} (a 401 usually means the key is wrong or this IP is not in the key's access control list)`);
    const inst = await fetchT("https://api.vultr.com/v2/instances?per_page=100", { headers: auth });
    if (inst.ok) {
      const list = ((await inst.json()) as { instances?: { id: string; label: string; tags?: string[]; region: string; plan: string; status: string; power_status: string; main_ip: string }[] }).instances ?? [];
      const ours = list.filter((i) => /airlock/i.test(i.label) || (i.tags ?? []).some((t) => /airlock/i.test(t)));
      ok(`instances listed: ${list.length} in the account, ${ours.length} labelled/tagged airlock`);
      for (const i of ours) info(`${i.label} ${i.id} ${i.region} ${i.plan} ${i.status}/${i.power_status} ${i.main_ip}`);
    } else bad(`GET /v2/instances → ${await why(inst)}`);
    const keys = await fetchT("https://api.vultr.com/v2/ssh-keys?per_page=100", { headers: auth });
    if (keys.ok) {
      const names = (((await keys.json()) as { ssh_keys?: { name: string }[] }).ssh_keys ?? []).map((k) => k.name);
      const wanted = get("AIRLOCK_SSHKEY_NAME") || "airlock-hackathon";
      if (names.includes(wanted)) ok(`SSH key "${wanted}" is registered in the account`);
      else info(`SSH key "${wanted}" is not registered (registered: ${names.length}); provision.sh needs it`);
    } else bad(`GET /v2/ssh-keys → ${await why(keys)}`);
  } catch (error) {
    bad(`Vultr API unreachable: ${error instanceof Error ? error.message.slice(0, 160) : "error"}`);
  }
}

console.log("== Vultr Serverless Inference (VULTR_INFERENCE_API_KEY)");
const inferenceKey = get("VULTR_INFERENCE_API_KEY");
const model = get("AIRLOCK_MODEL");
if (!inferenceKey) bad("VULTR_INFERENCE_API_KEY is not set (environment or .env)");
else {
  const auth = { authorization: `Bearer ${inferenceKey}` };
  try {
    const res = await fetchT(`${INFERENCE_BASE}/models`, { headers: auth });
    if (!res.ok) bad(`GET /v1/models → ${await why(res)} (401 and 422 are both authentication failures on this API)`);
    else {
      const ids = (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
      ok(`key accepted; ${ids.length} models listed`);
      if (!model) info(`AIRLOCK_MODEL is not set; models available: ${ids.slice(0, 30).join(", ")}`);
      else if (ids.includes(model)) ok(`AIRLOCK_MODEL "${model}" is listed`);
      else bad(`AIRLOCK_MODEL "${model.slice(0, 80)}" is not in the live list (available: ${ids.slice(0, 30).join(", ")})`);
      if (model && ids.includes(model)) {
        const body = {
          model,
          max_tokens: 256,
          messages: [{ role: "user", content: "Call the add tool with a=2 and b=3." }],
          tools: [{ type: "function", function: { name: "add", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } } }],
          tool_choice: { type: "function", function: { name: "add" } },
        };
        const chat = await fetchT(`${INFERENCE_BASE}/chat/completions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }, 60_000);
        if (!chat.ok) bad(`tool-call probe → ${await why(chat)}`);
        else {
          const j = (await chat.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
          const call = j.choices?.[0]?.message?.tool_calls?.[0]?.function;
          let args: { a?: number; b?: number } = {};
          try {
            args = JSON.parse(call?.arguments ?? "{}");
          } catch {
            /* malformed */
          }
          if (call?.name === "add" && args.a === 2 && args.b === 3) ok(`tool-call round trip works with ${model}`);
          else bad(`tool-call probe: the model did not return add(2,3) (got ${call?.name ?? "no tool call"})`);
        }
      }
    }
  } catch (error) {
    bad(`inference API unreachable: ${error instanceof Error ? error.message.slice(0, 160) : "error"}`);
  }
}

console.log("== Local deploy prerequisites");
const state = join(ROOT, "data/deploy/state.json");
existsSync(state) ? ok("data/deploy/state.json present") : info("data/deploy/state.json absent (provision.sh creates it, or copy it from the machine that deployed)");
existsSync(join(ROOT, "data/deploy/secrets.env")) ? ok("data/deploy/secrets.env present") : info("data/deploy/secrets.env absent (deploy.sh generates it on first run; copy it to keep existing passwords)");
const sshKey = get("AIRLOCK_SSH_KEY") || join(homedir(), ".ssh/airlock_ed25519");
existsSync(sshKey) ? ok(`SSH private key present (${sshKey.replace(homedir(), "~")})`) : info(`SSH private key absent (${sshKey.replace(homedir(), "~")}); needed to reach the VMs`);

console.log(failures === 0 ? "KEYS: all required checks passed" : `KEYS: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
