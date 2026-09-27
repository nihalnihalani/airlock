# Airlock fixtures (disclosed demo destination)

A small Bun service that Airlock's browser sandbox visits during the demo. Every page carries a
banner saying it is an Airlock demo fixture with synthetic data; form submissions are recorded only
here and go nowhere else. It serves two things:

1. **Hero-task data page** (research/40 Stage 3). Synthetic regional sales as a table and as CSV in
   `<pre id="csv">`, so the runner's page text keeps the lines the analysis parses.
2. **Controlled form destination** for the `airlock-forms-v1` adapter (research/40 Stage 5). The form
   accepts a submission only with a one-use approval code that the control plane issues for exactly
   the submitted values. The browser can submit by clicking the button, pressing Enter or typing with
   submit. Every one of those paths ends at `POST /f/:formId/submit`, so the destination (not button
   labels) decides.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Index |
| `GET /data/regional-sales[?variant=a\|b]` | Data page. Variant `a` (the default) is byte-identical to the CSV in `apps/control/test/fixtures/scripted-general/regional-sales.html`, where the lowest revenue/target is South. Variant `b` changes the numbers so the lowest is North. `GET /regional-sales.html` is an alias for variant `a`. Any other variant returns 400. |
| `GET /data/regional-sales.csv[?variant=]` | The same CSV as `text/csv` |
| `GET /f/contact-request`, `GET /f/order-sample` | Forms. Fields are `name`, `email`, `message` and `sku`, `quantity`, `address`. The last field of each is a textarea. Every form also has an `airlock_approval` text input. The page needs no JS. |
| `POST /f/:formId/submit` | `application/x-www-form-urlencoded`, 16 KiB max. Returns 200 with a confirmation page and receipt id, or 403 with "Submission refused: no valid approval for exactly these values" and a reason code. Nothing is stored on refusal. |
| `GET /api/receipts/:proposalId` | Reconciliation, needs `Authorization: Bearer <readToken>`. Returns `200 {status:"confirmed", proposalId, formId, receiptId, payloadDigest, at}`, `404 {status:"none"}` or `401 {status:"unauthorized"}`. |
| `GET /healthz` | `{status:"ok"}` |

## Contract shared with the control plane

Import the pure helpers from `@airlock/fixtures` (`src/lib.ts`), or reimplement them against
`test/vectors.json`.

**Normalization** (`normalizeFields(formId, raw)`):
- Every declared field appears exactly once. Unknown, missing and duplicate names are refused.
  Remove `airlock_approval` before calling.
- `\r\n` and lone `\r` become `\n`. Nothing else changes: no trimming, no case folding and no Unicode
  normalization.
- Single-line fields may not contain `\n`.
- Values must have no lone surrogates and be at most 4096 UTF-16 units long.

**Digest:** `payloadDigestOf({adapter:"airlock-forms-v1", destination, formId, fields})` from
`@airlock/contracts`.
- `destination` is `new URL(AIRLOCK_FIXTURES_ORIGIN).origin`.
- The control plane must call `normalizeFields` on the proposed fields, store the normalized result as
  `ActionProposal.fields`, and reject the proposal on `ok:false`.

**Approval code** (`mintApprovalCode`):
- `mac = base64url_nopad(HMAC-SHA256(AIRLOCK_FORMS_SECRET, "${proposalId}.${payloadDigest}.${expiresAtEpoch}"))`
- `code = "${proposalId}.${expiresAtEpoch}.${mac}"`
- `expiresAtEpoch` is integer seconds.
- The destination refuses a code with a MAC mismatch (any changed field, form, destination, id or
  expiry), when `now >= expiresAtEpoch`, when the expiry is more than 24 h ahead, and when the
  proposal id was already used. The one-use claim is atomic in sqlite and survives restarts.
- A refused attempt does not consume the id.

**Read token:** `receiptsReadToken(secret) = base64url_nopad(HMAC-SHA256(secret, "airlock-forms-v1 receipts-read"))`.
It is a separate HMAC domain: the label has no `.`, and every MAC input has two. The raw secret is
not accepted as a token. All comparisons are constant-time.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `AIRLOCK_FIXTURES_ORIGIN` | yes | Public origin, e.g. `https://forms.144-202-21-168.sslip.io`. It is bound into every digest. |
| `AIRLOCK_FORMS_SECRET` | yes | At least 32 characters, shared only with the control plane. Generate it with `openssl rand -base64 48`. |
| `AIRLOCK_FIXTURES_DATA_DIR` | yes (defaults to `/data` in the image) | Directory for `fixtures.sqlite`. It must be writable. |
| `AIRLOCK_FIXTURES_LISTEN` | no (default `127.0.0.1:3100`) | `host:port` |
| `AIRLOCK_TRUST_PROXY` | no | Set to `1` behind a same-host Caddy. The rate limiter then keys on the last `X-Forwarded-For` hop. |

## Security

Every response sets:
- CSP `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
- `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and `no-store`

The service loads no external resources and runs no scripts. It escapes every reflected value.
Bodies are capped at 16 KiB. The rate limit is per IP: 240 requests per minute overall, and 60 per
minute for POST and `/api`.

## Deploying on VM A

The service must be reachable at a **public** hostname because the egress proxy only dials public
addresses. Run it next to the control plane behind the same Caddy, on its own name:

```
forms.<a-b-c-d>.sslip.io {
	reverse_proxy 127.0.0.1:3100
}
```

Either option works:
- **systemd unit**, the same way the control plane runs: `bun apps/fixtures/src/index.ts` as the
  `airlock` user, with an env file for the variables above and `AIRLOCK_TRUST_PROXY=1`.
- **Container:**

  ```
  docker build -f apps/fixtures/Dockerfile -t airlock-fixtures .
  docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
    -v airlock-fixtures:/data -p 127.0.0.1:3100:3100 -e ... airlock-fixtures
  ```

For browser tasks that use it, allow the host in the task's `egressAllow`, e.g.
`["forms.<a-b-c-d>.sslip.io"]`.

## Tests

`bun test` in this directory covers:
- normalization, digest and approval-code vectors
- acceptance, replay, a changed field, expiry, a missing code, the receipts API auth, escaping, body
  and rate limits, and persistence across a restart
- a real-server run through `src/index.ts`
