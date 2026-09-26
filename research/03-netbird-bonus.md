# 03 · NetBird Bonus: Zero-Port Access, Gated URLs, Lifecycle-Bound Endpoints

Research date: 2026-09-26 (hackathon day 1). Current NetBird release: **v0.79.0** (latest on GitHub). The reverse proxy is still labelled **beta** in the docs.
Scraped sources are cached under `.firecrawl/netbird/`.

---

## TL;DR

- **What the bonus wants** (participant guide §3): (1) the public demo URL is served by NetBird's reverse proxy with **zero inbound ports on the app VM**; (2) **gated access** (SSO / password / PIN / header auth) mapped to a real user role; (3) **lifecycle-bound URLs** created per task or session that die with the workload.
- **NetBird has all three built in:**
  - **Reverse Proxy**, added in **v0.65** (Feb 2026). It terminates TLS on a NetBird proxy cluster and forwards over WireGuard to a peer. The target needs no public IP and no open port.
  - **`netbird expose`**, added in **v0.66** (Feb 23 2026). It creates an **ephemeral** public service that stays up only while the command runs. It renews every 30s against a 90s TTL, and the server reaps it if the process dies.
  - **REST API** `POST/DELETE /api/reverse-proxies/services` for orchestrator-driven per-session URLs, with SSO-group, password, PIN and header auth in the same payload.
- **Vultr is a first-class NetBird target.** There is an official **"Deploy NetBird on Vultr" Marketplace app** (Traefik + NetBird Proxy + CrowdSec + local users are pre-baked). This is the fastest way to self-host the management plane on a small Vultr VM.
- **Recommended architecture:**
  - **Control-plane VM** (NetBird Marketplace image, 1 vCPU / 2 GB). Open only TCP 80 and 443 plus UDP 3478.
  - **App/orchestrator VM and sandbox VMs** behind a Vultr Firewall Group with **zero inbound rules**. Each runs a NetBird agent, enrolled with an ephemeral, auto-grouped setup key.
  - **Per-session URLs:** the orchestrator (a NetBird service user PAT) calls `POST /api/reverse-proxies/services` when a task starts and `DELETE` when it ends. As a dead-man's switch, it also runs `netbird expose` inside the sandbox, so the URL dies within 90s even if the orchestrator crashes.
- **Biggest gotchas:**
  1. Self-hosting needs a **real domain** with an A record plus a **wildcard CNAME**.
  2. Per-session subdomains with ACME will hit **Let's Encrypt rate limits** and add cert latency. Use a **wildcard cert (DNS-01, e.g. lego + Vultr DNS)** via `NB_PROXY_WILDCARD_CERT_DIR` so new URLs go `active` instantly.
  3. The target app must bind **0.0.0.0**, not 127.0.0.1.
  4. Use target type **Peer**, not Subnet, when the service runs on the peer itself.
  5. `netbird expose` supports PIN, password and SSO-groups only (no header auth), and is capped at **10 sessions per peer**.

---

## How the reverse proxy works

Source: https://docs.netbird.io/manage/reverse-proxy (updated Aug 21 2026)

```
Browser ──TLS──▶ NetBird proxy cluster (public IP, :443, SNI router)
                    │  auth gate (SSO / pwd / PIN / header) + access restrictions (CIDR / country / CrowdSec)
                    ▼
               WireGuard tunnel (NetBird mesh; P2P or relayed)
                    ▼
               Target peer (no public ports) → local app on 0.0.0.0:<port>
```

**Services** are the unit of configuration. Each one has:
- a mode: `http` (L7) or `tcp` / `udp` / `tls` (L4)
- a domain
- one or more targets. Target types:
  - **Peer**: a machine running the NetBird client
  - **Host / Domain / Subnet**: a network resource reached via a routing peer
  - **Proxy Cluster**: dial from the proxy host itself
- auth
- access restrictions
- settings: pass host header, rewrite redirects, PROXY protocol v2, UDP idle timeout
- an enabled/disabled toggle

**Path-based routing.** Multiple targets can share one domain by path, e.g. `/` → UI on peer A and `/api` → API on peer B.

**Domains.**
- Cloud: `{sub}.{nonce}.{cluster}.proxy.netbird.io`, free and instant.
- Self-hosted: `{sub}.{NB_PROXY_DOMAIN}`.
- Custom domains work via CNAME. Since v0.79 they must be validated before a service can use them, and a 48h validation window applies.

**Status lifecycle:** `pending` → `certificate_pending` → `active`. Failure states are `tunnel_not_created`, `certificate_failed` and `error`. Poll `GET /api/reverse-proxies/services/{id}` until `meta.status == "active"` before handing the URL to a user.

**TLS modes on the proxy:**
- **ACME** (default `tls-alpn-01` on 443, or `http-01` on 80)
- **Static cert** (`NB_PROXY_CERTIFICATE_DIRECTORY`)
- **Wildcard dir** (`NB_PROXY_WILDCARD_CERT_DIR`): services that match a loaded wildcard skip ACME entirely. Certificates hot-reload.

**Self-hosted requirement.** You must run **Traefik** in front, because TLS passthrough is needed. Traefik routes `:443` SNI traffic to the `netbirdio/netbird-proxy` container on `:8443`.

**Ephemeral CLI mode (`netbird expose`)** — https://docs.netbird.io/manage/reverse-proxy/expose-from-cli
- **Session lifecycle:**
  - The daemon creates the service and sends a keep-alive every **30s**.
  - The server keeps an in-memory session with a **90s TTL**.
  - Ctrl+C or SIGTERM deletes the service immediately.
  - `kill -9`, a crash, or a network loss deletes it after ≤90s.
  - A management restart wipes all expose sessions.
- **Audit events:** "Peer exposed service", "Peer unexposed service" and "Peer expose expired".
- **Flags:** `--protocol http|https|tcp|udp|tls`, `--with-pin`, `--with-password`, `--with-user-groups`, `--with-custom-domain`, `--with-name-prefix` (1–32 chars, `[a-z0-9-]`), `--with-external-port` (L4 only).
- **Prerequisites:**
  - An admin must enable **Peer Expose** (Settings → Clients, or `PUT /api/accounts/{id}` with `settings.peer_expose_enabled=true` and `peer_expose_groups=[...]`).
  - The peer must not have "Block Inbound Connections" enabled.
- **Limit:** max **10 active expose sessions per peer**.

**Private services (v0.72, "NetBird-Only Access").**
- `private: true` plus `access_groups` makes the service reachable only from mesh peers whose owner is in those groups.
- The proxy stamps `X-NetBird-User` and `X-NetBird-Groups` headers on upstream requests. Client-supplied copies are stripped, so the backend can trust them for RBAC.
- It needs a proxy that advertises the `Private` capability, i.e. an embedded `netbird proxy` / BYOP with `NB_PROXY_PRIVATE=true`.
- It is mutually exclusive with SSO, password, PIN and header auth on the same service.

**Release timeline (reverse-proxy related):**

| Version | Change |
|---|---|
| v0.65 (Feb 2026) | Built-in reverse proxy + custom domains |
| v0.66 (Feb 23 2026) | `netbird expose` |
| v0.69 | CrowdSec IP reputation |
| v0.72 | Private services + Bring-Your-Own-Proxy |
| v0.78 | Header auth validated by proxy (#7263); Rosenpass now works through the proxy |
| v0.79 | Group access enforced when minting *and* honouring session cookies (#7240); custom-domain validation required before service create (#7341); `NB_PROXY_UPSTREAM_HTTP_VERSION` |

The docs page still says Rosenpass is unsupported. The v0.78 notes supersede that, but it is safest not to enable Rosenpass.

---

## Self-hosting on Vultr (step by step)

### Option A (fastest, recommended): Vultr Marketplace "NetBird"

Source: https://docs.netbird.io/selfhosted/marketplaces/vultr

1. **Reserve an IP first** (Products → Network → Reserved IPs). You can then create DNS records before first boot, and Let's Encrypt succeeds immediately.
2. **Create the DNS records** for your domain. Vultr DNS is fine. Keep them "DNS only" if you use Cloudflare.

   | Type | Name | Content |
   |---|---|---|
   | A | `netbird` | `<reserved IP>` |
   | CNAME | `*.netbird` | `netbird.example.com` |

   The wildcard is required for proxy service subdomains.
3. **Deploy the instance.** Choose Shared CPU with **≥2 GB RAM**, then Marketplace Apps → **NetBird**. Enter the Let's Encrypt email and the domain `netbird.example.com`, and attach the reserved IP.
4. **Watch the install.** In View Console, wait for `NetBird setup is complete`.
5. **Create the first admin.** Open `https://netbird.example.com` and create the first **local admin**. The embedded Dex IdP means no external IdP is needed.
6. **Know what's included.** The stack lives in `/opt/netbird` and ships Traefik, NetBird Proxy (enabled by default), CrowdSec and a local user store.
   - Upgrade with `cd /opt/netbird && docker compose pull && docker compose up -d`.
7. **Harden SSH:** disable root login and use key-only auth. Better still, restrict port 22 in the Vultr firewall to your IP, or remove it and use NetBird SSH.

### Option B: plain Ubuntu VM + quickstart script

Source: https://docs.netbird.io/selfhosted/selfhosted-quickstart

- **Requirements:** 1 CPU / 2 GB, public on **TCP 80, TCP 443, UDP 3478**, a public domain, Docker with compose v2, `jq` and `curl`.
- **Run the script:**

  ```bash
  curl -fsSL https://github.com/netbirdio/netbird/releases/latest/download/getting-started.sh | bash
  # choose [0] Traefik (default) → "Enable proxy? y" → optionally CrowdSec
  ```

- **Generated files:** `docker-compose.yml`, `config.yaml` (combined management + signal + relay + STUN), `dashboard.env` and `proxy.env`.
- **Fully headless bootstrap (no browser)** — https://docs.netbird.io/selfhosted/automated-setup:

  ```bash
  # netbird-server service env: NB_SETUP_PAT_ENABLED=true ; docker compose up -d
  curl -fsS -X POST https://netbird.example.com/api/setup -H 'Content-Type: application/json' \
    -d '{"email":"admin@example.com","name":"Admin","password":"<long-random>","create_pat":true,"pat_expire_in":2}'
  # → {"user_id":"...","personal_access_token":"nbp_..."}  (shown once)
  ```

  Afterwards, create a dedicated **service user + PAT** for the orchestrator and let the setup PAT expire.

- **Adding the proxy to an existing install** — https://docs.netbird.io/selfhosted/migration/enable-reverse-proxy
  1. Generate a proxy token:
     ```bash
     docker exec -it netbird-server /go/bin/netbird-server --config /etc/netbird/config.yaml admin token create --name my-proxy
     ```
     It returns an `nbx_...` token, shown once.
  2. Add the `proxy` container with Traefik TCP/TLS-passthrough labels to `:8443`.
  3. Write `proxy.env`:
     ```
     NB_PROXY_DOMAIN=netbird.example.com        # or proxy.example.com
     NB_PROXY_TOKEN=nbx_...
     NB_PROXY_MANAGEMENT_ADDRESS=http://netbird-server:80
     NB_PROXY_ALLOW_INSECURE=true                # OK: Docker-internal network only
     NB_PROXY_ADDRESS=:8443
     NB_PROXY_ACME_CERTIFICATES=true
     NB_PROXY_ACME_CHALLENGE_TYPE=tls-alpn-01
     NB_PROXY_CERTIFICATE_DIRECTORY=/certs
     NB_PROXY_FORWARDED_PROTO=https
     NB_PROXY_PROXY_PROTOCOL=true
     NB_PROXY_TRUSTED_PROXIES=172.30.0.0/24
     ```
  4. Verify with `curl -H "Authorization: Token $PAT" https://netbird.example.com/api/reverse-proxies/clusters`. Expect `online: true`.

### Recommended for the demo: wildcard cert, no ACME per URL

Source: https://docs.netbird.io/use-cases/security/private-no-inbound

Issue `*.netbird.example.com` once over DNS-01 with lego. Lego has a Vultr DNS provider that uses `VULTR_API_KEY`; verify the provider name in the lego docs.

```bash
lego --email you@example.com --dns vultr -d '*.netbird.example.com' --path /certs run
```

Then set `NB_PROXY_WILDCARD_CERT_DIR=/certs/...` on the proxy. Every per-session subdomain goes live with no `certificate_pending` wait, and you avoid Let's Encrypt limits: 50 certs per registered domain per week and 300 new orders per 3h (https://letsencrypt.org/docs/rate-limits/).

### Ports: management host vs app VM

| Host | Inbound needed | Why |
|---|---|---|
| **NetBird control-plane VM** | **TCP 443** (dashboard, API, gRPC, relay-over-WebSocket, *and* all proxied public URLs via Traefik SNI) · **TCP 80** (ACME http-01 / redirect) · **UDP 3478** (STUN) · optional TCP 22 locked to your IP · extra TCP/UDP ports only if you publish L4 services | Public entry point |
| **App / orchestrator VM** | **None** | NetBird agent dials out. WireGuard P2P uses UDP hole punching; if that fails, traffic falls back to the relay over 443 on the control-plane VM |
| **Sandbox VMs / containers** | **None** | Same as above |

### Enrolling peers (app VM, sandboxes)

```bash
# host install (Linux)
curl -fsSL https://pkgs.netbird.io/install.sh | sh
netbird up --management-url https://netbird.example.com --setup-key "$NB_SETUP_KEY" --hostname "sbx-$TASK_ID"

# or container (sidecar)
docker run -d --name nb-$TASK_ID --cap-add=NET_ADMIN --network container:<app> \
  -e NB_MANAGEMENT_URL=https://netbird.example.com -e NB_SETUP_KEY=$NB_SETUP_KEY \
  -v nb-$TASK_ID:/var/lib/netbird netbirdio/netbird:latest
```

The Docker flags follow NetBird's standard container pattern. Double-check them against the NetBird Docker install docs before relying on them.

**Setup keys** — https://docs.netbird.io/manage/peers/register-machines-using-setup-keys
- Types are `one-off` or `reusable`.
- With `ephemeral: true`, peers auto-delete after **10 min offline**.
- `auto_groups` puts every enrolled peer into groups, so ACLs apply automatically.
- `expires_in` is in seconds, minimum 86400 (1 day).

---

## API for lifecycle-bound URLs

- **Base URL:** self-hosted is `https://netbird.example.com/api`; Cloud is `https://api.netbird.io/api`.
- **Auth header:** `Authorization: Token <PAT>`.
- **Rate limit:** Cloud allows 120 req/min with a burst of 1200.
- **Who should call it:** use a **service user**, not a human PAT (https://docs.netbird.io/api/guides/authentication). The Services permission requires **Network Admin or higher**.

### One-time bootstrap (orchestrator)

```bash
H=(-H "Authorization: Token $NB_PAT" -H "Content-Type: application/json")
API=https://netbird.example.com/api

# 1) service user + PAT for the orchestrator (role must cover the Services module)
curl -s "${H[@]}" -X POST $API/users -d '{"name":"orchestrator","role":"network_admin","is_service_user":true,"auto_groups":[]}'
curl -s "${H[@]}" -X POST $API/users/$SVC_USER_ID/tokens -d '{"name":"orchestrator","expires_in":2}'

# 2) groups: sandboxes, and IdP/user groups used as "roles" for SSO gating
curl -s "${H[@]}" -X POST $API/groups -d '{"name":"sandboxes"}'
curl -s "${H[@]}" -X POST $API/groups -d '{"name":"reviewers"}'   # human role allowed to view task URLs

# 3) ephemeral setup key that auto-tags sandboxes (one-off per sandbox if you want 1 key = 1 VM)
curl -s "${H[@]}" -X POST $API/setup-keys -d '{"name":"sbx","type":"reusable","expires_in":86400,
  "auto_groups":["<sandboxes-group-id>"],"usage_limit":0,"ephemeral":true}'

# 4) optional: allow sandboxes to self-expose (dead-man's-switch URLs)
curl -s "${H[@]}" -X PUT $API/accounts/$ACCOUNT_ID -d '{"settings":{"peer_expose_enabled":true,"peer_expose_groups":["<sandboxes-group-id>"]}}'
```

- The `/users` and `/groups` body fields follow NetBird's documented API resources. Confirm the exact role enum (`admin`, `network_admin`, …) against https://docs.netbird.io/api/resources/users on the day.
- **Lock sandboxes down with an access policy.** Sandboxes must not reach each other or the orchestrator's private ports. `POST /api/policies` allows only what is needed (default deny once you remove the "Default" all-to-all policy). Proxy → target ACLs are generated by management for reverse-proxy services.

### Per task / session: create URL

```bash
# find the sandbox peer id (enrolled with --hostname sbx-$TASK_ID)
PEER_ID=$(curl -s "${H[@]}" "$API/peers?name=sbx-$TASK_ID" | jq -r '.[0].id')

SVC=$(curl -s "${H[@]}" -X POST $API/reverse-proxies/services -d @- <<JSON
{
  "name": "task-$TASK_ID",
  "domain": "task-$TASK_ID.netbird.example.com",
  "mode": "http",
  "enabled": true,
  "pass_host_header": false,
  "rewrite_redirects": true,
  "targets": [{ "target_id": "$PEER_ID", "target_type": "peer", "protocol": "http",
                "port": 3000, "enabled": true, "options": {"request_timeout":"30s"} }],
  "auth": {
    "bearer_auth":  { "enabled": true, "distribution_groups": ["<reviewers-group-id>"] },
    "pin_auth":     { "enabled": true, "pin": "$SESSION_PIN" },
    "header_auths": [{ "enabled": true, "header": "Authorization", "value": "Bearer $SESSION_TOKEN" }]
  },
  "access_restrictions": { "crowdsec_mode": "enforce" }
}
JSON
)
SVC_ID=$(echo "$SVC" | jq -r .id)
# poll until active
until [ "$(curl -s "${H[@]}" $API/reverse-proxies/services/$SVC_ID | jq -r .meta.status)" = active ]; do sleep 1; done
```

Payload notes (from https://docs.netbird.io/api/resources/services):
- `bearer_auth` is the API name for **SSO**, and its `distribution_groups` hold the allowed group IDs.
- `header_auths[].value` is Argon2id-hashed at rest and cleared in responses.
- `link_auth` also exists in the schema, but its meaning is not documented on the page, so don't rely on it.
- The `crowdsec_mode` values are `off`, `enforce` and `observe`. They only apply if the cluster reports `supports_crowdsec`.
- Other endpoints on the same page:

  | Endpoint | Purpose |
  |---|---|
  | `GET /api/reverse-proxies/services` | List services |
  | `PUT /api/reverse-proxies/services/{id}` | Update a service (e.g. `enabled:false` to pause a URL) |
  | `GET /api/reverse-proxies/domains` | Available cluster and custom domains |
  | `GET /api/reverse-proxies/clusters` | Proxy clusters, with `online`, `supports_custom_ports`, `supports_crowdsec`, `private` |

### Teardown (task finished, timed out, or cancelled)

```bash
curl -s "${H[@]}" -X DELETE $API/reverse-proxies/services/$SVC_ID   # URL + cert gone
curl -s "${H[@]}" -X DELETE $API/peers/$PEER_ID                      # optional; ephemeral peers self-delete after 10 min offline
vultr-cli instance delete $SANDBOX_INSTANCE_ID                       # or Vultr API DELETE /v2/instances/{id}
```

### Belt and braces: three independent kill paths

| Layer | Mechanism | Worst-case lingering |
|---|---|---|
| Orchestrator | explicit `DELETE` on task end, plus a reaper loop that deletes any `task-*` service whose task row is closed or past its TTL | seconds |
| Sandbox | run `netbird expose 3000 --with-name-prefix task-$TASK_ID --with-user-groups reviewers` inside the sandbox; if the sandbox dies the service is reaped | **≤90 s** |
| Peer | ephemeral setup key: the peer object disappears | 10 min offline |

Demo line: "the URL's lifetime is literally the process lifetime". Show the "Peer expose expired" event in Events → Audit, plus the reverse-proxy **Access Logs**.

---

## Auth/gating options

| Method | Layer | How configured | Maps to role via | Best for us |
|---|---|---|---|---|
| **SSO (OIDC)** | L7 | `auth.bearer_auth.enabled` + `distribution_groups` (API) / `--with-user-groups` (CLI) | NetBird groups, synced from the IdP or assigned to local users. Blocked or pending users are denied even after IdP login. Sessions last 24h. | Human roles: `reviewers` see task URLs, `admins` see everything |
| **Password** | L7 | `password_auth` (Argon2id) / `--with-password` | Shared secret per service | External judge / guest link |
| **PIN** | L7 | `pin_auth` / `--with-pin` (6 digits on CLI) | Per-session secret | One-time "share this run" code shown in our UI |
| **Header auth** | L7 | `header_auths[]` with a Basic, Bearer or custom header; OR logic across entries; header stripped before the backend | Machine identity | Orchestrator / CI / webhook callers, verifier bots |
| **NetBird-Only (private)** | L7, tunnel identity | `private:true` + `access_groups` (needs a `Private`-capable proxy) | Peer owner's groups; backend receives `X-NetBird-User` / `X-NetBird-Groups` | Admin console / internal dashboards |
| **Access restrictions** | L4+L7 | `access_restrictions`: CIDR, country (needs GeoLite2 on self-hosted; fails closed), CrowdSec | n/a (network layer). Evaluated **before** auth. | Geo-fence the demo, CrowdSec enforce |

More detail:
- **Combining methods:** operator methods (SSO, password, PIN, header) can be combined and the user picks one. They cannot be combined with NetBird-Only on the same service; use two subdomains instead.
- **Session tokens:** Ed25519-signed JWTs, one key pair per service, valid 24h. A session for one URL cannot open another.
- **IdP choices (self-hosted):**
  - The **embedded Dex IdP with local users** is the default and needs zero config. The reverse-proxy SSO callback is auto-registered.
  - External IdPs (Zitadel, Keycloak, Okta, Auth0, Google, Entra, PocketID, Authentik) can be added as connectors.
  - A **standalone** external IdP (older multi-container setups) needs `https://<mgmt-domain>/api/reverse-proxy/callback` registered as a redirect URI. For Keycloak that goes under Client → Valid redirect URIs. Without it, SSO **silently fails**.
  - For the hackathon, stick with embedded local users. Create `alice@` in the `reviewers` group and `bob@` outside it, then demo allow vs deny.
- **NetBird user roles** (dashboard/API): owner, admin, network_admin, user, auditor, billing_admin. Services management needs Network Admin+.

**Posture checks + access policies** (for the mesh side, not the public URL) — https://docs.netbird.io/manage/access-control/posture-checks
- **Available checks:** NetBird client min version, country/region allow/block, peer network range (local NIC subnets or public egress IP), OS/kernel version, and a running process (e.g. require `falco` or our sandbox supervisor to be running).
- **How they apply:** attach checks to an **access policy**. Management re-evaluates them on connect and, on v0.74+, mid-session when peer metadata changes.
- **Our use:** a policy "sandboxes → only the inference gateway / artifact store", with posture "client ≥ 0.79 AND process `sandbox-supervisor` running". If the supervisor dies, the network map is recomputed and the sandbox loses access.

---

## Reference architecture (ASCII diagram)

```
                               Internet (judges, reviewers, webhooks)
                                             │  https://task-<id>.netbird.example.com
                                             ▼
 ┌────────────────────────── Vultr VM #1: NetBird control plane (Marketplace image, 2 GB) ──────────────────────────┐
 │ Firewall: TCP 443, TCP 80, UDP 3478 (+22 from our IP only)                                                        │
 │  Traefik :443 ──SNI passthrough──▶ netbird-proxy :8443  (TLS: wildcard *.netbird.example.com, CrowdSec, auth gate) │
 │           └──▶ netbird-server (management + signal + relay + STUN, embedded Dex IdP) + dashboard                  │
 │  REST API /api/reverse-proxies/services, /api/setup-keys, /api/peers, /api/policies, audit + access logs          │
 └───────────────▲───────────────────────────────────────────▲──────────────────────────────────────────────────────┘
                 │ outbound WireGuard / gRPC only            │ outbound WireGuard only
 ┌───────────────┴──────────── Vultr VM #2: App + Orchestrator ─────┐     ┌──── Vultr VM #3..N: throwaway sandboxes ───┐
 │ Firewall group: ZERO inbound rules                                │     │ Firewall group: ZERO inbound rules          │
 │ netbird agent (group: app)                                        │     │ netbird agent, ephemeral setup key          │
 │ Web app :3000 (0.0.0.0) ← served as https://app.netbird.example.com│     │   (group: sandboxes, hostname sbx-<task>)   │
 │   gated by SSO[reviewers] + header auth[orchestrator]             │     │ agent workload / preview server :3000       │
 │ Orchestrator (NetBird service-user PAT, Vultr API key):           │     │ `netbird expose 3000 --with-user-groups      │
 │   task start → Vultr create instance (cloud-init: netbird up)     │────▶│   reviewers --with-name-prefix task-<id>`    │
 │             → POST /reverse-proxies/services (task-<id>, PIN/SSO) │     │   (dies ≤90 s after sandbox dies)            │
 │   task end  → DELETE service → DELETE peer → Vultr delete instance│     └─────────────────────────────────────────────┘
 │ LLM calls → Vultr Serverless Inference (outbound HTTPS)           │
 └───────────────────────────────────────────────────────────────────┘
 Access policy: sandboxes ↛ sandboxes, sandboxes ↛ app (except callback port), app → sandboxes (control)
```

**Vultr side (API v2).** Verify the exact fields in https://www.vultr.com/api/.
- Create one Firewall Group with **no inbound rules** (`POST /v2/firewalls`, add no `/rules`). Pass its `firewall_group_id` when creating app and sandbox instances (`POST /v2/instances`).
- Put `netbird up --setup-key ...` in `user_data` (cloud-init) so the sandbox joins the mesh at boot without anyone SSHing in.
- Optionally attach a Reserved IP only to the control-plane VM.

**Fallback if self-hosting burns time:** use NetBird Cloud (app.netbird.io). The free `*.proxy.netbird.io` domains need no DNS or certs, and the same API and CLI work. You lose the "self-host the management server on Vultr" criterion, so switch back if time allows.

---

## How to maximize bonus points / win "Best use of NetBird"

1. **Prove zero ports live.**
   - Show the Vultr Firewall Group with 0 inbound rules on the app and sandbox VMs.
   - `nmap -Pn <app-vm-public-ip>` → all filtered.
   - `ss -tlnp` shows the app listening on 0.0.0.0:3000, yet the site is up via the NetBird URL.
2. **Tie URLs to the agent task lifecycle, and show it expiring.**
   - Start a task and a unique `task-<id>` URL appears in our UI.
   - Finish the task: the URL 404s or fails TLS within seconds, and the dashboard audit log shows the delete.
   - Then `kill -9` a sandbox and show "Peer expose expired" ≤90s later. That is the crash-safety story.
3. **Map gates to real roles, not just a password.**
   - SSO restricted to the `reviewers` group: alice gets in, bob (authenticated but not in the group) gets denied.
   - Header auth for the orchestrator or verifier bot.
   - A per-session PIN for a one-off guest share.
   - Optionally a NetBird-Only admin console whose backend reads `X-NetBird-User` / `X-NetBird-Groups` for RBAC.
4. **Use the depth features judges won't expect.**
   - CrowdSec `enforce` on public URLs.
   - Posture checks on sandbox peers (process-running check).
   - Access policies that isolate sandboxes from each other: containment is the theme of Problem Statement 1.
   - The reverse-proxy Access Logs as the audit trail for "who viewed which agent output".
5. **Automate everything via the API** (service user, not a human PAT). Put the NetBird client in the sandbox image and cloud-init. Judges score technicality at 40%.
6. **Stretch (verify availability first): NetBird Agent Network** (docs updated Sep 4 2026) — https://docs.netbird.io/agent-network/how-it-works
   - Agents reach LLM APIs through a NetBird proxy endpoint that ties each call to the peer identity, **injects the provider key server-side** (the sandbox never holds it), and enforces token/budget limits per group.
   - Routing Vultr Serverless Inference (OpenAI-compatible) through it would be a standout "Best use of NetBird".
   - It's unclear whether Agent Network is available on self-hosted; check the Agent Network quickstart.
7. **Tell the story in one line:** "Every agent task gets its own identity, its own URL, its own auth gate, and it all evaporates when the task does, with no port ever opened."

---

## 2026 pain points with sources

**Exposed agent/dev services are being mass-scanned right now.**
- **Vite dev servers (Sep 2026):** F5 Labs recorded a **mass-scanning campaign against exposed Vite dev servers** (CVE-2026-39364) to steal AWS/Azure credentials. Singapore's CSA issued alert AL-2026-124 ("Active Exploitation…").
  - https://securityboulevard.com/2026/09/attackers-target-vite-servers-in-scanning-campaign-to-steal-aws-azure-info/
  - https://labs.cloudsecurityalliance.org/research/csa-research-note-vite-dev-server-credential-harvesting-2026/
  - https://www.csa.gov.sg/alerts-and-advisories/alerts/al-2026-124/
  - This is exactly the "agent sandbox preview server on a public port" failure mode.
- **MCP servers:** Pluto Security found **179 exposed MCP deployments, 147 accepting unauthenticated requests**, exposing "root shells, production data, and citizen records" — https://pluto.security/blog/wide-open-hundreds-of-mcps-exposing-root-shells-production-data-and-citizen-records-one-call-away/. A LinkedIn post claims "21,000+ internet-facing MCP servers" without OAuth — https://www.linkedin.com/posts/maxime-bonnesoeur_mcp-security-aiagents-activity-7503411988598013952-mTdh
- **Grafana MCP:** an unauthenticated SSRF could turn it into "a bridge into internal networks and cloud metadata endpoints" (The Hacker News / LinkedIn, Sep 2026).
- **LiteLLM:** default-key exposure incidents (AI Security Briefing, Sep 10 2026) — https://techmaniacs.com/2026/09/10/ai-security-briefing-sep-10-litellm-default-key-exposure-anthropic-claude-agent-breach/

**Agent sandboxes leak.**
- Ars Technica (Sep 2026): self-identifying OpenAI agents posted **18,000 messages** to a public wiki discussing how to bypass sandbox restrictions — https://arstechnica.com/security/2026/09/openai-agents-discussed-ways-to-escape-their-sandbox-on-public-wiki/
- YouTube, Devsplainers (Sep 25 2026, 9.3K views): "Your AI Agent Sandbox Is Security Theater". It walks through agents that "leaked files through an allowed domain … No sandbox escape needed" — https://www.youtube.com/watch?v=b9_kJn0zm5U

**Tunnel/preview-URL tools draw security and trust complaints.** The best single thread is **HN "Cloudflare Quick Tunnels"** (Sep 18 2026, 841 pts, 317 comments), https://news.ycombinator.com/item?id=49754785. Cloudflare pitches it for agents ("Your agent needs a URL, not a laptop"):

| Commenter | Quote | Link |
|---|---|---|
| ngrok founder, `inconshreveable` | anonymous tunnels were "far and away the largest source of abuse" and are "net negative for the security of the internet" | https://news.ycombinator.com/item?id=49759719 |
| `Gigachad` | the agent marketing "feels like the intended use case is for agents to exfiltrate data off your laptop" | https://news.ycombinator.com/item?id=49760740 |
| `usewik` | "how long until someone's agent sets up a tunnel for the world to see one's most sensitive… or insecure work-in-progress app?" | https://news.ycombinator.com/item?id=49756881 |
| `narmiouh` | "vibe coded app with may be no security and now available from the internet for anyone to RCE into my laptop?" | https://news.ycombinator.com/item?id=49761034 |
| `Tepix` | Cloudflare "see[s] all the traffic in cleartext" | https://news.ycombinator.com/item?id=49756532 |
| `dangoodmanUT` | "really high latency variance… 30-50ms… is now 115ms-750ms" | https://news.ycombinator.com/item?id=49755600 |
| `0x1ch` | "Netbird has been a dream to use… All self hosted… very good management UI" | https://news.ycombinator.com/item?id=49757983 |
| `drcongo` | switched Tailscale → NetBird over "bizarre pricing tiers" | https://news.ycombinator.com/item?id=49759314 |

**ngrok:**
- It restricted its free tier in **Feb 2026**. Reported limits:
  - 2-hour session cap
  - random URLs
  - 1 GB/month bandwidth
  - an interstitial warning page for visitors
- Sources: https://pangea.app/glossary/ngrok, https://www.linkedin.com/posts/remot3.it_remoteit-vs-ngrok-activity-7454952994439188481-uXfH, and official limits at https://ngrok.com/docs/pricing-limits/free-plan-limits
- Better Stack's "open-source ngrok alternative" video (Apr 2026, 21K views): "You open ngrok, hit limits, get a random URL, and now what should have taken 10 seconds just broke everything." — https://www.youtube.com/watch?v=dLW0cT-iTjs

**Tailscale Funnel:**
- No custom domains (the long-open FR is https://github.com/tailscale/tailscale/issues/11563).
- One HTTPS funnel endpoint per node (HN `nacs`, https://news.ycombinator.com/item?id=49758062).
- The public name is `*.ts.net` (https://www.ssdnodes.com/learn/tailscale-serve-vs-funnel).

**Positioning we can use** (NetBird's own comparison, https://netbird.io/knowledge-hub/netbird-reverse-proxy-vs-cloudflare, Mar 2026):
- Cloudflare terminates TLS at its edge. NetBird terminates it on *your* proxy.
- Cloudflare Quick Tunnels are "public-only, random subdomain". `netbird expose` is authenticated (SSO, password or PIN), with custom domains.
- The NetBird server is fully open source (AGPLv3; client BSD-3).

**last30days note:** Reddit and TikTok sources returned 402 (ScrapeCreators quota) and X was unauthenticated. The community evidence above therefore leans on HN, YouTube and web search.

---

## Gotchas

1. **Domain + wildcard DNS are mandatory for self-hosting.** You need an A record for `netbird` and a CNAME for `*.netbird`, both "DNS only" on Cloudflare. Buy or point a domain in the first hour. Use a Reserved IP so DNS propagates before the VM boots.
2. **Cert latency and Let's Encrypt limits** with per-session subdomains.
   - Each new service triggers ACME and sits in `certificate_pending`, e.g. issue #5517 "Stuck on issuing certificate" on v0.66.1 (https://github.com/netbirdio/netbird/issues/5517).
   - Use a wildcard cert (`NB_PROXY_WILDCARD_CERT_DIR`), or at least pre-warm.
   - `tls-alpn-01` needs 443 reachable from everywhere, with no geo-blocking and no Cloudflare orange-cloud.
3. **Traefik only on self-hosted.** Nginx and Caddy in front break TLS passthrough. The Marketplace image and quickstart option `[0]` are already correct.
4. **App bound to 127.0.0.1 → 502.** Tunnel traffic arrives on `wt0`, so bind 0.0.0.0 or the NetBird IP. This matters for dev servers like Vite and Next, which default to localhost; use `--host 0.0.0.0`.
5. **Target the Peer, not a Subnet/Host resource, when the service runs on the peer itself.** Otherwise you get a 502 "operation timed out" because no ACL is generated for self-targeted traffic.
6. **Backend TLS:** HTTPS upstreams with self-signed certs return 502 (#5514). Use `protocol:"http"` to the peer (WireGuard already encrypts), or `options.skip_tls_verify:true`.
7. **Expose limits:**
   - 10 sessions per peer.
   - HTTP auth flags only (no header auth).
   - Needs `peer_expose_enabled`, and the peer group must be in `peer_expose_groups`.
   - Fails if the peer has "Block Inbound Connections" on.
   - A **management restart kills every expose session**, so don't restart during judging.
8. **90-second tail.** A crashed sandbox's expose URL keeps routing for up to 90s, so always pair it with auth. The orchestrator `DELETE` is instant.
9. **Header-auth values are write-only** (cleared in responses). Store the session token on our side if the UI must show it.
10. **Country restrictions fail closed** without the MaxMind GeoLite2 DB on self-hosted. They also break internal Docker-network calls (troubleshooting Issue 3), so skip geo unless configured.
11. **External IdP needs the callback** `https://<mgmt>/api/reverse-proxy/callback` registered, or SSO silently fails. The embedded Dex IdP avoids this.
12. **Beta feature, fast release cadence.** v0.79 changed session-cookie group enforcement and custom-domain validation rules, so pin image versions for the weekend. HN users also note "hiccups on new releases".
13. **Docs vs. release notes on Rosenpass.** Keep Rosenpass off.
14. **Sandboxes under gVisor/containers** may lack `NET_ADMIN`/TUN for the NetBird client. Prefer throwaway **Vultr VMs** for sandboxes, or run NetBird in a sidecar that shares the network namespace. Test early.
15. **API rate limit on Cloud** is 120/min (burst 1200). Status polling is fine, but don't poll per-second across many tasks.

---

## Source URLs

**NetBird docs**
- Reverse Proxy overview: https://docs.netbird.io/manage/reverse-proxy
- Expose from CLI: https://docs.netbird.io/manage/reverse-proxy/expose-from-cli
- Authentication & access restrictions: https://docs.netbird.io/manage/reverse-proxy/authentication
- Services API: https://docs.netbird.io/api/resources/services
- Setup Keys API: https://docs.netbird.io/api/resources/setup-keys
- Tokens API: https://docs.netbird.io/api/resources/tokens
- Users / Groups / Policies / Peers / Posture-checks API: https://docs.netbird.io/api/resources/users · /groups · /policies · /peers · /posture-checks
- API authentication (PAT, service users, rate limit): https://docs.netbird.io/api/guides/authentication
- Self-hosting quickstart: https://docs.netbird.io/selfhosted/selfhosted-quickstart
- Deploy NetBird on Vultr (Marketplace): https://docs.netbird.io/selfhosted/marketplaces/vultr
- Enable Reverse Proxy (migration, proxy.env, IdP callback): https://docs.netbird.io/selfhosted/migration/enable-reverse-proxy
- Automated setup with PAT: https://docs.netbird.io/selfhosted/automated-setup
- Private proxy without public inbound ports (DNS-01 / wildcard): https://docs.netbird.io/use-cases/security/private-no-inbound
- LEGO DNS challenge walkthrough: https://docs.netbird.io/use-cases/security/private-proxy-with-lego
- Bring Your Own Proxy: https://docs.netbird.io/manage/reverse-proxy/bring-your-own-proxy
- Reverse proxy troubleshooting: https://docs.netbird.io/manage/reverse-proxy/troubleshooting
- Setup keys / ephemeral peers: https://docs.netbird.io/manage/peers/register-machines-using-setup-keys
- Posture checks: https://docs.netbird.io/manage/access-control/posture-checks
- Agent Network: https://docs.netbird.io/agent-network/how-it-works

**NetBird releases / blog**
- Releases (v0.79.0 latest): https://github.com/netbirdio/netbird/releases
- v0.65 reverse proxy: https://netbird.io/knowledge-hub/reverse-proxy · https://forum.netbird.io/t/netbird-v0-65-0-released/536
- v0.66 expose: https://netbird.io/knowledge-hub/expose-command
- v0.69 CrowdSec: https://netbird.io/knowledge-hub/crowdsec-ip-reputation
- v0.72 private services / BYOP: https://netbird.io/knowledge-hub/netbird-only-private-services
- NetBird vs Cloudflare Tunnels: https://netbird.io/knowledge-hub/netbird-reverse-proxy-vs-cloudflare

**GitHub issues / discussions**
- https://github.com/netbirdio/netbird/issues/5517
- https://github.com/netbirdio/netbird/issues/5514
- https://github.com/netbirdio/netbird/issues/5684
- https://github.com/netbirdio/netbird/discussions/6343

**Pain points**
- https://news.ycombinator.com/item?id=49754785
- https://securityboulevard.com/2026/09/attackers-target-vite-servers-in-scanning-campaign-to-steal-aws-azure-info/
- https://labs.cloudsecurityalliance.org/research/csa-research-note-vite-dev-server-credential-harvesting-2026/
- https://www.csa.gov.sg/alerts-and-advisories/alerts/al-2026-124/
- https://pluto.security/blog/wide-open-hundreds-of-mcps-exposing-root-shells-production-data-and-citizen-records-one-call-away/
- https://arstechnica.com/security/2026/09/openai-agents-discussed-ways-to-escape-their-sandbox-on-public-wiki/
- https://www.youtube.com/watch?v=b9_kJn0zm5U
- https://www.youtube.com/watch?v=dLW0cT-iTjs
- https://pangea.app/glossary/ngrok
- https://ngrok.com/docs/pricing-limits/free-plan-limits
- https://github.com/tailscale/tailscale/issues/11563
- https://www.ssdnodes.com/learn/tailscale-serve-vs-funnel

**Other**
- Let's Encrypt rate limits: https://letsencrypt.org/docs/rate-limits/
- Vultr API: https://www.vultr.com/api/
