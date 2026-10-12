# AGENTS.md

## Project orientation

Agent Eval Runner measures coding-agent attempts under reproducible conditions. Its output is evidence: inputs, environment identity, commands, patches, checks, resource use, and artifacts.

Read `README.md` and `ROADMAP.md` before changing scope. Milestones 0, 1, and 2 are implemented. Milestone 3 has restricted Linux containers, raw-object checkout, and bounded capture for trusted fake-agent fixtures; the milestone itself is not complete. Do not describe later items as complete unless their checkbox and implementation agree.

## Product rules

- Preserve the exact task identity, repository revision, configuration, and agent adapter used by every run.
- Keep deterministic checks separate from model-based judgments.
- Never discard a failed or interrupted run's logs or patch because it scored poorly.
- Enforce time, command, token, and cost budgets outside the agent process.
- Treat repository content and agent output as untrusted. Worktrees are disposable but not secure isolation.
- Redact credentials before persisting logs or reports. Keep original digests when redaction changes evidence.
- Make comparisons fair. Do not silently give one adapter more context, tools, retries, or time.

## Runtime and isolation

Use Node.js 22 or newer, pnpm, and strict TypeScript. TypeBox schemas define runtime validation, TypeScript types, and generated JSON Schemas. Do not hand-edit files under `schemas`; change the schema sources (`src/spec.ts`, `src/execution-spec.ts`, `src/safety.ts`, `src/result.ts`, `src/events.ts`, `src/usage.ts`, `src/batch-spec.ts`, `src/comparison-spec.ts`), then run `pnpm schemas:write`. Result v4 and comparison v3 are current. Archived result v1/v2/v3 and comparison v1/v2 must not be regenerated from current sources.

The local execution boundary is a detached Git worktree in a runner-owned temporary repository. It does not restrict agent/check network or host filesystem access. Host Git still parses source metadata and objects. Do not run paid models, untrusted repositories, or untrusted commands without explicit user authorization and stronger isolation.

Keep preparation and patch generation on raw blobs and private Git metadata. Do not restore ordinary checkout, source worktree registration, inherited Git config/templates, clean/smudge filters, or network/lazy fetch. Reject unsupported tree entries before materialization. Patches include ignored regular files and use a runner-owned index. Preserve raw-byte semantics and Unix/Windows mode handling when changing capture.

`src/safety.ts` fixes resource policy; `src/workspace.ts` owns bounded traversal/reads. Keep aggregate artifact limits, metadata/patch caps, and phase deadlines outside adapters. Never replace descriptor-bounded reads with unbounded `readFile`, or bounded copies with recursive copying of unchecked exports. Capture failure retains the entire private checkout and any Docker export. Snapshot limits are not a live disk quota; do not claim hostile-input safety.

For Docker changes, read `docs/isolation.md`. Keep the policy fixed and opt-in. Only preinstalled digest-pinned images and a local Linux engine are supported. Never accept arbitrary Docker flags, mount source `.git` or host credentials, or silently fall back to local execution. Stop the whole attempt container after every command, verify quiescence before capture, and retain exports after failed capture or cleanup. Never prune Docker resources or remove containers/images not owned by the current attempt.

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

On a non-root Linux runner with a trusted Docker Engine and the preinstalled image documented in README, also run `pnpm example:isolated` after building the CLI. Linux CI runs it; Windows tests verify unsupported execution does not fall back to the host. Native Windows cannot validate live Linux containment. Do not claim it passed without actually running the Linux acceptance path.

Add focused tests for budget enforcement, adapter normalization, event ordering, redaction, process termination, artifact capture, and scoring changes. Git/workspace tests also cover filter/hook/config rejection, raw binary patch replay, unsupported entries, bounded reads/traversal, aggregate artifacts, and oversized patch/export retention. Test cleanup must resolve and remove only private directories associated with its trusted source fixture. Do not add placeholder scripts that always pass.

## Documentation boundaries

Keep human setup, task formats, result formats, security limits, and known reproducibility limits in `README.md`. Keep agent operating rules here. Document scoring changes because they affect comparisons across versions. Update `ROADMAP.md` only when implementation and verification support the status change.
