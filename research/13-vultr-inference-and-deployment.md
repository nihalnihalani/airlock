# 13 · Vultr Inference, Isolation Options, Deployment Topology and Cost

Observation window: **2026-09-26 10:49–11:20 UTC (16:19–16:50 IST, 03:49–04:20 PDT)**. No Vultr account, key, resource or subscription was created. Nothing was spent.

Builds on `02-vultr-and-sandbox-tech.md`. This file does **not** repeat its recipes (throwaway-VM curl flow, OpenSandbox hardening, browser/CDP). It re-verifies the key facts and adds what was missing.

Raw evidence is in `raw/vultr/`:
- `models.json`: live catalog
- `vinf-root.html`: live Redoc with spec v1.1.3
- `api_*.json`: public plans, metal, apps, regions
- `doc_*.txt`: Vultr docs
- `vultr-metadata.md`, `cloudinit_*.py`
- `gvisor_*.txt`
- `vultr-pricing-live.md`
- `probe_inference.sh`
- `probe_dryrun_invalid_key.summary.jsonl`

Status tags:
- **[live]**: fetched or observed today
- **[doc]**: vendor documentation, fetched today
- **[inferred]**: our reasoning
- **[unverified]**: needs a key, an account or a measurement

---

## 1. Serverless Inference: live catalog (`GET https://api.vultrinference.com/v1/models`, no key) [live 10:49:36Z]

- HTTP 200, 29,445 bytes, `schema_version 2.4`. The catalog has **19 models, all served from datacenter `atl` (US)**.
- `/v1/chat/models` (the guide's URL) → **404**.
- `/v1/models/all` without a key → 401.
- The list is identical to this morning's capture.

| Model id | Kind | Context (tokens) | `tools` | Inputs | Reasoning budget enforced (`supports_max_tokens`) | $/M in | $/M out | Quant |
|---|---|---|---|---|---|---|---|---|
| `glm-5.3` | chat | 1,048,576 | ✅ | text, image | ✅ | 0.75 | 3.00 | nvfp4 |
| `glm-5.2` | chat | 1,048,576 | ✅ | text, image | ✅ | 0.75 | 3.00 | nvfp4 |
| `glm-5.3-flash` | chat | 1,048,576 | ✅ | text, image, video | ✅ | 0.10 | 0.35 | nvfp4 |
| `glm-5.x-menthol` | chat | 202,752 | ✅ | text, image | ✅ | 0.40 | 1.75 | fp8 |
| `deepseek-v4-flash-0731` | chat | 1,048,576 | ✅ | text, image | ❌ | 0.10 | 0.25 | fp8 |
| `deepseek-v4.1-flash` | chat | 1,048,576 | ✅ | text, image | ✅ | 0.15 | 0.60 | nvfp4 |
| `qwen3.8-flash-next` | chat | 262,144 | ✅ | text, image, video | ✅ | 0.10 | 0.20 | nvfp4 |
| `qwen3.8-27b` | chat | 262,144 | ✅ | text, image, video | ✅ | 0.15 | 1.00 | fp8 |
| `minimax-m3` | chat | 524,288 | ✅ | text, image, video | ✅ | 0.20 | 0.90 | fp8 |
| `mimo-v2.6-pro-rl` | chat | 1,048,576 | ✅ | text, image, audio, video | ❌ | 0.40 | 0.80 | fp8 |
| `mimo-v2.6-flash-rl` | chat | 1,048,576 | ✅ | text, image, audio, video | ❌ | 0.10 | 0.25 | fp8 |
| `laguna-s-2.1` | chat | 1,048,576 | ✅ | text, image | ❌ | 0.09 | 0.18 | fp8 |
| `muse-glimmer-30b` | chat | 131,072 | ✅ | text, image, video | ✅ | 0.25 | 1.00 | nvfp4 |
| `nemotron-3-nano-omni-30b-a3b-reasoning` | chat | 262,144 | ✅ | text, image, audio, video | ✅ | 0.10 | 0.25 | bf16 |
| `nemotron-3.5-content-safety` | moderation | 131,072 | ❌ | text, image | ✅ | 0.05 | 0.15 | bf16 |
| `bge-reranker-v2-m3` | rerank | 8,192 | ❌ | text | — | — | 0.05 | fp16 |
| `vultron-retriever-core-qwen3.5-4.5b` | rerank | 262,144 | ❌ | text | — | — | 0.10 | bf16 |
| `vultron-retriever-flash-qwen3.5-0.8b` | rerank | 262,144 | ❌ | text | — | — | 0.05 | bf16 |
| `z-image-turbo` | image gen | — | ❌ | text | — | — | $0.02/MP | bf16 |

**Tool-calling count is 14, not 15** (correction to README and file 02). "Tools" means the catalog *advertises* `supported_parameters.tools`. **Tool-call quality is unmeasured** until the probe runs.

All chat models stream (`streaming: true`) and list reasoning efforts `ultra…minimal`. **No model advertises `response_format`**; only `z-image-turbo` has it, for the image URL/b64 choice.

### Model recommendation (by tool-calling capability; provisional until `probe_inference.sh` runs)

| Role | Pick | Why (catalog facts) | Fallback |
|---|---|---|---|
| Planner (few calls, hard reasoning) | `glm-5.3` | tools, 1M ctx, image in, **enforced reasoning budget**, strongest-positioned in catalog text | `minimax-m3` (tools, 512K, enforced budget, $0.20/$0.90) |
| Tool loop / executor (many turns) | `qwen3.8-flash-next` | tools, **enforced budget** (predictable latency and cost), image+video, cheapest output ($0.20) | `deepseek-v4-flash-0731` (tools, 1M, but budget **not** enforced, so use `reasoning_effort:"low"`) |
| Vision verifier (Pattern B) | `glm-5.3-flash` | tools, image+video, enforced budget, $0.10/$0.35 | `qwen3.8-27b` |
| Pre-dispatch guard | `nemotron-3.5-content-safety` | moderation model, cheap | none; fail closed |

Decision rule at kickoff: run the probe on the 4 candidates. Keep a model only if it meets **all** of these:
- forced tool call → parseable args
- multi-step round trip OK
- streaming tool deltas assemble
- p50 latency < 5 s on `basic`

Otherwise swap in the fallback.

---

## 2. OpenAI-compatibility caveats (spec v1.1.3, re-verified live in Redoc at `api.vultrinference.com`)

| Topic | Finding | Status | What to do |
|---|---|---|---|
| Endpoints | `/chat/completions`, `/responses` (OpenAI Responses), `/messages` (Anthropic), `/chat/completions/RAG`, `/vector_store*`, `/rerank`, `/images/generations`, `/audio/speech`, `/audio/voices`, `/models`, `/models/all`, `/models/{id}`, `/usage`, `/health`. **No `/embeddings`.** | [doc] | Choose one client format; the OpenAI SDK is simplest |
| Chat request fields | `model, messages, stream, tools, tool_choice, temperature, top_p, n, stop, seed, logprobs, top_logprobs, frequency_penalty, presence_penalty, max_completion_tokens (default 32768; includes reasoning), max_tokens (deprecated), reasoning, reasoning_effort, continue_final_message` | [doc] | Always set `max_completion_tokens` **and** `reasoning_effort` |
| **Tool-call IDs** | Raw IDs look like `functions.<name>:<N>`. **`<model>-normalize`** rewrites them to `chatcmpl-tool-<hash>`. It also turns `reasoning_content` into `reasoning`, `content=None` into `""` when tool calls are present, strips empty `tool_calls=[]` and `content=null` from stream deltas, and strips whitespace-only content alongside tool calls. | [doc] | **Use the `-normalize` suffix for every agent-loop call.** Echo the ID back verbatim in the `tool` message. |
| `tool_choice` | `none` / `auto` / `required` / `{type:function,function:{name}}` / `allowed_tools` | [doc] | Force a function for structured output |
| `strict` on function tools | Present in the tool schema ("Only a subset of JSON Schema is supported when strict is true") | [doc] | Enforcement is unverified; the probe tests it. Always validate args server-side (pydantic/zod) and return validation errors to the model as the tool result. |
| **JSON mode / structured output** | `response_format` is **absent** from the chat request schema (only the image endpoint has it). `json_schema` and `json_object` appear nowhere. | [doc+live] | Use a forced tool call (`emit_plan`) as the structured-output channel. The probe checks whether `response_format` gets a 4xx or is silently ignored. |
| `parallel_tool_calls` | Not in spec | [doc] | The probe observes whether models emit >1 call. Handle N calls either way. |
| Streaming | `text/event-stream` response. **`stream_options` / `include_usage` are not in the spec.** | [doc] | Don't rely on usage in streams. The probe checks for a usage chunk. Also record usage from non-stream calls or `/v1/usage`. |
| Reasoning budget | `reasoning.max_tokens` is honoured only on models with `supports_max_tokens:true`; other models accept but ignore it. `:express` variant derives a budget. Unsupported `reasoning_effort` level → **422**. | [doc] | Prefer enforced-budget models for loops |
| Continuation | A final `assistant` message is treated as a prefill and continued. Thinking is disabled for the continuation. | [doc] | Never end history with an assistant message by accident |
| Usage reporting | `usage {prompt_tokens, completion_tokens, total_tokens}`. No `reasoning_tokens` breakdown in the spec. | [doc] | Assume reasoning is billed as completion [inferred] |
| Errors | Documented: 400, 401, 404 (model), 422, 429 (on `/messages` + rerank). **Missing key → 401 `No API key provided`; invalid key → 422 `Invalid API key`.** | [live dry run 10:56Z] | Treat 401 **and** 422-with-"Invalid API key" as auth errors. Don't retry them. |
| Rate limits | **No published numbers.** 429 is documented but no limits or headers are given. | [doc] | Client-side semaphore of about 4–8 concurrent calls, exponential backoff with jitter on 429/5xx, 60–120 s per-call timeout. `BURST=8` probe option. |
| Timeouts | Not documented server-side | [unverified] | Stream long calls. Client timeout 90 s non-stream. Cap `max_completion_tokens`. |
| Latency / region | All models are in `atl` | [live] | Put the control plane in `atl` |

### Pricing and subscription model

- **Subscription:** Console → Products → Serverless → Inference → "Add Serverless Inference", then give it a label and "acknowledge the list of supported models and the charges note". It can also be created with `POST /v2/inference` or `vultr-cli inference create`. [doc, provisioning page fetched today]
  - Each subscription gets its own inference API key, which can be regenerated (the old key is invalidated). [doc FAQ]
  - Whether a monthly base fee or minimum exists is **not stated** on the pages fetched today. [unverified] Old Reddit posts mention a "$10/mo for 50M tokens" beta plan; treat it as retired.
- **Per-token price: three conflicting sources, all fetched today.**
  1. Support/FAQ page and product page: flat **$0.55/M input, $2.75/M output**; "Media inference may incur additional charges".
  2. Live `/v1/models`: per-model prices of $0.09–0.75 in and $0.18–3.00 out (table above).
  3. `vultr.com/pricing` (live, cache bypassed): a **different model catalog** (MiniMax-M2.7 $0.30/$1.20, Kimi-K2.6 $0.30/$1.20, DeepSeek-V4-Flash $0.30/$1.00, GLM-5.1-FP8 $0.85/$3.10, Nemotron-3.5-Content-Safety $0.10/$0.30…).

  None of these names match the live API except loosely. **Budget with the worst case.** Check the console Usage tab and `GET /v1/usage` after the first 30 minutes.
- Whether hackathon credits cover inference is [unverified]. It is presumably the same account balance.

### Probe script: `raw/vultr/probe_inference.sh` (status: **NOT RUN, no key**)

- Covers catalog, basic plus usage, a tiny budget with high effort (the empty-content failure), `reasoning_effort:"none"`, streaming (TTFB, chunks, `[DONE]`, usage-in-stream), and forced tool calls raw vs `-normalize` (ID format, arg parse).
- Also covers a multi-step tool result round trip, streaming tool-delta assembly, parallel calls, strict and invalid args, `response_format` handling, server validation errors (unknown model, bad tool schema, orphan tool message), a 3 s client timeout, Anthropic `/messages` tool use, `/usage`, and an optional 429 burst.
- Cost is capped by `max_completion_tokens` and stays under $0.30 per full run.
- A plumbing dry run with a deliberately invalid key ran clean (all 20 checks executed, no script errors) and surfaced the 401-vs-422 behaviour.
- Run with: `VULTR_INFERENCE_API_KEY=… ./probe_inference.sh`. Copy the `summary.jsonl` lines into `experiments.jsonl`.

---

## 3. Isolation classes (what each actually isolates)

| Class | Mechanism | Kernel shared with host? | Escape needs | Satisfies C1-04 ("containers or throwaway instances, never inside your app process")? |
|---|---|---|---|---|
| **Process** | `subprocess` + seccomp / nsjail / firejail / rlimits on the app host | Yes, and same host as the app | One kernel bug, or any sandbox misconfiguration | **No** (not a container or instance; runs next to the app runtime) [inferred] |
| **Container** | Docker/runc: namespaces + cgroups + seccomp + caps | Yes | One host-kernel bug (or a mis-set flag like `--privileged`) | Yes (letter). Weak story. |
| **User-space kernel** | gVisor `runsc`: the Sentry reimplements Linux syscalls in Go; the host sees a narrow syscall set | Only via the Sentry's filtered host syscalls | A Sentry bug **and** a host-kernel bug | Yes. Strong story, no KVM needed. |
| **MicroVM** | Firecracker / libkrun (Microsandbox) / Kata / Cloud Hypervisor: own guest kernel on KVM | No (guest kernel), but a shared host VMM | A guest→VMM/KVM escape | Yes. Needs `/dev/kvm`. |
| **Full VM** | A separate Vultr instance per task | No; Vultr's hypervisor boundary | A cloud-hypervisor escape | Yes ("throwaway instances"). Minutes, not ms. |

---

## 4. Execution approaches compared (prices = public `/v2/plans`, fetched 10:52Z)

| Approach | Host plan (region) | $/h idle | KVM needed? | Startup per task | Setup effort | Notes |
|---|---|---|---|---|---|---|
| **A. Docker (runc) hardened** on a separate VM | `vhp-2c-4gb-amd` $0.033 (atl ✓) or `vc2-2c-4gb` $0.027 | 0.027–0.033 | No | ~0.3–1 s [unverified] | 10 min | Baseline. Kernel-escape question unanswered. |
| **B. Docker + gVisor `runsc`** (recommended) | Same, or `vhp-4c-8gb-amd` $0.066 | 0.033–0.066 | **No** (systrap default) | ~1 s [unverified] | 15–30 min | gVisor needs **x86_64/ARM64 and Linux 5.6+** (Ubuntu 24.04 ok) [doc]. "Systrap is a better choice when running inside a VM". **Install via the apt repo:** the legacy binary-only `runsc install` auto-download "will be dropped at the end of September 2026" [doc, gvisor.dev today]. Egress sidecars needing the iptables `nat` table don't work inside gVisor; use `--network none` or an external proxy. |
| **C. Microsandbox (libkrun) / Firecracker / Kata microVMs** | **VX1 only** among cloud plans: `vx1-g-2c-8g-120s` $0.076, `vx1-g-4c-16g-240s` $0.153 (atl, sjc; **not lax**) | 0.076–0.153 | **Yes** | ~100–300 ms class [vendor claims, unverified] | 30–60 min (Microsandbox) / hours (raw Firecracker) | See KVM evidence below. Must verify `/dev/kvm` on first boot. |
| **C′. Same on bare metal** | `vbm-4c-32gb` $0.164 (ewr, lax, sjc, mia; **not atl**); `vbm-6c-32gb` $0.253 (includes atl) | 0.164+ | Real KVM | same | + slow provisioning (budget 10+ min) [02, unverified] | Only if VX1 lacks `/dev/kvm` |
| **D. Throwaway Vultr VM per task** via API | `vc2-1c-1gb` $0.007, `vc2-2c-4gb` $0.027, `vx1-g-2c-8g-120s` $0.076 per hour of life | 0 idle (+ warm pool) | No | **Boot latency unmeasured.** VX1 doc: "Instant provisioning and ready for use in seconds" [vendor claim]. Plan for 30–120 s + cloud-init. | 1–2 h (API wrapper, janitor, warm pool) | Strongest separation. Billing granularity per instance not verified (assume ≥1 billed hour per instance, conservative). Snapshots cost $0.05/GB-month [pricing page]. Startup scripts are capped at 64 KB and `user_data` must be base64 (02). |

**Which Vultr plans expose KVM / nested virtualization** [evidence gathered today]:
- **VX1: yes (vendor-stated).**
  - The VX1 product doc says "Supports additional CPU features including support for virtualization" [doc].
  - Vultr blog: "Vultr VX1 supports nested virtualization, enabling businesses to deploy microVM solutions" [cached blog].
  - Vultr's own Microsandbox guide targets VX1 and checks `ls -l /dev/kvm` and `msb doctor` for "KVM device /dev/kvm ✓".
- **Bare metal (`vbm-*`): yes** (no hypervisor layer).
- **Shared-CPU `vc2`: no.** A third-party review (Better Stack) reports "VT-x/AMD-V flag shows disabled… standard for shared-CPU instances".
- **`vhp`/`voc`/`vdc`/`vhf`: not documented. Treat as no** until `ls /dev/kvm` proves otherwise.
- VX1 plans without the `-NNNs` suffix show `disk: 1` (block-storage boot, needs `block_devices`). Use the `-120s`/`-240s` variants.

**Cheapest credible isolation (recommendation):** **B, Docker + gVisor on a dedicated sandbox VM separate from the control plane.**
- It needs no KVM, is ready in about 20 minutes, and gives a real second kernel boundary on top of the VM boundary between sandbox and keys.
- Minimum spend: `vc2-2c-4gb` control + `vhp-2c-4gb-amd` sandbox host = **$0.060/h ≈ $1.77** for the 29.5 h event window.
- Upgrade path (for technicality points):
  - VX1 `vx1-g-4c-16g-240s` ($0.153/h) as the sandbox host, adding a Microsandbox microVM tier if `/dev/kvm` is present.
  - Plus approach D as the "high-risk" tier, with a warm pool of 1.

---

## 5. Egress control, VPC, metadata

- **Vultr Firewall is inbound-only.** FAQ, verbatim: "No, Vultr Firewall does not filter outgoing netwok traffic from your instance." [doc, fetched today]
  - Egress control must live on the host: `--network none`, or an internal Docker network plus an allowlisting forward proxy plus nftables in the `DOCKER-USER` chain.
  - Alternatively, use a `vpc_only` instance behind a **NAT Gateway ($0.03/h)** [pricing page]. The NAT gateway blocks *inbound* initiation. Whether its rules can filter *outbound* destinations is [unverified].
- **VPC:** region-scoped (inferred from the API shape `POST /vpcs {region}`). Keep the control plane and sandbox host in `atl`, attached to one VPC. The control plane reaches the sandbox daemon on the VPC IP only, and the daemon binds to the VPC interface.
- **Metadata service, 169.254.169.254:**
  - Vultr doc [fetched today]: "Function calls are performed over standard HTTP with **no authentication**."
  - Documented endpoints are `/v1.json` and `/v1/` (hostname, instanceid, instance-v2-id, **public-keys**, nvidia-driver, bgp/*, interfaces/* incl. IPs, MACs and VPC network ids, and region).
  - **Not in the public doc, but in cloud-init's Vultr datasource source today:** `/v1.json` returns **`user-data` and `vendor-data`**. cloud-init sends a header `Metadata-Token: cloudinit`, a static string and not a secret. [inferred from `cloudinit/sources/DataSourceVultr.py` + `helpers/vultr.py`]
  - Consequences:
    1. Anything in `user_data` (setup keys, API tokens, callback secrets) is readable by any process in that VM that can reach the link-local address.
    2. Sandboxes must be unable to reach 169.254.169.254. `--network none` does this. For bridged networks, add `nft add rule inet filter forward ip daddr 169.254.169.254 drop` or the DOCKER-USER equivalent, and **test it** (`curl -m2 http://169.254.169.254/v1.json` from inside must fail).
    3. Throwaway VMs: pass only a **one-off, short-TTL** credential (e.g. a NetBird one-off setup key, or a single-use callback nonce) in `user_data`, and still run the untrusted code in a container inside the VM.
  - Whether vendor-data contains credentials (e.g. root password material) is [unverified]. Assume sensitive.

---

## 6. Deployment topology (recommended)

```
                   Internet (users, judges)
                          │ HTTPS
          ┌───────────────▼────────────────┐   (option N: NetBird VM, see file 14; else Caddy/Traefik on control VM with 80/443)
          │ Ingress                         │
          └───────────────┬────────────────┘
                          │
 ┌────────────────────────▼─────────────────────────┐        ┌─────────────────────────────────────┐
 │ Control-plane VM  vhp-4c-8gb-amd, atl ($0.066/h)  │  HTTPS │ Vultr Serverless Inference (atl)    │
 │ web app + API (REST/WS) + planner/dispatcher      │───────▶│ glm-5.3 / qwen3.8-flash-next /      │
 │ Postgres + queue, audit log, receipts             │        │ glm-5.3-flash / nemotron guard      │
 │ secrets: inference key, Vultr API key (scoped)    │        └─────────────────────────────────────┘
 │ janitor (TTL reaper for containers/VMs/URLs)      │
 └───────┬───────────────────────────┬──────────────┘
         │ VPC (private, atl)         │ Vultr API v2 (create/delete throwaway VMs, tags)
 ┌───────▼──────────────────────┐   ┌─▼──────────────────────────────────────────┐
 │ Sandbox host (untrusted)      │   │ Throwaway VM tier (optional, high-risk)   │
 │ vx1-g-4c-16g-240s atl $0.153  │   │ vc2-2c-4gb $0.027/h, warm pool 1          │
 │  or vhp-2c-4gb-amd $0.033     │   │ user_data: one-off nonce only             │
 │ sandbox-daemon (VPC-bound,    │   │ untrusted code still in runsc container   │
 │  mTLS/token from control)     │   │ firewall group: 0 inbound (or SSH from    │
 │ docker + runsc; --network none│   │  control-plane IP only)                   │
 │ browser sbx on internal net → │   └───────────────────────────────────────────┘
 │  allowlist proxy → internet   │
 │ NO keys, metadata blocked     │──────▶ Vultr Object Storage ($18/mo: 1 TB + 1 TB transfer):
 │ firewall group: 0 inbound     │        artifacts/screenshots via short-lived presigned PUT URLs
 └───────────────────────────────┘        minted by control plane (sandbox never holds S3 keys)
```

Rules of the topology:
- The model and all keys live only on the control plane. Sandboxes receive code/commands, return stdout, files and hashes, and get presigned upload URLs.
- The sandbox host has **zero inbound rules on its public IP**. The daemon listens on the VPC interface only.
- Artifacts: Object Storage is optional. Local disk on the control plane plus hashes is enough for the demo. Object Storage adds a "Vultr as system of record" point for **$18/month (≈$0.025/h prorated [unverified proration])**.

---

## 7. Cost model (formulas + assumptions)

**Prices** (fetched 2026-09-26 10:52Z from public `/v2/plans` and `vultr.com/pricing`):

| Item | Price |
|---|---|
| `vc2-1c-2gb` | $0.014/h |
| `vc2-2c-4gb` | $0.027/h |
| `vhp-2c-4gb-amd` | $0.033/h |
| `vhp-4c-8gb-amd` | $0.066/h |
| `vx1-g-4c-16g-240s` | $0.153/h |
| NAT GW | $0.03/h |
| Object Storage | $18/mo |
| Snapshots | $0.05/GB-mo |
| Bandwidth overage | $0.01/GB |

**Assumptions:**
- Instances are billed hourly and stay billed until destroyed. Whether stopped instances are billed is [unverified]; assume yes.
- Per-instance minimum or rounding is [unverified]. Formulas are shown for both prorated and per-started-hour billing.
- Event window: 29.5 h (Sat 11:30 → Sun 17:00 PDT).

**Idle cost:**

```
C_idle/h = Σ plans + obj/730 (+ NAT)
recommended:  0.066 (control) + 0.153 (VX1 sandbox host) + 0.014 (NetBird VM) + 0.025 (object storage) = $0.258/h  → $7.60 per 29.5 h
cheapest:     0.027 (vc2-2c-4gb control) + 0.033 (vhp-2c-4gb sandbox) = $0.060/h → $1.77 per 29.5 h
```

**Per-task LLM cost.**

Variables:
- S = steps
- P = system prompt + tools tokens
- Δ = history growth per step
- O = visible output per step
- R = reasoning per step

```
Input  = S·P + Δ·S(S−1)/2          Output = S·(O+R)
C_llm  = Input·p_in + Output·p_out
```

Example: S=8, P=3k, Δ=1.5k, O=300, R=500, giving Input 66k and Output 6.4k.

| Pricing assumption | Cost per task |
|---|---|
| `glm-5.3` list price | $0.069 |
| Flat FAQ price | $0.054 |
| `deepseek-v4-flash-0731` | $0.008 |
| `qwen3.8-flash-next` | $0.008 |
| Mixed (2 planner calls on glm-5.3 + 6 flash steps) | ≈ **$0.017** |

Budget with **$0.02–0.07/task**. Vision screenshots add image tokens, which aren't priced in the catalog: [unverified].

**Per-task infra cost:**

```
Container tier (B/C):  marginal ≈ 0 until host saturation.
  capacity k = floor(min(vCPU·overcommit / cpu_per_sbx, (RAM − 2 GB) / mem_per_sbx))
  e.g. 4c/16G, browser sbx 1 vCPU·1.5 GB, overcommit 2 → k≈8; code sbx 0.5 vCPU·0.5 GB → k≈16
  hosts N = ceil(C_peak / k);  C_infra/h = control + N·host
Throwaway VM tier (D): lifetime L = T_boot + T_run + T_teardown
  prorated:           C_vm/task = rate·L                 steady state $/h = (λ·L + W)·rate
  per-started-hour:   C_vm/task = rate·ceil(L)           steady state $/h = λ·rate·ceil(L) + W·rate
  (λ = tasks/h, W = warm-pool size)
```

**Sensitivity.** Assumes browser tasks, a mixed-model LLM cost of $0.02/task, VM tier on `vc2-2c-4gb` with a 3-min boot and teardown overhead, and W=0.

| Concurrency C | Task duration | Tasks/h | Container hosts | Container infra $/h | LLM $/h | VM tier $/h (prorated) | VM tier $/h (per started hour) |
|---|---|---|---|---|---|---|---|
| 1 | 2 min | 30 | 1 | 0.22 | 0.60 | 0.13 | 0.88 |
| 1 | 10 min | 6 | 1 | 0.22 | 0.12 | 0.10 | 0.23 |
| 5 | 2 min | 150 | 1 | 0.22 | 3.00 | 0.40 | 4.12 |
| 5 | 10 min | 30 | 1 | 0.22 | 0.60 | 0.24 | 0.88 |
| 20 | 2 min | 600 | 3 | 0.53 | 12.00 | 1.42 | 16.27 |
| 20 | 10 min | 120 | 3 | 0.53 | 2.40 | 0.77 | 3.31 |

Takeaways:
- **LLM tokens dominate** once C>1. VM billing granularity is the other big unknown: per-started-hour billing makes a short-task VM tier 5–10× pricier than prorated billing.
- At hackathon scale (≤100 tasks total), the whole weekend costs **$10–20** on the recommended stack, which is well inside $200.
- The real risk is **leaked resources**, not throughput. Mitigate with a janitor and tags.
- Another unknown: new-account instance quotas may cap the VM tier. [unverified] Check the console limit at kickoff.

---

## 8. Kickoff verification list (needs account/key; not done)

1. Run `probe_inference.sh` against 4 models and pick the models (§1 rule).
2. Boot the VX1 host and run `ls -l /dev/kvm; egrep -c '(vmx|svm)' /proc/cpuinfo; msb doctor`. Record the result in experiments.jsonl.
3. Measure throwaway VM boot time: `POST /v2/instances` → `active/ok` → SSH-ready, 3 samples each for `vc2-2c-4gb` fresh OS vs a snapshot. Then delete them.
4. From inside a sandbox, run `curl -m2 169.254.169.254/v1.json` and expect failure. From the host, check that `user-data` appears in `v1.json` (confirms §5).
5. Check the console Usage tab after 30 min against the per-model and flat prices.
6. Check the billing granularity of a 5-minute instance on the invoice or pending charges.
