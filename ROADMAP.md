# Roadmap

This roadmap makes one local run reproducible before adding providers or dashboards.

## 0. Foundation

- [x] Define task, attempt, adapter, check, score, and artifact terminology
- [x] Record the runtime and isolation decisions
- [x] Add formatting, static checks, focused tests, and CI
- [x] Specify the versioned task and result formats

Completed in version 0.1.0. TypeBox is the source for strict TypeScript types, runtime validation, and checked-in JSON Schemas.

## 1. One reproducible run

- [x] Prepare a disposable checkout at a fixed Git revision
- [x] Execute one local fake-agent adapter
- [x] Capture commands, output, exit status, patch, and artifacts
- [x] Enforce wall-clock and command budgets
- [x] Run deterministic checks after the attempt
- [x] Produce a self-contained machine-readable result

Completed in version 0.1.0. `pnpm example` runs the acceptance path without model APIs or external repositories.

## 2. Useful comparisons

- [x] Run multiple attempts against the same task
- [x] Normalize token and cost reporting
- [x] Compare check results, duration, cost, and patch size
- [x] Generate a human-readable comparison report
- [x] Preserve failed and interrupted attempts

Completed in version 0.2.0. Batch v1 runs configurations and repetitions sequentially in fresh worktrees, with an atomic index and separate results. Result v2 records attempt identities, shared/configured input digests, normalized usage, and explicit skipped checks. Score v2 counts all declared checks; archived v1 results are not mixed into comparisons.

`pnpm build && pnpm example:batch` verifies the built batch/compare CLI with two successful repetitions, a failed check, and a timeout. All four results and artifacts survive, and JSON/Markdown reports regenerate byte-identically from saved evidence. Focused tests also verify cancellation, directory collisions, persistence failure, task compatibility, path escapes, and unknown usage propagation. Fake model usage is known zero; real usage collection and token/cost enforcement remain future work.

Failed and interrupted result preservation shipped in milestone 1. Version 0.2.0 also captures evidence after adapter exceptions, represents every declared check, and saves a snapshot before worktree deletion.

## 3. Real adapters and stronger isolation

- [ ] Add the first real coding-agent adapter
- [ ] Add credential redaction and an explicit secret boundary
- [ ] Enforce network and filesystem policies
- [ ] Add resumable execution and cancellation
- [ ] Publish a small, versioned evaluation suite

Basic text redaction and signal-driven cancellation shipped in version 0.1.0; version 0.2.0 adds batch cancellation and explicit unstarted entries. Neither release provides a complete secret/security boundary, hard process containment, or resumable execution, so those items remain open. No real adapter or paid-model execution was added.

## Later, if justified

- [ ] Optional model-based review with recorded prompts and outputs
- [ ] Statistical summaries across repeated runs
- [ ] Hosted workers
- [ ] Shared evaluation reports

## Explicitly out of scope for the first release

- A chat interface
- Hidden or proprietary benchmark tasks
- Autonomous production changes
- Treating one model's opinion as ground truth
