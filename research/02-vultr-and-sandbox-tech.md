# 02 — Vultr Stack and Sandbox Tech: Build Reference

Researched 2026-09-26, the morning of the event. Live-checked items are marked **[verified]**. Items that could not be tested without an API key are marked **[verify at kickoff]**. Raw captures are in `.firecrawl/vultr/`: `models.json`, `vinf-openapi.json` (the full Inference OpenAPI spec pulled from the Redoc page), `vultr-api.md` (the full Vultr API v2 reference), and `api-*.json` (public plans, regions, OS and app lists).

---

## 1. TL;DR: recommended stack

| Layer | Pick | Why |
|---|---|---|
| LLM | **Vultr Serverless Inference** at `https://api.vultrinference.com/v1`, OpenAI-compatible (it also has Anthropic `/v1/messages` and OpenAI `/v1/responses`) | Required. Tool calling works on 15 of the 19 live models. |
| Planner model | **`glm-5.3`** ($0.75/$3.00 per M tokens, 1M context, tools, vision, enforced reasoning budget) | The catalog describes it as the strongest option for "complex coding and long-horizon agentic work". |
| Executor / tool-loop model | **`deepseek-v4-flash-0731`** ($0.10/$0.25) or **`qwen3.8-flash-next`** ($0.10/$0.20) | Cheap and fast for many tool-call turns. `glm-5.3-flash` ($0.10/$0.35) is the vision-capable fallback. |
| Guardrail model | **`nemotron-3.5-content-safety`** | Screens planned commands and URLs before dispatch. Good for the "Blast Radius Zero" story. |
| Control-plane VM | 1× `vhp-4c-8gb-amd` in **`atl`** ($0.066/hr) | All inference models are served from `atl`, so putting the VM there keeps LLM round trips short. Runs the web app, agent loop, DB and job queue. |
| Sandbox host VM | 1× `vhp-8c-16gb-amd` (not in atl; use `sjc`/`lax`/`ewr`) **or** `vx1-g-4c-16g-240s` in `atl` ($0.153/hr) | Docker plus **gVisor (`runsc`)**. Use VX1 if you want KVM (Kata or Firecracker). Per Vultr's blog, VX1 is the family that supports nested virtualization. |
| Sandbox runtime | **Docker + gVisor `runsc`**. Optionally put **OpenSandbox** (docker runtime) in front for SDK, lifecycle and browser images. | Takes about 15 minutes, needs no KVM, and gives a real kernel boundary. OpenSandbox adds a Python/TS SDK, an MCP server, a browser image with VNC and CDP, and TTL cleanup. |
| "Throwaway VM" tier | Vultr API v2 `POST /v2/instances` with cloud-init, `DELETE` when done | Shows Vultr acting as the orchestrator, not just the host. Use it for high-risk tasks. Boot takes minutes, so keep a warm pool of 1–2 VMs. |
| Browser | Chromium/Playwright in a gVisor container, driven over **CDP** (`connect_over_cdp` / `browser-use` `cdp_url`), with a live view via **noVNC** or **CDP `Page.startScreencast`** | Ready-made images: `ghcr.io/agent-infra/sandbox` (AIO) and `opensandbox/chrome` / `opensandbox/playwright`. |
| Egress control | Code sandboxes run with `--network none`. Browser sandboxes sit on an `--internal` Docker network behind an allowlisting proxy, with nftables on the host. | **The Vultr Firewall does not filter outbound traffic** (Vultr FAQ). Egress control has to happen inside the VM. |

What to show judges: a plan from `glm-5.3`, then a safety check, then a dispatch to a gVisor sandbox or a fresh Vultr VM, then real stdout and screenshots with hashes, then teardown. All of it should be visible in the web UI.

---

## 2. Vultr Serverless Inference

### 2.1 Provisioning and auth
- Provision the subscription in the console (Products → Serverless → Inference → Add), or by API:
  ```bash
  curl https://api.vultr.com/v2/inference -X POST \
    -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json" \
    --data '{"label":"agent-arena"}'
  curl https://api.vultr.com/v2/inference/{inference-id} -H "Authorization: Bearer $VULTR_API_KEY"   # response includes the inference API key
  # CLI: vultr-cli inference create --label agent-arena ; vultr-cli inference get <id>
  ```
- There are **two different keys**. `VULTR_API_KEY` (account key) is for `api.vultr.com/v2`. `INFERENCE_API_KEY` (per-subscription key) is for `api.vultrinference.com/v1`. Both are sent as `Authorization: Bearer <key>`. The inference key can be regenerated from the subscription Overview page, which invalidates the old one.
- Usage: `GET https://api.vultr.com/v2/inference/{id}/usage`, or `GET https://api.vultrinference.com/v1/usage`.

### 2.2 API surface (from the live OpenAPI spec, v1.1.3) **[verified]**
Base URL: `https://api.vultrinference.com/v1`

| Endpoint | Notes |
|---|---|
| `POST /chat/completions` | OpenAI format. Supports `stream`, `tools`, `tool_choice` (`none`/`auto`/`required`/specific function/`allowed_tools`), `reasoning_effort` (`ultra…minimal`, `none`), `reasoning.max_tokens`, `max_completion_tokens` (counts reasoning tokens), `logprobs`, `seed`, `n`, `stop`. A final `assistant` message is treated as a prefill and continued. **`response_format` / JSON mode is not in the spec.** |
| `POST /messages` | **Anthropic Messages format**: `system`, content blocks, `tool_use`/`tool_result`, `thinking`, SSE event names. |
| `POST /responses` | OpenAI Responses format (`input`, `max_output_tokens`, `reasoning`). |
| `POST /chat/completions/RAG` | Chat grounded on a vector-store `collection`. Tools are allowed. |
| `/vector_store` (+ `/{id}/items`, `/{id}/files`, `/{id}/search`) | Managed collections. Items and files are embedded server-side. **There is no raw `/embeddings` endpoint.** |
| `POST /rerank` | `bge-reranker-v2-m3`, `vultron-retriever-*`. This is the only endpoint whose spec documents `429 Rate limit exceeded`. |
| `POST /images/generations` | `z-image-turbo`. Sizes 256–1792. Returns `url` (expires in 1 h) or `b64_json`. Costs $0.02/megapixel. |
| `POST /audio/speech`, `GET /audio/voices` | TTS endpoint exists (input up to 2,000 chars), but **no TTS model appears in the public `/v1/models` list**. Check `/v1/models/all` with a key. **[verify at kickoff]** |
| `GET /models` (**public, no key**), `/models/all`, `/models/{id}`, `/usage`, `/health` | Every endpoint except `/models` returns `401 No API key provided` without a key. |

Model-name modifiers from the spec:
- `<model>-normalize` routes the response through a normalizer. It rewrites `reasoning_content` to `reasoning`, rewrites tool-call IDs of the form `functions.x:N` to `chatcmpl-tool-<hash>`, and turns `content=null` into `""` when tool calls are present. **Use this if the OpenAI SDK, Vercel AI SDK or LangChain chokes on tool calls.**
- `<model>:express` derives a thinking budget automatically.

### 2.3 Live model list **[verified 2026-09-26]**
The guide's URL, `https://api.vultrinference.com/v1/chat/models`, **returns 404**. Use `https://api.vultrinference.com/v1/models`, which is public and needs no key. It returned 19 models, all served from datacenter **`atl`** (US).

| Model id | Kind | Context | Tools | Inputs | $/M in | $/M out | Reasoning budget enforced |
|---|---|---|---|---|---|---|---|
| `bge-reranker-v2-m3` | rerank | 8K | no | text | - | 0.05 | - |
| `deepseek-v4-flash-0731` | text | 1M | yes | text+image | 0.10 | 0.25 | no |
| `deepseek-v4.1-flash` | text | 1M | yes | text+image | 0.15 | 0.60 | yes |
| `glm-5.2` | text | 1M | yes | text+image | 0.75 | 3.00 | yes |
| `glm-5.3` | text | 1M | yes | text+image | 0.75 | 3.00 | yes |
| `glm-5.3-flash` | text | 1M | yes | text+image+video | 0.10 | 0.35 | yes |
| `glm-5.x-menthol` | text | 198K | yes | text+image | 0.40 | 1.75 | yes |
| `laguna-s-2.1` | text | 1M | yes | text+image | 0.09 | 0.18 | no |
| `mimo-v2.6-flash-rl` | text | 1M | yes | text+image+audio+video | 0.10 | 0.25 | no |
| `mimo-v2.6-pro-rl` | text | 1M | yes | text+image+audio+video | 0.40 | 0.80 | no |
| `minimax-m3` | text | 512K | yes | text+image+video | 0.20 | 0.90 | yes |
| `muse-glimmer-30b` | text | 128K | yes | text+image+video | 0.25 | 1.00 | yes |
| `nemotron-3-nano-omni-30b-a3b-reasoning` | text | 256K | yes | text+image+audio+video | 0.10 | 0.25 | yes |
| `nemotron-3.5-content-safety` | text (moderation) | 128K | no | text+image | 0.05 | 0.15 | yes |
| `qwen3.8-27b` | text | 256K | yes | text+image+video | 0.15 | 1.00 | yes |
| `qwen3.8-flash-next` | text | 256K | yes | text+image+video | 0.10 | 0.20 | yes |
| `vultron-retriever-core-qwen3.5-4.5b` | rerank | 256K | no | text | - | 0.10 | - |
| `vultron-retriever-flash-qwen3.5-0.8b` | rerank | 256K | no | text | - | 0.05 | - |
| `z-image-turbo` | image | - | no | text | - | $0.02/MP | - |

"Tools" means the model's `supported_parameters` includes `tools: true`. Every text model except the safety model supports reasoning with efforts `ultra, max, xhigh, high, medium, low, minimal`. The Nemotron models do not expose effort levels.

**Which model to use.** Actual tool-calling quality is not benchmarked here. Run a 10-minute smoke test at kickoff.
- **Planning / hard reasoning:** `glm-5.3`, with `reasoning_effort: "medium"` and a budget via `reasoning.max_tokens`. The catalog describes it as the best at "complex coding and long-horizon agentic work". Backup: `minimax-m3` or `mimo-v2.6-pro-rl`.
- **Tool-call loop (many turns, low latency):** `deepseek-v4-flash-0731` (described as "substantially enhanced agentic capabilities", $0.10/$0.25) or `qwen3.8-flash-next`. Use `reasoning_effort: "low"` or `"none"`.
- **Browser agent that needs screenshots:** `glm-5.3-flash` or `qwen3.8-27b`, since both take image and video input.
- **Guardrail:** `nemotron-3.5-content-safety` (can apply a custom policy) to screen commands and URLs before sandbox dispatch.
- Budget math: at the flash models' ~$0.25/M output, $200 of credits is effectively unlimited. Only `glm-5.3` at $3/M output needs any care.

### 2.4 Minimal calls
```bash
export VINF=https://api.vultrinference.com/v1
curl $VINF/chat/completions -H "Authorization: Bearer $INFERENCE_API_KEY" -H "Content-Type: application/json" -d '{
  "model": "deepseek-v4-flash-0731",
  "stream": true,
  "reasoning_effort": "low",
  "max_completion_tokens": 2048,
  "messages": [{"role":"system","content":"You are an agent. Use tools."},
               {"role":"user","content":"List files in /work and run tests"}],
  "tools": [{"type":"function","function":{"name":"run_in_sandbox","description":"Run a shell command in an isolated sandbox",
            "parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}}],
  "tool_choice": "auto"
}'
```
```python
from openai import OpenAI
llm = OpenAI(base_url="https://api.vultrinference.com/v1", api_key=os.environ["INFERENCE_API_KEY"])
r = llm.chat.completions.create(model="glm-5.3-normalize", messages=msgs, tools=tools, reasoning_effort="medium")
```
- Anthropic SDK: `Anthropic(base_url="https://api.vultrinference.com", auth_token=KEY)`. Use `auth_token` so the SDK sends `Authorization: Bearer`. **[verify at kickoff]**
- Vector store (for "memory", not a basic-RAG product, since basic RAG is a listed anti-project): `POST /vector_store {"name":...}`, then `POST /vector_store/{id}/items {"content","description"}`, then `POST /vector_store/{id}/search {"input":...}`.

### 2.5 Pricing and limits
- The marketing page and the support FAQ both say "$0.55 per 1M input tokens and $2.75 per 1M output tokens". The live `/v1/models` lists **per-model** prices that range from $0.09 to $0.75 in and $0.18 to $3.00 out. It is unclear which one billing actually uses. Watch `/v1/usage` after the first hour. **[verify at kickoff]**
- Rate limits: **no published numbers** for inference. Only `/rerank` documents a 429. Build retries with exponential backoff and jitter. Keep concurrent streams modest, around 5–10.
- Old Reddit posts mention a "$10/mo for 50M tokens" plan. That appears to be the retired beta; don't plan around it.

### 2.6 Gotchas
1. **The docs are out of date compared with the live catalog.** The Chat and RAG docs say "Tool calling is currently supported only on the kimi-k2-instruct model", and list RAG models such as `llama-3.3-70b-instruct-fp8` and `qwen2.5-32b-instruct`. None of those appear in the live list. Trust `GET /v1/models`, and read `tools` and `max_context_length` from it at startup.
2. Tool-call IDs look like `functions.get_horoscope:0` (seen in Vultr's own tool-calling guide), and reasoning arrives in `reasoning_content`. Strict clients may break on either. Use the `-normalize` suffix.
3. `max_completion_tokens` **includes reasoning tokens**, so a small cap with high effort can return empty content. Set effort explicitly on every call.
4. There is no JSON mode. For structured plans, force a function call with `tool_choice: {"type":"function","function":{"name":"emit_plan"}}`.
5. There is no `/embeddings` endpoint. If you need your own vectors, use the vector store's search API or embed locally (for example with `fastembed` on the VM).
6. Models are served only from `atl`, so put the control plane VM in `atl`.

---

## 3. Vultr API v2: throwaway-instance pattern

Base `https://api.vultr.com/v2`, `Authorization: Bearer $VULTR_API_KEY`. **Rate limit: 30 req/s per IP**; a 429 comes with `Retry-After` **[verified in the API reference]**. Pagination uses `per_page` (max 500) and `cursor`. `/regions`, `/plans`, `/os`, `/applications` and `/plans-metal` are public with no key **[verified]**.

### 3.1 Useful IDs (pulled live)
- **Regions near SF:** `sjc` (Silicon Valley), `lax`, `sea`. **Inference lives in `atl`.** All of these offer `kubernetes` and `load_balancers`.
- **OS:** `2284` Ubuntu 24.04, `2760` Ubuntu 26.04, `1743` Ubuntu 22.04, `2136` Debian 12. Pseudo-OS ids: `164` Snapshot, `186` Application, `426` Marketplace.
- **Marketplace apps:** `1125` Docker on Ubuntu 24.04 (`image_id: "docker"`), `1255` k3s, `1334` **NetBird Server** (for the bonus track), `1246` BrowserBox, `1265` Coolify.
- **Plans (hourly):**

| Plan | vCPU / RAM / disk | $/hr | Notes |
|---|---|---|---|
| `vc2-1c-1gb` | 1 / 1 GB / 25 GB | 0.007 | cheapest per-task throwaway |
| `vc2-2c-4gb` | 2 / 4 GB / 80 GB | 0.027 | throwaway VM that runs a browser |
| `vhp-4c-8gb-amd` | 4 / 8 GB / 180 GB | 0.066 | control plane (in atl) |
| `vhp-8c-16gb-amd` | 8 / 16 GB / 350 GB | 0.132 | sandbox host (sjc/lax/ewr, **not atl**) |
| `vx1-g-2c-8g-120s` | 2 / 8 GB / 120 GB local | 0.076 | **VX1 = nested virtualization** (atl, sjc) |
| `vx1-g-4c-16g-240s` | 4 / 16 GB / 240 GB local | 0.153 | KVM host for Kata, Firecracker or E2B |
| `vbm-4c-32gb` (bare metal) | E3-1270, 8 threads / 32 GB | 0.164 | real `/dev/kvm`; ewr, lax, sjc, mia; slow to provision |

VX1 plan ids **without** the `-NNNs` suffix have no local disk (`disk: 1`). They need `block_devices: [{"disk_size":50,"bootable":true}]`. Pick the `-120s`/`-240s` variants to avoid this.

### 3.2 Create-instance fields that matter (`POST /v2/instances` returns 202)
`region`*, `plan`*, and exactly one of `os_id` | `snapshot_id` | `app_id` | `image_id` | `iso_id`. Other fields: `label`, `hostname`, `tags[]`, `sshkey_id[]`, `script_id` (startup script), **`user_data` (base64 cloud-init)**, `firewall_group_id`, `enable_vpc` / `attach_vpc[]`, **`vpc_only`** (no public NIC; egress through the VPC's NAT Gateway), `enable_ipv6`, `disable_public_ipv4`, `backups: "disabled"`, `activation_email: false`, `user_scheme` (`root`|`limited`), `app_variables`, and `block_devices` (VX1 only).

The response contains `instance.id`, `status: "pending"`, `server_status: "none"`, `main_ip: "0.0.0.0"`, and **`default_password`**. Never log the password. The instance is ready when `status == "active"` and `server_status == "ok"`, and `main_ip` then holds the real IP.

### 3.3 Curl recipe: create, poll until ready, run, destroy
```bash
export API=https://api.vultr.com/v2 AUTH="Authorization: Bearer $VULTR_API_KEY"
TASK=t$(date +%s)

# 0) one-time setup: SSH key + firewall group (inbound SSH only from the control-plane IP)
SSH=$(curl -s -X POST $API/ssh-keys -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"name\":\"orchestrator\",\"ssh_key\":\"$(cat ~/.ssh/id_ed25519.pub)\"}" | jq -r .ssh_key.id)
FW=$(curl -s -X POST $API/firewalls -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"description":"sandbox-inbound"}' | jq -r .firewall_group.id)
curl -s -X POST $API/firewalls/$FW/rules -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"ip_type\":\"v4\",\"protocol\":\"tcp\",\"subnet\":\"$CONTROL_IP\",\"subnet_size\":32,\"port\":\"22\",\"notes\":\"orchestrator\"}"

# 1) cloud-init: Docker + gVisor + default-deny egress, then phone home
cat > ci.yaml <<'EOF'
#cloud-config
package_update: true
packages: [docker.io, nftables, jq]
runcmd:
  - curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  - echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  - apt-get update && apt-get install -y runsc && runsc install && systemctl restart docker
  - docker pull python:3.12-slim
  - curl -fsS -X POST "https://CONTROL_PLANE/api/vm-ready?id=$(curl -s http://169.254.169.254/v1/instance-v2-id)" || true
EOF
UD=$(base64 < ci.yaml | tr -d '\n')          # user_data MUST be base64

# 2) create
ID=$(curl -s -X POST $API/instances -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"region\":\"atl\",\"plan\":\"vc2-2c-4gb\",\"os_id\":2284,
  \"label\":\"sbx-$TASK\",\"hostname\":\"sbx-$TASK\",\"tags\":[\"sandbox\",\"task-$TASK\"],
  \"sshkey_id\":[\"$SSH\"],\"firewall_group_id\":\"$FW\",\"user_data\":\"$UD\",
  \"backups\":\"disabled\",\"activation_email\":false}" | jq -r .instance.id)

# 3) poll until active/ok (usually about 1–2 minutes; cloud-init then needs roughly 1–3 more)
until [ "$(curl -s $API/instances/$ID -H "$AUTH" | jq -r '.instance.status+"/"+.instance.server_status')" = "active/ok" ]; do sleep 5; done
IP=$(curl -s $API/instances/$ID -H "$AUTH" | jq -r .instance.main_ip)
until ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 root@$IP 'cloud-init status --wait' ; do sleep 5; done

# 4) run the task inside gVisor with no network, and collect output + hash
ssh root@$IP 'docker run --rm --runtime=runsc --network=none --read-only --tmpfs /tmp \
  --cap-drop=ALL --pids-limit=256 --memory=1g --cpus=1 python:3.12-slim \
  python -c "print(sum(range(10**6)))"' | tee out.txt; sha256sum out.txt

# 5) destroy (204). Also run a janitor that deletes anything tagged "sandbox" older than N minutes.
curl -s -X DELETE $API/instances/$ID -H "$AUTH"
curl -s "$API/instances?per_page=500" -H "$AUTH" | jq -r '.instances[] | select(.tags|index("sandbox")) | .id'
```
**Faster variant.** Build one "golden" VM (Docker, runsc and images already pulled), then `POST /v2/snapshots {"instance_id":...}` and create workers with `"snapshot_id":"..."` instead of `os_id` and cloud-init. Measure it, because restoring a snapshot is not always faster than a fresh OS plus a small cloud-init. The biggest win is a **warm pool**: pre-create 1–2 VMs and hand one to each high-risk task.

**Startup scripts** (alternative to cloud-init): `POST /v2/startup-scripts {"name","type":"boot","script":"<base64>"}` (64 KB limit), then pass `script_id` at create.

### 3.4 Other Vultr building blocks (API tags confirmed in the v2 reference)
- **Firewall groups** (`/firewalls`, rules take `ip_type/protocol/subnet/subnet_size/port`, with `source: "cloudflare"` supported). **They filter inbound traffic only.**
- **VPC** (`POST /vpcs {region, description, ...}`) and **NAT Gateway** (`POST /vpcs/{id}/nat-gateway`, plus NAT firewall and port-forward rules). Combined with `vpc_only: true`, sandbox VMs get no public IP at all, and the orchestrator reaches them on `internal_ip`.
- **Tags:** `tags[]` on create. The `?tag=` list filter is deprecated, so filter client-side.
- **Instance Templates and Clusters** (new API tags): reusable plan, OS, keys and VPC definitions. These could replace hand-rolled JSON for a VM pool; they are aimed at GPU fabric.
- **Bare metal** `POST /v2/bare-metals`, same shape. Real KVM, but provisioning is slow (budget 10+ minutes) and it is expensive for a hackathon.
- **VKE (Kubernetes)** `POST /v2/kubernetes/clusters {region, version, node_pools[], vpc_id, enable_firewall}`. Current versions are `v1.37.1+1`, `v1.36.5+1`, `v1.35.9+1` (public endpoint). **Not recommended in 24 h.** It adds provisioning time and extra layers to debug, and gVisor on managed nodes needs a DaemonSet install.
- **Container Registry** `POST /v2/registry {name, public, region, plan:"start_up"}`. Handy for pushing a custom sandbox image once and pulling it onto throwaway VMs.
- **Object Storage** `POST /v2/object-storage {cluster_id, tier_id, label}` (S3-compatible). Good for storing artifacts, logs and screenshots as "verifiable output".
- **Managed Databases** `POST /v2/databases` (Postgres, Valkey, etc.). Postgres in Docker on the control-plane VM is faster to set up for a hackathon.
- **Serverless Inference** subscriptions are also managed under `/v2/inference`.

---

## 4. Sandbox options comparison (running on Vultr VMs)

| Option | Setup time (24 h hackathon) | Isolation strength | Needs `/dev/kvm`? | Headless Chromium / Playwright inside | Egress control | Verdict |
|---|---|---|---|---|---|---|
| **Docker (runc) + seccomp, `--network none`, cap-drop, read-only** | ~10 min | Weak–medium: shared host kernel, and kernel exploits escape | No | Easy (`mcr.microsoft.com/playwright`); Chrome needs `--no-sandbox` or a custom seccomp profile | `--network none`, or an `--internal` network plus a proxy; `DOCKER-USER` iptables chain | Baseline only; judges will ask "what about kernel escapes?" |
| **gVisor (`runsc`) + Docker** | ~15 min (`apt install runsc && runsc install && systemctl restart docker`) | Strong: user-space kernel intercepts syscalls; default systrap platform needs no KVM | **No**, so it works on any vc2/vhp plan | Works in practice with `--no-sandbox --disable-dev-shm-usage`; partial syscall compatibility, so smoke-test **[verify]** | `--network none` works; allowlists need an `--internal` network plus a proxy container. **OpenSandbox's egress sidecar does NOT work under gVisor** (no iptables `nat` table) | **Recommended default** |
| **OpenSandbox** (opensandbox-group, Apache-2.0, ~15.5k stars, very active) | 30–60 min (`uvx opensandbox-server init-config ~/.sandbox.toml --example docker`) | Whatever runtime it uses: runc, gVisor, Kata or Firecracker via `[secure_runtime]` | Only for Kata or Firecracker | **Yes, first-class**: `opensandbox/chrome` (VNC :5901 plus DevTools :9222), `playwright`, and `desktop` examples, with endpoints proxied through the server | **Built-in**: per-sandbox `networkPolicy` (FQDN/wildcard/CIDR allow/deny, DNS plus nftables, credential vault). Requires `network_mode="bridge"` and a non-gVisor runtime | Strong pick if you want an SDK, an MCP server and a browser image without writing them yourself |
| **Kata Containers** | 1–2 h | VM-level (own kernel per container) | **Yes**: VX1 or bare metal only | Full syscall compatibility | Works with iptables and the OpenSandbox egress sidecar | Best isolation-to-effort ratio **if** `/dev/kvm` exists on VX1 |
| **Firecracker (raw)** | 4 h+ (kernel, rootfs, tap networking, jailer) | Strongest, minimal VMM | **Yes** | You build the rootfs yourself | Manual tap plus nftables | Only through E2B Embed or OpenSandbox/Kata, never raw |
| **E2B self-hosted ("E2B Embed", repo now `e2b-dev/runtime`)** | 1–2 h: `curl compose.yaml + .env && docker compose up -d --wait` | Firecracker microVMs, snapshot restore, pause/resume, fork | **Yes**, plus Ubuntu 24.04, kernel ≥6.8, Docker ≥27, **12 GiB RAM** (4 GiB hugepages), 20 GiB disk | Via custom templates built from Docker images | Per-sandbox nftables firewall plus SNI/Host domain allow/deny lists | Only on `vx1-g-4c-16g-240s` or bigger. "Evaluation package, not production." **Port 5008 (orchestrator gRPC) is unauthenticated**, so bind or firewall it. Using E2B Cloud would break the "sandbox on Vultr" rule |
| **AIO Sandbox** (`ghcr.io/agent-infra/sandbox`, Apache-2.0, ~6k stars) | ~5 min | Container. The README runs it with `--security-opt seccomp=unconfined`, which weakens it, so **run it under `--runtime=runsc`** **[verify it boots under gVisor]** | No | **Yes**: browser plus VNC (`/vnc/index.html`), CDP URL via SDK, shell, files, VS Code, Jupyter, MCP at `/mcp` | Container network plus proxy; set `SANDBOX_API_KEY` | Fastest route to a "computer-use" demo |
| **Throwaway Vultr VM per task** | Already covered by §3 | Strongest separation (separate VM on Vultr's hypervisor) | n/a | Anything | In-VM nftables (Vultr Firewall does not filter egress), or `vpc_only` plus NAT Gateway | Use for "high-risk" tasks; keep a warm pool |

**Does Vultr support KVM or nested virtualization?** Vultr's blog says "Vultr VX1 supports nested virtualization, enabling businesses to deploy microVM solutions" (blogs.vultr.com/cpus-workhorse-agentic-ai-infrastructure). A 2026 Better Stack review found VT-x/AMD-V disabled on shared-CPU plans. Bare metal (`vbm-*`) has real KVM. **Check immediately after boot with `ls -l /dev/kvm && egrep -c '(vmx|svm)' /proc/cpuinfo`.** If `/dev/kvm` is missing, stay on gVisor.

Egress recipe for gVisor sandboxes (no dependency on the OpenSandbox sidecar):
```bash
docker network create --internal sbx-net                       # no route out
docker run -d --name egress --network bridge <squid/tinyproxy with domain allowlist>
docker network connect sbx-net egress
docker run --runtime=runsc --network sbx-net -e HTTPS_PROXY=http://egress:3128 -e HTTP_PROXY=http://egress:3128 <browser-image>
# host-level backstop: nft/iptables DOCKER-USER drop from sandbox subnets except to the proxy; also block 169.254.169.254 (metadata)
```

OpenSandbox hardening, because its defaults are unsafe on a public VM:
```toml
[server]      # set api_key = "<long random>"  (clients send header OPEN-SANDBOX-API-KEY)
[docker]
network_mode = "bridge"        # default is "host" (!)
publish_host = "127.0.0.1"     # default "0.0.0.0" publishes every sandbox port on the public NIC
[secure_runtime]
type = "gvisor"                # OR leave "" and use [egress] networkPolicy; you can't have both
docker_runtime = "runsc"
[egress]
image = "opensandbox/egress:v1.1.7"
mode  = "dns+nft"
```
```python
sbx = await Sandbox.create("python:3.12", timeout=timedelta(minutes=15), resource={"cpu":"1","memory":"1Gi"},
        network_policy=NetworkPolicy(defaultAction="deny", egress=[NetworkRule(action="allow", target="pypi.org")]))
out = await sbx.commands.run("python -c 'print(42)'"); await sbx.destroy()
```

---

## 5. Browser in a sandbox, streamed back

**Control channel (agent → browser): CDP.**
- Run Chromium in the sandbox with `--headless=new --remote-debugging-port=9222 --no-sandbox --disable-dev-shm-usage --no-zygote --disable-gpu --user-data-dir=/tmp/p` (or give the container `--shm-size=1g`).
- Chrome may bind CDP only to `127.0.0.1`. `chrome-headless-shell` ignores `--remote-debugging-address=0.0.0.0`. Expose it with `socat TCP-LISTEN:9223,fork TCP:127.0.0.1:9222` inside the container, **or** use Playwright's server (`npx playwright run-server --port 3000`, client `chromium.connect("ws://…")`).
- Client options:
  - Playwright: `browser = await p.chromium.connect_over_cdp("http://sbx:9223")`
  - browser-use: `Browser(cdp_url=...)` / `BrowserSession(cdp_url=...)` with `ChatOpenAI(base_url="https://api.vultrinference.com/v1", model="glm-5.3-flash")`, a vision model **[verify browser-use accepts it]**
  - Chrome DevTools MCP
- **Never publish 9222 publicly.** CDP is full remote control of the browser and can read `file://` and cookies. Keep it on the Docker network or localhost, and proxy it through your authenticated backend. Also block `169.254.169.254` from the sandbox.

**Live view (browser → user), two ways:**
1. **noVNC:** Xvfb (or Xtigervnc), x11vnc, then websockify/noVNC on port 6080. The web app embeds `/vnc/vnc.html?autoconnect=1` behind the auth proxy. Ready-made: the AIO sandbox's `/vnc/index.html?autoconnect=true`, `opensandbox/chrome` (VNC 5901), and the Vultr Marketplace **BrowserBox** app (id 1246).
2. **CDP screencast** (lighter; no X server; works headless): `Page.startScreencast {format:"jpeg", quality:60, everyNthFrame:2}`. Forward the `Page.screencastFrame` base64 frames over your own WebSocket to the UI and ack each one with `Page.screencastFrameAck`. This works well for a "watch the agent" panel. Also save every step's screenshot plus its SHA-256 to object storage as the audit trail ("verifiable output").

**Suggested topology on the sandbox host:**
`control-plane (atl)` ⇄ (VPC or NetBird/WireGuard) ⇄ `sandbox-host: [browser container, runsc, sbx-net internal] → [egress proxy, allowlist] → internet`, with the CDP and VNC ports reachable only over the VPC or the tunnel.

---

## 6. Hackathon-speed setup recipe (about 3 hours to a working skeleton)

| Time | Step |
|---|---|
| 0:00 | Redeem the $200 credits. Create a Vultr account API key (check the key's **Access Control / allowed IPs** setting and allow your laptop and the control-plane IP **[verify in console]**). Create the Serverless Inference subscription. `curl /v1/models` and do one tool-call smoke test each on `glm-5.3`, `deepseek-v4-flash-0731` and `qwen3.8-flash-next`. |
| 0:20 | Create the **control-plane VM**: `vhp-4c-8gb-amd`, `atl`, `app_id 1125` (Docker) or `os_id 2284`, with a firewall group allowing only 22 from your IP. Deploy the web app (FastAPI or Next.js), the agent loop, Postgres and Redis via docker compose. |
| 0:40 | Create the **sandbox-host VM**: `vx1-g-4c-16g-240s` in `atl` (or `vhp-8c-16gb-amd` in `sjc`). Run the §3.3 cloud-init (Docker plus runsc). Check `/dev/kvm`. Put both VMs in one **VPC** (`attach_vpc`). |
| 1:00 | Sandbox API: either (a) OpenSandbox server with the §4 TOML, or (b) a small FastAPI "sandbox daemon" that runs `docker run --runtime=runsc …` with limits and a TTL reaper. Pull `python:3.12-slim`, `mcr.microsoft.com/playwright:<ver>-noble` and `ghcr.io/agent-infra/sandbox`. |
| 1:45 | Browser path: the AIO or `opensandbox/chrome` container under runsc, CDP proxied to the control plane, a screencast or noVNC panel in the UI, and the egress proxy allowlist. |
| 2:15 | Throwaway-VM tier: a `vultr.py` wrapper for create, poll, run and destroy (§3.3), tags, a janitor cron, and a warm pool of 1. Show VM lifecycle events live in the UI. |
| 2:45 | Guardrails: `nemotron-3.5-content-safety` checks each planned action, a human-approval toggle for "risky" actions, and a per-task audit log (commands, outputs, hashes, screenshots, and the cost from `/v1/usage`). |
| Later | NetBird bonus: marketplace app `1334` (NetBird Server) on its own VM, and the control plane served through the NetBird reverse proxy with no open inbound ports. |

---

## 7. Risks and gotchas (consolidated)
1. **Docs vs. reality:** the guide's `/v1/chat/models` returns 404; use `/v1/models`. The docs' model names (kimi-k2-instruct, llama-3.3-70b, qwen2.5) are gone. Detect capabilities at runtime.
2. **Two keys and two hosts** (`api.vultr.com/v2` for the account, `api.vultrinference.com/v1` for inference). Never ship either key to the browser. The Inference API docs explicitly say not to embed keys in client-side code.
3. **Pricing ambiguity:** flat $0.55/$2.75 per M (marketing and FAQ) vs. per-model prices (`/v1/models`). Check `/v1/usage` early.
4. **No published inference rate limits.** Add backoff and cap concurrency. The Vultr control API is limited to 30 req/s per IP; honor `Retry-After`.
5. **Reasoning tokens count against `max_completion_tokens`.** Set `reasoning_effort` explicitly (`low` or `none` for tool loops) or answers come back empty or slow.
6. **Non-standard tool-call IDs and `reasoning_content`.** Use `model-normalize`.
7. **No JSON mode and no embeddings endpoint.** Use forced tool calls and the vector store.
8. **The Vultr Firewall is inbound-only.** Egress control must live in the VM (nftables, `--network none`, or a proxy), or use `vpc_only` plus NAT Gateway.
9. **`user_data` and startup `script` must be base64.** Startup scripts are capped at 64 KB. The create response returns `default_password`, so scrub it from logs.
10. **VM boot is minutes, not milliseconds.** Keep a warm pool and demo container sandboxes (sub-second under gVisor) for the fast path. Vultr bills compute by the hour, so tag everything and run a janitor. Leaked VMs burn the $200.
11. **KVM is only on VX1 or bare metal.** Kata, Firecracker and E2B Embed fail on vc2/vhp. Verify `/dev/kvm` before committing.
12. **VX1 plans without the `-NNNs` suffix have no boot disk.** They need `block_devices`, and VX1 block storage doesn't support auto-backups.
13. **OpenSandbox defaults** (`network_mode=host`, `publish_host=0.0.0.0`, empty `api_key`) are dangerous on a public VM. Its egress sidecar is incompatible with gVisor, so choose gVisor with your own proxy, or runc/Kata with the sidecar.
14. **The AIO sandbox README uses `seccomp=unconfined`.** Wrap it in runsc or treat it as weak isolation.
15. **E2B Embed** opens 13 ports, and port 5008 is unauthenticated. It is evaluation-grade and needs 12 GiB RAM and KVM.
16. **CDP and VNC exposure means takeover of the browser.** Keep them on private networks or a tunnel, behind auth. Block the metadata IP `169.254.169.254` from sandboxes.
17. **Rules:** sandboxes must run on Vultr and never inside the app process, so hosted E2B Cloud or Browserbase are out as the execution layer. Repos must be public; keep keys out of git.
18. Plans are region-specific: `vhp-8c-16gb-amd` is **not** offered in `atl`, while VX1 `-s` plans are offered in `atl` and `sjc` but not `lax`.

---

## 8. Source URLs
- Participant guide: `research/00-participant-guide.md`
- Inference provisioning: https://docs.vultr.com/products/serverless/inference/provisioning (now under https://docs.vultr.com/products/compute/serverless-inference/…)
- Inference API key: https://docs.vultr.com/products/compute/serverless-inference/management/connection
- Chat endpoint and tool calling: https://docs.vultr.com/products/compute/serverless-inference/management/usage/chat
- Tool-calling guide: https://docs.vultr.com/how-to-use-tool-calling-with-vultr-serverless-inference
- TTS: https://docs.vultr.com/products/compute/serverless-inference/management/usage/text-to-speech
- Vector store and RAG: https://docs.vultr.com/products/compute/serverless-inference/vector-store/rag-chat-collection (plus create-collections, add-collection-items, add-collection-files)
- Monitor usage: https://docs.vultr.com/products/compute/serverless-inference/management/monitor
- Inference FAQ: https://docs.vultr.com/products/compute/serverless-inference/faq
- Pricing FAQ: https://docs.vultr.com/support/products/serverless/how-do-i-monitor-the-usage-and-cost-of-my-vultr-serverless-inference-subscription
- Product page: https://www.vultr.com/products/cloud-inference/
- Inference OpenAPI (Redoc): https://api.vultrinference.com/ ; live models: https://api.vultrinference.com/v1/models
- Vultr API v2 reference: https://www.vultr.com/api/ (rate limit, create-instance, firewall, VPC/NAT, startup scripts, VKE, registry, S3, DBs, instance templates and clusters)
- Public lists: https://api.vultr.com/v2/regions , /v2/plans , /v2/os , /v2/applications , /v2/plans-metal , /v2/kubernetes/versions
- Cloud compute docs: https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning (plus features/cloud-init, networking/enable-firewall, features/snapshots)
- Firewall FAQ (no egress filtering): https://docs.vultr.com/products/network/firewall/faq
- govultr `InstanceCreateReq`: https://github.com/vultr/govultr/blob/master/instance.go
- VX1 nested virtualization: https://blogs.vultr.com/cpus-workhorse-agentic-ai-infrastructure ; shared-CPU VT-x disabled: https://betterstack.com/community/guides/web-servers/vultr-review/
- OpenSandbox: https://github.com/opensandbox-group/OpenSandbox (README, docs/guides/secure-container.md, docs/architecture/network/egress.md, server/configuration.md, docs/examples/chrome.md, docs/examples/playwright.md, sdks/sandbox/python/README.md)
- gVisor: https://gvisor.dev/docs/user_guide/install/ , https://gvisor.dev/docs/user_guide/quick_start/docker/
- E2B: https://github.com/e2b-dev/E2B , https://github.com/e2b-dev/runtime (formerly e2b-dev/infra), https://github.com/e2b-dev/runtime/blob/main/embed/README.md , embed/compose/README.md
- AIO Sandbox: https://github.com/agent-infra/sandbox
- browser-use remote CDP: https://docs.browser-use.com/open-source/customize/browser/remote ; browser-use/browser-use#4700
- Chrome CDP binding quirk: https://github.com/googlechromelabs/chrome-for-testing/issues/203 , https://issues.chromium.org/issues/41487252
