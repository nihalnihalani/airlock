# 33a — Astra: choose the useful untrusted-code workflow, not a generic Airlock

**Date:** 2026-09-26. **Purpose:** reconsider the main Challenge 1, Blast Radius Zero, after the user rejected the booking-specific direction. This is a skeptical synthesis of existing research, not new customer research or new deployment testing. The booking recommendation in my file 28 is not carried forward as the product choice here.

**Inputs:** 01; 03's merged recent-signal ledger; 04's detailed dossiers and broader opportunity map; 05's paper methods/limitations; 06's competition and later corrections; 10; 18; 22; 24; 26a/b/c. The OpenBot/OpenMuse audits from the earlier review remain relevant. I also exchanged critiques with the product and architecture teammates. Labels below distinguish **recorded evidence**, **engineering inference**, and **recommendation**. A source cited inside an older research file has not automatically been freshly revalidated by this review.

## Recommendation

**Choose Repro Receipts as the evidence-backed main workflow, with a useful, review-ready reproduction as the product and the receipt as supporting evidence.** The entry point is a public bug report or attached reproduction that a maintainer would otherwise run locally. The result is an executable repro, observed behavior at explicitly pinned versions, captured outputs, and a maintainer-ready report. The agent must actually inspect, write and run code on Vultr; it cannot be only a summarizer.

**Keep repair as a gated extension, not the assumption that chooses the project.** If the real Vultr model can produce correct source patches for several bounded, reproducible cases early, add “attempt repair” and deliver the patch plus independent checks. That is a better useful outcome than a receipt alone. But the existing research establishes neither repair-agent reliability nor arbitrary-repository setup, and neither a new name nor a stronger diagram supplies that missing evidence.

My ranking under the currently recorded evidence is **B, A, D, C**. My ranking could change to **A, B, D, C** after a successful early repair spike. This is an explicit uncertainty about capability, not an invitation to build two unrelated products or spend another evening ideating.

The strongest shared wedge is: **“Turn an untrusted bug report into something a maintainer can run and review, without giving its code your machine or credentials.”** It makes safe execution necessary, produces a useful artifact even when no fix exists, and avoids the unsupported production-state promotion machinery of the booking plan.

## What the research actually supports

| Recorded evidence | What follows | What does not follow |
|---|---|---|
| 03 K7 records firsthand maintainer/triager examples, including running a stranger's PoC; 04 D1 describes the concrete issue → reproduce → disposition workflow. | Untrusted report execution is an actual job, not a contrived demonstration of isolation. | Every maintainer wants another bot, or will pay for it. K7 was specifically researched more heavily than other clusters. |
| 03 K1 and 04 D2 record false completion claims; 05 discusses verifier tampering and weak tests. | The result must come from execution and authoritative observation, not the model's recap. | Fresh execution proves semantic correctness, or passing tests proves an issue is a valid bug. |
| 22 reports deterministic local runs for 30 issue/ref pairs and successful hashed offline installs. Eight of ten curated issues behaved as originally expected; two required INCONCLUSIVE interpretation. | Several real public inputs and an offline replay mechanism are materially better understood than other candidates. | The Vultr model authored those tests, repaired the packages, or passed an end-to-end cloud system. The lab used hand-written tests and native macOS. |
| 18 finds the closest inspected triagebot runs code on the Actions runner alongside the parent process holding valuable credentials, without fresh re-execution. | A separately isolated, secret-free execution path is a concrete engineering difference from that pinned implementation. | All triage products work this way, or the inspected project's latest version still has that behavior. Use the pinned audit if making a comparison. |
| 06 documents commodity sandboxes, credential brokers, approvals, coding agents and established fuzzing repro verification. | The contribution must be an excellent workflow plus a real boundary. | Any one of isolation, signatures, two-ref replay or human approval is novel. |
| 03 K4 supports browser friction; K5 has framework duplication bugs but no firsthand production duplicate-side-effect incident; K6 has weak recent firsthand evidence. | Browser work is a valid secondary direction, but “safe exactly-once portal operations” is a weak evidence-led lead. | A seeded portal with a duplicate counter validates buyer demand. |
| 26a adds software/MCP trial concepts and setup research, with many sources explicitly snippet-only or recalled. | Trial-without-local-install is a plausible distinct workflow and deserves comparison. | Universal setup success, a clean security certificate, or the dramatic incident numbers being safe to quote without verification. |

Two corrections to the older synthesis matter: ordinary CI can run **before merge**, and a separate fresh container does not automatically make its test result trustworthy when the candidate code and evaluator share a mutable runtime. Do not repeat 06's “CI only after merge” or convert 05's architectural lesson into a stronger guarantee than the implementation provides.

## A — Secretless repair agent producing a patch and runnable result

**Strongest honest version:** the user supplies a supported public repository/ref and a reproducible failure. The agent diagnoses and changes source in a disposable workspace. A collector freezes the candidate, exports a bounded source-only patch, and an independent harness checks the resulting behavior. The user gets an inspectable patch and a working example, not a green model-generated summary.

**Why it could beat B:** a visible before/after fix is immediately understandable. “This input crashed; now it produces the expected result, and here is the patch” is stronger on stage than explaining triage classifications. The meaningful safety beat is the worker being unable to fake the judge's verdict while still completing useful work.

**Why I do not choose it unconditionally:** it adds patch generation and regression checking to reproduction. “Paste any repo” additionally adds dependency resolution, installation, build troubleshooting and preview orchestration. 26a's repository-setup literature is a warning; its cross-study percentages are not a measured failure probability for our chosen model. 22 proves none of these new capabilities.

**Novelty:** low at the category level. OpenHands, Codex, Devin and conventional CI already cover much of this workflow in the researched landscape. The lead additionally reports a fresh official OpenHands Verification Stack page covering agent criticism and functional QA; use its source record for the current details. This makes “other agents only trust themselves” especially indefensible. An external black-box witness can be a credible boundary, but trusted remote test drivers are not a new idea.

**The 24-hour scope that could work:** one language/runtime, immutable prebuilt dependency image, a small explicitly supported set of real public issues or one app with several distinct defects, no arbitrary installation, no production deploy, no repository write token in the runner. The final action is downloading or approving the exact source patch. A live preview is optional unless the chosen task needs it to make the result legible.

**Recommended hero candidate from the corpus:** test whether a real tabulate empty-table regression or humanize infinity-handling regression is repairable by the chosen model. Show its public historical issue and pin the buggy ref. A small UI/HTTP adapter may display inputs and outputs, but it must call the actual patched package, not duplicate the expected behavior in the UI. Label it a historical regression. An elegant demo of a real failure is more credible than another invented business incident.

**Fatal failure conditions:** only one planted bug works; the agent edits expected results; candidate code can fabricate the authoritative test report; “preview passed” is inferred from the agent's own screenshot; the final artifact differs from the artifact tested. Repair success must be measured before promising this product.

## B — Repro Receipts, re-centered on useful work

**The job:** a report arrives; turn it into a concise runnable reproduction and show whether its behavior occurs at the reported version and a pinned latest/fix version. Give the maintainer enough evidence to decide the next step without running stranger-supplied code locally.

**The product output:** a minimal repro file, exact environment/refs, actual outputs from fresh execution, and one clear disposition with caveats. A report that reproduces but describes intended behavior remains a human interpretation question. A no-fix-known case should not receive the certainty of a known-control case.

**Why B wins the evidence comparison:** it uses the concrete PoC-bearing workflow in 04 D1 and the only relevant executed feasibility work in 22. It avoids A's additional patch problem and C's browser session/side-effect problem. Code execution is intrinsic: the useful question cannot be answered reliably by chatting about the report.

**The weaknesses are material:** the strongest recent pain examples include C/Java/JS while the feasible demo set is pure Python; some maintainers reject AI-origin submissions regardless of validity; familiar CI and fuzzing systems already replay tests; small libraries sometimes fix reports immediately; the revenue hypothesis is not validated. A receipt by itself will not win a user. The interface must make the runnable repro and observed behavior obvious within seconds.

**Narrow scope:** public supported Python repos and pinned refs; bounded agent inspection/write/run loop; no secret-dependent services or arbitrary native toolchains; one real issue live and a second available; default offline verification from locked artifacts. A curated picker is honest. Arbitrary URLs can be “unsupported,” not silently coerced into the fixture.

**Do not inherit all of 25's scope:** a replay CLI, version comparison and readable evidence matter more than signature-tampering theatre, three verification refs for every task, GitHub posting, model classifiers, fancy cost accounting or a four-vector attack montage. Inference must remain useful: the agent should inspect, author/adapt the reproduction and react to real stderr. A fixed script plus an LLM-generated title is not the intended product.

**Core honesty limit:** a deterministic malicious reproducer can distinguish package versions and lie on purpose. An AST filter catches some tricks, not all programs. Independent execution establishes what the frozen program did in those environments. It does not establish the reporter's intent or general bug validity. Keep the script readable, the behavior claim narrow, and unsupported cases inconclusive.

## C — Bounded browser work with commit safety

**Strongest version:** prepare a real bounded admin change in a supported portal, obtain a human approval bound to authoritative fields, execute once, and independently read the resulting state. Alternatively, collect one UI-only evidence packet without committing a mutation.

**Why it loses this decision:** browser task utility depends on authentication, model navigation, page state and sometimes vision, while a safe commit adds identity, request binding, stale-state checks and uncertain-outcome reconciliation. A sandbox does not stop an authenticated browser from sending an authorized but unwanted request. Comparing DOM fields before a click does not guarantee the server received only those semantics. This is a larger boundary problem than code producing a downloadable artifact.

A custom seeded portal can make these pieces easy, but then a judge reasonably asks why it needed a browser agent rather than a narrow API call. A real third-party portal adds credentials, permission and reliability barriers. The strongest evidence in 03 K4 establishes browser friction, not a winning specific operational task. We should not invent another vertical to fill that gap.

**Decision:** not the default main-prize build. Consider only if a working target integration and browser flow already exist and a real user has named the task. The current audited OpenBot/OpenMuse code provides patterns, not such a verified deployment. Browser handoff and NetBird bonus appeal do not close this gap.

## D — Isolated software trial: use an unfamiliar MCP tool without local installation

This is the strongest genuinely different candidate warranted by the corpus. The user chooses a supported, pinned MCP server and a small practical task against disposable sample files. The agent installs/starts it in isolation, discovers its tools, uses them to produce a real artifact, and lets the user inspect the result. Examples must be selected from actually tested available packages; do not invent a package capability for the pitch.

**The useful outcome is the tool's output while the user's laptop remains uninvolved**, not a security score. A public package can have a real install/start failure; the product can report that failure honestly. The containment beat uses an explicitly labeled local test server that attempts an out-of-scope action; the good run still produces its intended artifact.

**Why it is attractive:** the risk follows directly from running unfamiliar package/tool code, and the task can use a standard protocol. It is less like code repair and gives an intelligible reason for a disposable environment.

**Why it is not the winner today:** no equivalent of 22 establishes a working task corpus, package boot times, model use or outputs. MCP inspectors and package-analysis systems provide close prior art. A server that needs credentials or real account access destroys the simple secret-free story. TLS interception, syscall tracing, multiple package registries, dynamic malware verdicts and NetBird per-task routing turn this into the excessive scope of 26a.

**If pursued:** support one offline-capable MCP package family, fixed dependency assets, sample data and one useful artifact format. Omit malware certification. Say “this run attempted X” or “we observed no such attempt during this run,” never “clean,” “safe to install,” or “everything it tried to do.” Delayed, dormant and sandbox-aware behavior defeat the broader claim.

Other different ideas lose harder: a dependency-upgrade rescue agent is useful but 10 explicitly records weak direct demand evidence and it adds repair complexity; an agent-certification/honeypot product has stochastic negatives; a spend governor or fleet kill switch is infrastructure without a substantial user task; a generic replay/receipt dashboard risks the anti-project rule. None earns preference just by sounding novel.

## The boundary A and B must both get right

1. **Authority:** Vultr inference keys, repository write tokens and infrastructure credentials live only in the control plane. Agent tools dispatch into a separate execution environment. Public source and synthetic inputs make the initial workload secret-free without a complicated credential-broker product.
2. **Execution:** limits, no host/Docker socket mounts, restricted egress or none, metadata blocking, task identities, output caps and supervisor-enforced termination. “Container” is not proof these controls were enabled.
3. **Artifact transfer:** stop the writer before collecting. Export only allowed bounded regular files; reject symlinks, device nodes, path traversal, unexpected manifests, altered tests and other forbidden paths. Apply the collected patch to a pristine base. Hash the actual transferred artifact.
4. **Verification:** for A, prefer an external protected HTTP/CLI harness that treats candidate outputs as data. The candidate service/process runs separately and cannot access the expected results or result store. A read-only pytest file imported into the same interpreter as malicious candidate code is insufficient. For B, state that hostile-code behavior replay is evidence with limits rather than semantic certification; do not call stdout an independent verdict.
5. **Presentation:** source-controlled expected cases and actual results belong in the evidence view. The same sealed artifact must back any preview and downloadable patch. Serve hostile previews on a separate origin without application credentials; a normal same-origin iframe is not automatically a security boundary.
6. **Lifecycle:** the agent cannot approve its own outward action. Downloading a patch avoids unnecessary external writes; if posting is added, approve exact bytes and reconcile uncertain outcomes. Clean up every task and keep public judge access separate from ephemeral task access.

The architecture teammate's external black-box witness is a good proposal for A. Finite black-box cases can still be hardcoded or incomplete; claim “these checks passed for this artifact,” not “verified correct.” An independent controller also does not imply a host-compromise-proof cryptographic attestation.

## Decide with an early experiment, then build one product

**Default commitment:** B, focused on a runnable repro and version comparison. **Possible upgrade:** A's patch export on that same input/execution engine. The upgrade must not delay the useful B flow.

| Deadline from authorized build start | Evidence to collect | Decision |
|---|---|---|
| +45 min | Real Vultr tool-call/result loop and code execution in a separate Vultr sandbox. | Shared prerequisite. If absent, fix it; neither changing names nor replaying everything resolves the challenge requirement. |
| +2 h | Model attempts three supported real issues, with fixed budgets and actual captured stdout/stderr. Separately attempt patches for a small subset if staffing permits. | Record genuine repro/repair outcomes. Do not count manually written 22 tests as model wins. |
| +3 h | Repro succeeds across several inputs; if promoting A, source patches pass protected behavioral and non-regression checks on at least three distinct bounded failures, with more than one fresh run of the hero. | Prefer A only if this incremental scope is working and demonstrably improves the story. Otherwise ship B. These are proposed thresholds, not present results or statistical reliability estimates. |
| +6 h | Public UI → model execution → trusted collected artifact → fresh result, on the actual cloud stack. | Freeze additional features until complete. No browser pivot at this point. |
| Final morning | Timed runs, independent rerun from documented artifacts, containment, clean reset, public URL and ≤60-second submission video. | Demo only achieved behavior; label stored traces and replays. |

For one builder, choose B's small supported corpus and one/two-ref replay; no patch feature, GitHub integration, dynamic installation or NetBird bonus. Two builders can plausibly attempt B plus the A spike, but this is an estimate, not demonstrated delivery capacity. More builders should improve integration/testing/presentation rather than multiply runtime agents.

## A three-minute story that serves either outcome

- **0:00–0:20:** show a real public report and the practical dilemma: “Would you run this attachment on the machine holding your keys?” State the requested useful result, not a generic AI-security slogan.
- **0:20–1:10:** the Vultr agent inspects the supported source, writes/adapts a reproduction, runs it and responds to actual errors. Show the failing input/output. Historical source and curated setup are labeled.
- **1:10–1:50:** fresh execution establishes the pinned-version behavior. If A earned its gate, show the actual patch and independently checked corrected output here; otherwise show the latest-version result and actionable maintainer report. No invented live failure/retry choreography.
- **1:50–2:20:** a labeled unsafe PoC or tampered candidate attempts to destroy its workspace or fake completion. Show the relevant enforced boundary and unaffected control plane. This is one concrete test, not proof of invulnerability.
- **2:20–2:50:** download/open the minimal repro or patch and run the documented reproduction. The artifact, inputs, versions and execution evidence are the deliverable. A digest verifies identity, not semantic safety.
- **2:50–3:00:** one honest close: “Useful code execution without handing the report your machine or credentials; a result you can inspect and rerun.”

The final choice should turn on achieved utility, not which architecture name sounds largest. **B currently has the strongest supporting evidence. A has the better potential before/after moment but must earn it with a live repair experiment. Neither needs a booking system, production mutation engine, universal sandbox platform, or claim that existing agents cannot verify their work.**

## Addendum — critique of the lead's revised Airlock choice

After the draft above, the lead proposed **Airlock** as the codename for “untrusted report → independently reproduced behavior → attempted minimal fix → frozen before/after/regression evidence + patch export.” The product teammate independently moved toward this same bounded Repro-to-Repair workflow. The suggested hero is historical tabulate#365 at its pinned pre-fix ref, with a trusted report viewer displaying the real library's returned text. This is substantially better scoped than a general repo-to-preview agent.

**My position:** conditional support for that choice, with a recorded disagreement about the default ordering. Pure reproduction is still the evidence-ranked choice before the repair experiment. The team may rationally buy the bounded extra risk for the stronger stage outcome, provided failure leaves an honest useful reproduction result rather than an invented fix. No unanimous unconditional endorsement is implied.

Specific conditions for this revised product:

- The author receives the frozen pre-fix source and report, not a mounted gold patch or fix checkout. A known historical issue may be memorized by a model; do not sell this as a blind benchmark, newly discovered bug or measured general repair capability.
- The trusted report viewer renders bounded escaped text, not candidate HTML/scripts. It must display output from the actual frozen candidate artifact. This keeps a useful visual result without the complexity of arbitrary app hosting.
- The external harness treats all returned JSON/stdout as untrusted data with strict size/schema/time bounds. It never imports the candidate package into its authoritative judging process. Candidate output cannot become instructions or a result-file path for the verifier.
- Downloaded patch, runnable example and tested candidate must bind to the same base and collected artifact digest. Regeneration or cherry-picking after verification requires a new check.
- Include normal and edge-case behavior alongside the original failure. A passing finite suite does not prove semantic equivalence or eliminate hardcoded answers. “Patch and proof” must mean recorded evidence of the stated checks, not proof of correctness.
- Keep the early live Vultr repair gate. Repeated successful fresh runs of the actual hero are required for the intended demo, and additional supported input/failure cases strengthen credibility. Do not turn three normal input tests into a claim of three independently repaired bugs.

The positioning remains **a useful maintainer intake workflow with a demonstrated separation between worker and verifier**. The freshly checked OpenHands verification capability and ordinary pre-merge CI prevent stronger category-novelty claims. This integration can still be a strong hackathon product if the patch works, the result is legible, and the boundary survives a concrete tampering test.
