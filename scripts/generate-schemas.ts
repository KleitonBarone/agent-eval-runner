import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { format } from "prettier";

import { ResultSpecSchema } from "../src/result.js";
import { TaskSpecSchema } from "../src/spec.js";

const schemas = [
  ["schemas/task-v1.schema.json", TaskSpecSchema],
  ["schemas/result-v1.schema.json", ResultSpecSchema],
] as const;
const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Use --check or --write");
}

for (const [relativePath, schema] of schemas) {
  const path = resolve(relativePath);
  const expected = await format(JSON.stringify(schema), { parser: "json" });
  if (mode === "--write") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected, "utf8");
    continue;
  }
  const actual = await readFile(path, "utf8").catch(() => "");
  if (actual !== expected)
    throw new Error(`${relativePath} is stale. Run pnpm schemas:write.`);
}
