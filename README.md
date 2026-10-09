# Agent Eval Runner

Agent Eval Runner executes coding-agent attempts at an exact Git commit and compares their saved evidence. Milestones 0, 1, and 2 are implemented. The only adapter is a deterministic fake agent for trusted local development and tests.

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

The first execution boundary is a detached Git worktree created under the operating system's temporary directory. The runner resolves the task's full commit hash, checks that Git returns the same hash, and checks out that commit. Each attempt starts fresh. Before deleting a worktree, it writes an evidence snapshot when an output path was supplied. It then writes the finalized result. It retains the worktree when `--keep-worktree` is set, initial persistence fails, or cleanup fails.

A worktree is disposable, but it is not a security sandbox. Agent and check processes retain the runner user's filesystem permissions and network access. They can reach the source repository, other local files, and local services. Git checkout filters and other local Git configuration may run during checkout. Use only repositories and commands you trust.

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs formatting verification, ESLint, strict type checking, schema drift checking, and the focused Vitest suite. CI runs these checks, builds, and both examples on Linux and Windows. No evaluation artifacts are uploaded.

## Run the deterministic example

```sh
pnpm example
```

The example resolves this repository's current commit, writes a version 1 task to `.agent-eval/example-task.json`, and runs the fake adapter in a disposable worktree. Its version 2 result is `.agent-eval/example-result.json`. Repeating this single-run example replaces those two files. The directory is ignored by Git so local evaluation evidence is not published by accident.

After `pnpm build`, the equivalent CLI form is:

```sh
node dist/cli.js run --task .agent-eval/example-task.json --output .agent-eval/cli-result.json
```

The CLI exits with code 0 for success, 1 for a completed failure, 2 for invalid input or an unrecoverable runner error, and 130 for an interrupted attempt.

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

Batch version 1 has `schemaVersion`, `id`, a shared `task`, and `configurations`. The shared task is a task version 1 without `adapter` or `$schema`. Configurations contain a unique `id`, an `adapter`, and `repetitions` (1 to 1000). A batch may schedule at most 10000 attempts. All configurations receive identical repository, prompt, budgets, checks, and artifact requests.

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

The atomic `batch-index.json` tracks each scheduled attempt as `pending`, `running`, `finished`, `not_started`, or `persistence_failed`. A finished entry names its result and SHA-256 digest. Each result is finalized before the next attempt starts. If result persistence fails, scheduling stops and the checkout is retained if the initial snapshot could not be saved. Permanent filesystem failure, SIGKILL, or power loss cannot guarantee a final result: inspect the last index/snapshot and retained worktrees (`git worktree list`). There is no automatic recovery or resume.

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

## Result and report formats

| Format         | Current schema                                                   |
| -------------- | ---------------------------------------------------------------- |
| Task v1        | [task-v1.schema.json](schemas/task-v1.schema.json)               |
| Result v2      | [result-v2.schema.json](schemas/result-v2.schema.json)           |
| Batch v1       | [batch-v1.schema.json](schemas/batch-v1.schema.json)             |
| Batch index v1 | [batch-index-v1.schema.json](schemas/batch-index-v1.schema.json) |
| Comparison v1  | [comparison-v1.schema.json](schemas/comparison-v1.schema.json)   |

The result embeds the redacted task, original task digest, requested and resolved commits, runtime identity, attempt/configuration/repetition identity, usage, outcome, normalized commands, patch, declared artifacts, checks, score, ordered events, errors, and worktree cleanup state. Events are discriminated unions inferred from their schema. The archived [result-v1.schema.json](schemas/result-v1.schema.json) remains unchanged. New comparisons reject v1 results rather than silently applying different scoring semantics.

Patches and text artifacts record both persisted and original SHA-256 digests. If redaction changes content, the `redacted` field is true, the regular `sha256` covers the embedded content, and `originalSha256` identifies the pre-redaction bytes. Binary artifacts are preserved byte for byte and are not text-scanned.

Checks run after patch and artifact capture, including after an adapter exception. Their filesystem writes, if any, are not part of the agent patch. A check passes only with exit status 0, no termination, and no process error. Every declared check appears as `passed`, `failed`, or `skipped`. Skipped checks have no command and give a reason: cancellation, wall-clock exhaustion, checkout failure, or check setup error. One capture/check error does not prevent later phases or replace the adapter's original outcome.

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

The shared comparison digest covers the resolved source path, full commit, prompt, effective budgets (including the artifact-size default), ordered checks/environment additions, and artifacts. It excludes task labels, `$schema`, and adapter configuration; adapter and full configured-task digests are separate. Repetitions of a configuration share these input digests but have distinct attempt identities and worktrees. Changing a source path changes comparison identity, even if its commit matches.

The fixed example writes and checks produce the same patch/artifact content, outcomes, and scores under the same effective runtime inputs. Arbitrary fake-agent commands can still be nondeterministic. Results are not byte-identical across executions: attempt IDs, temporary paths, durations, operating systems, executable versions, Git configuration, filesystem behavior, and inherited `PATH` can differ. The runner records several of these inputs but does not pin an operating system image or tool binaries. Given unchanged saved index/result bytes and the same report generator version, regenerated JSON and Markdown reports are byte-identical.

Digests detect mismatches against the supplied index; they are not signatures or proof that evidence is authentic. Redacted inputs cannot be fully reconstructed from their hashes, so exact replay of secret-bearing tasks requires an independently retained trusted input. Checks can also depend on external state. Repeated attempts do not imply statistical significance.

Failed and interrupted attempts use the same result contract. Once task validation succeeds, the runner tries to capture the available patch and artifacts, terminates over-budget process trees on a best-effort basis, and persists evidence before cleanup. Git preparation/capture/cleanup and file I/O are not covered by the agent wall-clock budget. Each check has its own timeout; there is no total batch deadline. Atomic renames avoid partial JSON during normal execution but are not fsync-backed crash durability. Invalid JSON or an invalid task cannot produce a versioned result because no valid task identity exists.

## Credential handling

Before persistence, the runner replaces secret values found under credential-like environment keys. It also redacts bearer tokens and assignments such as `API_KEY=value` in commands, output, errors, patches, the embedded task, and declared text artifacts. The original task and pre-redaction file contents are represented only by SHA-256 digests.

This is a basic backstop, not a secret boundary. It can miss unknown formats, encoded values, short secrets, and credentials in binary artifacts. The runner never records the inherited environment, but child processes still receive a small set of operating system variables including `PATH` and temporary-directory variables.

Process termination uses Unix process groups or Windows `taskkill`. Descendants that escape these mechanisms or outlive their parent may survive. These mechanisms are not a hard containment or resource-accounting boundary.

## Before real adapters are safe

Real agents should wait for milestone 3. The runner still needs:

- A container or virtual-machine boundary that blocks access to the host and source repository metadata
- Default-deny network and filesystem policies with explicit task grants
- A credential broker and tested redaction policy for structured and binary evidence
- Token and cost budgets enforced outside provider processes
- Repository checkout hardening against filters, hooks, submodules, and local Git configuration
- Cross-platform process containment stronger than best-effort process-tree termination
- Versioned toolchain or image identities for checks and adapters

Until those exist, adding a real adapter would turn trusted local commands into a host-level execution path. That is not a reasonable default.

## License

[MIT](LICENSE)
