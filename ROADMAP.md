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

- [ ] Run multiple attempts against the same task
- [ ] Normalize token and cost reporting
- [ ] Compare check results, duration, cost, and patch size
- [ ] Generate a human-readable comparison report
- [x] Preserve failed and interrupted attempts

Failed and interrupted result preservation shipped early because budget enforcement needs inspectable evidence.

## 3. Real adapters and stronger isolation

- [ ] Add the first real coding-agent adapter
- [ ] Add credential redaction and an explicit secret boundary
- [ ] Enforce network and filesystem policies
- [ ] Add resumable execution and cancellation
- [ ] Publish a small, versioned evaluation suite

Version 0.1.0 has basic text redaction and signal-driven cancellation. Neither is a complete security boundary or resumable execution, so the corresponding items remain open.

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
