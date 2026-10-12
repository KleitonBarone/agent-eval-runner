import { execFile } from "node:child_process";
import { link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { captureArtifact } from "../src/artifacts.js";
import { SafetyDeadline } from "../src/safety.js";
import {
  assertPortablePath,
  readBoundedFile,
  registerPath,
  scanWorkspace,
  WORKSPACE_LIMITS,
} from "../src/workspace.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "./helpers/repository.js";

afterEach(cleanupTestRepositories);
const execFileAsync = promisify(execFile);

async function workspace() {
  const repository = await createTestRepository();
  const root = join(repository.path, "workspace");
  await mkdir(root);
  return { repository, root };
}

describe("bounded workspace evidence", () => {
  it("enforces aggregate bytes, per-file bytes, entry counts, and path depth", async () => {
    const { root } = await workspace();
    await writeFile(join(root, "a.txt"), "abc");
    await writeFile(join(root, "b.txt"), "def");
    const limited = (limits: Partial<typeof WORKSPACE_LIMITS>) =>
      scanWorkspace(root, new SafetyDeadline(), {
        limits: { ...WORKSPACE_LIMITS, ...limits },
      });
    expect(
      (await limited({ bytes: 6, entries: 2 })).map(({ path }) => path),
    ).toEqual(["a.txt", "b.txt"]);
    await expect(limited({ bytes: 5 })).rejects.toThrow("Workspace byte limit");
    await expect(limited({ fileBytes: 2 })).rejects.toThrow("file byte limit");
    await expect(limited({ entries: 1 })).rejects.toThrow("entry limit");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "c.txt"), "x");
    await expect(limited({ depth: 1 })).rejects.toThrow("over-depth");
  });

  it("bounds actual file reads and redaction expansion", async () => {
    const { root } = await workspace();
    await writeFile(join(root, "a.txt"), "12345");
    expect(await readBoundedFile(root, "a.txt", 5)).toEqual(
      Buffer.from("12345"),
    );
    await expect(readBoundedFile(root, "a.txt", 4)).rejects.toThrow(
      "byte limit",
    );
    await expect(
      captureArtifact(
        root,
        { path: "a.txt", mediaType: "text/plain" },
        5,
        () => "longer replacement",
      ),
    ).rejects.toThrow("Redacted artifact");
  });

  it("rejects symlinks, linked directories, and hard links before reads", async () => {
    const { repository, root } = await workspace();
    await symlink(repository.path, join(root, "alias"), "junction");
    await expect(readBoundedFile(root, "alias/README.md", 100)).rejects.toThrow(
      "link or non-directory",
    );
    await expect(scanWorkspace(root)).rejects.toThrow("single-link regular");
    await rm(join(root, "alias"));
    await writeFile(join(root, "file.txt"), "data");
    await link(join(root, "file.txt"), join(root, "hard.txt"));
    await expect(readBoundedFile(root, "hard.txt", 100)).rejects.toThrow(
      "single-link regular",
    );
  });

  it.runIf(process.platform === "linux")(
    "rejects FIFOs without opening or waiting on them",
    async () => {
      const { root } = await workspace();
      await execFileAsync("mkfifo", [join(root, "pipe")]);
      await expect(readBoundedFile(root, "pipe", 100)).rejects.toThrow(
        "single-link regular",
      );
    },
  );

  it("rejects metadata paths, platform aliases, traversal, and case collisions", () => {
    for (const path of [
      "../escape",
      ".git/config",
      "sub/.GIT/config",
      "CON",
      "file:stream",
      "a\\b",
      "a/",
      "file.",
      "a\u0000b",
    ])
      expect(() => {
        assertPortablePath(path);
      }).toThrow("workspace path");
    const paths = new Map<string, string>();
    registerPath("Dir/a", paths);
    expect(() => {
      registerPath("dir/b", paths);
    }).toThrow("Case-colliding");
  });

  it("checks phase deadlines and cancellation before filesystem work", async () => {
    const { root } = await workspace();
    await writeFile(join(root, "a.txt"), "x");
    await expect(scanWorkspace(root, new SafetyDeadline(0))).rejects.toThrow(
      "deadline exceeded",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      readBoundedFile(
        root,
        "a.txt",
        100,
        new SafetyDeadline(1000, controller.signal),
      ),
    ).rejects.toThrow("cancelled");
  });
});
