# Live-gate receipts

Each `*.json` here is a `LiveGateReceipt` (packages/contracts) written by `bun scripts/live-gate.ts`
against a deployed stack running the live Vultr driver on gVisor or Kata: fresh hero attempts judged
by the external comparator, with provenance taken from each task's own events (every model call from
`api.vultrinference.com`, no scripted diagnostics, not dev-unsafe). Receipts carry no secrets, cookies
or issue text.

The control plane (`apps/control/src/availability.ts`, `GET /api/repair-availability`) offers live
repair only while the newest valid receipt matches the running profile and contract digest, the
configured model and the supervisor's selected runtime, with at least 2 of 3 attempts passing. A
later failing receipt withdraws availability. Commit receipts as they are written; never edit one.
