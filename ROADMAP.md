# Roadmap

This roadmap makes one local run reproducible before adding providers or dashboards.

## 0. Foundation

- [ ] Define task, attempt, adapter, check, score, and artifact terminology
- [ ] Record the runtime and isolation decisions
- [ ] Add formatting, static checks, focused tests, and CI
- [ ] Specify the versioned task and result formats

## 1. One reproducible run

- [ ] Prepare a disposable checkout at a fixed Git revision
- [ ] Execute one local fake-agent adapter
- [ ] Capture commands, output, exit status, patch, and artifacts
- [ ] Enforce wall-clock and command budgets
- [ ] Run deterministic checks after the attempt
- [ ] Produce a self-contained machine-readable result

## 2. Useful comparisons

- [ ] Run multiple attempts against the same task
- [ ] Normalize token and cost reporting
- [ ] Compare check results, duration, cost, and patch size
- [ ] Generate a human-readable comparison report
- [ ] Preserve failed and interrupted attempts

## 3. Real adapters and stronger isolation

- [ ] Add the first real coding-agent adapter
- [ ] Add credential redaction and an explicit secret boundary
- [ ] Enforce network and filesystem policies
- [ ] Add resumable execution and cancellation
- [ ] Publish a small, versioned evaluation suite

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
