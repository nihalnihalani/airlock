# 14 · NetBird Bonus Plan: Go/No-Go, Topology, Lifecycle Binding

> **Amended by the organizers' clarification (see [01 §2c-1](01-rules-and-compliance.md) and [38 §3.4/§4](38-kickoff-decks-and-netbird-clarification.md)).** The three bullets are **not cumulative tiers**: any one approach qualifies, and a fourth approach, **peer-to-peer connectivity over WireGuard**, was added. NetBird remains an **optional add-on attempted only after Airlock's core works**; if attempted, the plan is approach 3 for the controller → supervisor link (supervisor bound to its NetBird address, zero inbound rules on VM B, deny-by-default access policy), combined with approaches 1 and 2 for the public URL and the judge role. §3 (lifecycle-bound URLs) is **not pursued** for Airlock, whose preview has no per-task URL by design. §2's topology, §4's judge access and the self-hosting facts in §1 still apply; the go/no-go clocks in §6 do not.

Re-verified **2026-09-26 11:00–11:15 UTC (16:30–16:45 IST, 04:00–04:15 PDT)** with fresh fetches of the NetBird docs and the GitHub releases API. Raw pages are in `raw/vultr/netbird/`. This builds on `03-netbird-bonus.md` (API payloads, gotchas and pain points are not repeated here).

Organizer requirement IDs NB-01…NB-06 are defined in `01-rules-and-compliance.md` §2c.

---

## 1. Re-verified facts

| Fact | Status today | Evidence |
|---|---|---|
| Latest release | **v0.79.0** (2026-09-18). Earlier: v0.78.2 (09-14), v0.79.0-rc.1, v0.80 canary builds exist. | GitHub releases API |
| Reverse proxy status | "Availability: Reverse Proxy is currently in **beta**." Self-hosted must use **Traefik** ("the only supported reverse proxy that provides TLS passthrough") | `/manage/reverse-proxy` |
| Service statuses | `pending` → `certificate_pending` (ACME only) → `active`; failure: `tunnel_not_created`, … | same |
| TLS modes | ACME per domain, static cert dir, wildcard cert dir | same |
| `netbird expose <port>` | Flags: `--with-pin`, `--with-password`, `--with-user-groups`, `--with-name-prefix`, `--with-custom-domain`, `--with-external-port`, `--protocol` | `/manage/reverse-proxy/expose-from-cli` |
| Expose lifecycle | Keep-alive "every 30 seconds"; server session "90-second TTL"; Ctrl+C / stop → removed immediately; `kill -9` / crash → removed "after 90 seconds"; **"Management server restart: In-memory sessions are lost. Yes, immediately on restart"** | same |
| Expose limits | "Each peer can have a maximum of **10 active expose sessions**"; auth on expose = "SSO (user groups), Password, PIN (HTTP only)", so **no header auth via expose**; needs admin to enable `peer_expose_enabled` (+ `peer_expose_groups`); fails if peer has "Block Inbound Connections" | same |
| Audit events | "Peer exposed service", "Peer unexposed service", "Peer expose expired" | same |
| Auth methods (operator auth) | SSO (OIDC, optional distribution-group restriction, **sessions 24 h**), Password (Argon2id), PIN, Header auth. "Multiple methods can be enabled on the same service; users pick which one to use". NetBird-Only (private) access "does not combine with operator auth on the same service". Country restrictions **fail closed** without the GeoIP DB | `/manage/reverse-proxy/authentication` |
| Identity headers to backend | Proxy injects `X-NetBird-User` and `X-NetBird-Groups` (private/NetBird-only mode) | same |
| Services API | `GET/POST /api/reverse-proxies/services`, `GET/PUT/DELETE /api/reverse-proxies/services/{serviceId}`, `GET/POST /api/reverse-proxies/domains`, `GET …/domains/{id}/validate`, `DELETE …/domains/{id}`, `GET /api/reverse-proxies/clusters`, `DELETE …/clusters/{clusterAddress}` (BYOP) | `/api/resources/services` |
| Auth fields in API | `auth.password_auth`, `auth.pin_auth`, `auth.bearer_auth{distribution_groups}` (= SSO), `auth.link_auth`, `auth.header_auths[]`; plus `access_restrictions`, `private`, `access_groups` | same |
| **TTL/expiry on API-created services** | **None.** No `ttl`/`expire`/`expires_at` field in the Services API page. API-created services are permanent until `DELETE`. | same (absence verified by text search) |
| Ephemeral peers | Setup key with ephemeral option: peers "automatically removed… after staying offline for more than 10 minutes". One-off keys recommended; dashboard default expiry 7 days | `/manage/peers/register-machines-using-setup-keys` |
| Vultr Marketplace | App id **1334 "NetBird Server"** (`image_id netbird-server`) live in `/v2/applications`. Docs: Shared CPU with "at least 2 GB of memory"; stack = Traefik + NetBird Proxy (on by default) + CrowdSec + local user store; DNS `A netbird` + **`CNAME *.netbird` ("required for the NetBird Proxy to issue certificates")**; reserve an IP first; Cloudflare DNS-only | `/selfhosted/marketplaces/vultr` + Vultr API |
| Management host ports | "The VM must be publicly accessible on **TCP ports 80 and 443, and UDP port 3478**" + a public domain; ≥1 CPU / 2 GB | `/selfhosted/selfhosted-quickstart` |
| Plan for NetBird VM | `vc2-1c-2gb` $0.014/h (atl, sjc, lax) | Vultr `/v2/plans` today |

---

## 2. Concrete topology

```
Internet ──HTTPS──▶ ┌──────────────────────────────────────────────────────────────┐
                    │ VM-NB  "netbird" (Marketplace 1334, vc2-1c-2gb, atl)          │
                    │ Firewall group FW-NB: TCP 80, TCP 443, UDP 3478 inbound       │
                    │   (+ TCP 22 from team IP only, or none + console access)      │
                    │ Traefik :443 SNI passthrough → netbird-proxy (TLS, auth gate) │
                    │ netbird-server (mgmt+signal+relay+STUN), dashboard, Dex local │
                    └──────────────▲───────────────────────────▲───────────────────┘
                                   │ outbound WireGuard/gRPC    │ outbound only
     ┌─────────────────────────────┴──────────┐   ┌────────────┴────────────────────────────┐
     │ VM-CP control plane (atl)              │   │ VM-SBX sandbox host (atl)               │
     │ FW-ZERO: **0 inbound rules**           │   │ FW-ZERO: **0 inbound rules**            │
     │ netbird peer (group: app)              │   │ netbird peer (group: sandboxes)         │
     │ web app :3000 on wt0/0.0.0.0           │   │ per-task preview/noVNC ports bound to   │
     │ service "app.<dom>" (permanent):       │   │  NetBird IP; `expose-supervisor` runs   │
     │  SSO[operators] + password[judge]      │   │  `netbird expose` per task (≤10/peer)   │
     │ orchestrator: NB service-user PAT      │   │ no NB PAT on this host                  │
     └────────────────────────────────────────┘   └─────────────────────────────────────────┘
     Admin SSH: via NetBird SSH/peer access (no public 22) or temporarily-allowed team IP, removed before recording.
```

Say this explicitly on video and in the README: **the NetBird VM needs inbound 80/443/3478, and that is the only public entry point. The app VM and the sandbox VM have zero inbound rules.** "No inbound application ports on the VM" (NB-01) refers to the app VM. See Q-03 in file 01.

Access policies (NetBird ACL):
- `app → sandboxes` on the daemon/preview ports only
- `sandboxes ↛ app`
- `sandboxes ↛ sandboxes`
- Delete the default all-to-all policy.

Proxy→target ACLs for services are generated by management.

---

## 3. Lifecycle binding of URLs to tasks (tier 3), including crash reconciliation

There are two mechanisms, and we use both for different purposes.

| Mechanism | Who holds the lifetime | Crash behaviour | Limits | Use for |
|---|---|---|---|---|
| **A. `netbird expose` child process** on the sandbox host, supervised per task | The process. It dies when the task's sandbox dies. | Host/process crash → URL gone in **≤ 90 s** (TTL reaper). Management restart → **all** sessions gone immediately. | 10 per peer; auth = SSO groups / password / PIN only | **Per-task URLs** (the tier-3 story: "URL lifetime = process lifetime") |
| **B. Services API** (`POST`/`DELETE /api/reverse-proxies/services`) from the orchestrator | Our DB row | **No server-side TTL.** An orchestrator crash leaves the URL live until the reconciler deletes it. | NetBird Cloud documents 120 req/min; self-hosted is [unverified] | Permanent judge/app service; fallback per-task path if expose fails |

**Task state machine** (the control plane owns it; the DB table `task_urls(task_id, mech, nb_service_id|expose_pid, url, auth, created_at, expires_at, state)`):

```
QUEUED → SANDBOX_READY → URL_PENDING → URL_ACTIVE → (DONE|FAILED|TIMEOUT|CANCELLED) → URL_REVOKING → URL_GONE
```

- **Create (A):**
  1. The sandbox daemon starts `netbird expose <port> --with-name-prefix t-<id> --with-pin <pin>` (or `--with-user-groups reviewers`).
  2. It parses the printed URL and reports `{url, pid}` to the control plane.
  3. The control plane polls until the URL answers with an auth challenge, then marks it `URL_ACTIVE`.
- **Create (B):**
  1. `POST` the service with name `t-<id>`, target type `peer`, and auth.
  2. Poll `GET …/{id}` until `meta.status == active`. With a wildcard cert this is instant; otherwise it waits in `certificate_pending`.
- **Teardown:** on any terminal task state, SIGTERM the expose process (removed immediately) or `DELETE` the service. Then destroy the sandbox, then verify: `curl` the URL and expect a non-200 or TLS failure. Record `URL_GONE` with a timestamp. **Revoke the URL before destroying the sandbox**, so no URL ever points at a dead target.
- **Hard TTL:** every task carries `expires_at` (e.g. 15 min). A watchdog enforces it even if the agent loop hangs.
- **Reconciler** (runs every 30 s, and **first thing on control-plane boot**):
  1. `GET /api/reverse-proxies/services` and filter names beginning `t-`. Delete any whose task is terminal, missing from the DB, or past `expires_at`. This handles orchestrator crashes for mechanism B.
  2. For DB rows in `URL_ACTIVE` whose URL no longer resolves: if the task is still running, the expose session was lost (management restart or network loss), so re-run expose or mark `URL_LOST` and surface it in the UI. Otherwise mark `URL_GONE`.
  3. Sandbox host: kill any `netbird expose` process whose task id is not active. This catches supervisor bugs.
  4. Vultr: delete `sandbox`-tagged instances past TTL (shared janitor, file 13).
- **Crash matrix:**

  | What crashed | Result |
  |---|---|
  | Sandbox or host | URL dies in ≤ 90 s (A) |
  | Control plane | A-URLs survive until their tasks' watchdog on the sandbox host kills them. **Put the TTL on the sandbox daemon as well, not only on the control plane.** B-URLs are removed by the reconciler on restart. |
  | NetBird management | All A-URLs die, and the permanent B service survives (persisted). **Do not restart management during judging.** |

---

## 4. Judge access

- **Permanent service `app.<domain>`** (mechanism B), with operator auth enabled:
  - **Password** → our app's `judge` role: can view runs and start the scripted demo tasks, but can't change settings or keys.
  - **SSO** `operators` group → team.
- **README:** URL, judge password, and a note that per-task links show a PIN in the UI. The organizer explicitly asks for credentials in the README (NB-05). Scope them to the judge role. Rotate the password after judging.
- **Real user role mapping (NB-02):**

  | NetBird gate | App role |
  |---|---|
  | `operators` (SSO group) | admin console |
  | `reviewers` (SSO group) | open per-task URLs |
  | password | judge |
  | PIN | one-off share of a single run |
  | header auth (`X-Verifier-Token`) | machine verifier/webhook, on a separate service, since expose lacks header auth |

  Demo: alice (in `reviewers`) is admitted; bob (authenticated, not in the group) is denied.

---

## 5. Incremental plan, complexity and risk

| Step | Delivers | Effort | Main risks | Exit check |
|---|---|---|---|---|
| 0 | Domain + reserved IP + DNS (`A netbird`, `CNAME *.netbird`) | 15 min + propagation | **No domain** (buying one is the team's decision and cost); DNS propagation | `dig +short x.netbird.<dom>` → reserved IP |
| 1 | Marketplace NetBird VM up, admin created, peers enrolled on CP and SBX with one-off/ephemeral setup keys | 30–45 min | LE issuance, Traefik, the marketplace script stalls | Dashboard shows 2 peers online |
| 2 = **tier 1** | `app.<dom>` → CP:3000; remove all inbound rules from CP's firewall group | 20 min | App bound to 127.0.0.1 → 502; wrong target type | nmap of CP public IP: all filtered; URL loads |
| 3 = **tier 2** | Password + SSO groups; alice/bob demo | 20–30 min | External IdP callback (avoid: use embedded Dex local users) | Deny/allow shown |
| 4 = **tier 3** | Per-task expose supervisor + reconciler + UI link + "URL died" check | 1.5–2.5 h | 10/peer cap; cert latency per new subdomain (ACME) unless a wildcard cert is loaded; beta bugs | URL dies ≤ 5 s after task end; `kill -9` test ≤ 90 s |
| Stretch | Wildcard cert via DNS-01; private service with `X-NetBird-User` RBAC; posture check "supervisor running"; CrowdSec enforce | 1–2 h | Scope creep | only after C1 core is frozen |

Total for tiers 1–3: **about 3.5–5 h of one person's time.** This is not on the C1 critical path.

---

## 6. Go / no-go and defer criteria

**Decision: conditional GO for tiers 1 + 2. GO for tier 3 only if the gates below pass.** Assign one teammate. Never block C1 work on it.

Defer or stop if any of these happen:
1. **No domain with DNS control by 13:30 PDT Sat (02:00 IST Sun).** Drop self-hosting.
   - Optional fallback: NetBird Cloud with its free `*.proxy.netbird.io` domains, only if organizers confirm Cloud counts (Q-04).
   - Untested idea: `sslip.io`-style wildcard DNS. Its rate-limit and certificate behaviour are [unverified].
2. **NetBird VM not serving the dashboard with valid TLS 45 min after deploy.** Stop and destroy the VM.
3. **C1 core not working by 02:00 PDT Sun.** Core means plan → dispatch → sandbox → real output → containment moment. If it isn't, freeze NetBird at whatever tier already works.
4. **Tier 3 flaky at 10:00 PDT Sun** (URL doesn't die reliably, or orphans appear). Claim only tiers 1–2 in the video and description.
5. **During judging:** never restart NetBird management, since that wipes expose sessions. Keep the permanent judge service on mechanism B.

Why it's worth it:
- It directly strengthens the C1 story: sandboxes get identity, no inbound ports, and URLs that die with the task.
- It's cheap: +$0.014/h.
- It has its own $500 prize.

Why it's risky:
- The feature is beta.
- A domain is required.
- Several moving parts (ACME, Traefik, peers) could eat 2+ hours if anything misbehaves.

---

## 7. Rule ambiguities to ask organizers

- **Q-03 (critical):** With a self-hosted management server, is it acceptable that the *NetBird VM* has 80/443/3478 open while the *app VM* has zero inbound ports? Does SSH (22) on the app VM count as an "application port"?
- **Q-04:** Does NetBird Cloud (not self-hosted) qualify for the bonus, or only a Vultr self-hosted management server?
- **Q-09:** Are the three bullets cumulative tiers? Does claiming tier 3 require tiers 1 and 2 too? The doc's wording ("second tier", "third") implies yes.
- **Q-10:** What counts as a "real user role"? Is an app role (judge/reviewer/operator) mapped to NetBird groups enough, or must it be IdP SSO?
- **Q-11:** For tier 3, is a **per-session** URL (per judge session) acceptable, or must it be per agent task? The doc says "per task or session", so we think either is acceptable.
- **Q-12:** Is it acceptable to put judge credentials in a public README (the doc says to), and should we rotate them after judging?
- **Q-02:** How does the video length limit interact with the containment moment plus the zero-ports moment (file 01 D-06)?
