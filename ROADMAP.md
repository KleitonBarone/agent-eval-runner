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

- [x] Add an opt-in restricted Linux Docker backend for trusted fake-agent fixtures
- [x] Isolate checkout configuration and bound workspace/evidence capture
- [x] Enforce live Linux workspace and temporary byte/inode limits
- [x] Contain Docker revision resolution, Git object parsing, and patch generation
- [ ] Add the first real coding-agent adapter
- [ ] Add credential redaction and an explicit secret boundary
- [ ] Enforce network and filesystem policies
- [ ] Add resumable execution and cancellation
- [ ] Publish a small, versioned evaluation suite

The first slice ships in version 0.3.0. Docker execution uses a preinstalled digest-pinned image, a copied workspace without `.git`, fixed offline/non-root/read-only-root settings, memory/CPU/PID limits, and whole-container termination after every command. Result v3 and comparison v2 preserve image, runtime, policy, and cleanup evidence. Scoring remains version 2. Local execution remains available; unsupported Docker environments never fall back to it. `pnpm example:isolated` verifies containment probes, detached children, budgets, cancellation, failed/interrupted evidence, repeated attempts, and report regeneration on Linux. CI runs this path without publishing results.

Basic text redaction and signal-driven cancellation shipped in version 0.1.0; version 0.2.0 adds batch cancellation and explicit unstarted entries. The restricted backend is not authorization to execute hostile repositories. Local checkout still runs on the host, containers share the host kernel, and there is no credential broker, controlled provider egress, host/global disk quota, token/cost enforcement, or resume. The broader security items remain open pending that work and adversarial review. See [the isolation decisions and next gates](docs/isolation.md). No real adapter or paid-model execution was added.

The second slice ships in version 0.4.0. Preparation materializes verified raw blobs into a runner-owned detached worktree without source config, hooks, templates, filters, or submodule fetch. Patches use a private raw index, include ignored regular files, and replay binary changes. Fixed workspace/file/entry/depth limits, patch and aggregate artifact caps, and separate preparation/capture deadlines preserve failed evidence instead of silently truncating it. Result v4 and comparison v3 record this policy; prior schemas are archived and scoring remains v2. Focused tests reproduce the old filter execution, verify rejection and replay, and cover oversized evidence retention. Linux acceptance also rejects an oversized Docker export while preserving output and smaller artifacts.

The third slice ships in version 0.5.0. The `linux-container-v2` policy replaces the writable host bind mount with a local-driver tmpfs volume limited to 128 MiB of allocated blocks and 12000 inodes. A read-only runner-owned holder keeps it mounted between command restarts without running repository code. `/tmp` has separate 64 MiB/4096-inode limits. Preparation verifies mounted quotas and holder read-only behavior, and a lost/restarted holder never silently resets the workspace. Bounded regular-file exports preserve small evidence after invalid/oversized entries; incomplete export retains the raw holder/volume with recorded cleanup identities. Result v5 and comparison v4 record this policy; archived schemas and scoring v2 remain unchanged. Linux acceptance reaches real `ENOSPC` for both mounts' bytes/inodes and verifies failed-command evidence, subsequent checks, resource cleanup, and saved-report regeneration. CI runs these checks without uploading results.

At version 0.5.0, Docker preparation still trusted host Git parsing. Local execution, host preparation/evidence storage, and aggregate retained resources were not quota-enforced. Tmpfs allocation limits do not bound sparse logical lengths or guarantee survival across unmount/reboot; capture limits still apply. Cooperative filesystem deadlines do not preempt stalled kernel calls. Git preparation containment follows in version 0.6.0; the other security gates remain open.

Version 0.6.0 contains Docker Git operations in a separate fixed offline/non-root preparer. The controller copies only bounded opaque loose/packed objects, rejects external alternates and unsupported layouts, and never calls host Git for Docker evaluations. Source config/hooks/refs remain outside both containers. A bundled worker uses preparation request/response v1; validated file transfers preserve raw bytes and binary patches. Result v6 and comparison v5 record preparation image, Git/Node/Engine identity, worker/snapshot digests, fixed resource policy, and cleanup. Earlier schemas and scoring v2 are unchanged. Linux acceptance blocks host Git while preparing a packed fixture and replaying its binary patch, and preserves rejected/malformed source attempts. Local execution still uses host Git. Host copying remains non-atomic, host/aggregate storage remains unquotaed, and kernel/image trust, adversarial review, credential/provider boundaries, budgets, resume, and a versioned suite remain open.

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
