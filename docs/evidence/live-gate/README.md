# Live-gate receipts

Each `*.json` here is a `LiveGateReceipt` (packages/contracts) written by `bun scripts/live-gate.ts`
against a deployed stack running the live Vultr driver on gVisor or Kata: fresh hero attempts judged
by the external comparator, with provenance taken from each task's own events (every model call from
`api.vultrinference.com`, no scripted diagnostics, not dev-unsafe). Receipts carry no secrets, cookies
or issue text.

Every receipt is bound to the exact runtime image id the supervisor enforced (`runtimeImageId`,
`sha256:<64 hex>`, cross-checked against each record's inspected image id) and the adapter digest
the verification records were measured under (`adapterDigest`); the script refuses to write one
without both, and never writes one with `--allow-dev-unsafe`.

The control plane (`apps/control/src/availability.ts`, `GET /api/repair-availability`) offers live
repair only while the newest receipt matches the running profile and contract digest, the
configured model, the supervisor's selected runtime and enforced image id, and the adapter on disk,
with at least 2 of 3 attempts passing as counted from the control plane's own task records (so a
receipt only backs repair on the stack whose store holds its gate tasks). A later failing receipt
withdraws availability, and so does a later invalid one (it is not skipped); a receipt dated in the
future is refused. Receipts from before `runtimeImageId`/`adapterDigest` existed no longer validate.
Commit receipts as they are written; never edit one.

Run the tests with `bun test ./scripts/` (or from `scripts/`): `bun test scripts/…` without `./` is
a name filter that also collects `research/` reference-repo tests.
