# Agent Eval Runner

Agent Eval Runner executes a coding-agent attempt at an exact Git commit and saves the evidence as versioned JSON. Milestones 0 and 1 are implemented. The only adapter is a deterministic fake agent for local development and tests.

The runner does not call model APIs. Do not use it on untrusted repositories yet.

## What works

- Version 1 task and result formats, with generated JSON Schemas in [`schemas`](schemas)
- Exact 40-character Git commit validation and detached disposable worktrees
- A fake adapter with deterministic file-write and command actions
- Ordered run events modeled as TypeScript discriminated unions
- Command, output, exit status, patch, and artifact capture
- Runner-owned wall-clock and agent command budgets
- Post-attempt command checks and deterministic pass-ratio scoring
- Atomic result writes for successful, failed, and interrupted attempts
- Basic redaction for configured secret values, bearer tokens, and common credential assignments

## Terms

- A **task** is the versioned input. It fixes the repository commit, prompt, adapter configuration, budgets, checks, and requested artifacts.
- An **attempt** is one adapter execution for a task.
- An **adapter** translates the task into agent actions. The fake adapter is the only implemented adapter.
- A **check** is a deterministic command that the runner executes after the attempt.
- A **score** is the number of passing checks divided by the number of checks. A task with no checks has a `null` ratio.
- An **artifact** is a task-declared file embedded in the result as base64 with byte counts and SHA-256 digests.

## Runtime and isolation decisions

The runtime is Node.js 22 or newer, strict TypeScript, and pnpm. Node gives the runner cross-platform process control without adding a second runtime. TypeBox defines runtime validators, TypeScript types, and the checked-in JSON Schemas from the same source.

The first execution boundary is a detached Git worktree created under the operating system's temporary directory. The runner resolves the task's full commit hash, checks that Git returns the same hash, and checks out that commit. It removes the worktree after evidence capture unless `--keep-worktree` is set or cleanup fails.

A worktree is disposable, but it is not a security sandbox. Agent and check processes retain the runner user's filesystem permissions and network access. They can reach the source repository, other local files, and local services. Git checkout filters and other local Git configuration may run during checkout. Use only repositories and commands you trust.

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs formatting verification, ESLint, strict type checking, schema drift checking, and the focused Vitest suite. CI runs the same command on Linux and then builds the CLI.

## Run the deterministic example

```sh
pnpm example
```

The example resolves this repository's current commit, writes a version 1 task to `.agent-eval/example-task.json`, and runs the fake adapter in a disposable worktree. Its machine-readable result is `.agent-eval/example-result.json`. The directory is ignored by Git so local evaluation evidence is not published by accident.

After `pnpm build`, the equivalent CLI form is:

```sh
node dist/cli.js run --task .agent-eval/example-task.json --output .agent-eval/cli-result.json
```

The CLI exits with code 0 for success, 1 for a completed failure, 2 for invalid input or an unrecoverable runner error, and 130 for an interrupted attempt.

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

## Result format, version 1

The result embeds the redacted task, original task digest, requested and resolved commits, runtime identity, attempt outcome, normalized commands, patch, declared artifacts, checks, score, ordered events, errors, and worktree cleanup state. [`result-v1.schema.json`](schemas/result-v1.schema.json) is the exact contract.

Patches and text artifacts record both persisted and original SHA-256 digests. If redaction changes content, the `redacted` field is true, the regular `sha256` covers the embedded content, and `originalSha256` identifies the pre-redaction bytes. Binary artifacts are preserved byte for byte and are not text-scanned.

Checks run after patch and artifact capture. Their filesystem writes, if any, are not part of the agent patch. A check passes only when its command exits with status 0.

## Reproducibility guarantees

For a given result, the runner records or embeds:

- The validated task and a SHA-256 digest of its original JSON value
- The exact requested commit and the commit Git resolved
- The complete fake-adapter action list and prompt
- Agent command arguments, reduced environment additions, captured output, exit state, and termination reason
- The agent patch before checks run
- Declared artifact content, subject to documented redaction and size limits
- Check commands and their results
- Runner version, Node version, platform, architecture, event order, and measured durations

This is enough to audit what the local run did and repeat it when the source commit and named executables remain available. Results are not byte-identical across runs. Temporary paths, durations, operating systems, executable versions, Git configuration, filesystem behavior, and inherited `PATH` can differ. The runner records several of these inputs but does not pin an operating system image or tool binaries.

Failed and interrupted attempts use the same result contract. Once task validation succeeds, the runner tries to capture the available patch and artifacts, kills an over-budget process tree, cleans up the worktree, and atomically writes the result. Invalid JSON or an invalid task cannot produce a versioned result because no valid task identity exists.

## Credential handling

Before persistence, the runner replaces secret values found under credential-like environment keys. It also redacts bearer tokens and assignments such as `API_KEY=value` in commands, output, errors, patches, the embedded task, and declared text artifacts. The original task and pre-redaction file contents are represented only by SHA-256 digests.

This is a basic backstop, not a secret boundary. It can miss unknown formats, encoded values, short secrets, and credentials in binary artifacts. The runner never records the inherited environment, but child processes still receive a small set of operating system variables including `PATH` and temporary-directory variables.

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
