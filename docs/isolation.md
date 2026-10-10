# Restricted Linux execution

Version 0.3.0 adds the first milestone 3 slice. It runs deterministic fake-agent actions and post-run checks in Docker against trusted local fixtures. It does not approve hostile repositories, real adapters, paid-model calls, or production credentials. The acceptance tests use disposable test-only credential values.

## Execution boundary

The runner validates task v1 and prepares a detached Git worktree at the exact requested commit. Local execution uses that worktree directly. Docker execution copies its regular files into a separate temporary directory, excluding the root `.git` entry. The container mounts only that copy at `/workspace`. The original checkout and source repository metadata stay on the host.

Docker requires a non-root Linux runner and a trusted local Engine at `/var/run/docker.sock`. The runner ignores Docker contexts and uses an empty per-attempt Docker configuration directory. It never mounts the engine socket or configuration into the container. Only a preinstalled `repository@sha256:<digest>` image is accepted; there are no implicit pulls. Images must provide `/usr/local/bin/node` version 22 or newer and must not declare volumes.

The fixed `linux-container-v1` policy is:

| Setting         | Value                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| Network         | `none`, loopback only, no published ports                                        |
| Writable files  | Copied `/workspace` plus a 64 MiB `/tmp` tmpfs                                   |
| Root filesystem | Read-only                                                                        |
| User            | Runner's nonzero Linux UID and runner GID                                        |
| Privileges      | All capabilities dropped, no new privileges, private IPC, engine-default seccomp |
| Resources       | 512 MiB memory with no extra swap, 1 CPU quota, 128 PIDs                         |
| Lifecycle       | Start for each action/check, kill the whole container afterward                  |
| Environment     | Image defaults and explicit task additions, no inherited host environment        |

Docker's virtual device, proc, and private IPC mounts still exist; read-only root does not make every virtual filesystem read-only. Tasks cannot override these settings or add mounts, networks, ports, capabilities, or Docker options. There is no credential broker or provider network grant yet. Digest pinning identifies bytes, not image trust or provenance. Docker documents [network-none behavior](https://docs.docker.com/engine/network/drivers/none/), [runtime restrictions](https://docs.docker.com/engine/containers/run/), and [the host/daemon trust boundary](https://docs.docker.com/engine/security/).

## Lifecycle and evidence

1. Prepare the host checkout and isolated copy, inspect the image, create an owned `agent-eval-<uuid>` container, validate the daemon-resolved policy, and probe its Node runtime.
2. Route fake file writes and agent commands into that container. The runner owns the wall-clock and command budgets. File-write helpers do not count as agent commands.
3. Kill and inspect the container after every command, even if its parent process exited successfully. Restarting clears `/tmp` and descendants; only workspace files carry over. A stop failure refuses further commands and capture that requires a stopped workspace.
4. Once quiescent, reject symlinks and special files before copying the export back to the host checkout. Capture the Git patch and declared artifacts before checks. Git diff disables external diff and textconv.
5. Run checks under the same restrictions, with their own deadlines. Check writes do not enter the already-captured agent patch or artifacts.
6. Remove only the current attempt's container, persist an evidence snapshot, then remove disposable directories. Capture/cleanup failure, initial persistence failure, or `--keep-worktree` retains workspace evidence. Containers are removed even when the worktree is intentionally retained.

Result v3 records requested image, resolved image ID and architecture, Node/Engine versions, UID/GID, fixed policy, container ID/name, cleanup status, and retained export path. Fields unavailable after preparation failure are `null`. Ordered normalized events include `execution.prepared`. Failed and interrupted attempts use the same result contract. Comparison v2 retains this evidence and warns on stable runtime differences rather than on temporary container IDs.

Execution policy and requested image enter the shared-task digest. Local and Docker results therefore cannot share a comparison. Result v1/v2 and comparison v1 are archived and unchanged; current report generation does not migrate them. Scoring remains version 2.

## Limits that still matter

- Host Git checkout, indexing, filters, hooks, and local configuration remain trusted. Copying out `.git` does not harden preparation. Repository files can contain secrets.
- Docker shares the host kernel. Kernel/runtime vulnerabilities, a compromised daemon, a malicious image, or a hostile host user are outside this boundary. Docker socket access gives the host controller substantial authority. There is no VM isolation or cross-platform equivalent.
- Memory/CPU/PID settings constrain container processes, not runner work. `/workspace` has no disk quota, and patch/tree traversal has no total byte/file budget. A hostile attempt could exhaust host storage or capture resources.
- The agent deadline covers actions and command startup, not preparation, capture, or cleanup. Docker control calls have individual 10-second limits. Termination can exceed the deadline, and a stuck daemon can prevent cleanup. There is no total run/batch deadline.
- `SIGKILL`, power loss, and storage/daemon failure can leave a container, export, or last snapshot. Inspect recorded owned container identities and retained paths. There is no automatic recovery or resume.
- Redaction is a text backstop. Encoded, unknown, short, binary, or repository-committed credentials can escape it. Image environment defaults and task additions must already be trusted.
- Pinning the image does not pin host kernel, Engine, Git, hardware, filesystem behavior, or scheduling. Arbitrary commands remain potentially nondeterministic. Saved reports regenerate byte-identically; independent runs do not.

For these reasons, this backend remains limited to trusted repositories and commands. Stronger isolation must precede permission to run untrusted inputs.

## Verification and next gates

The README provides the exact image pull and `pnpm example:isolated` commands. The acceptance script creates trusted temporary repositories and verifies failed host reads/writes, denied host-service connections, no inherited test credential or Git/Docker metadata, non-root/capability restrictions, detached-child termination, time/command budgets, cancellation, redaction, evidence capture/scoring, rejected symlink exports and forensic retention, cleanup, repeated workspaces, and deterministic saved-report regeneration. It preserves results locally and never uploads them. The rejected-export fixture also retains its source repository so its saved checkout remains inspectable. These targeted probes are not an adversarial security audit.

To verify the acceptance script without the `tsx` loader on Linux, run `pnpm exec tsc -p tsconfig.isolation.json`, then `node .agent-eval/isolation-tools/scripts/run-isolated-example.js`. This also supports a Windows checkout accessed from WSL, provided Node.js 22 or newer and Docker run inside Linux. Run the normal build first when checking the CLI.

Before a real adapter:

- Harden host repository preparation and exported-evidence handling, with traversal/disk limits.
- Review the threat model and image provenance, and add adversarial escape tests or VM isolation as required.
- Design a credential broker and controlled provider egress that cannot reach host/private services.
- Collect trustworthy provider usage and enforce token/cost budgets outside the provider process.
- Define adapter capabilities and toolchain identity without weakening the fixed backend silently.

Resume and a small versioned evaluation suite follow as separate roadmap work. No first-provider choice is implied by this implementation.
