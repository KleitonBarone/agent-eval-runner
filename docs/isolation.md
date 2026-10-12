# Restricted Linux execution

Version 0.5.0 adds kernel-enforced tmpfs allocation/inode limits to the raw-object checkout and bounded capture from 0.4.0. It runs deterministic fake-agent actions and post-run checks against trusted local fixtures. It does not approve hostile repositories, real adapters, paid-model calls, or production credentials. The acceptance tests use disposable test-only credential values.

## Execution boundary

The runner validates task v1 and resolves the exact commit with sanitized Git plumbing. It checks the tree and sizes before materialization, initializes private bare metadata with an empty template, borrows source objects through a read-only alternate, and creates a detached worktree with `--no-checkout`. Batched raw blob reads verify object hashes and lengths before writing files. Private attributes disable filters and checkout conversions; hooks, fsmonitor, inherited Git configuration/environment, network protocols, and lazy fetch are disabled. Source Git configuration is not copied into the private repository, and captured blobs/indexes never enter the source repository. Git still parses the trusted source's metadata and objects. See [raw object reads](https://git-scm.com/docs/git-cat-file), [object alternates](https://git-scm.com/docs/gitrepository-layout), and [attribute precedence](https://git-scm.com/docs/gitattributes).

Local execution uses this worktree directly. Docker execution imports validated regular files into a runner-owned local-driver tmpfs volume with bounded reads, excluding the root `.git` entry. The container mounts only that volume at `/workspace`. The private metadata and original source stay on the host, with no writable host directory mounted into the agent. Source symlinks, submodules, unsupported modes, and nonportable paths are rejected. LFS pointers are not hydrated.

Docker requires a non-root Linux runner and a trusted local Engine at `/var/run/docker.sock`. The runner ignores Docker contexts and uses an empty per-attempt Docker configuration directory. It never mounts the engine socket or configuration into the container. Only a preinstalled `repository@sha256:<digest>` image is accepted; there are no implicit pulls. Images must provide `/usr/local/bin/node` version 22 or newer and must not declare volumes.

The fixed `linux-container-v2` policy is:

| Setting         | Value                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| Network         | `none`, loopback only, no published ports                                                      |
| Writable files  | `/workspace` tmpfs volume: 128 MiB allocated blocks, 12000 inodes; `/tmp`: 64 MiB, 4096 inodes |
| Root filesystem | Read-only                                                                                      |
| User            | Runner's nonzero Linux UID and runner GID                                                      |
| Privileges      | All capabilities dropped, no new privileges, private IPC, engine-default seccomp               |
| Resources       | 512 MiB memory with no extra swap, 1 CPU quota, 128 PIDs                                       |
| Lifecycle       | Start for each action/check, kill the whole container afterward                                |
| Environment     | Image defaults and explicit task additions, no inherited host environment                      |

## Storage decision

Ordinary Docker volumes do not impose a byte or inode quota. This backend uses the Linux local driver with `type=tmpfs`, `device=tmpfs`, and fixed `size`, `nr_inodes`, `uid`, `gid`, `mode=0700`, `nosuid`, and `nodev` options. It verifies those options and ownership labels, then verifies actual filesystem type, block capacity, and inode totals through Node `statfs`. Unsupported drivers/kernels/engines fail preparation, never fall back to a host directory. See [Docker's local tmpfs volume example](https://docs.docker.com/reference/cli/docker/volume/create/) and [the kernel's allocation/inode semantics](https://cdn.kernel.org/doc/html/latest/filesystems/tmpfs.html).

A separate non-root, offline, read-only-root holder mounts the workspace volume read-only with the same resource/privilege restrictions. Only fixed runner code executes there: a keeper and bounded export helpers. It never receives task commands, task environment additions, repository scripts, or host mounts. Preparation tests that holder writes fail with `EROFS`. The holder remains running while agent containers stop between commands, because unmounting tmpfs destroys its contents. Its original start timestamp is checked before execution/export; a lost or restarted holder cannot silently supply a reset workspace.

Kernel limits apply to allocated blocks and inodes, not logical file lengths. Files, directories, and some extended attributes consume inodes. Sparse truncation can create huge logical lengths without allocating blocks; export rejects such files before reading them. The existing logical 64 MiB workspace/16 MiB file limits are intentionally stricter than the live allocation limit. The 128 MiB live limit allows block rounding for small files and intermediate command writes, not a larger capture allowance. `/tmp` uses explicit inode limits as well as bytes, and resets on every agent restart. Other virtual device/proc/IPC mounts remain part of Docker's standard setup; these workspace quotas are not a claim that every virtual filesystem has this inode policy.

Export runs through the read-only holder only after the agent is quiescent. Fixed helpers stream directory iteration, refuse links/special files, use bounded descriptor reads, and return base64 regular files under fixed logical limits. The JSON transport is capped at 96 MiB. The host validates the payload, paths, modes, base64, aggregate bytes, entries, and metadata before exclusive file creation. It never unpacks tar from the daemon or copies a sparse logical length unchecked. Invalid entries leave a bounded partial export and available artifacts; the patch remains explicitly uncaptured. The complete raw volume remains mounted for inspection if export is incomplete. Later checks can change that retained raw volume; the partial host export records the capture point.

Successful export permits holder/volume removal after checks. Incomplete export retains both, records their generated names/ID and `storage.cleanup=retained`, and still removes the agent container. Ownership is revalidated before any resource removal. Retained holders consume bounded RAM/swap but there is no aggregate retained-resource quota or automatic cleanup/recovery. Inspect only recorded names and labels; save needed evidence before removing their last mount. A daemon restart, host reboot, or holder failure may lose raw tmpfs contents. `--keep-worktree` retains a complete host export, not a live volume after successful export.

Docker's virtual device, proc, and private IPC mounts still exist; read-only root does not make every virtual filesystem read-only. Tasks cannot override these settings or add mounts, networks, ports, capabilities, or Docker options. There is no credential broker or provider network grant yet. Digest pinning identifies bytes, not image trust or provenance. Docker documents [network-none behavior](https://docs.docker.com/engine/network/drivers/none/), [runtime restrictions](https://docs.docker.com/engine/containers/run/), and [the host/daemon trust boundary](https://docs.docker.com/engine/security/).

## Lifecycle and evidence

1. Prepare the raw private checkout, inspect the image, create and verify the owned quota volume/read-only holder/agent container, probe Node and mounted quotas, then import bounded files. The preparation phase has a 30-second deadline.
2. Route fake file writes and agent commands into that container. The runner owns the wall-clock and command budgets. File-write helpers do not count as agent commands.
3. Kill and inspect the agent container after every command, even if its parent process exited successfully. Restarting clears `/tmp` and descendants; only workspace files carry over through the holder. A stop failure refuses further commands and capture that requires a stopped workspace.
4. Once quiescent, export through the read-only holder under the entry, depth, per-file, total-byte, and transport limits. Reject symlinks, hard links, special files, metadata paths, and nonportable names. Materialize only validated files with exclusive writes. Build a raw index and capture patch/artifacts before checks under a separate 30-second capture deadline. Patches include ignored regular files and disable external diff, textconv, and rename detection. Oversized patches are rejected, never truncated.
5. Run checks under the same restrictions, with their own deadlines. Check writes do not enter the already-captured agent patch or artifacts.
6. Remove only the current attempt's agent container and, after complete export, its holder/volume. Persist an evidence snapshot, then remove disposable directories. Capture/cleanup failure, initial persistence failure, or `--keep-worktree` retains host workspace evidence. Incomplete export also retains raw holder/volume evidence. Agent containers are removed even when evidence is retained.

Result v5 records the fixed safety policy alongside requested image, resolved image ID and architecture, Node/Engine versions, UID/GID, container/storage policy, container ID/name, cleanup status, retained export path, and volume/holder identities, mounted-quota verification, and storage cleanup status. Fields unavailable after preparation failure are `null`. Ordered normalized events include `execution.prepared`. Failed and interrupted attempts use the same result contract. Comparison v4 retains this evidence and warns on stable runtime differences rather than on temporary container/holder/volume identities.

Execution/storage policy, requested image, and safety policy enter the shared-task digest. Local and Docker results therefore cannot share a comparison. Result v1/v2/v3/v4 and comparison v1/v2/v3 are archived and unchanged; current report generation does not migrate them. Scoring remains version 2. The README lists exact capture limits, Windows mode behavior, and patch replay commands.

## Limits that still matter

- Host Git still parses source config/metadata and objects, including read-only alternates. The source must remain available for the lifetime of the private checkout. Object-parser vulnerabilities, malicious source metadata, and concurrent host mutation are not contained by these changes. Repository files can contain secrets. Local agents/checks still have host-level filesystem authority.
- Docker shares the host kernel. Kernel/runtime vulnerabilities, a compromised daemon, a malicious image, or a hostile host user are outside this boundary. Docker socket access gives the host controller substantial authority. There is no VM isolation or cross-platform equivalent.
- Memory/CPU/PID settings constrain container processes, not runner work. Live tmpfs allocation/inode limits constrain agent/check workspace writes, and capture separately bounds logical bytes, file sizes, entries/depth, metadata, patches, and artifacts. Host Git preparation, private compressed objects, exports, and saved results have no hard filesystem quota. Local execution is unquotaed, and repeated retained holders/exports can exhaust aggregate host memory, swap, or disk. Tmpfs may use host swap; it is not encrypted secret storage or fsync-backed persistence.
- The agent deadline covers actions and command startup. Preparation/capture have separate deadlines, Git subprocesses have kill-on-timeout/cancellation, and filesystem loops checkpoint between operations. These cannot preempt stalled kernel calls, synchronous hashing/compression, or races with a hostile host user. Docker metadata/cleanup requests have individual 10-second limits; command startup/import/export use the remaining execution/phase deadline. Termination/cleanup can exceed deadlines; a stuck daemon can prevent cleanup. There is no total run/batch deadline.
- `SIGKILL`, power loss, and storage/daemon failure can leave containers, volumes, exports, or the last snapshot, and can lose raw tmpfs bytes. Inspect recorded owned resource identities and retained paths. There is no automatic recovery or resume.
- Redaction is a text backstop. Encoded, unknown, short, binary, or repository-committed credentials can escape it. Image environment defaults and task additions must already be trusted.
- Pinning the image does not pin host kernel, Engine, Git, hardware, filesystem behavior, or scheduling. Arbitrary commands remain potentially nondeterministic. Saved reports regenerate byte-identically; independent runs do not.

For these reasons, this backend remains limited to trusted repositories and commands. Stronger isolation must precede permission to run untrusted inputs.

## Verification and next gates

The README provides the exact image pull and `pnpm example:isolated` commands. The acceptance script creates trusted temporary repositories and verifies failed host reads/writes, denied host-service connections, no inherited test credential or Git/Docker metadata, non-root/capability restrictions, detached-child termination, time/command budgets, cancellation, redaction, evidence capture/scoring, actual workspace/temporary byte and inode `ENOSPC`, failed-command evidence with later checks, rejected symlink and oversized exports, forensic holder/volume retention, successful cleanup, repeated workspaces, and deterministic saved-report regeneration. It preserves results locally and never uploads them. Rejected-export fixtures retain their source repository so private metadata alternates remain inspectable. Focused Git/workspace/storage tests cover filters/hooks/ambient config, binary patch replay, unsupported entries, traversal/read limits, aggregate artifact caps, phase deadlines, weakened quotas, escaping export paths, and malformed export bytes. These targeted probes are not an adversarial security audit.

To verify the acceptance script without the `tsx` loader on Linux, run `pnpm exec tsc -p tsconfig.isolation.json`, then `node .agent-eval/isolation-tools/scripts/run-isolated-example.js`. This also supports a Windows checkout accessed from WSL, provided Node.js 22 or newer and Docker run inside Linux. Run the normal build first when checking the CLI.

Before a real adapter:

- Contain host Git parsing and quota host preparation/evidence and aggregate retained resources. Protect preparation/export from concurrent filesystem mutation.
- Review the threat model and image provenance, and add adversarial escape tests or VM isolation as required.
- Design a credential broker and controlled provider egress that cannot reach host/private services.
- Collect trustworthy provider usage and enforce token/cost budgets outside the provider process.
- Define adapter capabilities and toolchain identity without weakening the fixed backend silently.

Resume and a small versioned evaluation suite follow as separate roadmap work. No first-provider choice is implied by this implementation.
