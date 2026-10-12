import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["scripts/preparation-worker.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  write: false,
});
const output = result.outputFiles[0];
if (output === undefined || result.outputFiles.length !== 1)
  throw new Error("Expected one self-contained preparation worker");
for (const path of [
  "dist/preparation-worker.mjs",
  ".agent-eval/isolation-tools/dist/preparation-worker.mjs",
]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output.contents);
}
