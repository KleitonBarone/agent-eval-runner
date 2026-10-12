import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ExecutionBackend } from "./execution.js";
import { CONTAINER_POLICY, type ExecutionEvidence } from "./execution-spec.js";
import { assertCheckoutRoot, type PreparedCheckout } from "./git.js";
import { resolveInside } from "./paths.js";
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from "./process.js";
import type { Redactor } from "./redaction.js";
import { SafetyDeadline } from "./safety.js";
import { copyWorkspaceFiles, scanWorkspace } from "./workspace.js";

type DockerEvidence = Extract<ExecutionEvidence, { kind: "docker" }>;
const CONTROL_TIMEOUT_MS = 10_000;
const ImageInspection = Type.Object({
  Id: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
  Os: Type.Literal("linux"),
  Architecture: Type.String({ minLength: 1 }),
  Config: Type.Object({
    Volumes: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    ),
  }),
});

// Validate daemon-resolved settings before starting any task action.
export function assertContainerPolicy(
  input: unknown,
  workspace: string,
  uid: number,
  gid: number,
  imageId: string,
): void {
  const schema = Type.Object({
    Image: Type.Literal(imageId),
    Config: Type.Object({
      User: Type.Literal(`${String(uid)}:${String(gid)}`),
    }),
    HostConfig: Type.Object({
      NetworkMode: Type.Literal("none"),
      ReadonlyRootfs: Type.Literal(true),
      Privileged: Type.Literal(false),
      CapDrop: Type.Array(Type.Literal("ALL"), { minItems: 1, maxItems: 1 }),
      SecurityOpt: Type.Array(Type.Literal("no-new-privileges=true"), {
        minItems: 1,
        maxItems: 1,
      }),
      Memory: Type.Literal(CONTAINER_POLICY.memoryBytes),
      MemorySwap: Type.Literal(CONTAINER_POLICY.memoryBytes),
      NanoCpus: Type.Literal(CONTAINER_POLICY.cpus * 1_000_000_000),
      PidsLimit: Type.Literal(CONTAINER_POLICY.pids),
      PidMode: Type.Literal(""),
      IpcMode: Type.Literal("private"),
      Init: Type.Literal(true),
      Binds: Type.Union([
        Type.Null(),
        Type.Array(Type.String(), { maxItems: 0 }),
      ]),
      Tmpfs: Type.Object(
        {
          "/tmp": Type.Literal(
            `rw,noexec,nosuid,nodev,size=${String(CONTAINER_POLICY.temporaryBytes)},mode=1777`,
          ),
        },
        { additionalProperties: false },
      ),
    }),
    Mounts: Type.Array(
      Type.Object({
        Type: Type.Literal("bind"),
        Source: Type.Literal(workspace),
        Destination: Type.Literal("/workspace"),
        RW: Type.Literal(true),
        Propagation: Type.Literal("rprivate"),
      }),
      { minItems: 1, maxItems: 1 },
    ),
  });
  if (!Value.Check(schema, input))
    throw new Error(
      "Docker resolved settings do not match the fixed execution policy",
    );
}

// No arbitrary Docker options come from a task. Only this copied directory is mounted.
export function containerCreateArguments(
  image: string,
  name: string,
  workspace: string,
  uid: number,
  gid: number,
): string[] {
  if (uid <= 0 || !Number.isInteger(uid) || gid < 0 || !Number.isInteger(gid))
    throw new Error("Container execution requires a non-root Linux user");
  if (workspace.includes(","))
    throw new Error("Docker mount path contains a comma");
  return [
    "create",
    "--name",
    name,
    "--label",
    "agent-eval-runner=true",
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--memory",
    String(CONTAINER_POLICY.memoryBytes),
    "--memory-swap",
    String(CONTAINER_POLICY.memoryBytes),
    "--cpus",
    String(CONTAINER_POLICY.cpus),
    "--pids-limit",
    String(CONTAINER_POLICY.pids),
    "--ipc",
    "private",
    "--init",
    "--no-healthcheck",
    "--log-driver",
    "none",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${String(CONTAINER_POLICY.temporaryBytes)},mode=1777`,
    "--mount",
    `type=bind,source=${workspace},target=/workspace,bind-propagation=rprivate`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/usr/local/bin/node",
    image,
    "-e",
    "setInterval(() => {}, 1000)",
  ];
}

async function assertDisposable(path: string, prefix: string): Promise<void> {
  const root = await realpath(tmpdir());
  const target = await realpath(path);
  const relation = relative(root, target);
  if (
    !basename(target).startsWith(prefix) ||
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`)
  )
    throw new Error(`Refusing to remove a non-disposable directory: ${path}`);
}

export class DockerExecution implements ExecutionBackend {
  #root: string | undefined;
  #workspace: string | undefined;
  readonly #name = `agent-eval-${randomUUID()}`;
  #created = false;
  #quiescent = true;

  get workspace(): string {
    return this.#workspace ?? this.checkout.path;
  }
  get quiescent(): boolean {
    return this.#quiescent;
  }

  constructor(
    readonly checkout: PreparedCheckout,
    readonly image: string,
    readonly evidence: DockerEvidence,
    readonly redact: Redactor,
  ) {}

  async #docker(
    args: readonly string[],
    request?: Partial<ProcessRequest>,
  ): Promise<ProcessResult> {
    if (this.#root === undefined)
      throw new Error("Docker control directory is missing");
    return runProcess(
      {
        command: "docker",
        args: [
          "--host",
          "unix:///var/run/docker.sock",
          "--config",
          join(this.#root, "docker-config"),
          ...args,
        ],
        cwd: this.checkout.path,
        timeoutMs: CONTROL_TIMEOUT_MS,
        timeoutTermination: "check_timeout",
        maxOutputBytes: 256 * 1024,
        ...request,
      },
      this.redact,
    );
  }

  async #control(
    args: readonly string[],
    signal?: AbortSignal,
    deadline?: SafetyDeadline,
  ): Promise<string> {
    const result = await this.#docker(args, {
      ...(signal === undefined ? {} : { signal }),
      ...(deadline === undefined
        ? {}
        : { timeoutMs: Math.min(CONTROL_TIMEOUT_MS, deadline.remainingMs()) }),
    });
    if (
      result.exitCode !== 0 ||
      result.termination !== null ||
      result.error !== null
    )
      throw new Error(
        `Docker ${args[0] ?? "control"} failed: ${result.error ?? (result.stderr.length > 0 ? result.stderr : (result.termination ?? String(result.exitCode)))}`,
      );
    return result.stdout.trim();
  }

  async prepare(deadline = new SafetyDeadline()): Promise<void> {
    const signal = deadline.signal;
    if (process.platform !== "linux")
      throw new Error(
        "Docker execution requires a Linux runner and local Linux Docker Engine",
      );
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || uid === 0 || gid === undefined)
      throw new Error("Container execution requires a non-root Linux user");
    this.evidence.uid = uid;
    this.evidence.gid = gid;
    this.#root = await mkdtemp(join(tmpdir(), "agent-eval-isolated-"));
    await mkdir(join(this.#root, "docker-config"));
    this.#workspace = join(this.#root, "workspace");
    this.evidence.workspacePath = this.#workspace;
    const files = await scanWorkspace(this.checkout.path, deadline, {
      skipRootGit: true,
    });
    await copyWorkspaceFiles(
      this.checkout.path,
      this.#workspace,
      files,
      deadline,
    );
    const input: unknown = JSON.parse(
      await this.#control(
        ["image", "inspect", "--format", "{{json .}}", this.image],
        signal,
        deadline,
      ),
    );
    if (!Value.Check(ImageInspection, input))
      throw new Error(
        "Expected a locally installed Linux image identified by SHA-256",
      );
    if (
      input.Config.Volumes != null &&
      Object.keys(input.Config.Volumes).length > 0
    )
      throw new Error(
        "Container images with implicit volumes are not supported",
      );
    this.evidence.imageId = input.Id;
    this.evidence.architecture = input.Architecture;
    this.evidence.engineVersion = await this.#control(
      ["version", "--format", "{{.Server.Version}}"],
      signal,
      deadline,
    );
    this.evidence.containerName = this.#name;
    // Mark the generated name before create, so ambiguous create failures can be cleaned up.
    this.#created = true;
    this.evidence.cleanup = "pending";
    const id = await this.#control(
      containerCreateArguments(
        this.image,
        this.#name,
        this.#workspace,
        uid,
        gid,
      ),
      signal,
      deadline,
    );
    if (!/^[0-9a-f]{64}$/u.test(id))
      throw new Error("Docker returned an invalid container ID");
    this.evidence.containerId = id;
    const container: unknown = JSON.parse(
      await this.#control(
        ["inspect", "--format", "{{json .}}", this.#name],
        signal,
        deadline,
      ),
    );
    assertContainerPolicy(container, this.#workspace, uid, gid, input.Id);
    const runtime = await this.execute({
      command: "/usr/local/bin/node",
      args: ["-p", "process.version"],
      cwd: this.checkout.path,
      timeoutMs: Math.min(CONTROL_TIMEOUT_MS, deadline.remainingMs()),
      timeoutTermination: "check_timeout",
      maxOutputBytes: 1024,
      ...(signal === undefined ? {} : { signal }),
    });
    const node = runtime.stdout.trim();
    const version = /^v(\d+)\./u.exec(node);
    if (
      runtime.exitCode !== 0 ||
      runtime.termination !== null ||
      runtime.error !== null ||
      version?.[1] === undefined ||
      Number(version[1]) < 22
    )
      throw new Error(
        "Container image must provide Node.js 22 or newer at /usr/local/bin/node",
      );
    this.evidence.node = node;
  }

  async execute(request: ProcessRequest): Promise<ProcessResult> {
    if (!this.#created) throw new Error("Container has not been created");
    if (!this.#quiescent)
      throw new Error("Container did not stop after the previous command");
    const startedAt = performance.now();
    let result: ProcessResult = {
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
      termination: null,
      error: null,
    };
    this.#quiescent = false;
    try {
      const started = await this.#docker(["start", this.#name], {
        timeoutMs: request.timeoutMs,
        timeoutTermination: request.timeoutTermination,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const remaining = Math.floor(
        request.timeoutMs - (performance.now() - startedAt),
      );
      if (
        started.exitCode !== 0 ||
        started.termination !== null ||
        started.error !== null
      )
        result = started;
      else if (remaining <= 0)
        result = {
          ...started,
          exitCode: null,
          termination: request.timeoutTermination,
        };
      else {
        const cwd = relative(
          this.checkout.path,
          resolveInside(this.checkout.path, request.cwd),
        );
        const environment = Object.entries(request.env ?? {}).flatMap(
          ([key, value]) => ["--env", `${key}=${value}`],
        );
        result = await this.#docker(
          [
            "exec",
            "--interactive",
            "--workdir",
            join("/workspace", cwd),
            ...environment,
            this.#name,
            request.command,
            ...request.args,
          ],
          {
            timeoutMs: remaining,
            timeoutTermination: request.timeoutTermination,
            maxOutputBytes: request.maxOutputBytes,
            ...(request.input === undefined ? {} : { input: request.input }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
      }
    } catch (error) {
      result = {
        ...result,
        error: this.redact(
          error instanceof Error ? error.message : String(error),
        ),
      };
    } finally {
      // Killing only the Docker CLI leaves exec processes alive in the daemon.
      // Stop the whole container after every command, including successful ones.
      try {
        await this.#docker(["kill", this.#name]);
        if (
          (await this.#control([
            "inspect",
            "--format",
            "{{.State.Running}}",
            this.#name,
          ])) !== "false"
        ) {
          result = {
            ...result,
            error: "Container processes could not be stopped",
          };
        } else this.#quiescent = true;
      } catch (error) {
        result = {
          ...result,
          error: [
            result.error,
            this.redact(error instanceof Error ? error.message : String(error)),
          ]
            .filter(Boolean)
            .join("; "),
        };
      }
    }
    return {
      ...result,
      command: this.redact(request.command),
      args: request.args.map(this.redact),
      cwd: this.redact(request.cwd),
      durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    };
  }

  async writeFile(
    path: string,
    content: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"wall_clock" | "cancelled" | null> {
    const target = resolveInside("/workspace", path);
    const result = await this.execute({
      command: "/usr/local/bin/node",
      args: [
        "-e",
        "const fs=require('node:fs'); const path=require('node:path'); const [target,content]=JSON.parse(fs.readFileSync(0,'utf8')); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,content);",
      ],
      input: JSON.stringify([target, content]),
      cwd: this.checkout.path,
      timeoutMs,
      timeoutTermination: "wall_clock",
      maxOutputBytes: 4096,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      result.termination === "cancelled" ||
      result.termination === "wall_clock"
    )
      return result.termination;
    if (
      result.exitCode !== 0 ||
      result.error !== null ||
      result.termination !== null
    )
      throw new Error(
        `Fake file write failed: ${result.error ?? result.stderr}`,
      );
    return null;
  }

  async synchronize(deadline = new SafetyDeadline()): Promise<void> {
    if (this.#workspace === undefined) return;
    if (!this.#quiescent)
      throw new Error(
        "Cannot capture a workspace with running container processes",
      );
    // The container is stopped before traversal. Reject links and special files.
    const files = await scanWorkspace(this.#workspace, deadline);
    await assertCheckoutRoot(this.checkout);
    for (const entry of await readdir(this.checkout.path)) {
      if (entry !== ".git")
        await rm(join(this.checkout.path, entry), {
          recursive: true,
          force: true,
        });
    }
    await copyWorkspaceFiles(
      this.#workspace,
      this.checkout.path,
      files,
      deadline,
    );
  }

  async dispose(): Promise<void> {
    if (!this.#created) return;
    try {
      await this.#control(["rm", "--force", this.#name]);
      this.#created = false;
      this.#quiescent = true;
      this.evidence.cleanup = "removed";
    } catch (error) {
      this.evidence.cleanup = "failed";
      throw error;
    }
  }

  async removeWorkspace(): Promise<void> {
    if (this.#root === undefined) return;
    if (this.evidence.cleanup === "failed")
      throw new Error("Retaining workspace because container cleanup failed");
    await assertDisposable(this.#root, "agent-eval-isolated-");
    await rm(this.#root, { recursive: true, force: true });
    this.evidence.workspacePath = null;
  }
}
