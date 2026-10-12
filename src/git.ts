import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { deflate } from "node:zlib";

import { SAFETY_POLICY, SafetyDeadline } from "./safety.js";
import {
  assertPortablePath,
  readBoundedFile,
  registerPath,
  scanWorkspace,
  type WorkspaceFile,
} from "./workspace.js";

const execFileAsync = promisify(execFile);
const compress = promisify(deflate);
// Git for Windows understands its POSIX null path, not Node's \\.\nul device path.
const gitNull = "/dev/null";
const gitOptions = [
  "-c",
  `core.hooksPath=${gitNull}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  `core.attributesFile=${gitNull}`,
  "-c",
  "core.autocrlf=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.allow=never",
];

function gitEnvironment(
  additions: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...additions,
  };
}

async function git(
  args: readonly string[],
  deadline: SafetyDeadline,
  options: {
    input?: Buffer;
    maxBytes?: number;
    env?: Readonly<Record<string, string>>;
  } = {},
): Promise<Buffer> {
  const pending = execFileAsync("git", [...gitOptions, ...args], {
    encoding: "buffer",
    env: gitEnvironment(options.env),
    timeout: deadline.remainingMs(),
    killSignal: "SIGKILL",
    ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
    maxBuffer: options.maxBytes ?? SAFETY_POLICY.gitMetadataBytes,
    windowsHide: true,
  });
  let inputError: Error | undefined;
  pending.child.stdin?.on("error", (error: Error) => {
    inputError = error;
  });
  pending.child.stdin?.end(options.input);
  const result = await pending;
  if (inputError !== undefined) throw inputError;
  return result.stdout;
}

export interface PreparedCheckout {
  readonly sourcePath: string;
  readonly rootPath: string;
  readonly gitPath: string;
  readonly path: string;
  readonly revision: string;
}
type GitFile = WorkspaceFile & { readonly oid: string };

function parseTree(contents: Buffer): GitFile[] {
  const text = contents.toString("utf8");
  if (!Buffer.from(text).equals(contents))
    throw new Error("Git tree paths must be valid UTF-8");
  const records = text.split("\0").filter((entry) => entry.length > 0);
  if (records.length > SAFETY_POLICY.workspaceEntries)
    throw new Error("Source workspace entry limit exceeded");
  const files: GitFile[] = [];
  const paths = new Map<string, string>();
  let bytes = 0;
  for (const record of records) {
    const match =
      /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40}) +(\d+|-)\t(.+)$/u.exec(
        record,
      );
    const mode = match?.[1];
    const oid = match?.[3];
    const path = match?.[5];
    if (mode === undefined || oid === undefined || path === undefined)
      throw new Error("Invalid Git tree entry");
    assertPortablePath(path);
    registerPath(path, paths);
    if (mode === "040000" && match?.[2] === "tree") continue;
    if ((mode !== "100644" && mode !== "100755") || match?.[2] !== "blob")
      throw new Error(
        `Source accepts regular files only; symlinks and submodules are unsupported: ${path}`,
      );
    const size = Number(match[4]);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > SAFETY_POLICY.fileBytes
    )
      throw new Error(`Source file byte limit exceeded: ${path}`);
    bytes += size;
    if (bytes > SAFETY_POLICY.workspaceBytes)
      throw new Error("Source workspace byte limit exceeded");
    files.push({ path, oid, bytes: size, mode });
  }
  return files;
}

async function materialize(
  checkout: PreparedCheckout,
  files: readonly GitFile[],
  deadline: SafetyDeadline,
): Promise<void> {
  const contents = await git(
    [`--git-dir=${checkout.gitPath}`, "cat-file", "--batch"],
    deadline,
    {
      input: Buffer.from(files.map(({ oid }) => `${oid}\n`).join("")),
      maxBytes: SAFETY_POLICY.workspaceBytes + SAFETY_POLICY.gitMetadataBytes,
    },
  );
  let offset = 0;
  for (const file of files) {
    deadline.remainingMs();
    const end = contents.indexOf(10, offset);
    if (
      end < offset ||
      contents.subarray(offset, end).toString() !==
        `${file.oid} blob ${String(file.bytes)}`
    )
      throw new Error(`Unexpected Git blob header: ${file.path}`);
    const start = end + 1;
    const content = contents.subarray(start, start + file.bytes);
    const oid = createHash("sha1")
      .update(`blob ${String(content.length)}\0`)
      .update(content)
      .digest("hex");
    if (
      content.length !== file.bytes ||
      oid !== file.oid ||
      contents[start + file.bytes] !== 10
    )
      throw new Error(
        `Git blob bytes do not match the declared object: ${file.path}`,
      );
    const path = join(checkout.path, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
    await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
    offset = start + file.bytes + 1;
  }
  if (offset !== contents.length)
    throw new Error("Unexpected extra Git blob output");
}

export async function prepareCheckout(
  sourcePath: string,
  requestedRevision: string,
  deadline = new SafetyDeadline(),
): Promise<PreparedCheckout> {
  if (!/^[0-9a-fA-F]{40}$/u.test(requestedRevision))
    throw new Error("Expected an exact 40-character Git revision");
  const source = await realpath(resolve(sourcePath));
  const revision = (
    await git(
      ["-C", source, "rev-parse", "--verify", `${requestedRevision}^{commit}`],
      deadline,
    )
  )
    .toString()
    .trim();
  if (revision.toLowerCase() !== requestedRevision.toLowerCase())
    throw new Error(
      `Git revision did not resolve exactly to ${requestedRevision}`,
    );
  const files = parseTree(
    await git(
      [
        "-C",
        source,
        "ls-tree",
        "--full-tree",
        "-r",
        "-t",
        "-l",
        "-z",
        revision,
      ],
      deadline,
    ),
  );
  const objects = (
    await git(
      [
        "-C",
        source,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ],
      deadline,
    )
  )
    .toString()
    .trim();
  if (/[\r\n\0]/u.test(objects) || !isAbsolute(objects))
    throw new Error("Unsupported source object directory path");
  const rootPath = await mkdtemp(join(tmpdir(), "agent-eval-worktree-"));
  const gitPath = join(rootPath, "git");
  const path = join(rootPath, "checkout");
  const checkout = { sourcePath: source, rootPath, gitPath, path, revision };
  try {
    const template = join(rootPath, "empty-template");
    await mkdir(template);
    await git(
      [
        "init",
        "--bare",
        "--object-format=sha1",
        `--template=${template}`,
        gitPath,
      ],
      deadline,
    );
    await mkdir(join(gitPath, "info"), { recursive: true });
    await writeFile(
      join(gitPath, "info", "attributes"),
      "* -filter -text -ident -working-tree-encoding\n",
    );
    await writeFile(
      join(gitPath, "objects", "info", "alternates"),
      `${process.platform === "win32" ? objects.replaceAll("\\", "/") : objects}\n`,
    );
    await writeFile(
      join(rootPath, "source.json"),
      JSON.stringify({ sourcePath: source }),
    );
    await git(
      [
        `--git-dir=${gitPath}`,
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        path,
        revision,
      ],
      deadline,
    );
    await git(["-C", path, "read-tree", revision], deadline);
    await materialize(checkout, files, deadline);
    await git(["-C", path, "update-index", "--refresh"], deadline);
    return checkout;
  } catch (error) {
    // No agent has started. Remove only this freshly created private checkout.
    await removeCheckout(checkout);
    throw error;
  }
}

// Used only by the isolated worker. Source config/hooks/refs never enter this repository.
export async function prepareObjectCheckout(
  objects: string,
  revision: string,
  deadline: SafetyDeadline,
): Promise<PreparedCheckout> {
  const source = await mkdtemp(join(tmpdir(), "agent-eval-object-source-"));
  const template = join(source, "empty-template");
  await mkdir(template);
  await git(
    [
      "init",
      "--bare",
      "--object-format=sha1",
      `--template=${template}`,
      source,
    ],
    deadline,
  );
  await writeFile(
    join(source, "objects", "info", "alternates"),
    `${objects}\n`,
  );
  return prepareCheckout(source, revision, deadline);
}

async function writeBlob(
  checkout: PreparedCheckout,
  content: Buffer,
): Promise<string> {
  const bytes = Buffer.concat([
    Buffer.from(`blob ${String(content.length)}\0`),
    content,
  ]);
  const oid = createHash("sha1").update(bytes).digest("hex");
  const directory = join(checkout.gitPath, "objects", oid.slice(0, 2));
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, oid.slice(2)), await compress(bytes), {
      flag: "wx",
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  }
  return oid;
}

export async function capturePatch(
  checkout: PreparedCheckout,
  deadline = new SafetyDeadline(),
): Promise<string> {
  const files = await scanWorkspace(checkout.path, deadline, {
    skipRootGit: true,
  });
  const baseline = parseTree(
    await git(
      [
        `--git-dir=${checkout.gitPath}`,
        "ls-tree",
        "--full-tree",
        "-r",
        "-t",
        "-l",
        "-z",
        checkout.revision,
      ],
      deadline,
    ),
  );
  const modes = new Map(baseline.map(({ path, mode }) => [path, mode]));
  const records: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const content = await readBoundedFile(
      checkout.path,
      file.path,
      Math.min(SAFETY_POLICY.fileBytes, SAFETY_POLICY.workspaceBytes - bytes),
      deadline,
    );
    bytes += content.length;
    const oid = await writeBlob(checkout, content);
    const mode =
      process.platform === "win32"
        ? (modes.get(file.path) ?? "100644")
        : file.mode;
    records.push(`${mode} blob ${oid}\t${file.path}\0`);
  }
  const args = [
    `--git-dir=${checkout.gitPath}`,
    `--work-tree=${checkout.path}`,
  ];
  const env = { GIT_INDEX_FILE: join(checkout.rootPath, "capture-index") };
  const input = Buffer.from(records.join(""));
  if (input.length > SAFETY_POLICY.gitMetadataBytes)
    throw new Error("Patch index metadata byte limit exceeded");
  await git([...args, "read-tree", "--empty"], deadline, { env });
  await git([...args, "update-index", "-z", "--index-info"], deadline, {
    env,
    input,
  });
  return (
    await git(
      [
        ...args,
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        checkout.revision,
        "--",
      ],
      deadline,
      { env, maxBytes: SAFETY_POLICY.patchBytes },
    )
  ).toString("utf8");
}

export async function assertCheckoutRoot(
  checkout: PreparedCheckout,
): Promise<void> {
  const temporaryRoot = await realpath(tmpdir());
  const root = await realpath(checkout.rootPath);
  const relation = relative(temporaryRoot, root);
  if (
    !basename(root).startsWith("agent-eval-worktree-") ||
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation) ||
    resolve(checkout.path) !== join(resolve(checkout.rootPath), "checkout") ||
    resolve(checkout.gitPath) !== join(resolve(checkout.rootPath), "git")
  )
    throw new Error(
      `Refusing to remove a non-disposable checkout: ${checkout.rootPath}`,
    );
}

export async function removeCheckout(
  checkout: PreparedCheckout,
): Promise<void> {
  await assertCheckoutRoot(checkout);
  await rm(checkout.rootPath, { recursive: true, force: true });
}
