# AGENTS.md

## Project orientation

Agent Eval Runner measures coding-agent attempts under reproducible conditions. Its output is evidence: inputs, environment identity, commands, patches, checks, resource use, and artifacts.

Read `README.md` and `ROADMAP.md` before changing scope. Milestones 0, 1, and 2 are implemented. Milestone 3 has restricted Linux containers, contained Git preparation, bounded capture, live Linux workspace quotas, and opt-in cooperative resource admission for trusted fake-agent fixtures; the milestone itself is not complete. Do not describe later items as complete unless their checkbox and implementation agree.

## Product rules

- Preserve the exact task identity, repository revision, configuration, and agent adapter used by every run.
- Keep deterministic checks separate from model-based judgments.
- Never discard a failed or interrupted run's logs or patch because it scored poorly.
- Enforce time, command, token, and cost budgets outside the agent process.
- Treat repository content and agent output as untrusted. Worktrees are disposable but not secure isolation.
- Redact credentials before persisting logs or reports. Keep original digests when redaction changes evidence.
- Make comparisons fair. Do not silently give one adapter more context, tools, retries, or time.

## Runtime and isolation

Use Node.js 22 or newer, pnpm, and strict TypeScript. TypeBox schemas define runtime validation, TypeScript types, and generated JSON Schemas. Do not hand-edit files under `schemas`; change the schema sources (`src/spec.ts`, `src/execution-spec.ts`, `src/preparation-protocol.ts`, `src/resources-spec.ts`, `src/safety.ts`, `src/result.ts`, `src/events.ts`, `src/usage.ts`, `src/batch-spec.ts`, `src/comparison-spec.ts`), then run `pnpm schemas:write`. Result v7, comparison v6, and batch index v2 are current. Preparation and resource contracts are v1. Archived result v1-v6, comparison v1-v5, and batch index v1 must not be regenerated from current sources.

The local execution boundary is a detached Git worktree in a runner-owned temporary repository. It does not restrict agent/check network or host filesystem access. Local runs still use host Git. Docker runs must use the fixed preparer for all Git operations, including revision resolution and patch generation. Do not run paid models, untrusted repositories, or untrusted commands without explicit user authorization and stronger isolation.

Keep preparation and patch generation on raw blobs and private Git metadata. Do not restore ordinary checkout, source worktree registration, inherited Git config/templates, clean/smudge filters, or network/lazy fetch. Reject unsupported tree entries before materialization. Patches include ignored regular files and use a runner-owned index. Preserve raw-byte semantics and Unix/Windows mode handling when changing capture.

`src/safety.ts` fixes capture policy; `src/workspace.ts` owns bounded traversal/reads. Keep aggregate artifact limits, metadata/patch caps, and phase deadlines outside adapters. Never replace descriptor-bounded reads with unbounded `readFile`, or bounded copies with recursive copying of unchecked exports. Capture failure retains the private checkout and available Docker export. Snapshot limits are distinct from Linux live allocated-byte/inode quotas; local execution is still unquotaed. Do not claim hostile-input safety.

For Docker changes, read `docs/isolation.md`. Keep the policy fixed and opt-in. Only preinstalled digest-pinned images and a local Linux engine are supported. Never accept arbitrary Docker flags, mount source `.git` or host credentials, or silently fall back to local execution. Stop the whole attempt container after every command, verify quiescence before capture, and retain exports after failed capture or cleanup. Never prune Docker resources or remove containers/images not owned by the current attempt.

`src/storage.ts` owns fixed tmpfs options, mounted-quota verification, and bounded export validation. Do not restore a writable host bind mount, use ordinary unquotaed volumes, unpack daemon tar exports, or restart a lost storage holder. The read-only holder runs only fixed runner helpers, never task commands. Incomplete export retains the holder/volume and records their identities; removing the last mount destroys tmpfs data. Verify ownership before cleanup, and never remove retained resources automatically.

`src/object-snapshot.ts` copies only bounded opaque loose/pack object files without calling Git. Reject external alternates, linked-worktree metadata, links, and unsupported layouts. Do not copy source config/hooks/refs or mount the source object store directly. `src/git-preparation.ts` passes only the copied read-only snapshot and bundled worker to the preparer; the agent never receives either. Validate protocol, paths, bytes, and digests before accepting files. Stop the preparer after each operation and retain its private quota volume on incomplete capture. Failed preparation retains copied inputs, never falls back to host Git, and never starts an adapter.

`src/resources.ts` owns opt-in Docker admission. Persist reservations and planned names before creating resources; keep canonical bounded results inside the owned pool before deleting checkouts. Caller mirrors must stay outside it, including through aliases. Use the lease's explicit temporary parent for checkout/export cleanup, not a broad directory. Ledger/result validation must refuse altered identities, undercharging, links, and changed finalized bytes.

Inventory is read-only and registered-only. Never adopt legacy/unrelated resources, break stale locks, reclaim exited PIDs, or remove retained evidence automatically. Unfinished and uncertain attempts keep conservative charges. Account for redaction growth before persistence, preserve bounded captured-stream digests, and mark additional truncation. Admission accounting is per pool, not a hard host filesystem quota, physical free-space reservation, or fresh Docker ownership attestation.

## Keep adapters thin

The runner owns orchestration, evidence collection, budgets, and scoring. Agent adapters translate a common run request into provider-specific execution and return normalized events. Do not leak provider-specific fields into the core result model.

Use discriminated unions for run events. Do not use `any`, unsafe assertions, or casting wrappers to bypass the type system.

## Batches and comparisons

- Keep batch scheduling sequential, in configuration/repetition order, with a fresh worktree for each attempt. Do not add retries or concurrency implicitly.
- Exclusively create the output directory. Finalize each result before starting another attempt; persist a snapshot before deleting a checkout. Preserve the last index on cancellation or persistence failure.
- Ordinary failure/timeouts do not cancel the schedule. External cancellation stops new attempts and records them as `not_started`.
- Score version 2 counts every declared check, including skipped checks. Record skip reasons and preserve the original adapter outcome when later phases fail.
- Comparisons read saved results only. Reject incompatible task/scoring identities, altered bytes, escaping result paths, and attempts to overwrite evidence.
- Keep known-zero fake model usage distinct from unknown usage. Unknown usage propagates to totals; no provider token/cost budget exists yet.
- Shared-task digests include execution policy, requested image, and safety policy, but exclude adapter configuration; preserve separate configured-task and adapter digests. Changing checkout/capture semantics requires a policy/version decision. Do not claim matching hashes pin the host toolchain or authenticate evidence. Compare stable execution runtimes, not generated container IDs.
- Include resource accounting mode/limits in comparison identity; exclude generated pool/reservation IDs and pool paths. Resource refusal starts no adapter and uses `not_started/resource_admission` in batch index v2, not `persistence_failed`. Stop new scheduling without losing earlier finalized results.

## Verification

Use these commands:

```sh
pnpm format
pnpm check
pnpm build
pnpm example
pnpm example:batch
```

`pnpm check` verifies formatting, linting, types, generated schemas, and focused tests. Tests cover budgets, descendant process termination, event ordering, artifact/patch capture, scoring, result preservation, basic credential redaction, repetitions, cancellation, persistence failure, usage aggregation, execution policy, and report compatibility/regeneration. Integration tests create trusted local temporary Git repositories and credentials. `pnpm example:batch` needs the built CLI and verifies intentional failures, all saved artifacts, and deterministic regeneration. CI runs both local examples on Linux and Windows without uploading results.

`pnpm build` also bundles the preparation worker with esbuild. Docker APIs/examples require this asset. Never replace it with runtime package installation or repository scripts. Keep the worker byte digest in results and identical worker bytes for the compiled Linux acceptance helper. Linux acceptance must block host Git during packed checkout/patch generation, replay binary patches, and preserve rejected/malformed-source attempts. Snapshot/protocol tests must cover limits, cancellation, altered bytes, and path escapes.

On a non-root Linux runner with a trusted Docker Engine and both preinstalled images documented in README, also run `pnpm example:isolated` after building the CLI. Linux CI runs it; Windows tests verify unsupported execution does not fall back to the host. Native Windows cannot validate live Linux containment. Do not claim it passed without actually running the Linux acceptance path.

Add focused tests for budget enforcement, adapter normalization, event ordering, redaction, process termination, artifact capture, and scoring changes. Git/workspace/storage tests also cover filter/hook/config rejection, raw binary patch replay, unsupported entries, bounded reads/traversal, aggregate artifacts, quota-policy rejection, and oversized patch/export retention. Linux acceptance must reach actual `ENOSPC` for workspace and temporary bytes/inodes, verify evidence/check continuation, and verify successful resource cleanup. Test cleanup must resolve and remove only private directories associated with its trusted source fixture. Do not add placeholder scripts that always pass.

Resource tests cover each admission dimension, real cross-process locking, stale owners/locks, cancellation, canonical persistence failure, ownership/path aliases, changed evidence, and policy compatibility. Linux acceptance must exercise the built resource CLI, managed cancellation, successful cleanup, retained capture, read-only inventory, and refusal without evidence changes. Never simulate those live assertions with mocks; focused filesystem/state tests may mock unavailable execution preparation.

## Documentation boundaries

Keep human setup, task formats, result formats, security limits, and known reproducibility limits in `README.md`. Keep agent operating rules here. Document scoring changes because they affect comparisons across versions. Update `ROADMAP.md` only when implementation and verification support the status change.
