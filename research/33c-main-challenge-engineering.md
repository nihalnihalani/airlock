# 33c — Main-challenge engineering: useful code execution with evidence

**Status: design assessment, 2026-09-26. No product code, cloud resources or new execution experiments were created for this reassessment.** This returns to Challenge 1, Blast Radius Zero. It does not recommend a booking product. Inputs: the rules in 01; architecture/threat model 12; deployment 13; OpenBot/OpenMuse audits 07–09; papers 05; candidate/competition research 06/10/26a–c; feasibility lab 22; critiques 18/24/28; and coordination with the product and GPT-6 Astra review teammates. Existing measurements retain their original limitations.

## Recommendation and scope

The converged product is **Airlock: Repro-to-Repair**, initially for the pinned historical regression **`tabulate#365`**. For two or three effective builders, give **a code-repair agent that returns a tested patch plus an interactive working result** an early, bounded spike. The best supported starting point is **one real public-library regression already reproduced in file 22**, exposed through a small fixed web interface. This is more defensible than inventing another synthetic business incident, and substantially smaller than building an arbitrary-repository application repair platform.

The agent writes and runs real code in a disposable sandbox on Vultr. An independent trusted harness then tests a frozen candidate in a fresh sandbox using external expected results. The user receives the source diff, exact tested artifact, evidence and an interactive preview of the repaired behavior. The preview is the output of useful work, not merely a transcript or a red containment card.

Keep **curated Repro Receipts** as the conservative choice if the repair spike does not pass promptly, especially for a solo builder. It has the strongest component evidence in the research folder: file 22 measured reproductions and offline installs. It does not have evidence of model-written repairs, working Vultr isolation or an integrated deployed agent. Browser tasks have more new moving parts and weaker existing execution evidence; do not choose them merely because their UI looks impressive.

**Scope boundary:** one pinned runtime, one supported package adapter, one known source baseline, no live dependency installation, no production access, no arbitrary repositories, no custom build commands, no GitHub write credentials, no auto-merge, no agent-editable tests or grading files. The patch artifact is reviewable; applying it elsewhere is outside the MVP.

This is a workflow/product integration, not a novel code-repair algorithm or a guarantee of correctness. File 06 already identifies coding agents, CI, fuzzing systems and fresh re-execution as prior art.

## 1. Comparative engineering confidence

| Candidate | Useful completed work | Evidence already present | New critical unknowns | Engineering judgment |
|---|---|---|---|---|
| **Repair → independent checks → interactive result** | Real source patch and demonstrated changed behavior | File 22 supplies pinned real issue baselines, known fixes, reproducible failure cases and offline dependency preparation | Vultr model can author a valid patch; artifact freeze/collection; external oracle; preview adapter | Highest visible payoff among these choices if the early repair gate passes; narrower supported inputs essential |
| **Repro Receipts** | Re-runnable evidence of reported/fixed/latest behavior | Eight of ten curated issue cases behaved as expected; all 30 issue/ref pairs had repeatable outcomes locally | Agent repro authoring, deployed runsc and inference, reliable artifact extraction; malicious repro grading remains difficult | Lower uncertainty, particularly with reporter-PoC mode; strongest conservative choice |
| **Browser task / Tap In / Evidence Clerk** | Completed UI action or authenticated evidence | Reference architecture and static audits; no equivalent end-to-end browser success lab in the reviewed research | Browser/model latency, selectors/vision, session/MFA, safe handoff, site drift, preview or noVNC streaming, external side effects | Adds too many independent failures unless a working browser flow already exists; none established here |
| **Try Before You Trust / arbitrary repo preview** | Installed package or runnable third-party app | Research/market context, no equivalent execution lab | Dependency/build compatibility, network policy, lifecycle preview routing, runtime detection limits | More setup uncertainty than a pinned repair target; a short observation cannot certify safety |

File 15's older full Repro Receipts plan totals **68–108 estimated person-hours**. Do not reuse its earlier “16–26 hours” headline as if the entire feature list fits a solo day. The architecture below deliberately deletes its dynamic dependency proxy, generic repository setup, public room-wide intake, outbound GitHub posting, multi-provider execution and cryptographic ceremony from the critical path.

The booking transaction probe in file 30 is irrelevant evidence for repair quality, package execution or preview reliability. Do not count it toward this candidate's readiness.

## 2. Starting with real issue provenance

Use the observed cases in 22 to choose a supported task. Candidate examples, not a final product-content decision:

- **`packaging#1315`:** stringifying/reparsing a marker changes logical evaluation. An interactive page can show the original expression, serialized expression and changed decision. This has a more visible semantic result than an empty-table exception, but the interpretation must remain faithful to the actual issue.
- **`tabulate#365`:** the empty-table and width-constraint path raises `IndexError`; a fixed interactive table formatter demonstrates the formerly failing path plus normal populated tables.
- **`humanize#333`:** non-finite duration input behavior is short to reproduce, but avoid promising a particular corrected output without checking the documented contract and known fix.

The initial Airlock page therefore shows the `tabulate#365` empty-table/width regression, a populated table as a normal control, the generated source patch and a trusted text-only formatter preview. This is a historical-issue demonstration, not a claim that the current upstream release still has the bug. The other examples above are future adapter candidates and are not part of the initial build.

A known upstream fix is a **control for the test harness**, not a patch secretly supplied to the agent. Seed authoring with the pinned reported/before source, the issue and allowed interface only. The fixed revision and reference expectations stay with the verifier. Existing model knowledge could still include a public fix, so do not claim the task proves novel algorithm discovery.

Before choosing the hero, confirm that its public issue, baseline, fixed behavior and expected outputs are coherent. File 22 found two cases where the reporter's claim was real but the maintainer's intended behavior differed. A test failing at one revision and passing at another does not by itself prove an unwanted bug was repaired.

The fixed UI must identify the actual package/issue, supported operation, source revision, candidate digest, observed checks and whether the run is live or replayed. A single supported adapter is an honest hackathon MVP. “Paste any repo and we fix it” is not supported.

## 3. Two-VM trust graph

```text
Browser: trusted application UI and bounded interactive inputs
                           |
VULTR VM A — trusted control plane
  HTTPS app + durable run/event store
  Vultr Serverless Inference client and key
  task/phase dispatcher and controller-owned limits
  immutable baseline/test manifest; external test oracle
  artifact byte store; human review/download flow
  no Docker socket; never imports/executes package or model code
                           |
       authenticated private supervisor protocol over VPC
                           |
VULTR VM B — execution host
  supervisor + Docker/runsc + fixed image allowlist + janitor
  no inference/GitHub/cloud-write credentials in workload containers
  ├── AUTHOR: editable package source; network none; unprivileged
  ├── COLLECTOR: stopped author's volume read-only; fixed collector
  ├── BASE CONTROL: pristine broken package; network none
  ├── FIX CONTROL: known good package; network none (setup validation)
  ├── CANDIDATE: frozen modified source; network none
  └── PREVIEW: same immutable candidate bytes; fresh state; network none
```

The supervisor is trusted, root-equivalent infrastructure because it holds the Docker socket. Its authentication material remains outside workload containers. The execution host is an isolation fault domain, **not an independently trusted third-party attestor**. A host compromise could forge execution results. Two VMs principally keep workload execution away from controller/model credentials; they do not establish “trustless verification.”

The controller treats issue text, code, model output, stdout, file contents, JSON responses, compiler errors and preview responses as untrusted data. It can validate and compare bounded data without executing it. All generated Python/shell/package execution runs inside Vultr containers, never through a subprocess on VM A.

Fixed phase roles matter. The agent gets only author read/write/execute tools with an opaque task identifier. It cannot choose Docker flags, image names, supervisor verbs, mounts, host paths, verifier inputs or phase transitions. The controller starts verification and preview. All roles carry CPU, memory, PID, disk/output and wall-clock limits; rootfs is read-only; capabilities are dropped; privilege escalation is disabled; task workspaces are disposable named volumes. Runtime and actual settings must be inspected after creation.

All live LLM calls use Vultr Serverless Inference. Development-time GPT-6 Astra critique is not part of the deployed agent runtime. Choose the actual model only after the tool-call and retry probe; catalog capability is not measured reliability.

## 4. Artifact transfer is a boundary, not a convenience function

Do not copy the author's entire filesystem or run its chosen export script.

1. Stop further author dispatch and fence the task. Terminate the author container and all task processes before collecting anything; a merely “finished” shell command is insufficient because background processes may remain.
2. Mount the now-stable task workspace read-only into a separate fixed collector container. Do not unpack untrusted archives or load package code on the host/controller.
3. The collector walks only the controller-defined source allowlist. Reject path traversal, absolute paths, duplicate normalized paths, symlinks, hard links, device nodes, sockets, FIFOs, excessive size/count/depth and unsupported file names/types. Use descriptor-relative no-follow file access. Do not follow a link because it happens to resolve inside the workspace.
4. Export a **typed file manifest**: canonical relative path, length, SHA-256 and raw bytes, within tight limits. No arbitrary tar extraction, executable hook, install script, free-form command or HTML in this protocol. Supervisor/controller recompute lengths and hashes on received bytes.
5. Compare the manifest with the immutable source baseline. Changes outside supported package source—including tests, fixtures, dependency locks, manifests, server adapters and startup scripts—reject the candidate. The user may download an explanatory diff, but an unsupported patch cannot receive a passing status.
6. Create a fresh candidate volume from the trusted base and apply exactly those permitted file replacements inside a fixed staging container. Seal the source read-only for candidate execution. Transient runtime writes go to fresh capped `/tmp` or data directories, not the source tree.
7. Bind the artifact digest to base commit, source manifest, runtime image digest, adapter version and dependency manifest. Verification and preview use this same object, never the current mutable author workspace.

The typed manifest is the source of truth. Generate the human-readable patch from baseline versus manifest in a contained diff tool; do not promote an agent-written patch or agent-written “tests passed” JSON as authoritative output. The authoritative bundle may be retained/downloaded as inert bytes. Text and patch downloads use attachment/text headers, `nosniff`, safe filenames and escaped UI rendering.

**Race gate:** if a process can still alter source after its digest was taken, snapshot binding is broken. The first adversarial test must try background mutation while export starts and verify that the submitted frozen artifact is stable.

## 5. A fresh verifier must not execute attacker code in its own process

File 05's BenchJack discussion is directly relevant: moving pytest into a fresh container does not fix an architecture in which patched code can alter the very interpreter/harness deciding whether it passed. A candidate `conftest.py`, startup hook, monkey patch, malicious import or forged JUnit file can counterfeit success.

For this narrow adapter, use a **black-box harness outside the candidate process and container**:

- Reference test inputs, expected results, case identifiers, minimum case count and comparison logic live on VM A as an immutable versioned test manifest. The author and candidate receive neither those files nor write access to the test runtime.
- A fixed adapter inside each candidate accepts a typed request and invokes the actual package function. It returns bounded JSON/text. Candidate code may lie in that response; this is precisely the data under test, not a verdict.
- The harness sends independent test cases, compares returned values/errors to its own expected results, and records pass/fail itself. It never imports the target package, loads agent plugins, reads candidate JUnit output or treats `exit 0`/“all tests passed” as a pass.
- Run the same harness against the pristine broken baseline and known good fixed baseline as a setup sanity check. Require the named regression to fail on the former and pass on the latter. Require normal/regression cases to remain valid; if the reference harness rejects the known good revision, fix the harness or mark the task unsupported.
- Run the frozen candidate fresh at least twice for the bounded case set. Distinguish timeout, crash, response parse error, incorrect answer, missing cases and actual pass. Bound output size, nesting depth, numeric ranges and request duration. A parser error cannot count as the expected application error without a specific typed contract.
- Candidate failure information may be returned to the model for a bounded repair attempt; tests becoming visible in that feedback does not give the agent control of the oracle. A “hidden tests” claim is unnecessary.

**Simplest transport:** every candidate remains `--network none`. VM A sends `invoke_adapter(task_snapshot, typed_request)` to the supervisor. The supervisor invokes a fixed rootfs adapter executable inside the chosen container with request bytes on stdin; there is no host shell interpolation. Results come back as bounded bytes. The independent oracle remains on VM A.

If a genuinely running HTTP backend is desired for preview, the adapter can be a process bound to `127.0.0.1` **inside the isolated network namespace**. A separate fixed probe process in that namespace sends requests only to the controller-fixed loopback endpoint and returns bounded bodies. No arbitrary target URL, host port, host-network access or redirect following is accepted. This adds a service startup gate; a stdio adapter is smaller and should be called an interactive package preview, not a deployed arbitrary website.

Read-only trusted adapter files do not make the candidate's process trustworthy: importing malicious package code can compromise that adapter process. The design assumes its answers are adversarial. The protection is that the external oracle and recorded verdict are outside that process.

Keep three evidence layers explicit:

| Layer | What it establishes | What it cannot establish |
|---|---|---|
| Candidate adapter JSON/text | The untrusted candidate produced these bounded bytes for this input | Its own `passed`, `safe`, `expected`, test-count or timing fields have no authority and should not enter the verdict schema |
| Supervisor execution metadata | The fixed invocation exited/timed out/was killed, with controller-recorded start/end and collected-byte counts | Exit zero is not correctness; the supervisor has not decided whether the candidate's answer is right |
| Verifier-owned comparison | Each manifest case was actually dispatched, a valid response arrived, and the result matched the verifier's external expectation | Only the named cases were checked; finite observations do not prove general correctness |

Only the third layer produces `passed_cases` and overall check status. Store actual versus expected per case and require the full known case set. Logs and captured stdout are explanatory artifacts. The immutable manifest hash, runtime/adapter identifiers and supervisor execution references bind the report to the same candidate digest used for preview and export.

**Limits:** a finite test suite can be weak, overfit or deliberately hardcoded. Re-running twice tests only those cases under those conditions. External grading prevents easy “edit the report” fraud; it does not prove correctness, absence of malicious behavior or fitness for production. Say **“passed these independent checks”**, show the cases and residual limits, and deliver the patch for review.

## 6. Dependency policy and output path

For the MVP, build the runtime image and dependency bundles from reviewed pinned sources before admitting tasks. Pin the interpreter, package versions, hashes, image digest and adapter. File 22 demonstrates that hashed offline installs worked for its curated Python corpus on macOS; container/platform compatibility still needs a deployed check.

No task gets an online package installer. The agent cannot modify `requirements`, `pyproject`, `setup.py`, package-manager config, image files or lock manifests. Replacing a dependency is **unsupported**, not a reason to open egress. A target's build/install hooks remain executable code: prepare those in an isolated setup environment without model/cloud keys; do not run them on VM A. Prefer the already validated pure-Python wheel/source path and avoid arbitrary build scripts during the demo.

Network-none author, candidate and preview containers prevent direct external connections. They do not erase all information flows: source, logs and responses intentionally return through the supervisor and model context. Since only public source, synthetic inputs and no real credentials enter these workloads, that output channel carries no intended secrets. Do not say the system proves “no exfiltration” for arbitrary private inputs.

Outputs leave by **controller pull**. A container never receives object-storage credentials, presigned upload capability, GitHub token or a callback URL containing a controller secret. The supervisor returns bounded blobs; VM A persists them under generated content-addressed names. A downloadable source patch is enough for the real outward result. The user clicks **Export tested patch** after inspecting the diff and evidence; the button resolves the frozen verified digest and never exports the mutable author workspace. This explicit user action owns the export. It does not push a branch, open a PR, merge, deploy or modify a production repository. Human review can bind to the exact digest without implementing an external write integration.

## 7. Working preview without handing an attacker the app origin

For the recommended library adapter, serve the interface from trusted static frontend code. It accepts a few bounded sample/custom inputs and displays the candidate's result as escaped text or validated data. It identifies the artifact digest and candidate lifetime. It does not render returned HTML, execute returned JavaScript, load candidate-provided URLs or forward arbitrary browser requests into the sandbox.

This gives the judge a real interaction with the repaired package while keeping the preview environment network-none. The same artifact tested by the verifier executes the request; display data cannot overwrite the controller's verified-status UI. Separate verification evidence from the package output panel. A candidate output saying “verified” is just escaped output text.

If the team insists on arbitrary app HTML/JavaScript preview, that is a separate scope tier requiring a distinct origin without controller cookies, a constrained gateway, appropriate browser isolation, blocked controller/private/metadata endpoints, limited methods, task-bound expiry and revocation. A same-origin iframe or reverse proxy path under the authenticated app is unacceptable for attacker-controlled HTML. A read-only filesystem alone does not solve this. **Do not add this tier in the initial 24-hour plan.**

Preview state is disposable. Ending the run revokes adapter invocation before destroying its container, then confirms absence. A dead UI button is not evidence of destroyed compute; show observed lifecycle status separately.

## 8. OpenBot/OpenMuse reuse, with changed requirements

Use the small audited patterns, not either whole application. Source versions remain OpenBot `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` and OpenMuse `205cc386b75aae1a862f3fdd43104b570c8d0911`.

| Source | Useful pattern | Adaptation |
|---|---|---|
| OpenBot `supervisor/src/index.ts:19-134`, `names.ts:67-90` | Narrow vocabulary and server-derived resource names | Per-task create, author-exec, freeze, collect, adapter-invoke, destroy; caller cannot select Docker internals |
| OpenBot `supervisor/src/docker.ts:418-457` | Cap-drop, no-new-privileges, resource limit and runtime settings | Mandatory runsc/limits, network none, restart `no`, no persistent browser profiles; inspect actual creation |
| OpenBot `server/src/computer/gateway.ts:532-620` | Audit intent before effect | Durable dispatch event before calling supervisor; no audit record means no dispatch |
| OpenMuse `apps/server/src/engine/worker.ts:116-248` | Leases, guard, CAS checkpoints | Add supervisor fencing and idempotent operation IDs so stale workers cannot keep issuing commands |
| OpenMuse `apps/server/src/computer.ts:225-294` | Refuse attachment on isolation drift | Inspect per-phase identity, image, flags, named volume and no-network configuration |
| OpenMuse `apps/server/src/actions.ts:39-191`, `db.ts:78-105` | Hash-bound approval, atomic claim, expiry, unknown outcome | Useful if human acceptance/download record is built; external posting is optional and cut first |

Do not adopt OpenBot's browser-mediated shell execution, allow-all startup policy, shared persistent bot environment or one-image security boundary. Do not retain OpenMuse's Docker control in the app process. Both audited applications require the external CopilotKit Intelligence service; importing whole apps adds dependencies unrelated to the critical path. Their tests are not tests of this new system. Declare any actual copied code with its MIT notices and distinguish pattern inspiration from direct reuse.

## 9. Acceptance gates and twenty-four-hour budget

These are goals to measure, not observations. Time starts when sanctioned hacking starts and necessary credentials are available. Shared infrastructure failures are not cured by renaming the product.

| Gate | Required evidence | Decision if missed |
|---|---|---|
| First 60–90 minutes: substrate | Vultr inference parsed tool call + tool-result roundtrip; runsc on second Vultr VM; network-none execution, bounds, cancellation and destruction; public app skeleton | Fix the mandatory platform path; pause optional features |
| By hour 2–3: live repair spike | Model repairs one pinned real issue from baseline, source-only artifact freezes, external baseline/fix/candidate checks run; three fresh attempts logged | If consistently unable to repair, choose curated Repro Receipts/PoC lane; do not fabricate repair success |
| By hour 4–5: integrity path | Agent-edited test/setup file rejected; forged pass stdout ignored; background mutation cannot change frozen artifact; fake exception/timeout not misgraded; valid patch succeeds | Cut preview polish and optional signing; retain these boundary checks |
| By hour 6–8: complete user flow | Public request → live model/tool loop → frozen diff → independent result → interactive repaired output → download → task destruction | Freeze supported inputs and tool count; no extra package adapters |
| By hour 10–12: reliability | At least 4/5 fresh supported-task attempts complete within the chosen demo budget; actual measured latencies reported; an authentic stderr→retry example retained | Simplify issue/tool schema or try another Vultr model. Stored-code fallback stays labelled |
| Hours 12–18 | Containment test, role/access check, restart/janitor cleanup, artifact review, five timed rehearsals | Fix blockers only; cut NetBird, extra APIs, extra models and cloud snapshot tiers |
| Hours 18–24 | Record required containment + useful result, document source reuse/limits, keep public judge URL alive, submit early | No new product scope |

The UI is one task page: input/issue, a compact execution-and-budget strip, source diff, independent case results, escaped interactive preview, export and teardown status. Show controller-measured elapsed time, tool-attempt budget and observed model usage; if billed cost cannot be established, label a calculated figure as an estimate. Do not build an admin dashboard.

A plausible two-person split: person A owns runtime/supervisor/artifact boundary/deployment; person B owns agent loop/reference oracle/trusted UI. A third owns the fixture, repeated evaluation and demo. Solo should prefer the existing Repro Receipts evidence unless the small repair spike is immediately strong.

Minimum staged demonstration:

1. Show the real issue behavior failing on the supported baseline.
2. Agent inspects source, edits and executes the package in its isolated workspace; show actual tools, not narrated work.
3. Fresh external checks compare baseline/candidate behavior and produce a bounded test report.
4. Judge changes a supported input in the working preview and downloads the patch.
5. A separately labelled unsafe command deletes only its disposable workspace or exceeds its time limit; show independent host/controller health and confirmed teardown.

Do not manufacture a model failure to obtain a retry animation. Keep the genuine stderr/retry evidence from rehearsal if the live attempt succeeds first time. A replayed generated patch on a fresh container is a valid labelled fallback demonstration; it is not evidence that a live model just produced it.

## 10. Evidence and claim discipline

**Already measured, file 22:** native macOS Python reproduction/install behavior for a curated public-issue corpus, with a macOS network restriction in selected runs. Eight cases matched the proposed outcome; two required interpretation changes. Docker/gVisor and Vultr timings were not measured there.

**Statically inspected, files 07/08/09:** useful reference source implementations and dependencies. Their existence does not prove this system's safety, transport compatibility or deployment.

**Research-supported design concerns, file 05:** evaluator isolation failures, weak tests, prompt injection and container misconfiguration. The paper statistics are not performance measurements of this product. Some cited works were read only at abstract level; use their limitations as recorded rather than turning them into certification claims.

**Unmeasured in this assessment:** model patch quality; all deployed isolation checks; runtime dependency compatibility; artifact collection under race conditions; protected oracle integration; adapter latency; live preview lifetime; task cleanup; cost per completed repair; judge-visible reliability. No new implementation or infrastructure experiment was run for this document.

The engineering claim to earn is narrow: **“A Vultr-hosted agent repaired this supported issue inside an isolated environment. These fixed external checks passed against the exact downloadable source artifact, and you can try its behavior here.”** That claim is understandable, testable and directly aligned with the main challenge. Everything beyond it must wait for evidence.


## Source-coverage ledger

This assessment used local research rather than conducting a new live-web search. Capability, price, model and benchmark claims are inherited observations dated in their owner files, not freshly reverified facts.

| Local source | Coverage used in this decision |
|---|---|
| `01-rules-and-compliance.md` | C1 VM/inference/orchestration/isolation/real-work/public-web/containment deliverables; all agent actions sandboxed; reference-code disclosure |
| `13-vultr-inference-and-deployment.md` | Two-VM deployment, runsc versus VM options, inference compatibility probes and unmeasured deployment/latency limits |
| `07-openbot-audit.md`, `08-openmuse-audit.md`, `09-reuse-and-integration-matrix.md` | Version-pinned supervisor, worker, hardening and approval reuse; whole-app dependencies and trust defects |
| `12-architecture-and-threat-model.md` | Source/artifact boundaries, separate control/execution domains, secret-free workloads and supervisor lifecycle |
| `05-papers-and-benchmarks.md` | Independent evaluator design, forged test output, weak-test limits and explicit restrictions on benchmark claims |
| `22-feasibility-lab.md` | Exact historical issue/ref outcome evidence, offline bundle feasibility, macOS/no-Docker caveats and corrected cases |
| `10-ideas-and-scorecards.md`, `26a-ideas-relatable.md`, `26b-ideas-api-wow.md`, `26c-ideas-bold.md` | Repro, claim verification, browser/preview, rehearsal and infrastructure candidate tradeoffs; these scorecards are forecasts, not measured outcomes |
| `06-competitive-landscape.md` | Established coding-agent, CI, sandbox and re-execution prior art; avoid novelty overclaim |
| `15-build-plan-and-acceptance-tests.md`, `18-devils-advocate-review.md`, `24-fable-devils-advocate.md` | Over-budget original scope, uncontrolled demo intake, verification/receipt caveats and deterministic fallback discipline |
| `28-astra-devils-advocate.md`, `30-architecture-feasibility.md`, `32-source-checks-and-decision-record.md` | Latest critique and claim/evidence limits; booking logic evidence specifically excluded as proof of code repair |

The task's GPT-6 Astra teammate independently questioned the code-repair recommendation and suggested real public-library provenance over a synthetic fixture. The product/lead team selected the `tabulate#365` lane with a live-repair gate. This disagreement is a reason to run the gate early, not to report unanimous evidence or guaranteed winning odds.
