import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { CONTAINER_POLICY } from "../src/execution-spec.js";
import { SAFETY_POLICY, SafetyDeadline } from "../src/safety.js";
import {
  assertStorageProbe,
  assertVolumePolicy,
  materializeStorageExport,
  STORAGE_EXPORT_SCRIPT,
  volumeOptions,
} from "../src/storage.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "./helpers/repository.js";

const execFileAsync = promisify(execFile);
afterEach(cleanupTestRepositories);

describe("bounded live storage", () => {
  it("rejects unbounded, wrong-driver, and unowned volume settings", () => {
    const name = "agent-eval-test-workspace";
    const volume = {
      Name: name,
      Driver: "local",
      Scope: "local",
      Labels: { "agent-eval-runner": name },
      Options: { type: "tmpfs", device: "tmpfs", o: volumeOptions(1001, 1001) },
    };
    expect(() => {
      assertVolumePolicy(volume, name, 1001, 1001);
    }).not.toThrow();
    for (const changed of [
      { ...volume, Driver: "another" },
      { ...volume, Labels: {} },
      { ...volume, Options: { ...volume.Options, type: "none" } },
      { ...volume, Options: { ...volume.Options, o: "size=0,nr_inodes=0" } },
    ])
      expect(() => {
        assertVolumePolicy(changed, name, 1001, 1001);
      }).toThrow("fixed storage policy");
  });

  it("fails closed unless both live mounts enforce the exact byte and inode limits", () => {
    const probe = {
      workspace: {
        type: 0x01021994,
        bsize: 4096,
        blocks: CONTAINER_POLICY.workspaceBytes / 4096,
        files: CONTAINER_POLICY.workspaceInodes,
      },
      temporary: {
        type: 0x01021994,
        bsize: 4096,
        blocks: CONTAINER_POLICY.temporaryBytes / 4096,
        files: CONTAINER_POLICY.temporaryInodes,
      },
    };
    expect(() => {
      assertStorageProbe(probe);
    }).not.toThrow();
    for (const mount of ["workspace", "temporary"] as const)
      for (const override of [
        { type: 1 },
        { blocks: 0 },
        { blocks: probe[mount].blocks * 2 },
        { files: 0 },
        { files: probe[mount].files + 1 },
      ])
        expect(() => {
          assertStorageProbe({
            ...probe,
            [mount]: { ...probe[mount], ...override },
          });
        }).toThrow("storage limits");
  });

  it("exports small evidence while refusing oversized files and limiting traversal", async () => {
    const { path } = await createTestRepository();
    const source = join(path, "export-source");
    const target = join(path, "export-target");
    await mkdir(source);
    await writeFile(join(source, "answer.txt"), "answer\n");
    await writeFile(join(source, "oversized.txt"), "x".repeat(33));
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      STORAGE_EXPORT_SCRIPT,
      JSON.stringify([source, { ...SAFETY_POLICY, fileBytes: 32 }]),
    ]);
    const input: unknown = JSON.parse(stdout);
    const errors = await materializeStorageExport(
      input,
      target,
      new SafetyDeadline(),
    );
    expect(errors.join(" ")).toContain("file byte limit");
    expect(await readFile(join(target, "answer.txt"), "utf8")).toBe("answer\n");
    await expect(readFile(join(target, "oversized.txt"))).rejects.toThrow();
    const limited = await execFileAsync(process.execPath, [
      "-e",
      STORAGE_EXPORT_SCRIPT,
      JSON.stringify([source, { ...SAFETY_POLICY, workspaceEntries: 1 }]),
    ]);
    expect(limited.stdout).toContain("entry limit");
  });

  it("does not follow symlinks or extract escaping paths", async () => {
    const { path } = await createTestRepository();
    const source = join(path, "links");
    await mkdir(source);
    await symlink(
      path,
      join(source, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      STORAGE_EXPORT_SCRIPT,
      JSON.stringify([source, SAFETY_POLICY]),
    ]);
    expect(stdout).toContain("single-link regular files");
    const errors = await materializeStorageExport(
      {
        files: [
          { path: "../escape.txt", mode: "100644", contentBase64: "eA==" },
        ],
        errors: [],
      },
      join(path, "safe"),
      new SafetyDeadline(),
    );
    expect(errors.join(" ")).toContain("Unsupported");
    await expect(readFile(join(path, "escape.txt"))).rejects.toThrow();
  });

  it("rejects malformed base64 and preserves valid later evidence", async () => {
    const { path } = await createTestRepository();
    const target = join(path, "validated");
    const errors = await materializeStorageExport(
      {
        files: [
          { path: "bad.txt", mode: "100644", contentBase64: "!!!" },
          { path: "answer.txt", mode: "100644", contentBase64: "eA==" },
        ],
        errors: [],
      },
      target,
      new SafetyDeadline(),
    );
    expect(errors.join(" ")).toContain("Invalid");
    expect(await readFile(join(target, "answer.txt"), "utf8")).toBe("x");
  });
});
