# Coverage, limitations and completion ledger

- **Run:** 2026-09-26, 16:16 → about 18:25 IST (researcher TZ Asia/Kolkata; event TZ America/Los_Angeles).
- **Counts:** read from files, not estimated, unless marked *(estimate)*.

## Completion ledger

| Item | Actual |
|---|---|
| Queries logged | 225 in `queries.jsonl` (a 101, b 52, p 43, r 29), plus the Vultr agent's calls logged in `experiments.jsonl` and `sources-v.jsonl`, plus the devil's-advocate verification queries (in 18, not in the ledger) |
| Unique source URLs recorded | 281 (`sources.jsonl`, unique by URL) |
| Sources inspected (fetched and read) | 145 flagged `inspected=true`. 13 papers were also read at methods/results level. |
| Evidence lines / independence groups | 161 lines / 104 distinct `independence_group` values. 03-recent-signals counts 103 excluding papers, after merging one label variant. |
| Firsthand observations | 90 lines labelled strictly `firsthand` (problem-side) |
| Last-30-day evidence (2026-08-27..09-26) | 56 lines by label. Four EV-R lines carry in-window dates but are labelled `2026-context` (see 03). |
| Papers | 13 full (methods/results), about 25 abstract-only (05) |
| Competitors | 20 matrix rows (06) plus 9 repro-specific rows (03c), plus ClusterFuzz/syzbot prior art (18) |
| Repositories and SHAs | CopilotKit/openbot `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` (2026-09-23). CopilotKit/openmuse `205cc386b75aae1a862f3fdd43104b570c8d0911` (2026-09-25). withastro/triagebot-action `51d30da` (read by the reviewer). |
| Files inspected in repos | See the file-coverage ledgers: 07 §1 (about 30 files read with line cites, plus headers of about 15 more) and 08 §10 (about 45 files read in full, about 20 partially, all test titles). Tests were **read, not run**. |
| Experiments run | 7 (EXP-V-01..04, 06..08): public model list (19 models, 14 advertise tools), guide URL 404, no-key auth behaviour, probe dry run with an invalid key, Google Docs public export, CV event record dates, Vultr public plans/regions |
| Experiments passed/failed | All 7 returned usable results. EXP-V-02 confirmed the guide's model-list URL returns 404, which is a discrepancy rather than a failure of ours. |
| Experiments **not run** | EXP-V-05 (full inference probe: no key), EXP-V-09 (VX1 `/dev/kvm`), EXP-V-10 (VM boot latency), EXP-V-11 (metadata reachability from sandbox), EXP-V-12 (billing granularity). All need a Vultr account or spend, so they're assigned to kickoff. No repo code, installs or containers were run. |
| Firecrawl spend | 25,720 → 25,505 remaining = **215 credits** measured by the shared counter. Per-agent self-reports overlap because the counter is shared. |
| last30days runs | about 13+ runs across agents, all with `--no-browser-cookies` (per-agent raw dirs) *(count approximate: see `raw/problems-*`)* |
| Vultr spend / resources created | **None** |
| Outward actions | **None**: no posts, PRs, comments, messages, logins or account connections |

## Inaccessible or degraded sources
- **X/Twitter:** needs browser-cookie auth, which was not authorized, so there is no coverage. The Loss-of-Control Observatory counts (EV-A-0021) couldn't be checked.
- **Reddit:** Firecrawl refuses it and direct `.json` returns 403, so there are titles/scores only via last30days and no comment bodies. No Reddit item is used as firsthand evidence.
- **YouTube transcripts:** HTTP 402/429.
- **Paywalls and logins:** Medium (Explyt) is paywalled. LinkedIn is snippet-only.
- **Cerebral Valley `/details` and `/hackathon/submit`:** login-gated, so the **judge list and event-specific submit questions are unknown**.
- **Research gaps:**
  - Government/benefits portal firsthand evidence: a query hit a 429 and wasn't retried.
  - Devin, Modal and Operator-specific complaints were not gathered.

## Known limitations of the conclusions
- There are no prevalence or frequency statistics for any pain cluster, and the online sample is self-selected and GitHub-heavy.
- Demand for the chosen concept is real but partially mismatched:
  - Recent firsthand repro pain is mostly JS, C and Java, while the MVP is Python (18 DA-06).
  - The strongest counterevidence (curl, Vite-style burden shifting) shows policy fixes work.
- Novelty is a *stronger boundary plus packaging*, not a new capability (06, 18 DA-05).
- All Vultr inference behaviour (tool calls, `-normalize`, streaming) is **unverified** until K1.
- The build estimate is uncertain. 09's component rows sum to 33–54 h, against a 24.5 h window, so the cut lines in 15 are mandatory, not optional.
- Scores are our decision model. Two scorers (director and reviewer) disagree by about 0.75 points and were not averaged.

## Prioritized continuation queue
1. **K3a model-only repro spike**, once a Vultr inference key exists. This decides the pivot.
2. K1 probe (`raw/vultr/probe_inference.sh`, then move it into the product repo).
3. K2 sandbox checks on a Vultr VM: gVisor from apt, metadata blocked, per-sandbox network isolation, pids and memory caps.
4. Pre-install check of all 10 curated issues, including the setuptools-scm version workaround.
5. Log in to CV to get the judge list and submit-form questions, and ask the organizers:
   - whether in-sandbox containment satisfies the "containment moment";
   - whether NetBird can be judged on a partial tier.
6. Research follow-ups if time allows:
   - Python-specific repro pain from the last 30 days, to close the DA-06 mismatch;
   - a triagebot-action user experience report.
