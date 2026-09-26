# 02 — Tool capabilities and coverage

Preflight run on 2026-09-26 at 16:17 IST. The machine-readable ledger is `capabilities.jsonl`.

| Capability | Installed version | Actual invocation used | Auth | Quota at start | Verified output | Fallback | Limitation |
|---|---|---|---|---|---|---|---|
| Firecrawl CLI | 1.23.3 | `firecrawl search/scrape/map`, `firecrawl --status`, `firecrawl credit-usage` | `FIRECRAWL_API_KEY` env | 25,720 credits; 2 concurrent jobs | status + credit calls succeeded; search/scrape used by all agents | Firecrawl MCP | Reddit is refused ("we do not support this site"); 429s at bursts; `tbs=qdr:m` does not guarantee page dates, so dates were read from pages |
| Firecrawl MCP (hosted) | n/a | `firecrawl_search`, `firecrawl_scrape`, `firecrawl_research_search_papers`/`read_paper`/`inspect_paper`, `firecrawl_developer_search` | bearer | shared | used by the papers agent | CLI | research index covers arXiv/biomedical only |
| last30days | 3.23.0 (`~/.claude/skills/last30days`) | `python3 scripts/last30days.py "<topic>" --emit md --no-browser-cookies --save-dir …` | OpenRouter key present; no OpenAI/xAI/Perplexity | not reported | `--diagnose`: status ready; sources reddit, tiktok, instagram, x, youtube, hackernews, polymarket, github, grounding | Firecrawl search | **X needs browser-cookie auth, which was not authorized**, so X coverage is **absent**. Reddit returns keyless titles/scores only, no comment bodies. YouTube transcripts failed (402/429). |
| git | system | `git clone --depth 1` | none | n/a | both repos cloned and SHAs recorded | none | shallow history |
| gh CLI | system | read-only `gh search issues`, `gh api` | user's existing auth | GitHub rate limits | used by the validation agent | Firecrawl | read-only by instruction; nothing was posted |
| curl | system | public Vultr model list | none | n/a | `/v1/models` fetched (model list and tool-calling flags recorded in 13) | Firecrawl | inference calls need a key, which we don't have, so they were **not run** |
| Parallel agents | Claude Code Agent tool | 6 research + 1 validation + 2 synthesis writers + 1 reviewer | n/a | session guideline under 10 concurrent | all returned | sequential | Firecrawl concurrency (2) is shared; one agent overwrote another's helper script (4 queries re-logged, 03b) |

Features checked, used only where present:
- **Used:** search, scrape, and the research paper index. **Map** and **crawl** were used by the earlier session (see `.firecrawl/`) and were not needed again.
- **Not used:** Agent/Extract and interact, because targeted scrape plus `gh` sufficed.
- **Not used:** screenshots and PDF parsing, because no diagram-only content was critical.

Browser cookies, keychain and logged-in profiles: **not accessed**. `--no-browser-cookies` was passed on every last30days run.

## Coverage (counts computed from files on 2026-09-26)

| Measure | Count | Basis |
|---|---|---|
| Queries logged this run | 225 | `queries.jsonl` (a 101, b 52, p 43, r 29). The Vultr agent's curl/Firecrawl calls are in `sources-v.jsonl` and `experiments.jsonl`. |
| Unique source URLs recorded | 281 | `sources.jsonl`. Discovery results that were never recorded are not counted. |
| Sources marked inspected (fetched and read) | 145 | `inspected=true` in `sources.jsonl`. The papers agent also read 13 papers at methods/results level. |
| Evidence lines | 161 | `evidence.jsonl` (a 44, b 46, p 44, r 25, s 2) |
| Independence groups | 104 | distinct `independence_group` values |
| Last-30-day evidence lines | 56 | `window=last30days` |
| Firsthand evidence lines (strict label) | 90 | `firsthand_status=firsthand`. Papers use "firsthand-read" to mean *we* read the primary source, which is a different meaning. |
| Papers read at methods/results level | 13 (plus about 25 abstract-only) | 05 |
| Competitors in the matrix | 20 rows (25+ products) | 06, plus 03c for repro-specific competitors |
| Repositories audited | 2 (openbot@3c73cf0, openmuse@205cc38) | 07, 08 |
| Experiments | see `experiments.jsonl`. The inference probe was **not run** (no key); no Vultr resources were created. | 13 |
| Firecrawl spend | 215 credits (25,720 → 25,505, shared counter measured at the end of the run) | `firecrawl credit-usage` |

### Against the breadth targets
- **Met or exceeded:**
  - unique URLs screened: 281 recorded, against a 250–400 target;
  - relevant full sources: 145 inspected, against 120–180;
  - firsthand observations: 90 strict lines, against 40–60, though these collapse to fewer independent groups;
  - papers: 13, against 8–12;
  - competitors: 20, against 12–20;
  - pain clusters: 15 across 03a/03b (overlapping), against 8–12;
  - concepts: 18, against 15–20;
  - shortlisted: 6, against 5–8;
  - finalists: 3.
- **Shortfalls:**
  - X is absent.
  - Reddit comment bodies are absent.
  - There is no firsthand evidence from government or benefits portals.
  - There are no frequency or prevalence numbers for any cluster.
  - The evidence skews toward GitHub-issue sources.
