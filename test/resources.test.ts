import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runBatch } from "../src/batch.js";
import { readComparison } from "../src/comparison.js";
import { DockerExecution } from "../src/docker.js";
import { GitPreparation } from "../src/git-preparation.js";
import { createSnapshotCheckout } from "../src/object-snapshot.js";
import { parseResultSpec } from "../src/result.js";
import { runEvaluation } from "../src/runner.js";
import { parseTaskSpec, type TaskSpec } from "../src/spec.js";
import {
  assertExternalOutput,
  createResourcePool,
  readResourceInventory,
  reserveResources,
  resourceReservation,
  ResourceLease,
  ResourceAdmissionError,
} from "../src/resources.js";
import {
  RESOURCE_POLICY,
  parseResourceLedger,
  parseResourcePolicy,
  type ResourcePolicyInput,
} from "../src/resources-spec.js";
import { batchFor } from "./helpers/batch.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "./helpers/repository.js";

const execFileAsync = promisify(execFile);
afterEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanupTestRepositories);

function policy(slots = 1): ResourcePolicyInput {
  const reserved = resourceReservation();
  return {
    schemaVersion: "1",
    limits: {
      poolBytes: RESOURCE_POLICY.metadataBytes + slots * reserved.poolBytes,
      poolEntries:
        RESOURCE_POLICY.metadataEntries + slots * reserved.poolEntries,
      dockerVolumeBytes: slots * reserved.dockerVolumeBytes,
      dockerContainers: slots * reserved.dockerContainers,
      dockerVolumes: slots * reserved.dockerVolumes,
      records: 10,
    },
  };
}
async function fixture(input = policy()) {
  const repository = await createTestRepository();
  const root = join(repository.path, "pool");
  await createResourcePool(root, input);
  const task = parseTaskSpec({
    ...batchFor(repository).task,
    execution: { kind: "docker", image: `node@sha256:${"a".repeat(64)}` },
    adapter: { kind: "fake", actions: [] },
  });
  return { repository, root, task };
}

describe("resource admission and preservation", () => {
  it("validates versioned policies, claims new roots exclusively, and leaves inventory reads unchanged", async () => {
    for (const input of [
      { ...policy(), schemaVersion: "2" },
      { ...policy(), limits: { ...policy().limits, dockerVolumes: 1.5 } },
      { ...policy(), limits: { ...policy().limits, records: 1001 } },
      { ...policy(), deleteOldEvidence: true },
    ])
      expect(() => parseResourcePolicy(input)).toThrow("policy v1");
    const { repository, root } = await fixture();
    const before = await readFile(join(root, "inventory.json"));
    const first = await readResourceInventory(root);
    expect(await readResourceInventory(root)).toEqual(first);
    expect(await readFile(join(root, "inventory.json"))).toEqual(before);
    expect(await readdir(root)).toEqual([
      "attempts",
      "inventory.json",
      "pool.json",
    ]);
    const existing = join(repository.path, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "sentinel"), "preserve");
    await expect(createResourcePool(existing, policy())).rejects.toThrow();
    expect(await readFile(join(existing, "sentinel"), "utf8")).toBe("preserve");
  });

  it("checks every capacity dimension before creating an attempt", async () => {
    for (const key of [
      "poolBytes",
      "poolEntries",
      "dockerVolumeBytes",
      "dockerContainers",
      "dockerVolumes",
      "records",
    ] as const) {
      const input = policy();
      const needed =
        resourceReservation()[key] +
        (key === "poolBytes"
          ? RESOURCE_POLICY.metadataBytes
          : key === "poolEntries"
            ? RESOURCE_POLICY.metadataEntries
            : 0);
      // Record counts have a minimum of one; an existing record exhausts that dimension.
      if (key === "records") {
        input.limits.records = 1;
        const { root, task } = await fixture(input);
        await reserveResources(root, task, "first");
        await expect(
          reserveResources(root, task, "blocked"),
        ).rejects.toMatchObject({ decision: { reason: "capacity" } });
      } else {
        input.limits[key] = needed - 1;
        const { root, task } = await fixture(input);
        await expect(
          runEvaluation(task, { resourceRoot: root }),
        ).rejects.toMatchObject({ decision: { reason: "capacity" } });
        expect((await readResourceInventory(root)).ledger.records).toEqual([]);
        expect(await readdir(join(root, "attempts"))).toEqual([]);
      }
    }
  });

  it("serializes admission across real processes and keeps exited owners fully charged on restart", async () => {
    const { root, task } = await fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        execFileAsync(
          process.execPath,
          ["--import", "tsx", "test/helpers/resource-worker.ts", root],
          { timeout: 15000, windowsHide: true },
        ),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const inventory = await readResourceInventory(root);
    expect(inventory.ledger.records).toHaveLength(1);
    expect(inventory.ledger.records[0]).toMatchObject({
      state: "active",
      charged: resourceReservation(),
    });
    expect(inventory.lockPresent).toBe(false);
    const registered = inventory.ledger.records[0];
    if (registered === undefined) throw new Error("Missing worker reservation");
    expect(registered.docker.map(({ containerName }) => containerName)).toEqual(
      [
        `agent-eval-${registered.id}-agent`,
        `agent-eval-${registered.id}-preparation`,
      ],
    );
    await expect(
      reserveResources(root, task, "after-restart"),
    ).rejects.toMatchObject({ decision: { reason: "capacity" } });
    expect((await readResourceInventory(root)).ledger.records).toEqual(
      inventory.ledger.records,
    );
  });

  it("refuses stale locks and cancellation without reclaiming or changing evidence", async () => {
    const { root, task } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      reserveResources(root, task, "cancelled", controller.signal),
    ).rejects.toMatchObject({ decision: { reason: "cancelled" } });
    await writeFile(join(root, ".admission-lock"), "interrupted-owner", {
      flag: "wx",
    });
    const before = await readFile(join(root, "inventory.json"));
    expect((await readResourceInventory(root)).lockPresent).toBe(true);
    await expect(reserveResources(root, task, "blocked")).rejects.toMatchObject(
      { decision: { reason: "busy" } },
    );
    expect(await readFile(join(root, ".admission-lock"), "utf8")).toBe(
      "interrupted-owner",
    );
    expect(await readFile(join(root, "inventory.json"))).toEqual(before);
  });

  it("preserves failed snapshots and conservatively charges all ambiguous resources", async () => {
    const { root, task } = await fixture();
    const lease = await reserveResources(root, task, "failed");
    const snapshot = join(lease.storage.temporaryDirectory, "snapshot.txt");
    await writeFile(snapshot, "available evidence");
    await lease.preserveFailure("capture interrupted");
    const inventory = await readResourceInventory(root);
    expect(inventory.ledger.records[0]).toMatchObject({
      state: "retained",
      charged: resourceReservation(),
      error: "capture interrupted",
    });
    await expect(reserveResources(root, task, "later")).rejects.toMatchObject({
      decision: { reason: "capacity" },
    });
    expect(await readFile(snapshot, "utf8")).toBe("available evidence");
  });

  it("refuses altered ownership, escaping IDs, and aliased outputs into its inventory", async () => {
    const { repository, root, task } = await fixture();
    const parentAlias = join(repository.path, "parent-alias");
    await symlink(
      repository.path,
      parentAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasedRoot = join(parentAlias, "pool");
    const lease = await reserveResources(aliasedRoot, task, "ownership");
    expect(lease.storage.temporaryDirectory).toBe(
      join(
        await realpath(aliasedRoot),
        "attempts",
        lease.record.id,
        "temporary",
      ),
    );
    const alias = join(repository.path, "alias");
    await symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(readResourceInventory(alias)).rejects.toThrow(
      "real directory",
    );
    await expect(
      assertExternalOutput(root, join(alias, "inventory.json")),
    ).rejects.toThrow("outside the resource pool");
    await expect(
      assertExternalOutput(root, join(root, "missing", "result.json")),
    ).rejects.toThrow("outside the resource pool");
    const raw: unknown = JSON.parse(
      await readFile(join(root, "inventory.json"), "utf8"),
    );
    const ledger = parseResourceLedger(raw);
    const record = ledger.records[0];
    if (record?.docker[0] === undefined)
      throw new Error("Missing fixture record");
    expect(() =>
      parseResourceLedger({
        ...ledger,
        records: [{ ...record, id: "../escape" }],
      }),
    ).toThrow();
    record.docker[0].volumeName = "unrelated-production-volume";
    await writeFile(join(root, "inventory.json"), JSON.stringify(ledger));
    await expect(readResourceInventory(root)).rejects.toThrow("ownership");
    expect(await readdir(join(root, "attempts"))).toEqual([lease.record.id]);
  });

  it("keeps unknown storage charged and refuses admission rather than following a retained link", async () => {
    const { repository, root, task } = await fixture(policy(2));
    const lease = await reserveResources(root, task, "unknown-storage");
    await symlink(
      repository.path,
      join(lease.storage.temporaryDirectory, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await lease.preserveFailure("interrupted capture");
    const inventory = await readResourceInventory(root);
    expect(inventory.ledger.records[0]).toMatchObject({
      state: "retained",
      charged: resourceReservation(),
      measurement: { kind: "unknown" },
    });
    await expect(reserveResources(root, task, "blocked")).rejects.toMatchObject(
      { decision: { reason: "unresolved_inventory" } },
    );
    expect(await readFile(join(repository.path, "README.md"), "utf8")).toBe(
      "fixture\n",
    );
  });

  it("saves a canonical failed result, releases only verified unused capacity, and marks later batch attempts unstarted", async () => {
    const input = policy();
    input.limits.records = 1;
    const { repository, root, task } = await fixture(input);
    // No live Docker is needed to prove admission/result/batch transitions.
    vi.spyOn(GitPreparation.prototype, "prepare").mockRejectedValue(
      new Error("fixture preparation unavailable"),
    );
    const batch = batchFor(repository);
    if (task.execution?.kind !== "docker")
      throw new Error("Expected Docker fixture");
    batch.task.execution = task.execution;
    batch.configurations[0] = {
      id: "managed",
      adapter: task.adapter,
      repetitions: 2,
    };
    const directory = join(repository.path, "results");
    const index = await runBatch(batch, {
      outputDirectory: directory,
      resourceRoot: root,
    });
    expect(index.schemaVersion).toBe("2");
    expect(index.state).toBe("failed");
    expect(index.attempts).toMatchObject([
      { state: "finished" },
      { state: "not_started", reason: "resource_admission" },
    ]);
    const inventory = await readResourceInventory(root);
    const record = inventory.ledger.records[0];
    if (record === undefined) throw new Error("Missing finalized record");
    expect(record.state).toBe("completed");
    expect(record.charged.dockerVolumeBytes).toBe(0);
    expect(record.charged.dockerContainers).toBe(0);
    expect(record.charged.poolBytes).toBeLessThan(record.reserved.poolBytes);
    const saved: unknown = JSON.parse(
      await readFile(join(root, "attempts", record.id, "result.json"), "utf8"),
    );
    const result = parseResultSpec(saved);
    expect(result.status).toBe("failed");
    expect(result.commands).toEqual([]);
    expect(result.resourceAccounting).toMatchObject({
      kind: "managed",
      reservationId: record.id,
      reserved: resourceReservation(),
    });
    expect((await readComparison(directory)).summary).toMatchObject({
      finished: 1,
      failed: 1,
      notStarted: 1,
    });
    await writeFile(
      join(root, "attempts", record.id, "result.json"),
      "altered evidence\n",
    );
    expect((await readResourceInventory(root)).warnings.join(" ")).toContain(
      "Finalized result bytes changed",
    );
    await expect(
      reserveResources(root, task, "after-tampering"),
    ).rejects.toMatchObject({ decision: { reason: "unresolved_inventory" } });
  });

  it("keeps canonical evidence and the checkout when the caller's output cannot be persisted", async () => {
    const { repository, root, task } = await fixture();
    vi.spyOn(GitPreparation.prototype, "prepare").mockImplementation(
      async function (this: GitPreparation, source, revision) {
        if (this.storage === undefined)
          throw new Error("Expected managed storage");
        this.checkout = await createSnapshotCheckout(
          source,
          revision,
          this.storage.temporaryDirectory,
        );
        await writeFile(join(this.checkout.path, "answer.txt"), "preserved\n");
        return this.checkout;
      },
    );
    vi.spyOn(DockerExecution.prototype, "prepare").mockResolvedValue();
    vi.spyOn(DockerExecution.prototype, "synchronize").mockResolvedValue();
    vi.spyOn(GitPreparation.prototype, "capture").mockResolvedValue(
      "fixture patch\n",
    );
    const blocked = join(repository.path, "blocked-result.json");
    await mkdir(blocked);
    const noChecks: TaskSpec = { ...task, checks: [], artifacts: [] };
    await expect(
      runEvaluation(noChecks, { resourceRoot: root, outputPath: blocked }),
    ).rejects.toThrow();
    const inventory = await readResourceInventory(root);
    const record = inventory.ledger.records[0];
    if (record === undefined) throw new Error("Missing failed reservation");
    expect(record.state).toBe("retained");
    expect(record.charged).toEqual(record.reserved);
    const input: unknown = JSON.parse(
      await readFile(join(root, "attempts", record.id, "result.json"), "utf8"),
    );
    const result = parseResultSpec(input);
    expect(result.patch.content).toBe("fixture patch\n");
    expect(result.workspace.retained).toBe(true);
    if (result.workspace.path === null)
      throw new Error("Missing retained checkout");
    expect(
      await readFile(join(result.workspace.path, "answer.txt"), "utf8"),
    ).toBe("preserved\n");
    await expect(access(blocked)).resolves.toBeUndefined();
  });

  it("classifies post-admission lock contention as persistence failure, not an unstarted attempt", async () => {
    const { repository, root, task } = await fixture();
    vi.spyOn(GitPreparation.prototype, "prepare").mockRejectedValue(
      new Error("fixture preparation unavailable"),
    );
    vi.spyOn(ResourceLease.prototype, "finalize").mockRejectedValue(
      new ResourceAdmissionError(
        "busy",
        "fixture finalization lock contention",
      ),
    );
    const batch = batchFor(repository);
    if (task.execution?.kind !== "docker")
      throw new Error("Expected Docker fixture");
    batch.task.execution = task.execution;
    batch.configurations = [
      { id: "managed", adapter: task.adapter, repetitions: 2 },
    ];
    const index = await runBatch(batch, {
      outputDirectory: join(repository.path, "results"),
      resourceRoot: root,
    });
    expect(index.attempts).toMatchObject([
      { state: "persistence_failed" },
      { state: "not_started", reason: "persistence_error" },
    ]);
    const record = (await readResourceInventory(root)).ledger.records[0];
    if (record === undefined) throw new Error("Missing retained reservation");
    expect(record.state).toBe("retained");
    expect(record.charged).toEqual(record.reserved);
    const saved: unknown = JSON.parse(
      await readFile(join(root, "attempts", record.id, "result.json"), "utf8"),
    );
    expect(parseResultSpec(saved).events.at(-1)?.type).toBe("run.finished");
  });

  it("rejects unsupported execution and output/input budgets before reservation", async () => {
    const { root, task } = await fixture();
    await expect(
      reserveResources(
        root,
        { ...task, execution: { kind: "local" } },
        "local",
      ),
    ).rejects.toMatchObject({ decision: { reason: "unsupported" } });
    await expect(
      reserveResources(
        root,
        { ...task, prompt: "x".repeat(RESOURCE_POLICY.taskBytes + 1) },
        "input",
      ),
    ).rejects.toMatchObject({ decision: { reason: "capacity" } });
    await expect(
      reserveResources(
        root,
        {
          ...task,
          budgets: {
            ...task.budgets,
            maxOutputBytes: RESOURCE_POLICY.resultBytes,
          },
        },
        "output",
      ),
    ).rejects.toMatchObject({ decision: { reason: "capacity" } });
    expect((await readResourceInventory(root)).ledger.records).toEqual([]);
  });
});
