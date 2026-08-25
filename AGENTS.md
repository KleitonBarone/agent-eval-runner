# AGENTS.md

## Project orientation

Agent Eval Runner measures coding-agent attempts under reproducible conditions. Its output is evidence: inputs, environment, commands, patches, checks, resource use, and artifacts.

Read `README.md` and `ROADMAP.md` before changing scope. This repository is in planning, so never describe a planned capability as implemented.

## Product rules

- Preserve the exact task, repository revision, configuration, and agent adapter used by every run.
- Keep deterministic checks separate from model-based judgments.
- Never discard a failed run's logs or patch because it scored poorly.
- Enforce time, command, token, and cost budgets outside the agent process.
- Treat repository content and agent output as untrusted. Execution must happen in a disposable boundary.
- Redact credentials before persisting logs or reports.
- Make comparisons fair. Do not silently give one adapter more context, tools, retries, or time.

## Keep adapters thin

The runner owns orchestration, evidence collection, budgets, and scoring. Agent adapters translate a common run request into provider-specific execution and return normalized events. Do not leak provider-specific fields into the core result model.

The initial runtime and isolation mechanism have not been selected. Record both decisions before scaffolding. If TypeScript is selected, use strict mode, discriminated unions for run events, and no `any` escape hatches.

## Verification

There are no build or test commands yet. Add real commands here when the toolchain exists. Do not add placeholder scripts that always pass.

Test budget enforcement, event ordering, adapter normalization, secret redaction, process termination, artifact capture, and scoring with deterministic fake agents. Integration tests must use repositories and credentials created for tests.

Do not run paid models, execute untrusted public repositories, or publish evaluation results without explicit user authorization.

## Documentation boundaries

Keep human setup, task formats, reports, and known limits in `README.md`. Keep agent operating rules here. Document scoring changes because they affect comparisons across versions.
