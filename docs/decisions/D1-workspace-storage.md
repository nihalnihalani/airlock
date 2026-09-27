# D1 — Per-attempt workspace storage

Status: **provisional, pending measurement on the VX1 host.** Recorded 27 September 2026 at `fix/milestone-1-guarantees`.

## The requirement

Research 37 ("Runtime profile") asks for dedicated per-attempt volumes retained through stopped-container collection, a hard per-volume storage quota, host-wide admission and disk headroom, and explicitly warns against a tmpfs workspace, because a tmpfs disappears when its last mount goes away. The remediation prompt requires quota enforcement and post-stop collection proven on Kata, or an explicit decision with equivalent guarantees and measured proof.

## What is implemented

Each author, analysis and node attempt gets a Docker `local` volume of type `tmpfs` with a hard `size=` (profile `workspaceBytes`, default 128 MiB for repair, 256 MiB for code roles), mounted at `/workspace`. Freeze and collect-outputs keep 37's ordering: revoke dispatch, **start the collector container with the volume mounted read-only before stopping the author**, stop, settle outstanding operations (refuse on failure), inspect stopped, then collect. The collector's mount keeps the tmpfs alive across the author's stop.

## Guarantees compared with 37

| Guarantee | 37 (durable volume + quota) | Implemented (tmpfs + hold) | Evidence |
|---|---|---|---|
| Hard per-attempt size limit | quota (mechanism unspecified) | `size=` on the tmpfs, verified on every mount | supervisor tests; `deploy/preflight-api.ts` D1 fill check (VX1 pending) |
| Survives the author's stop until collection | yes | yes, while the collector holds the mount | lifecycle tests; local real Docker |
| Freeze retry after a failed collection | yes | **no**: a collection failure after the stop loses the workspace; the task ends INCONCLUSIVE, never a false pass | B5/D1 notes in the ledger |
| Nothing on host disk | no | yes (RAM only) | — |
| Host memory accounting | n/a | tmpfs pages count as host RAM; under Kata they may sit outside the guest memory limit, so `capacity.ts` charges every tmpfs size against the memory budget | capacity tests; D1 MemAvailable measurement in preflight (VX1 pending) |
| Host-wide admission | required | implemented for every role (M2) | capacity tests |

## Decision

Keep tmpfs + hold as the shipped mechanism **until the VX1 measurements below say otherwise**. The one lost guarantee (freeze retry after a failed post-stop collection) fails closed: the task is INCONCLUSIVE and no candidate is sealed. Replacing it with durable storage on the host disk requires a quota mechanism that the deployed Docker/Kata combination honours (for example XFS project quotas on a dedicated volume filesystem, or loop-mounted per-attempt filesystems managed by the supervisor). That can't be chosen without the host.

## Measurements that close or reopen this decision (run `deploy/preflight.sh` on VM B)

1. Filling `/workspace` past its size fails inside a Kata sandbox (the preflight D1 fill check).
2. Host `MemAvailable` drops by roughly the filled amount and recovers after teardown. If the drop is not bounded by the budget `capacity.ts` reserves, the budget must grow or the mechanism must change.
3. Post-stop collection returns the written file under Kata (the preflight freeze check). If virtio-fs or the Kata agent breaks the read-only hold, switch to durable storage.
4. The probe's mount classification accepts the Kata guest's view of `/workspace` (a filesystem root). If Kata reports a non-root mount there, record the exact mountinfo line and adjust `probe.sh` without widening it to arbitrary binds.

If 1–3 pass, D1 is closed with this decision recorded as the equivalent mechanism. If any fails, the durable alternative is required before claiming Kata support for that role.
