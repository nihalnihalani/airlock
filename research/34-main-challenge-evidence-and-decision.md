# Main-challenge decision: evidence, objections and research coverage

Date: 26 September 2026. Current product: [Airlock — Repro-to-Repair](35-AIRLOCK-MAIN-CHALLENGE.md). This pass responds to the user's request to reconsider the main challenge deeply using the full research. It does not claim that every raw web capture or every line of every ledger was independently reread or revalidated.

## Decision and the tradeoff we are making

The chosen user job is **handling an actionable, untrusted bug report through contained reproduction and attempted repair**. The intended successful outcome is a working, inspectable source patch with frozen before/after observations. The initial supported example is a real historical Python library regression, not an invented booking operation or a universal application builder.

The team agrees on the strong evidence for reproduction, hostile-input containment, bounded execution and distrust of self-reported success. It does not agree that repair is already proven feasible. Product and engineering support the extra repair stage for its useful visible outcome; GPT-6 Astra prefers reproduction as the evidence-ranked floor until a live Vultr repair spike passes. The lead accepts the bounded extra build risk, with an early gate and an honest unresolved outcome inside the same product.

The operative gate is the one in 35. Earlier teammate reports suggest different thresholds and schedules; they are opinions, not parallel build instructions. No invented weighted scores or winning probabilities were averaged to produce this decision.

## What the main challenge actually asks us to solve

The organizer requires a public web agent doing actual code or browser work, orchestrated by a Vultr VM backend, with agent reasoning through Vultr Serverless Inference. Execution must occur outside the app process in Vultr-hosted sandboxes. Resource limits, credential hygiene, lifecycle cleanup and a recorded containment moment are central. [Organizer Challenge 1](https://docs.google.com/document/d/1cca0kJZSraBDNfE_gFCRovpgRnlD2m613WLebd2ApN4/edit).

The organizer does not require inventing a new isolation primitive, supporting arbitrary repositories, writing to production, using three models, or implementing both code and browser execution. The right strategy is one useful workflow that exposes and exercises the real trust boundaries. The challenge text was fetched successfully in the prior pass and read again through local records here; the current rules owner is 01.

## Evidence chain

| Research finding | Design implication | Limit |
|---|---|---|
| D1/K7: maintainers request or run reproductions, sometimes with unfamiliar attached code; 23 adds Python-specific examples | Intake an actual report and execute a reproduction, instead of inventing a new business app | Desk evidence, not interviews or proof anyone will buy this product |
| D2/K1 and 05: reported success and evaluator output can be misleading | Frozen external acceptance contract and separate deterministic comparator | Finite checks can still miss errors; no generic correctness guarantee |
| 22: offline dependency bundles and several pinned bugs behave reproducibly in the local lab | Choose a supported pinned library/runtime, not live arbitrary setup | Native macOS, hand-written repros; no Vultr/model repair evidence |
| 07/08/09: useful supervisor, task and approval patterns, but whole-app dependencies and broad defaults | Selective reuse of small lifecycle/policy patterns | Static inspection at pinned commits, not a validated complete fork |
| 18/24/28: scope growth, fake judge precision, unsafe verifier placement and misleading demos | Early gates; one useful result; transparent containment fixtures; no universal safety claim | Reviews are engineering judgments, not measured user demand |
| 20/26: sponsor architecture and vivid before/after outcome can improve the demo | Show actual Vultr execution and a repaired report; keep cloud-feature count secondary | Inferred judge profiles and historic winner patterns cannot predict actual judging |

### Fresh primary-source checks in this pass

1. **The chosen bug is real.** The issue describes an empty-table `IndexError` when header width wrapping is enabled. It is an understandable function-level failure suitable for a visible report-export wrapper. [python-tabulate #365](https://github.com/astanin/python-tabulate/issues/365). Its current status is not used to claim an outstanding issue; the demo uses explicit historical SHAs from the local lab.
2. **Maintainers do execute supplied reproductions.** The Little-CMS issue contains a reproduction package and the maintainer's follow-up after running it. This supports the job, but it is a C-library example, not evidence that our Python adapter already handles it. [Little-CMS #608](https://github.com/mm2/Little-CMS/issues/608). Product teammate additionally checked primary issue material using GitHub CLI, as recorded in 33b.
3. **Reproduce→fix→preview is existing functionality.** Astro's current triagebot README describes reproduction, diagnosis, attempted fixes, preview releases and reporter confirmation/PR handling. Its README places shell execution on the Actions runner. This establishes close product prior art; do not extrapolate an old source audit into a new universal security accusation. [Astro triagebot-action](https://github.com/withastro/triagebot-action).
4. **Coding-agent verification is already a product feature.** OpenHands documents an agent critic plus repository code-review and QA agents. QA actually runs code, browsers and requests; it is not merely text analysis. Airlock cannot claim that nobody else executes or verifies agent work. [OpenHands Verification Stack](https://www.openhands.dev/blog/20260506-the-verification-stack).
5. **Evaluator isolation is a real research concern.** BenchJack studies agents exploiting benchmark/evaluation weaknesses. The prior paper dossier gives detailed isolation and output-trust examples; the paper's abstract page was reopened in this pass. The design adopts separation as an engineering measure, not a transfer of the paper's numerical results to our product. [BenchJack](https://arxiv.org/abs/2605.12673).

The Agent Reach skill governs research routing. Its Exa backend was unavailable in the earlier pass. This pass uses the available web tool and the product teammate's GitHub CLI primary-source reads; there are no new customer interviews, social-platform surveys, outbound messages or cloud deployments. A guessed OpenHands blog slug failed; the correct official page above was then located and read. Failed requests were not treated as source confirmation.

## Important corrections to inherited arguments

- **“CI only verifies after merge” is false.** Pre-merge CI is standard. Airlock earns its role by handling report intake/reproduction and packaging contained work for review, not by pretending CI cannot run tests.
- **“No agent vendor verifies results” is false.** OpenHands and Astro are direct counterexamples. Our external acceptance boundary must be demonstrated and explained as a scoped design choice.
- **A clean new container plus pristine pytest files is not sufficient evaluator separation** when the candidate package shares the verifier's interpreter. The comparator must not import or execute candidate code in its authoritative process.
- **A signed receipt is not proof of safety.** The control plane still needs to be trusted. It records artifact identity and observed outcomes; it does not certify correctness or absence of a backdoor.
- **A pass on several inputs is not several repaired bugs.** One tabulate regression with five cases is one demonstrated repair with five checks.
- **The booking tests are irrelevant to model code-repair feasibility.** Preserve those measurements as prior research; do not cite 11 PostgreSQL passes as validation of Airlock.
- **Historical repro success is not model repair success.** 22's reference fixes and handwritten tests establish a reproducible exercise, not a live generated-patch result.
- **Containment claims need deployed evidence.** No keys in a diagram, a configured `--network none`, or an unrun resource limit is not a measured boundary.
- **No stage story needs uncertain incident counts or a supposed known judge roster.** The report-export failure and actual containment test are sufficient to explain the product.

## Alternatives considered across the corpus

| Family | Why it was considered | Why it loses to the selected scope |
|---|---|---|
| Repro Receipts | Strongest concrete user-job evidence and local component experiments | Retained as the product's useful floor; a checked patch gives a stronger intended stage outcome if feasible |
| Generic coding agent / claim verifier | Broad appeal, maps directly to code execution | Crowded and difficult to differentiate; arbitrary environment support multiplies risk |
| Dress Rehearsal / booking recovery | Measured state changes and interactive approvals | Added production-effect correctness and invented vertical work; moved attention away from hostile-code execution |
| Browser evidence clerk / handoff / exactly-once submitter | Clear browser actions and human control | Portal/authentication/recovery burden; weak guarantees without target-system support; weaker corpus evidence for duplicates |
| MCP or software trial | Naturally needs isolation; can produce a useful tool output | No established task corpus here; install variance and secrets complicate a short event; observation is not malware certification |
| Dependency rescue / safe backport | Useful source patch and direct developer payoff | Additional compatibility/version questions and weaker dedicated demand evidence; logical later adapters, not first build |
| Honeypot certification / attack wall / isolation ladder | Memorable infrastructure demonstrations | Stochastic negative results, weak user deliverable, or scope that competes with the actual task |
| Robotics / enterprise workflow agents | Prior event-theme research | Main challenge has a more direct executed-code path and this user explicitly asked to focus there |

## Consolidated research coverage

This is coverage by evidence family and team responsibility. Individual depth/limitations are in 33a–c. Older exploratory recommendations were considered as hypotheses, not followed as instructions.

| Corpus | Use in this decision |
|---|---|
| `README`, `00-executive`, `00-participant`, `01-event`, `01-rules`, `coverage-and-limitations` | Resolve current challenge and separate organizer requirements from guide/inference/old project choices |
| `02-tool-capabilities`, `02-vultr`, `13-deployment`, `03-netbird`, `14-netbird` | Feasible runtime/deployment baseline; optional bonus kept off the main path; untested inference and cloud claims retained as gates |
| `03-recent`, `03a`, `03b`, `03c`, `04-dossiers`, `04-blast-radius`, `23-customer-validation` | Principal pain clusters, firsthand evidence, counterevidence and limits, with targeted primary-source/ledger checks |
| `05-papers`, `06-competitive`, `06-meta`, `20-judges` | Evaluator/isolation insight, competitive reality, and presentation assumptions; no borrowed benchmark statistics |
| `05-future-of-work-robotics` | Background alternate-track work; not made a requirement for this main-challenge decision |
| `07-openbot`, `08-openmuse`, `09-reuse`, `17-originality` | Pinned architectural reuse, dependencies, boundaries and attribution |
| `10-scorecards`, `11-PRD`, `12-architecture`, `15-build`, `16-demo`, `19-handoff` | Prior engine and implementation constraints, not the current scope; engineering review targets relevant sections |
| `18-review`, `21-options`, `22-lab`, `24-review`, `25-plan`, `26a/b/c`, `27-panel` | Alternative tournament, actually measured component work, feasibility objections and demo vetoes |
| `28-review`, `29-product`, `30-architecture`, `31-booking`, `32-checks` | Latest booking design's strengths and mismatch; no transfer of its tests to code repair |
| `evidence*.jsonl`, `sources*.jsonl`, `queries*.jsonl`, `experiments*.jsonl`, raw lab E04 | Targeted traceability for claims used, exact pinned versions and executed experiment caveats; not every ledger row newly validated |
| User's pasted Gary-Yau Chan guide | One/two core features, team roles, actual validation, readable UI, interactive demo and rehearsal; prototype-only advice rejected for this working-product challenge |

Review artifacts: [Astra](33a-main-challenge-astra.md), [product](33b-main-challenge-product.md), [engineering](33c-main-challenge-engineering.md). The actionable decision is [35](35-AIRLOCK-MAIN-CHALLENGE.md), including its specific pass/fail gates.
