import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { capturePatch, prepareCheckout, removeCheckout } from "../src/git.js";
import { SAFETY_POLICY, SafetyDeadline } from "../src/safety.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "./helpers/repository.js";

const execFileAsync = promisify(execFile);
afterEach(cleanupTestRepositories);

function shellQuote(value: string): string {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "'\"'\"'")}'`;
}

describe("raw Git checkout and capture", () => {
  it("does not run source filters during preparation or patch capture", async () => {
    const repository = await createTestRepository({
      ".gitattributes": "*.txt filter=trip\n",
      "answer.txt": "raw source\n",
    });
    const marker = join(repository.path, "filter-ran");
    const script = join(repository.path, "filter.cjs");
    await writeFile(
      script,
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('transformed\\n'));`,
    );
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    for (const filter of ["smudge", "clean"])
      await execFileAsync("git", [
        "-C",
        repository.path,
        "config",
        `filter.trip.${filter}`,
        command,
      ]);
    const checkout = await prepareCheckout(
      repository.path,
      repository.revision,
    );
    try {
      expect(await readFile(join(checkout.path, "answer.txt"), "utf8")).toBe(
        "raw source\n",
      );
      await writeFile(join(checkout.path, "new.txt"), "raw change\n");
      expect(await capturePatch(checkout)).toContain("+raw change");
      await expect(access(marker)).rejects.toThrow();
      await expect(
        access(join(repository.path, ".git", "worktrees")),
      ).rejects.toThrow();
    } finally {
      await removeCheckout(checkout);
    }
  });

  it("ignores source hooks and ambient Git configuration/templates", async () => {
    const repository = await createTestRepository({
      ".gitattributes": "*.txt text eol=crlf ident\n",
      "answer.txt": "$Id$\n",
    });
    const hooks = join(repository.path, "hooks");
    const template = join(repository.path, "template");
    const marker = join(repository.path, "hook-ran");
    await mkdir(hooks);
    await mkdir(join(template, "hooks"), { recursive: true });
    const script = `#!/bin/sh\n${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`)}\n`;
    for (const directory of [hooks, join(template, "hooks")]) {
      await writeFile(join(directory, "post-checkout"), script);
      await chmod(join(directory, "post-checkout"), 0o755);
    }
    await execFileAsync("git", [
      "-C",
      repository.path,
      "config",
      "core.hooksPath",
      hooks,
    ]);
    const globalConfig = join(repository.path, "bad-global.conf");
    await writeFile(globalConfig, "[invalid config\n");
    const previousGlobal = process.env["GIT_CONFIG_GLOBAL"];
    const previousTemplate = process.env["GIT_TEMPLATE_DIR"];
    process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
    process.env["GIT_TEMPLATE_DIR"] = template;
    try {
      const checkout = await prepareCheckout(
        repository.path,
        repository.revision,
      );
      try {
        expect(await readFile(join(checkout.path, "answer.txt"), "utf8")).toBe(
          "$Id$\n",
        );
        await expect(access(marker)).rejects.toThrow();
      } finally {
        await removeCheckout(checkout);
      }
    } finally {
      if (previousGlobal === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = previousGlobal;
      if (previousTemplate === undefined)
        delete process.env["GIT_TEMPLATE_DIR"];
      else process.env["GIT_TEMPLATE_DIR"] = previousTemplate;
    }
  });

  it("captures raw binary changes, ignored files, removals, and executable modes", async () => {
    const repository = await createTestRepository({
      ".gitignore": "ignored.txt\n",
      "removed.txt": "old\n",
    });
    const checkout = await prepareCheckout(
      repository.path,
      repository.revision,
    );
    try {
      await rm(join(checkout.path, "removed.txt"));
      await writeFile(join(checkout.path, "ignored.txt"), "included\n");
      const binary = Buffer.from([0, 255, 1, 2, 3]);
      await writeFile(join(checkout.path, "binary.bin"), binary);
      await chmod(join(checkout.path, "binary.bin"), 0o755);
      const patch = await capturePatch(checkout);
      expect(patch).toContain("+included");
      expect(patch).toContain("deleted file mode");
      expect(patch).toContain("GIT binary patch");
      if (process.platform !== "win32")
        expect(patch).toContain("new file mode 100755");
      expect((await stat(join(checkout.path, "binary.bin"))).size).toBe(
        binary.length,
      );
      const replay = await prepareCheckout(
        repository.path,
        repository.revision,
      );
      try {
        const applying = execFileAsync("git", [
          "-c",
          "core.autocrlf=false",
          "-C",
          replay.path,
          "apply",
          "--binary",
          "--index",
          "-",
        ]);
        applying.child.stdin?.end(patch);
        await applying;
        expect(await readFile(join(replay.path, "binary.bin"))).toEqual(binary);
        expect(await readFile(join(replay.path, "ignored.txt"), "utf8")).toBe(
          "included\n",
        );
        await expect(
          access(join(replay.path, "removed.txt")),
        ).rejects.toThrow();
      } finally {
        await removeCheckout(replay);
      }
    } finally {
      await removeCheckout(checkout);
    }
  });

  it.each(["120000", "160000"])(
    "rejects unsupported Git mode %s before materialization",
    async (mode) => {
      const repository = await createTestRepository();
      const { stdout: oid } = await execFileAsync("git", [
        "-C",
        repository.path,
        "rev-parse",
        mode === "120000" ? "HEAD:README.md" : "HEAD",
      ]);
      await execFileAsync("git", [
        "-C",
        repository.path,
        "update-index",
        "--add",
        "--cacheinfo",
        `${mode},${oid.trim()},unsupported`,
      ]);
      await execFileAsync("git", [
        "-C",
        repository.path,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "unsupported tree",
      ]);
      const { stdout: revision } = await execFileAsync("git", [
        "-C",
        repository.path,
        "rev-parse",
        "HEAD",
      ]);
      await expect(
        prepareCheckout(repository.path, revision.trim()),
      ).rejects.toThrow("symlinks and submodules are unsupported");
    },
  );

  it("aborts an oversized patch rather than returning truncated evidence", async () => {
    const repository = await createTestRepository();
    const checkout = await prepareCheckout(
      repository.path,
      repository.revision,
    );
    try {
      await writeFile(
        join(checkout.path, "large.txt"),
        "line\n".repeat(Math.floor(SAFETY_POLICY.patchBytes / 5) + 1),
      );
      await expect(capturePatch(checkout)).rejects.toThrow("maxBuffer");
    } finally {
      await removeCheckout(checkout);
    }
  });

  it("rejects an expired preparation phase before invoking Git", async () => {
    const repository = await createTestRepository();
    await expect(
      prepareCheckout(
        repository.path,
        repository.revision,
        new SafetyDeadline(0),
      ),
    ).rejects.toThrow("deadline exceeded");
  });
});
