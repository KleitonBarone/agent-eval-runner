import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { canonicalJson, comparisonDigest, sha256 } from "./identity.js";
import { jsonDocument, writeAtomic } from "./persistence.js";
import type { ResultSpec } from "./result.js";
import { collectTaskSecrets, createRedactor } from "./redaction.js";
import { SAFETY_POLICY, SafetyDeadline } from "./safety.js";
import type { TaskSpec } from "./spec.js";
import { readBoundedFile } from "./workspace.js";
import {
  CONTAINER_POLICY,
  PREPARATION_CONTAINER_POLICY,
} from "./execution-spec.js";
import {
  RESOURCE_POLICY,
  RESOURCE_RESERVATION,
  ResourcePoolSchema,
  parseResourceLedger,
  parseResourcePolicy,
  type AdmissionDecision,
  type AttemptStorage,
  type DockerResource,
  type ResourceAccounting,
  type ResourceCapacity,
  type ResourceIdentity,
  type ResourceInventory,
  type ResourceLedger,
  type ResourcePolicyInput,
  type ResourceRecord,
} from "./resources-spec.js";

const keys = [
  "poolBytes",
  "poolEntries",
  "dockerVolumeBytes",
  "dockerContainers",
  "dockerVolumes",
  "records",
] as const;
const OwnerSchema = Type.Object(
  { poolId: Type.String(), id: Type.String() },
  { additionalProperties: false },
);

export class ResourceAdmissionError extends Error {
  readonly decision: AdmissionDecision;
  constructor(reason: AdmissionDecision["reason"], message: string) {
    super(message);
    this.decision = {
      schemaVersion: "1",
      kind: "resource_admission_denied",
      reason,
      message: message.slice(0, 4096),
    };
  }
}

function zero(): ResourceCapacity {
  return {
    poolBytes: 0,
    poolEntries: 0,
    dockerVolumeBytes: 0,
    dockerContainers: 0,
    dockerVolumes: 0,
    records: 0,
  };
}
export function resourceReservation() {
  return { ...RESOURCE_RESERVATION };
}
function total(ledger: ResourceLedger): ResourceCapacity {
  const used = {
    ...zero(),
    poolBytes: RESOURCE_POLICY.metadataBytes,
    poolEntries: RESOURCE_POLICY.metadataEntries,
  };
  for (const record of ledger.records)
    for (const key of keys) {
      used[key] += record.charged[key];
      if (!Number.isSafeInteger(used[key]))
        throw new Error("Resource accounting overflow");
    }
  return used;
}
function names(id: string, role: DockerResource["role"]): DockerResource {
  const containerName = `agent-eval-${id}-${role}`;
  return {
    role,
    containerName,
    holderName: `${containerName}-holder`,
    volumeName: `${containerName}-workspace`,
    containerId: null,
    holderId: null,
    containerCleanup: "reserved",
    storageCleanup: "reserved",
  };
}
function dockerCharge(resources: readonly DockerResource[]): ResourceCapacity {
  const charge = zero();
  for (const resource of resources) {
    if (!["removed", "not_created"].includes(resource.containerCleanup))
      charge.dockerContainers += 1;
    if (!["removed", "not_created"].includes(resource.storageCleanup)) {
      charge.dockerContainers += 1;
      charge.dockerVolumes += 1;
      charge.dockerVolumeBytes +=
        resource.role === "agent"
          ? CONTAINER_POLICY.workspaceBytes
          : PREPARATION_CONTAINER_POLICY.workspaceBytes;
    }
  }
  return charge;
}
function validateLedger(ledger: ResourceLedger): void {
  if (
    ledger.records.length > ledger.limits.records ||
    new Set(ledger.records.map(({ id }) => id)).size !== ledger.records.length
  )
    throw new Error("Invalid resource record identities/count");
  for (const record of ledger.records) {
    if (canonicalJson(record.reserved) !== canonicalJson(resourceReservation()))
      throw new Error("Invalid resource reservation");
    if (new Set(record.docker.map(({ role }) => role)).size !== 2)
      throw new Error("Invalid Docker resource roles");
    for (const resource of record.docker) {
      const expected = names(record.id, resource.role);
      if (
        resource.containerName !== expected.containerName ||
        resource.holderName !== expected.holderName ||
        resource.volumeName !== expected.volumeName
      )
        throw new Error("Docker resource ownership does not match reservation");
      for (const id of [resource.containerId, resource.holderId])
        if (id !== null && !/^[0-9a-f]{64}$/u.test(id))
          throw new Error("Invalid recorded Docker ID");
    }
    const minimum: ResourceCapacity =
      record.state === "active"
        ? { ...record.reserved }
        : {
            ...dockerCharge(record.docker),
            records: 1,
            poolBytes:
              record.state === "retained" ? record.reserved.poolBytes : 0,
            poolEntries:
              record.state === "retained" ? record.reserved.poolEntries : 0,
          };
    if (record.measurement.kind === "measured") {
      minimum.poolBytes = Math.max(
        minimum.poolBytes,
        record.measurement.poolBytes,
      );
      minimum.poolEntries = Math.max(
        minimum.poolEntries,
        record.measurement.poolEntries,
      );
    } else if (record.state === "completed")
      throw new Error("Completed record has unknown storage");
    if (
      record.state === "completed" &&
      (minimum.dockerContainers !== 0 ||
        minimum.dockerVolumes !== 0 ||
        record.resultSha256 === null)
    )
      throw new Error(
        "Completed record still has unresolved resources/evidence",
      );
    for (const key of keys)
      if (record.charged[key] < minimum[key])
        throw new Error(
          "Resource record undercharges its reservation/evidence",
        );
  }
  total(ledger);
}

async function ownedDirectory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Resource directory is not a real directory");
  if (process.platform !== "win32" && process.getuid?.() !== stat.uid)
    throw new Error("Resource directory belongs to another user");
  return realpath(path);
}
async function readJson(
  root: string,
  path: string,
  bytes: number,
): Promise<unknown> {
  return JSON.parse(
    (await readBoundedFile(root, path, bytes)).toString("utf8"),
  );
}
async function openPool(rootPath: string) {
  const root = await ownedDirectory(resolve(rootPath));
  const pool = await readJson(root, "pool.json", 16 * 1024);
  if (!Value.Check(ResourcePoolSchema, pool))
    throw new Error("Invalid resource pool v1");
  const ledger = parseResourceLedger(
    await readJson(root, "inventory.json", RESOURCE_POLICY.ledgerBytes),
  );
  if (
    pool.poolId !== ledger.poolId ||
    ledger.policySha256 !== sha256(canonicalJson(pool.policy)) ||
    canonicalJson(pool.policy.limits) !== canonicalJson(ledger.limits)
  )
    throw new Error("Resource pool policy/identity changed");
  validateLedger(ledger);
  await ownedDirectory(join(root, "attempts"));
  return { root, pool, ledger };
}
async function saveLedger(root: string, ledger: ResourceLedger): Promise<void> {
  validateLedger(ledger);
  const bytes = jsonDocument(ledger);
  if (Buffer.byteLength(bytes) > RESOURCE_POLICY.ledgerBytes)
    throw new Error("Resource ledger byte limit exceeded");
  await writeAtomic(join(root, "inventory.json"), bytes);
}
async function present(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    },
  );
}
async function warnings(
  root: string,
  ledger: ResourceLedger,
): Promise<string[]> {
  const problems: string[] = [];
  const deadline = new SafetyDeadline();
  let entries = 0;
  const top = await opendir(root);
  for await (const entry of top) {
    deadline.remainingMs();
    if (++entries > RESOURCE_POLICY.metadataEntries) {
      problems.push("Resource pool metadata entry limit exceeded");
      break;
    }
    if (
      !["pool.json", "inventory.json", "attempts", ".admission-lock"].includes(
        entry.name,
      )
    )
      problems.push(`Unregistered pool entry: ${entry.name}`);
  }
  const expected = new Set(ledger.records.map(({ id }) => id));
  const attempts = await opendir(join(root, "attempts"));
  entries = 0;
  for await (const entry of attempts) {
    deadline.remainingMs();
    if (++entries > 1000) {
      problems.push("Resource attempt directory limit exceeded");
      break;
    }
    if (!expected.has(entry.name)) {
      problems.push(`Unregistered attempt directory: ${entry.name}`);
      continue;
    }
    const owner = await readJson(
      root,
      `attempts/${entry.name}/owner.json`,
      4096,
    ).catch(() => null);
    if (
      !Value.Check(OwnerSchema, owner) ||
      owner.poolId !== ledger.poolId ||
      owner.id !== entry.name
    )
      problems.push(`Attempt ownership cannot be verified: ${entry.name}`);
    expected.delete(entry.name);
  }
  for (const id of expected)
    problems.push(`Recorded attempt directory is unavailable: ${id}`);
  for (const record of ledger.records) {
    deadline.remainingMs();
    if (record.state !== "active" && record.measurement.kind === "unknown")
      problems.push(`Unresolved storage measurement: ${record.id}`);
    if (record.resultSha256 !== null) {
      const saved = await readBoundedFile(
        root,
        `attempts/${record.id}/result.json`,
        RESOURCE_POLICY.resultBytes,
        deadline,
      ).catch(() => null);
      if (saved === null || sha256(saved) !== record.resultSha256)
        problems.push(
          `Finalized result bytes changed or are unavailable: ${record.id}`,
        );
    }
  }
  return problems;
}

// No retries, stale-lock removal, PID-based reclamation, or evidence deletion.
async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const path = join(root, ".admission-lock");
  try {
    await writeFile(path, token, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new ResourceAdmissionError(
        "busy",
        "Resource pool is locked; inspect it before retrying",
      );
    throw error;
  }
  const outcome = await Promise.resolve()
    .then(action)
    .then(
      (value) => ({ kind: "value", value }) as const,
      (error: unknown) => ({ kind: "error", error }) as const,
    );
  try {
    const saved = await readBoundedFile(root, ".admission-lock", 128);
    if (saved.toString() !== token)
      throw new Error("Resource lock ownership changed; refusing removal");
    await unlink(path);
  } catch (error) {
    if (outcome.kind === "error")
      throw new AggregateError(
        [outcome.error, error],
        "Resource operation and lock cleanup failed; reservation is retained",
      );
    throw error;
  }
  if (outcome.kind === "error") throw outcome.error;
  return outcome.value;
}

export async function createResourcePool(
  rootPath: string,
  input: ResourcePolicyInput,
): Promise<ResourceInventory> {
  const policy = parseResourcePolicy(input);
  const root = resolve(rootPath);
  // Claim a new directory only. Existing directories and evidence are never adopted.
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "attempts"), { mode: 0o700 });
  const poolId = randomUUID();
  await writeFile(
    join(root, "pool.json"),
    jsonDocument({ schemaVersion: "1", poolId, policy }),
    { flag: "wx", mode: 0o600 },
  );
  await saveLedger(root, {
    schemaVersion: "1",
    poolId,
    policySha256: sha256(canonicalJson(policy)),
    limits: policy.limits,
    records: [],
  });
  return readResourceInventory(root);
}
export async function readResourceInventory(
  rootPath: string,
): Promise<ResourceInventory> {
  const { root, ledger } = await openPool(rootPath);
  return {
    schemaVersion: "1",
    root,
    ownership: "registered_only",
    ledger,
    charged: total(ledger),
    lockPresent: await present(join(root, ".admission-lock")),
    warnings: await warnings(root, ledger),
  };
}
export async function readResourceIdentity(
  rootPath: string,
): Promise<ResourceIdentity> {
  const { ledger } = await openPool(rootPath);
  return {
    kind: "managed",
    policyVersion: RESOURCE_POLICY.version,
    limits: ledger.limits,
  };
}
export async function assertExternalOutput(
  rootPath: string,
  output: string,
): Promise<void> {
  const root = await realpath(rootPath);
  let ancestor = resolve(output);
  const missing: string[] = [];
  while (!(await present(ancestor))) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error("Output has no existing filesystem ancestor");
    ancestor = parent;
  }
  const target = join(await realpath(ancestor), ...missing);
  const relation = relative(
    process.platform === "win32" ? root.toLowerCase() : root,
    process.platform === "win32" ? target.toLowerCase() : target,
  );
  if (
    relation === "" ||
    (!isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${sep}`))
  )
    throw new ResourceAdmissionError(
      "unsupported",
      "Caller output must be outside the resource pool; its canonical evidence is saved inside",
    );
}

function checkTask(task: TaskSpec): void {
  if (task.execution?.kind !== "docker")
    throw new ResourceAdmissionError(
      "unsupported",
      "Resource-managed execution currently requires Docker; local execution is unquotaed",
    );
  const taskBytes = Buffer.byteLength(jsonDocument(task));
  if (
    taskBytes > RESOURCE_POLICY.taskBytes ||
    task.adapter.actions.length > RESOURCE_POLICY.taskItems ||
    task.checks.length > RESOURCE_POLICY.taskItems
  )
    throw new ResourceAdmissionError(
      "capacity",
      "Task exceeds resource-managed input limits",
    );
  const commandCount =
    Math.min(
      task.budgets.maxCommands,
      task.adapter.actions.filter(({ kind }) => kind === "runCommand").length,
    ) + task.checks.length;
  const worstResult =
    Buffer.byteLength(
      createRedactor(collectTaskSecrets(task))(jsonDocument(task)),
    ) *
      8 +
    commandCount * task.budgets.maxOutputBytes * 12 +
    SAFETY_POLICY.patchBytes * 6 +
    SAFETY_POLICY.totalArtifactBytes * 2 +
    4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(worstResult) ||
    worstResult > RESOURCE_POLICY.resultBytes
  )
    throw new ResourceAdmissionError(
      "capacity",
      "Task output budgets exceed the reserved result capacity",
    );
}

export async function reserveResources(
  rootPath: string,
  task: TaskSpec,
  attemptId: string,
  signal?: AbortSignal,
): Promise<ResourceLease> {
  checkTask(task);
  if (signal?.aborted === true)
    throw new ResourceAdmissionError(
      "cancelled",
      "Resource admission cancelled before execution",
    );
  try {
    const { root } = await openPool(rootPath);
    return await withLock(root, async () => {
      const { ledger } = await openPool(root);
      const problems = await warnings(root, ledger);
      if (problems.length > 0)
        throw new ResourceAdmissionError(
          "unresolved_inventory",
          problems.join("; ").slice(0, 4096),
        );
      if (signal?.aborted === true)
        throw new ResourceAdmissionError(
          "cancelled",
          "Resource admission cancelled before execution",
        );
      const reserved = resourceReservation();
      const used = total(ledger);
      for (const key of keys)
        if (
          used[key] > ledger.limits[key] ||
          reserved[key] > ledger.limits[key] - used[key]
        )
          throw new ResourceAdmissionError(
            "capacity",
            `Resource pool ${key} capacity exhausted; existing evidence is preserved`,
          );
      const id = randomUUID();
      const identity: ResourceIdentity = {
        kind: "managed",
        policyVersion: RESOURCE_POLICY.version,
        limits: ledger.limits,
      };
      const record: ResourceRecord = {
        id,
        state: "active",
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
        attemptId: createRedactor(collectTaskSecrets(task))(attemptId),
        taskSha256: sha256(canonicalJson(task)),
        comparisonSha256: comparisonDigest(task, identity),
        reserved,
        charged: { ...reserved },
        measurement: {
          kind: "unknown",
          reason:
            "Attempt has not finalized; its entire reservation remains charged",
        },
        docker: [names(id, "agent"), names(id, "preparation")],
        resultSha256: null,
        error: null,
      };
      ledger.records.push(record);
      // Persist possible resource names before any directory/container creation.
      await saveLedger(root, ledger);
      const directory = join(root, "attempts", id);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        join(directory, "owner.json"),
        jsonDocument({ poolId: ledger.poolId, id }),
        { flag: "wx", mode: 0o600 },
      );
      await mkdir(join(directory, "temporary"), { mode: 0o700 });
      return new ResourceLease(root, ledger, record);
    });
  } catch (error) {
    if (error instanceof ResourceAdmissionError) throw error;
    throw new ResourceAdmissionError(
      "inventory_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function measure(directory: string) {
  let poolBytes = 0;
  let poolEntries = 1;
  const deadline = new SafetyDeadline();
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 64)
      throw new Error("Resource measurement depth limit exceeded");
    const opened = await opendir(path);
    for await (const entry of opened) {
      deadline.remainingMs();
      if (++poolEntries > RESOURCE_POLICY.poolEntries)
        throw new Error("Resource measurement entry limit exceeded");
      const child = join(path, entry.name);
      const stat = await lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        await visit(child, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) {
        poolBytes += stat.size;
        if (
          !Number.isSafeInteger(poolBytes) ||
          poolBytes > RESOURCE_POLICY.poolBytes
        )
          throw new Error("Resource measurement byte limit exceeded");
      } else
        throw new Error("Resource measurement refuses links/special files");
    }
  };
  try {
    await visit(await ownedDirectory(directory), 0);
    return { kind: "measured", poolBytes, poolEntries } as const;
  } catch (error) {
    return {
      kind: "unknown",
      reason: (error instanceof Error ? error.message : String(error)).slice(
        0,
        4096,
      ),
    } as const;
  }
}

export class ResourceLease {
  readonly storage: AttemptStorage;
  readonly accounting: Extract<ResourceAccounting, { kind: "managed" }>;
  constructor(
    readonly root: string,
    readonly ledger: ResourceLedger,
    readonly record: ResourceRecord,
  ) {
    const directory = join(root, "attempts", record.id);
    this.storage = {
      temporaryDirectory: join(directory, "temporary"),
      agentName: names(record.id, "agent").containerName,
      preparationName: names(record.id, "preparation").containerName,
    };
    this.accounting = {
      kind: "managed",
      policyVersion: RESOURCE_POLICY.version,
      limits: ledger.limits,
      poolId: ledger.poolId,
      reservationId: record.id,
      reserved: record.reserved,
      resultBytesLimit: RESOURCE_POLICY.resultBytes,
      resultPath: join(directory, "result.json"),
    };
  }
  async persist(result: ResultSpec): Promise<void> {
    const content = jsonDocument(result);
    if (Buffer.byteLength(content) > RESOURCE_POLICY.resultBytes)
      throw new Error(
        "Managed result byte limit exceeded; retaining original workspace and reservation",
      );
    await writeAtomic(this.accounting.resultPath, content);
  }
  async #update(
    change: (record: ResourceRecord) => Promise<void>,
  ): Promise<void> {
    await withLock(this.root, async () => {
      const { ledger } = await openPool(this.root);
      if (ledger.poolId !== this.accounting.poolId)
        throw new Error("Resource pool ownership changed");
      const record = ledger.records.find(({ id }) => id === this.record.id);
      if (
        record?.state !== "active" ||
        canonicalJson(record.reserved) !== canonicalJson(this.record.reserved)
      )
        throw new Error("Resource reservation ownership/state changed");
      const owner = await readJson(
        this.root,
        `attempts/${record.id}/owner.json`,
        4096,
      );
      if (
        !Value.Check(OwnerSchema, owner) ||
        owner.id !== record.id ||
        owner.poolId !== ledger.poolId
      )
        throw new Error("Attempt directory ownership changed");
      await change(record);
      await saveLedger(this.root, ledger);
    });
  }
  async finalize(result: ResultSpec): Promise<void> {
    await this.#update(async (record) => {
      if (result.execution.kind !== "docker")
        throw new Error("Missing managed Docker evidence");
      for (const resource of record.docker) {
        const runtime =
          resource.role === "agent"
            ? result.execution
            : result.execution.preparation;
        if (
          (runtime.containerName !== null &&
            runtime.containerName !== resource.containerName) ||
          (runtime.storage.volumeName !== null &&
            runtime.storage.volumeName !== resource.volumeName) ||
          (runtime.storage.holderName !== null &&
            runtime.storage.holderName !== resource.holderName)
        )
          throw new Error("Docker evidence ownership changed");
        resource.containerId = runtime.containerId;
        resource.holderId = runtime.storage.holderId;
        resource.containerCleanup = runtime.cleanup;
        resource.storageCleanup = runtime.storage.cleanup;
      }
      const saved = await readBoundedFile(
        this.root,
        `attempts/${record.id}/result.json`,
        RESOURCE_POLICY.resultBytes,
      );
      if (saved.toString() !== jsonDocument(result))
        throw new Error("Managed result bytes changed before finalization");
      record.resultSha256 = sha256(saved);
      record.measurement = await measure(
        join(this.root, "attempts", record.id),
      );
      const docker = dockerCharge(record.docker);
      record.state =
        result.workspace.retained ||
        docker.dockerContainers !== 0 ||
        docker.dockerVolumes !== 0 ||
        record.measurement.kind === "unknown"
          ? "retained"
          : "completed";
      record.charged = {
        ...docker,
        records: 1,
        poolBytes:
          record.state === "retained"
            ? record.reserved.poolBytes
            : record.measurement.kind === "measured"
              ? record.measurement.poolBytes
              : record.reserved.poolBytes,
        poolEntries:
          record.state === "retained"
            ? record.reserved.poolEntries
            : record.measurement.kind === "measured"
              ? record.measurement.poolEntries
              : record.reserved.poolEntries,
      };
    });
  }
  async preserveFailure(message: string): Promise<void> {
    await this.#update(async (record) => {
      record.state = "retained";
      record.error = message.slice(0, 4096);
      record.measurement = await measure(
        join(this.root, "attempts", record.id),
      );
      // Ambiguous failures keep all planned Docker resources charged as well.
      record.charged = { ...record.reserved };
    });
  }
}
