import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ExecutionBackend } from "./execution.js";
import {
  CONTAINER_POLICY,
  PREPARATION_CONTAINER_POLICY,
  type ContainerPolicy,
  type DockerRuntime,
} from "./execution-spec.js";
import { assertCheckoutRoot, type PreparedCheckout } from "./git.js";
import { resolveInside } from "./paths.js";
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from "./process.js";
import type { Redactor } from "./redaction.js";
import { SAFETY_POLICY, SafetyDeadline } from "./safety.js";
import {
  copyWorkspaceFiles,
  readBoundedFile,
  scanWorkspace,
} from "./workspace.js";
import {
  assertStorageProbe,
  assertVolumePolicy,
  materializeStorageExport,
  volumeOptions,
  STORAGE_EXPORT_SCRIPT,
  STORAGE_IMPORT_SCRIPT,
  STORAGE_PROBE_SCRIPT,
  STORAGE_TRANSFER_BYTES,
} from "./storage.js";

export type DockerRole =
  | { readonly kind: "agent" }
  | { readonly kind: "git_preparer"; readonly input: string };
function rolePolicy(role: DockerRole): ContainerPolicy {
  return role.kind === "agent"
    ? CONTAINER_POLICY
    : PREPARATION_CONTAINER_POLICY;
}
const CONTROL_TIMEOUT_MS = 10_000;
const KEEPER_SCRIPT = "setInterval(() => {}, 1000)";
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
  volume: string,
  uid: number,
  gid: number,
  imageId: string,
  readOnly = false,
  role: DockerRole = { kind: "agent" },
): void {
  const policy = rolePolicy(role);
  const volumeMount = Type.Object({
    Type: Type.Literal("volume"),
    Source: Type.Literal(volume),
    Target: Type.Literal("/workspace"),
    ReadOnly: readOnly
      ? Type.Literal(true)
      : Type.Optional(Type.Literal(false)),
    VolumeOptions: Type.Object({ NoCopy: Type.Literal(true) }),
  });
  const effectiveVolume = Type.Object({
    Type: Type.Literal("volume"),
    Name: Type.Literal(volume),
    Driver: Type.Literal("local"),
    Destination: Type.Literal("/workspace"),
    RW: Type.Literal(!readOnly),
  });
  const mounts =
    role.kind === "git_preparer" && !readOnly
      ? Type.Tuple([
          volumeMount,
          Type.Object({
            Type: Type.Literal("bind"),
            Source: Type.Literal(role.input),
            Target: Type.Literal("/input"),
            ReadOnly: Type.Literal(true),
            BindOptions: Type.Object({ Propagation: Type.Literal("rprivate") }),
          }),
        ])
      : Type.Tuple([volumeMount]);
  const effectiveMounts =
    role.kind === "git_preparer" && !readOnly
      ? Type.Array(
          Type.Union([
            effectiveVolume,
            Type.Object({
              Type: Type.Literal("bind"),
              Source: Type.Literal(role.input),
              Destination: Type.Literal("/input"),
              RW: Type.Literal(false),
              Propagation: Type.Literal("rprivate"),
            }),
          ]),
          { minItems: 2, maxItems: 2 },
        )
      : Type.Tuple([effectiveVolume]);
  const schema = Type.Object({
    Image: Type.Literal(imageId),
    Config: Type.Object({
      User: Type.Literal(`${String(uid)}:${String(gid)}`),
      Labels: Type.Object({ "agent-eval-runner": Type.Literal(volume) }),
      Entrypoint: Type.Tuple([Type.Literal("/usr/local/bin/node")]),
      Cmd: Type.Tuple([Type.Literal("-e"), Type.Literal(KEEPER_SCRIPT)]),
      Healthcheck: Type.Object({ Test: Type.Tuple([Type.Literal("NONE")]) }),
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
      Memory: Type.Literal(policy.memoryBytes),
      MemorySwap: Type.Literal(policy.memoryBytes),
      NanoCpus: Type.Literal(CONTAINER_POLICY.cpus * 1_000_000_000),
      PidsLimit: Type.Literal(CONTAINER_POLICY.pids),
      PidMode: Type.Literal(""),
      IpcMode: Type.Literal("private"),
      Init: Type.Literal(true),
      LogConfig: Type.Object({ Type: Type.Literal("none") }),
      RestartPolicy: Type.Object({ Name: Type.Literal("no") }),
      Mounts: mounts,
      Binds: Type.Union([
        Type.Null(),
        Type.Array(Type.String(), { maxItems: 0 }),
      ]),
      Tmpfs: Type.Object(
        {
          "/tmp": Type.Literal(
            `rw,noexec,nosuid,nodev,size=${String(CONTAINER_POLICY.temporaryBytes)},nr_inodes=${String(CONTAINER_POLICY.temporaryInodes)},mode=1777`,
          ),
        },
        { additionalProperties: false },
      ),
    }),
    Mounts: effectiveMounts,
  });
  if (
    !Value.Check(schema, input) ||
    input.Mounts.filter((mount) => mount.Type === "volume").length !== 1
  )
    throw new Error(
      `Docker resolved settings do not match the fixed execution policy: ${[
        ...Value.Errors(schema, input),
      ]
        .slice(0, 5)
        .map(({ path, message }) => `${path}: ${message}`)
        .join("; ")}`,
    );
}

// Only a runner-owned quota volume is mounted. The holder never runs task code.
export function containerCreateArguments(
  image: string,
  name: string,
  volume: string,
  uid: number,
  gid: number,
  readOnly = false,
  role: DockerRole = { kind: "agent" },
): string[] {
  const policy = rolePolicy(role);
  if (uid <= 0 || !Number.isInteger(uid) || gid < 0 || !Number.isInteger(gid))
    throw new Error("Container execution requires a non-root Linux user");
  if (!/^agent-eval-[a-zA-Z0-9-]+$/u.test(volume))
    throw new Error("Invalid owned Docker volume name");
  if (role.kind === "git_preparer" && role.input.includes(","))
    throw new Error("Preparation mount path contains a comma");
  return [
    "create",
    "--name",
    name,
    "--label",
    `agent-eval-runner=${volume}`,
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
    String(policy.memoryBytes),
    "--memory-swap",
    String(policy.memoryBytes),
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
    `/tmp:rw,noexec,nosuid,nodev,size=${String(CONTAINER_POLICY.temporaryBytes)},nr_inodes=${String(CONTAINER_POLICY.temporaryInodes)},mode=1777`,
    "--mount",
    `type=volume,source=${volume},target=/workspace,volume-nocopy${readOnly ? ",readonly" : ""}`,
    ...(role.kind === "git_preparer" && !readOnly
      ? [
          "--mount",
          `type=bind,source=${role.input},target=/input,readonly,bind-propagation=rprivate`,
        ]
      : []),
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/usr/local/bin/node",
    image,
    "-e",
    KEEPER_SCRIPT,
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
  readonly #volume = `${this.#name}-workspace`;
  readonly #holder = `${this.#name}-holder`;
  #created = false;
  #volumeCreated = false;
  #holderCreated = false;
  #holderStartedAt: string | undefined;
  #prepared = false;
  #exportComplete = false;
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
    readonly evidence: DockerRuntime,
    readonly redact: Redactor,
    readonly role: DockerRole = { kind: "agent" },
  ) {}

  async #docker(
    args: readonly string[],
    request?: Partial<ProcessRequest>,
    redact = this.redact,
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
      redact,
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
      result.error !== null ||
      result.stdoutTruncated ||
      result.stderrTruncated
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
    await mkdir(this.#workspace);
    const files =
      this.role.kind === "agent"
        ? await scanWorkspace(this.checkout.path, deadline, {
            skipRootGit: true,
          })
        : [];
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
    // Creating an existing volume is not exclusive. Refuse it before creation,
    // then verify ownership/options before mounting or removing it.
    const existing = await this.#docker(["volume", "inspect", this.#volume]);
    if (existing.exitCode === 0)
      throw new Error("Owned storage name already exists");
    this.evidence.storage.volumeName = this.#volume;
    this.evidence.storage.holderName = this.#holder;
    this.evidence.storage.cleanup = "pending";
    this.#volumeCreated = true;
    await this.#control(
      [
        "volume",
        "create",
        "--driver",
        "local",
        "--label",
        `agent-eval-runner=${this.#volume}`,
        "--opt",
        "type=tmpfs",
        "--opt",
        "device=tmpfs",
        "--opt",
        `o=${volumeOptions(uid, gid, rolePolicy(this.role))}`,
        this.#volume,
      ],
      signal,
      deadline,
    );
    await this.#verifyVolume(deadline);
    this.#holderCreated = true;
    const holderId = await this.#control(
      containerCreateArguments(
        this.image,
        this.#holder,
        this.#volume,
        uid,
        gid,
        true,
        this.role,
      ),
      signal,
      deadline,
    );
    if (!/^[0-9a-f]{64}$/u.test(holderId))
      throw new Error("Docker returned an invalid holder ID");
    this.evidence.storage.holderId = holderId;
    const holder: unknown = JSON.parse(
      await this.#control(
        ["inspect", "--format", "{{json .}}", this.#holder],
        signal,
        deadline,
      ),
    );
    assertContainerPolicy(
      holder,
      this.#volume,
      uid,
      gid,
      input.Id,
      true,
      this.role,
    );
    await this.#control(["start", this.#holder], signal, deadline);
    this.#holderStartedAt = await this.#control(
      ["inspect", "--format", "{{.State.StartedAt}}", this.#holder],
      signal,
      deadline,
    );
    await this.#control(
      [
        "exec",
        this.#holder,
        "/usr/local/bin/node",
        "-e",
        "require('node:assert/strict').throws(()=>require('node:fs').writeFileSync('/workspace/.holder-write-probe','x'),{code:'EROFS'})",
      ],
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
        this.#volume,
        uid,
        gid,
        false,
        this.role,
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
    assertContainerPolicy(
      container,
      this.#volume,
      uid,
      gid,
      input.Id,
      false,
      this.role,
    );
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
    const probe = await this.execute({
      command: "/usr/local/bin/node",
      args: ["-e", STORAGE_PROBE_SCRIPT],
      cwd: this.checkout.path,
      timeoutMs: deadline.remainingMs(),
      timeoutTermination: "check_timeout",
      maxOutputBytes: 4096,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      probe.exitCode !== 0 ||
      probe.termination !== null ||
      probe.error !== null ||
      probe.stdoutTruncated
    )
      throw new Error(
        `Storage verification failed: ${probe.error ?? probe.stderr}`,
      );
    const mounted: unknown = JSON.parse(probe.stdout);
    assertStorageProbe(mounted, rolePolicy(this.role));
    this.evidence.storage.verified = true;
    if (this.role.kind === "git_preparer") {
      this.#prepared = true;
      return;
    }
    const imported = [];
    let importBytes = 0;
    for (const file of files) {
      const content = await readBoundedFile(
        this.checkout.path,
        file.path,
        Math.min(
          SAFETY_POLICY.fileBytes,
          SAFETY_POLICY.workspaceBytes - importBytes,
        ),
        deadline,
      );
      importBytes += content.length;
      imported.push({
        path: file.path,
        mode: file.mode,
        contentBase64: content.toString("base64"),
      });
    }
    const importInput = JSON.stringify(imported);
    if (Buffer.byteLength(importInput) > STORAGE_TRANSFER_BYTES)
      throw new Error("Workspace import transport limit exceeded");
    const importedResult = await this.execute({
      command: "/usr/local/bin/node",
      args: ["-e", STORAGE_IMPORT_SCRIPT],
      input: importInput,
      cwd: this.checkout.path,
      timeoutMs: deadline.remainingMs(),
      timeoutTermination: "check_timeout",
      maxOutputBytes: 4096,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      importedResult.exitCode !== 0 ||
      importedResult.termination !== null ||
      importedResult.error !== null
    )
      throw new Error(
        `Quota workspace import failed: ${importedResult.error ?? importedResult.stderr}`,
      );
    this.#prepared = true;
  }

  async #verifyVolume(deadline?: SafetyDeadline): Promise<void> {
    const input: unknown = JSON.parse(
      await this.#control(
        ["volume", "inspect", "--format", "{{json .}}", this.#volume],
        deadline?.signal,
        deadline,
      ),
    );
    assertVolumePolicy(
      input,
      this.#volume,
      this.evidence.uid ?? -1,
      this.evidence.gid ?? -1,
      rolePolicy(this.role),
    );
  }

  async #removeOwnedContainer(name: string, id: string | null): Promise<void> {
    const input: unknown = JSON.parse(
      await this.#control(["inspect", "--format", "{{json .}}", name]),
    );
    const ownership = Type.Object({
      Name: Type.Literal(`/${name}`),
      Id:
        id === null
          ? Type.String({ pattern: "^[0-9a-f]{64}$" })
          : Type.Literal(id),
      Config: Type.Object({
        Labels: Type.Object({
          "agent-eval-runner": Type.Literal(this.#volume),
        }),
      }),
    });
    if (!Value.Check(ownership, input))
      throw new Error(
        "Refusing to remove a container without matching ownership",
      );
    await this.#control(["rm", "--force", name]);
  }

  async execute(
    request: ProcessRequest,
    redact: Redactor = this.redact,
  ): Promise<ProcessResult> {
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
    const holder = await this.#docker(
      [
        "inspect",
        "--format",
        "{{.State.StartedAt}} {{.State.Running}}",
        this.#holder,
      ],
      {
        timeoutMs: Math.min(CONTROL_TIMEOUT_MS, request.timeoutMs),
        timeoutTermination: request.timeoutTermination,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    if (
      holder.exitCode !== 0 ||
      holder.error !== null ||
      holder.termination !== null ||
      holder.stdout.trim() !== `${this.#holderStartedAt ?? "missing"} true`
    ) {
      result = {
        ...holder,
        error:
          holder.error ??
          "Storage holder is unavailable; refusing a potentially reset workspace",
      };
      return {
        ...result,
        command: this.redact(request.command),
        args: request.args.map(this.redact),
        cwd: this.redact(request.cwd),
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      };
    }
    this.#quiescent = false;
    try {
      const started = await this.#docker(["start", this.#name], {
        timeoutMs: Math.max(
          1,
          Math.floor(request.timeoutMs - (performance.now() - startedAt)),
        ),
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
          redact,
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
    const holderState = await this.#control(
      [
        "inspect",
        "--format",
        "{{.State.StartedAt}} {{.State.Running}}",
        this.#holder,
      ],
      undefined,
      deadline,
    );
    if (holderState !== `${this.#holderStartedAt ?? "missing"} true`)
      throw new Error(
        "Storage holder stopped or restarted; refusing potentially reset evidence",
      );
    // Use the read-only holder. Never restart agent processes or unpack a tar export.
    const exported = await this.#docker(
      [
        "exec",
        this.#holder,
        "/usr/local/bin/node",
        "-e",
        STORAGE_EXPORT_SCRIPT,
        JSON.stringify(["/workspace", SAFETY_POLICY]),
      ],
      {
        timeoutMs: deadline.remainingMs(),
        maxOutputBytes: STORAGE_TRANSFER_BYTES,
      },
      (value) => value,
    );
    if (
      exported.exitCode !== 0 ||
      exported.termination !== null ||
      exported.error !== null ||
      exported.stdoutTruncated
    )
      throw new Error(
        `Bounded workspace export failed: ${this.redact(exported.error ?? exported.stderr)}`,
      );
    const output: unknown = JSON.parse(exported.stdout);
    const exportErrors = await materializeStorageExport(
      output,
      this.#workspace,
      deadline,
    );
    if (exportErrors.length > 0)
      throw new Error(
        `Incomplete workspace export: ${exportErrors.join("; ")}`,
      );
    const files = await scanWorkspace(this.#workspace, deadline);
    this.#exportComplete = true;
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

  finishExport(): void {
    this.#exportComplete = true;
  }

  async dispose(): Promise<void> {
    try {
      if (this.#created) {
        await this.#removeOwnedContainer(this.#name, this.evidence.containerId);
        this.#created = false;
        this.#quiescent = true;
        this.evidence.cleanup = "removed";
      }
    } catch (error) {
      this.evidence.cleanup = "failed";
      this.evidence.storage.cleanup = "failed";
      throw error;
    }
    if (this.#prepared && !this.#exportComplete) {
      this.evidence.storage.cleanup = "retained";
      return;
    }
    try {
      if (this.#holderCreated) {
        await this.#removeOwnedContainer(
          this.#holder,
          this.evidence.storage.holderId,
        );
        this.#holderCreated = false;
      }
      if (this.#volumeCreated) {
        await this.#verifyVolume();
        await this.#control(["volume", "rm", this.#volume]);
        this.#volumeCreated = false;
        this.evidence.storage.cleanup = "removed";
      }
    } catch (error) {
      this.evidence.storage.cleanup = "failed";
      throw error;
    }
  }

  async removeWorkspace(): Promise<void> {
    if (this.#root === undefined) return;
    if (
      this.evidence.cleanup === "failed" ||
      this.evidence.storage.cleanup === "failed" ||
      this.evidence.storage.cleanup === "retained"
    )
      throw new Error("Retaining workspace because container cleanup failed");
    await assertDisposable(this.#root, "agent-eval-isolated-");
    await rm(this.#root, { recursive: true, force: true });
    this.evidence.workspacePath = null;
  }
}
