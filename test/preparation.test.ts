import { execFile } from "node:child_process";
import {
  access,
  link,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { PREPARATION_POLICY } from "../src/execution-spec.js";
import { sha256 } from "../src/identity.js";
import { snapshotObjects } from "../src/object-snapshot.js";
import {
  materializeTransfer,
  parsePreparationRequest,
  parsePreparationResponse,
} from "../src/preparation-protocol.js";
import { SafetyDeadline } from "../src/safety.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "./helpers/repository.js";

const execFileAsync = promisify(execFile);
afterEach(cleanupTestRepositories);

describe("isolated Git preparation transfers", () => {
  it("snapshots loose and packed objects without config, refs, hooks, or worktree files", async () => {
    const repository = await createTestRepository();
    for (const packed of [false, true]) {
      if (packed)
        await execFileAsync("git", ["-C", repository.path, "repack", "-ad"]);
      const target = join(
        repository.path,
        packed ? "packed-snapshot" : "loose-snapshot",
      );
      const snapshot = await snapshotObjects(
        repository.path,
        target,
        new SafetyDeadline(),
      );
      expect(snapshot.bytes).toBeGreaterThan(0);
      expect(snapshot.records.length).toBeGreaterThan(0);
      for (const record of snapshot.records) {
        expect(sha256(await readFile(join(target, record.path)))).toBe(
          record.sha256,
        );
        expect(record.path).toMatch(
          /^(?:[0-9a-f]{2}\/[0-9a-f]{38}|pack\/pack-[0-9a-f]{40}\.(?:pack|idx))$/u,
        );
      }
      await expect(access(join(target, "config"))).rejects.toThrow();
      await expect(access(join(target, "HEAD"))).rejects.toThrow();
      await expect(access(join(target, "README.md"))).rejects.toThrow();
    }
  });

  it("rejects external alternates instead of reading outside the object store", async () => {
    const { path } = await createTestRepository();
    await writeFile(
      join(path, ".git", "objects", "info", "alternates"),
      "../../host-private\n",
    );
    await expect(
      snapshotObjects(path, join(path, "snapshot"), new SafetyDeadline()),
    ).rejects.toThrow("External Git alternates");
    await expect(access(join(path, "snapshot"))).rejects.toThrow();
  });

  it("rejects linked object directories and hard-linked files", async () => {
    const { path } = await createTestRepository();
    const objects = join(path, ".git", "objects");
    const existing = await readdir(objects);
    const prefix = Array.from({ length: 256 }, (_, index) =>
      index.toString(16).padStart(2, "0"),
    ).find((name) => !existing.includes(name));
    if (prefix === undefined)
      throw new Error(
        "Fixture unexpectedly occupies every loose-object prefix",
      );
    const linked = join(objects, prefix);
    await symlink(
      path,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      snapshotObjects(
        path,
        join(path, "linked-snapshot"),
        new SafetyDeadline(),
      ),
    ).rejects.toThrow("rejects links");
    await unlink(linked);
    const pack = join(objects, "pack");
    const source = join(path, "not-an-object");
    await writeFile(source, "test");
    await link(source, join(pack, `pack-${"a".repeat(40)}.pack`));
    await expect(
      snapshotObjects(
        path,
        join(path, "hardlink-snapshot"),
        new SafetyDeadline(),
      ),
    ).rejects.toThrow("single-link regular files");
  });

  it("bounds opaque snapshot file bytes, aggregate bytes, entries, and cancellation", async () => {
    const { path } = await createTestRepository();
    for (const [label, limits] of [
      ["file", { ...PREPARATION_POLICY, snapshotFileBytes: 1 }],
      ["total", { ...PREPARATION_POLICY, snapshotBytes: 1 }],
      ["entries", { ...PREPARATION_POLICY, snapshotEntries: 1 }],
    ] as const)
      await expect(
        snapshotObjects(path, join(path, label), new SafetyDeadline(), limits),
      ).rejects.toThrow(/limit/u);
    const controller = new AbortController();
    controller.abort();
    await expect(
      snapshotObjects(
        path,
        join(path, "cancelled"),
        new SafetyDeadline(undefined, controller.signal),
      ),
    ).rejects.toThrow("cancelled");
  });

  it("treats malformed source configuration as inert, uncopied data", async () => {
    const { path } = await createTestRepository();
    await writeFile(
      join(path, ".git", "config"),
      "this is not Git configuration\n",
    );
    const snapshot = await snapshotObjects(
      path,
      join(path, "snapshot"),
      new SafetyDeadline(),
    );
    expect(snapshot.bytes).toBeGreaterThan(0);
    expect(snapshot.records.some(({ path }) => path.includes("config"))).toBe(
      false,
    );
  });

  it("validates protocol versions and refuses arbitrary commands or revisions", () => {
    expect(
      parsePreparationRequest({
        schemaVersion: "1",
        kind: "prepare",
        revision: "a".repeat(40),
      }).kind,
    ).toBe("prepare");
    for (const request of [
      { schemaVersion: "2", kind: "prepare", revision: "a".repeat(40) },
      { schemaVersion: "1", kind: "prepare", revision: "HEAD" },
      {
        schemaVersion: "1",
        kind: "prepare",
        revision: "a".repeat(40),
        command: "sh",
      },
    ])
      expect(() => parsePreparationRequest(request)).toThrow("request v1");
    expect(() =>
      parsePreparationResponse({
        schemaVersion: "2",
        kind: "patch",
        patch: "",
      }),
    ).toThrow("response v1");
  });

  it("rejects altered bytes, escaping paths, and case aliases before accepting a checkout", async () => {
    const { path } = await createTestRepository();
    const file = {
      path: "answer.txt",
      mode: "100644",
      contentBase64: "eA==",
      sha256: sha256("x"),
    } as const;
    await expect(
      materializeTransfer(
        [{ ...file, sha256: "a".repeat(64) }],
        join(path, "digest"),
        new SafetyDeadline(),
      ),
    ).rejects.toThrow("digest mismatch");
    await expect(
      materializeTransfer(
        [{ ...file, path: "../escape.txt" }],
        join(path, "escape"),
        new SafetyDeadline(),
      ),
    ).rejects.toThrow("Unsupported");
    await expect(
      materializeTransfer(
        [file, { ...file, path: "ANSWER.txt" }],
        join(path, "case"),
        new SafetyDeadline(),
      ),
    ).rejects.toThrow("Case-colliding");
    await expect(access(join(path, "escape.txt"))).rejects.toThrow();
    const valid = join(path, "valid");
    await materializeTransfer([file], valid, new SafetyDeadline());
    expect(await readFile(join(valid, "answer.txt"), "utf8")).toBe("x");
    expect(await readdir(valid)).toEqual(["answer.txt"]);
  });
});
