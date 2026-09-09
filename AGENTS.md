# AGENTS.md

## Project orientation

Agent Eval Runner measures coding-agent attempts under reproducible conditions. Its output is evidence: inputs, environment identity, commands, patches, checks, resource use, and artifacts.

Read `README.md` and `ROADMAP.md` before changing scope. Milestones 0 and 1 are implemented. Do not describe roadmap items from milestone 2 onward as complete unless their checkbox and implementation agree.

## Product rules

- Preserve the exact task identity, repository revision, configuration, and agent adapter used by every run.
- Keep deterministic checks separate from model-based judgments.
- Never discard a failed or interrupted run's logs or patch because it scored poorly.
- Enforce time, command, token, and cost budgets outside the agent process.
- Treat repository content and agent output as untrusted. Worktrees are disposable but not secure isolation.
- Redact credentials before persisting logs or reports. Keep original digests when redaction changes evidence.
- Make comparisons fair. Do not silently give one adapter more context, tools, retries, or time.

## Runtime and isolation

Use Node.js 22 or newer, pnpm, and strict TypeScript. TypeBox schemas define runtime validation, TypeScript types, and generated JSON Schemas. Do not hand-edit files under `schemas`; change `src/spec.ts`, `src/result.ts`, or `src/events.ts`, then run `pnpm schemas:write`.

The local execution boundary is a detached Git worktree under the operating system's temporary directory. It does not restrict network access, host filesystem access, source repository metadata, or local Git configuration. Do not run paid models, untrusted repositories, or untrusted commands without explicit user authorization and stronger isolation.

## Keep adapters thin

The runner owns orchestration, evidence collection, budgets, and scoring. Agent adapters translate a common run request into provider-specific execution and return normalized events. Do not leak provider-specific fields into the core result model.

Use discriminated unions for run events. Do not use `any`, unsafe assertions, or casting wrappers to bypass the type system.

## Verification

Use these commands:

```sh
pnpm format
pnpm check
pnpm build
pnpm example
```

`pnpm check` verifies formatting, linting, types, generated schemas, and focused tests. Tests cover command budgets, wall-clock budgets, descendant process termination, event ordering, artifact capture, patch generation, deterministic scoring, result preservation, and basic credential redaction. Integration tests create local temporary Git repositories and credentials for each test.

Add focused tests for budget enforcement, adapter normalization, event ordering, redaction, process termination, artifact capture, and scoring changes. Do not add placeholder scripts that always pass.

## Documentation boundaries

Keep human setup, task formats, result formats, security limits, and known reproducibility limits in `README.md`. Keep agent operating rules here. Document scoring changes because they affect comparisons across versions. Update `ROADMAP.md` only when implementation and verification support the status change.
