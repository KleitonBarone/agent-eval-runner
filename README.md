# Agent Eval Runner

Agent Eval Runner executes coding-agent attempts at an exact Git commit and compares their saved evidence. Milestones 0, 1, and 2 are implemented. Version 0.5.0 adds kernel-enforced Linux workspace storage limits to the raw-object checkout and bounded capture from 0.4.0. Milestone 3 remains incomplete. The only adapter is a deterministic fake agent for trusted local development and tests.

The runner does not call model APIs. Do not use it on untrusted repositories yet.

## What works

- Versioned task, result, batch, index, and comparison formats in [`schemas`](schemas)
- Exact 40-character Git commit validation and detached disposable worktrees
- A fake adapter with deterministic file-write and command actions
- Ordered run events modeled as TypeScript discriminated unions
- Command, output, exit status, patch, and artifact capture
- Runner-owned wall-clock and agent command budgets
- Post-attempt command checks and deterministic pass-ratio scoring
- Atomic result writes for successful, failed, and interrupted attempts
- Sequential batches with fresh worktrees, repeated configurations, and cancellation
- Known/unknown model usage and deterministic JSON and Markdown comparison reports
- Basic redaction for configured secret values, bearer tokens, and common credential assignments
- Digest-pinned Linux containers with fixed network, filesystem, privilege, and resource restrictions
- Runner-owned Git metadata, raw blob checkout, and bounded workspace/patch/artifact capture
- Live Linux tmpfs byte/inode limits, verified before any agent action

Start with `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm example`. Docker is optional for that path.

## Terms

- A **task** is the versioned input. It fixes the repository commit, prompt, adapter configuration, budgets, checks, and requested artifacts.
- An **attempt** is one adapter execution for a task.
- An **adapter** translates the task into agent actions. The fake adapter is the only implemented adapter.
- A **check** is a deterministic command that the runner executes after the attempt.
- A **score** is passing checks divided by all declared checks, including failed and skipped checks. A task with no checks has a `null` ratio.
- A **batch** schedules configurations and repetitions of one shared task, in input order.
- An **artifact** is a task-declared file embedded in the result as base64 with byte counts and SHA-256 digests.

## Runtime and isolation decisions

The runtime is Node.js 22 or newer, strict TypeScript, and pnpm. Node gives the runner cross-platform process control without adding a second runtime. TypeBox defines runtime validators, TypeScript types, and the checked-in JSON Schemas from the same source.

The execution boundary is a detached Git worktree in a runner-owned temporary repository. The source supplies commit objects through a read-only Git object alternate, not its configuration or worktree metadata. Preparation validates the exact commit and tree, then materializes verified raw blob bytes. Git runs with a reduced environment, no system/global configuration, disabled hooks/fsmonitor, an empty initialization template, no lazy fetch, and no network protocols. Private attributes disable filters, line-ending conversion, ident expansion, and working-tree encoding conversion. Git LFS pointers remain pointers; submodules and symlinks are rejected, not fetched or followed.

Each attempt starts fresh. Its `agent-eval-worktree-<suffix>` directory holds `checkout`, private Git metadata, and the source identity. The source repository receives no worktree registration or captured blobs. Before removing the private directory, the runner saves an evidence snapshot when an output path was supplied. `--keep-worktree`, failed capture, initial persistence failure, and cleanup failure retain it. Inspect retained metadata with `git -C <saved-workspace-path> worktree list`; the source repository's worktree list no longer tracks attempts.

A worktree is disposable, but it is not a security sandbox. Local agent and check processes retain the runner user's filesystem permissions and network access. They can reach the source repository, other local files, and local services. Host Git still parses source repository metadata and objects. Use only repositories and commands you trust.

Setting `execution.kind` to `docker` runs fake-agent writes, commands, and checks in a Linux container. The host still prepares a worktree, but the container receives only verified files in a quota-limited tmpfs volume without `.git`, not a writable host directory. It never receives the source repository, Docker socket, host home directory, or inherited host credentials. Unsupported systems, missing images, unavailable quota mounts, and preparation failures produce failed evidence; they never fall back to local execution. See [the isolation policy and threat model](docs/isolation.md) before using this backend.

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs formatting verification, ESLint, strict type checking, schema drift checking, and the focused Vitest suite. CI runs these checks, builds, and both local examples on Linux and Windows. Linux CI also runs the Docker acceptance example. No evaluation artifacts are uploaded.

## Run the deterministic example

```sh
pnpm example
```

The example resolves this repository's current commit, writes a version 1 task to `.agent-eval/example-task.json`, and runs the fake adapter in a disposable worktree. Its version 5 result is `.agent-eval/example-result.json`. Repeating this single-run example replaces those two files. The directory is ignored by Git so local evaluation evidence is not published by accident.

After `pnpm build`, the equivalent CLI form is:

```sh
node dist/cli.js run --task .agent-eval/example-task.json --output .agent-eval/cli-result.json
```

The CLI exits with code 0 for success, 1 for a completed failure, 2 for invalid input or an unrecoverable runner error, and 130 for an interrupted attempt.

## Run the restricted Linux example

Use a non-root Linux account with access to a trusted local Docker Engine at `/var/run/docker.sock`. The runner does not support remote engines, arbitrary Docker flags, or native Windows container execution. The trusted image must provide Node.js 22 or newer at `/usr/local/bin/node` and must not declare volumes.

Preinstall the example's official Node 24.20.0 Linux amd64 image explicitly, then run the acceptance checks:

```sh
docker pull node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
pnpm build
pnpm example:isolated
```

The runner itself never pulls images. This example uses the built CLI and generated trusted repositories, not public repositories. It verifies host filesystem/network denial, credential non-inheritance and redaction, detached-child termination, budgets, cancellation, scoring, patch/artifact preservation, actual byte/inode exhaustion in `/workspace` and `/tmp`, rejected symlink and oversized exports, two isolated repetitions, resource cleanup, and byte-identical report regeneration. Each invocation preserves results under `.agent-eval/isolation-example-<uuid>`. Incomplete exports also retain their trusted temporary source, private checkout, bounded partial export, and read-only storage holder/volume for inspection. Their paths and owned resource names appear in the saved results.

Add this optional field to a task or a batch's shared task to use the same backend through the existing CLI:

```json
{
  "execution": {
    "kind": "docker",
    "image": "node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
  }
}
```

Omitting `execution`, or using `{ "kind": "local" }`, keeps the trusted-worktree behavior. The Docker policy is fixed, with no network grants or provider credential broker. A stopped agent container restarts before each command and is killed afterward, including after successful commands. A separate read-only holder keeps the tmpfs mounted between commands and runs only fixed runner helpers. Files under `/workspace` persist within the attempt; agent background processes and `/tmp` contents do not. A stopped or restarted holder causes failure, not a fresh workspace or host fallback.

## Live Linux storage limits

The `linux-container-v2` policy fixes `/workspace` at 128 MiB of allocated blocks and 12000 inodes, and `/tmp` at 64 MiB and 4096 inodes. Files, directories, and some extended attributes consume inodes. The kernel rejects further allocation with `ENOSPC`; tasks cannot raise these limits. The runner verifies Docker's local-volume options and actual tmpfs block/inode totals before importing files or starting the adapter. Sparse files can have larger logical lengths, so the stricter capture limits below remain necessary.

The runner exports bounded regular files through the read-only holder after stopping all agent processes. It does not unpack a daemon-provided archive or copy arbitrary sparse files to the host. Incomplete export preserves available small files and marks the patch uncaptured rather than inventing a complete patch. Successfully exported agent evidence survives later check writes and resource removal.

After complete export, the runner removes its agent container, holder, and volume. Incomplete export retains the holder/volume and records `execution.storage.cleanup` as `retained`; the agent container is still removed. Inspect only the names recorded in your result:

```sh
docker inspect <holder-name>
docker volume inspect <volume-name>
```

Retained tmpfs data is ephemeral and consumes bounded RAM or swap until released. Removing the last mount destroys it. After inspection and saving needed evidence, verify the recorded ownership labels before removing that exact holder and volume. Never prune Docker resources. Host reboot, daemon failure, or holder termination can lose raw tmpfs contents; saved JSON and partial exports are the persisted evidence. Local execution has no live storage quota, and repeated retained attempts have no global aggregate quota.

## Run and compare a batch

```sh
pnpm build
pnpm example:batch
```

This acceptance example exercises the built CLI with two successful repetitions, a failed test, and a timeout. It verifies that all four results and artifacts survived and that both reports regenerate byte-identically. Intentional failures make the batch CLI exit 1; the example exits 0 only after verifying the expected evidence. Each invocation creates a new `.agent-eval/batch-example-<uuid>` directory and prints its paths.

To use another trusted batch file:

```sh
node dist/cli.js batch --batch batch.json --output-dir .agent-eval/my-batch
node dist/cli.js compare --input-dir .agent-eval/my-batch --output .agent-eval/my-batch/comparison.json --markdown .agent-eval/my-batch/comparison.md
```

`batch` requires a directory that does not exist. It never reuses or resumes an existing batch. Ordinary failures and attempt timeouts do not stop the schedule. SIGINT/SIGTERM cancels the active attempt and marks later attempts `not_started`. Batch exit codes are 0 when every attempt succeeds, 1 for failed/interrupted attempts or recorded persistence failure, 2 for invalid input or an unrecoverable error, and 130 for external cancellation. `compare` only reads saved evidence; it never invokes an adapter or a check.

Batch version 1 has `schemaVersion`, `id`, a shared `task`, and `configurations`. The shared task is a task version 1 without `adapter` or `$schema`. Configurations contain a unique `id`, an `adapter`, and `repetitions` (1 to 1000). A batch may schedule at most 10000 attempts. All configurations receive identical repository, execution policy, prompt, budgets, checks, and artifact requests.

For example, a batch's `configurations` can contain:

```json
[
  {
    "id": "answer",
    "repetitions": 2,
    "adapter": {
      "kind": "fake",
      "actions": [
        { "kind": "writeFile", "path": "answer.txt", "content": "answer\n" }
      ]
    }
  },
  {
    "id": "wrong-answer",
    "repetitions": 1,
    "adapter": {
      "kind": "fake",
      "actions": [
        { "kind": "writeFile", "path": "answer.txt", "content": "wrong\n" }
      ]
    }
  }
]
```

The atomic `batch-index.json` tracks each scheduled attempt as `pending`, `running`, `finished`, `not_started`, or `persistence_failed`. A finished entry names its result and SHA-256 digest. Each result is finalized before the next attempt starts. If result persistence fails, scheduling stops and the checkout is retained if the initial snapshot could not be saved. Permanent filesystem failure, SIGKILL, or power loss cannot guarantee a final result. Inspect the last index/snapshot and use `git -C <saved-workspace-path> worktree list` for retained attempts. There is no automatic recovery or resume.

## Task format, version 1

Task files accept only a full 40-character commit hash. Symbolic revisions such as `HEAD`, branch names, and tags fail validation.

```json
{
  "$schema": "./schemas/task-v1.schema.json",
  "schemaVersion": "1",
  "id": "fake-agent-example",
  "repository": {
    "path": "/absolute/path/to/trusted/repository",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  },
  "prompt": "Create answer.txt",
  "adapter": {
    "kind": "fake",
    "actions": [
      { "kind": "writeFile", "path": "answer.txt", "content": "answer\n" },
      {
        "kind": "runCommand",
        "command": "node",
        "args": ["-e", "console.log('done')"]
      }
    ]
  },
  "budgets": {
    "wallClockMs": 5000,
    "maxCommands": 1,
    "maxOutputBytes": 16384,
    "maxArtifactBytes": 65536
  },
  "checks": [
    {
      "id": "answer-exists",
      "kind": "test",
      "command": "node",
      "args": ["-e", "require('node:fs').accessSync('answer.txt')"],
      "timeoutMs": 2000
    }
  ],
  "artifacts": [{ "path": "answer.txt", "mediaType": "text/plain" }]
}
```

The command budget applies only to agent commands. Each check declares whether it is a `test`, `lint`, or `custom` command. Checks have their own timeouts and do not consume the agent command budget. The wall-clock budget covers the fake-agent attempt. Each stdout and stderr stream is capped at `maxOutputBytes`; the result marks truncated streams. `maxArtifactBytes` defaults to 1 MiB when omitted.

## Fixed checkout and capture limits

The runner owns these limits; tasks cannot raise them. Result v5 embeds the versioned policy, and it enters comparison identity.

| Limit                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| Source/export workspace   | 64 MiB of logical file bytes                                        |
| Individual workspace file | 16 MiB                                                              |
| Workspace entries         | 10000 files and directories                                         |
| Path depth                | 32 components                                                       |
| Patch                     | 8 MiB, before and after redaction                                   |
| All embedded artifacts    | 8 MiB, counting the larger of original/persisted bytes per artifact |
| Git tree/index metadata   | 2 MiB                                                               |
| Preparation and capture   | Separate 30-second phase deadlines                                  |

Traversal uses directory iteration and bounded descriptor reads. It rejects links, special files, hard links, metadata paths, case collisions, non-NFC names, control characters, Windows reserved names, and short-name-like aliases. Reads stop at their byte limit even if a file grows after its initial size check. Oversized patches are rejected, never silently truncated. A failed capture preserves available command output and smaller artifacts, keeps the original agent outcome, and retains the checkout/export.

These are logical snapshot/capture limits, separate from the Linux allocated-byte/inode quotas. Local commands can still exhaust host storage. Host preparation, private Git objects, saved results, and retained exports are not on a quota-enforced filesystem. Phase deadlines bound Git subprocesses and checkpoint filesystem operations; they cannot preempt a stalled kernel filesystem call or guarantee a hard total run duration.

## Result and report formats

| Format         | Current schema                                                   |
| -------------- | ---------------------------------------------------------------- |
| Task v1        | [task-v1.schema.json](schemas/task-v1.schema.json)               |
| Result v5      | [result-v5.schema.json](schemas/result-v5.schema.json)           |
| Batch v1       | [batch-v1.schema.json](schemas/batch-v1.schema.json)             |
| Batch index v1 | [batch-index-v1.schema.json](schemas/batch-index-v1.schema.json) |
| Comparison v4  | [comparison-v4.schema.json](schemas/comparison-v4.schema.json)   |

The result embeds the redacted task, original task digest, requested and resolved commits, runtime and execution identity, attempt/configuration/repetition identity, usage, outcome, normalized commands, patch, declared artifacts, checks, score, ordered events, errors, and worktree cleanup state. Docker evidence also records requested image digest, resolved image ID, image architecture, container Node version, engine version, UID/GID, fixed policy, container identity, cleanup status, any retained export path, and storage volume/holder identities, quota verification, and cleanup state. Preparation failures leave unavailable fields `null`. Events are discriminated unions inferred from their schema.

Version 5 retains the fixed `safety` policy and requires Docker's `linux-container-v2` storage policy/evidence. Comparison v4 includes both. Earlier execution evidence and events remain present. Scoring stays version 2. Archived [result v1](schemas/result-v1.schema.json), [v2](schemas/result-v2.schema.json), [v3](schemas/result-v3.schema.json), [v4](schemas/result-v4.schema.json), [comparison v1](schemas/comparison-v1.schema.json), [v2](schemas/comparison-v2.schema.json), and [v3](schemas/comparison-v3.schema.json) remain unchanged. Current comparisons reject old results rather than infer missing storage identities or mix shared-task digests. There is no automatic migration.

Patches and text artifacts record both persisted and original SHA-256 digests. If redaction changes content, the `redacted` field is true, the regular `sha256` covers the embedded content, and `originalSha256` identifies the pre-redaction bytes. Binary artifacts are preserved byte for byte and are not text-scanned.

Patches compare a runner-built raw-byte index against the requested commit. They include every regular workspace file, including ignored files, and disable rename detection, external diff, and textconv. They do not use agent-controlled staging or Git clean filters. This differs from v3, which excluded ignored untracked files. Executable-bit changes are recorded on Unix; Windows preserves tracked Git modes and assigns new files mode `100644`. Empty directories are not Git evidence. Replaying with another Git configuration may require `git -c core.autocrlf=false apply --binary <patch>`; replaying into a raw prepared checkout is covered by tests.

Checks run after patch and artifact capture, including after an adapter exception. Their filesystem writes, if any, are not part of the agent patch. A check passes only with exit status 0, no termination, and no process error. Every declared check appears as `passed`, `failed`, or `skipped`. Skipped checks have no command and give a reason: cancellation, wall-clock exhaustion, checkout failure, execution preparation failure, or check setup error. One capture/check error does not prevent later phases or replace the adapter's original outcome.

Score version 2 reports passed, failed, skipped, total, and ratio. The denominator is all declared checks, not just checks that ran. This intentionally differs from version 1 for incomplete attempts. A missing patch capture is distinct from a captured empty patch; reports show unknown patch size for the former.

Usage metrics `modelTokens` and `modelCostUsd` are either `known` with a value and source (`measured` or `not_applicable`), or `unknown` with a reason. Fake model usage is known zero/not-applicable. This is model usage, not host compute cost. Unknown usage, or a started attempt without a finalized result, propagates to aggregate totals. Token/cost budgets and real provider usage are not implemented.

Reports retain scheduled order, configuration details, runtime identities, outcomes, individual check statuses/reasons, scores, agent duration, agent command count, model usage, and original patch bytes. They do not rank a winner. Comparisons require matching shared-task digests, scoring version 2, matching attempt identities, complete check evidence, and consistent scores. Differing recorded runtimes produce a warning. Result file digests are verified and escaping paths are rejected; report outputs cannot overwrite index/result evidence.

## Reproducibility guarantees

For a given result, the runner records or embeds:

- The validated task and a SHA-256 digest of its canonical original JSON value (object keys sorted, array order retained)
- The exact requested commit and the commit Git resolved
- The complete fake-adapter action list and prompt
- Agent command arguments, reduced environment additions, captured output, exit state, and termination reason
- The agent patch before checks run
- Declared artifact content, subject to documented redaction and size limits
- Check commands and their results
- Runner version, Node version, platform, architecture, event order, and measured durations
- Effective execution and safety policy, including capture limits and raw checkout behavior
- For Docker, requested/resolved image and runtime identity

The shared comparison digest covers the resolved source path, full commit, execution policy and requested image, safety policy, prompt, effective budgets (including the artifact-size default), ordered checks/environment additions, and artifacts. It excludes task labels, `$schema`, and adapter configuration; adapter and full configured-task digests are separate. Repetitions of a configuration share these input digests but have distinct attempt identities and worktrees. Changing a source path changes comparison identity, even if its commit matches. Local and Docker attempts cannot share a comparison; explicit local execution and the omitted default have the same effective identity.

The fixed example writes and checks produce the same patch/artifact content, outcomes, and scores under the same effective runtime inputs. Arbitrary fake-agent commands can still be nondeterministic. Results are not byte-identical across executions: attempt/container IDs, temporary paths, durations, operating systems, executable versions, Git configuration, filesystem behavior, and inherited local `PATH` can differ. Docker pins image bytes and records the resolved runtime, but it does not pin the host kernel, engine, CPU, Git checkout behavior, or resource contention. Local execution does not pin tool binaries. Given unchanged saved index/result bytes and the same report generator version, regenerated JSON and Markdown reports are byte-identical.

Digests detect mismatches against the supplied index; they are not signatures or proof that evidence is authentic. Redacted inputs cannot be fully reconstructed from their hashes, so exact replay of secret-bearing tasks requires an independently retained trusted input. Checks can also depend on external state. Repeated attempts do not imply statistical significance.

Failed and interrupted attempts use the same result contract. Once task validation succeeds, the runner tries to capture the available patch and artifacts and persists evidence before workspace deletion. Local termination is best-effort. Docker commands stop the whole agent container before capture, and container-stop failures refuse further execution and unsafe capture. Failed capture retains the available isolated export and original checkout; incomplete export also retains raw quota storage in its read-only holder. Docker cleanup verifies ownership and removes only this attempt's resources, never unrelated containers, volumes, or images.

The agent wall-clock budget covers actions and command startup, not checkout, backend preparation, capture, or cleanup. Preparation and capture have separate deadlines described above. Docker file writes run under the agent budget; local file I/O is not preemptible. Container termination and control operations can add time beyond a deadline, with each Docker metadata/cleanup request bounded at 10 seconds. Command startup/import/export use the remaining execution/phase deadline. Each check has its own timeout; there is no total batch deadline or host/global storage quota. Atomic renames avoid partial JSON during normal execution but are not fsync-backed crash durability. Daemon failure, SIGKILL, power loss, or permanent storage failure cannot guarantee termination or final evidence. Invalid JSON or an invalid task cannot produce a versioned result because no valid task identity exists.

## Credential handling

Before persistence, the runner replaces secret values found under credential-like environment keys. It also redacts bearer tokens and assignments such as `API_KEY=value` in commands, output, errors, patches, the embedded task, and declared text artifacts. The original task and pre-redaction file contents are represented only by SHA-256 digests.

This is a basic backstop, not a complete secret boundary. It can miss unknown formats, encoded values, short secrets, and credentials in binary artifacts. The runner never records the inherited environment. Local child processes still receive a small set of operating system variables including `PATH` and temporary-directory variables. Docker commands receive image defaults and explicit task environment additions only. Neither backend can protect secrets deliberately committed in a repository or supplied through the task.

Local process termination uses Unix process groups or Windows `taskkill`. Descendants that escape these mechanisms or outlive their parent may survive. Docker kills the container after each command and confirms it stopped, so the next phase cannot share surviving container processes. This still trusts the host kernel and Docker daemon; it is not VM isolation.

## Before real adapters are safe

Real agents should wait for the remaining milestone 3 work. The current Docker backend is for trusted fixtures, not hostile code. The runner still needs:

- A threat-model review and adversarial validation, with VM isolation where host-kernel trust is unacceptable
- Controlled network grants for provider access, with destination restrictions and no local-service access
- A credential broker and tested redaction policy for structured and binary evidence
- Token and cost budgets enforced outside provider processes
- Containment of host Git object/metadata parsing and protection against concurrent host filesystem changes
- Cross-platform containment and host/global storage accounting outside agent processes
- Reviewed adapter toolchains and image provenance, not just digest pinning

Resumable execution and a small versioned evaluation suite also remain open. The fake adapter needs no secrets or network access; a real adapter would add both. That needs a separate design and explicit authorization.

## License

[MIT](LICENSE)
