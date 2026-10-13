import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await promisify(execFile)(process.execPath, [
  fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
  "-p",
  "tsconfig.build.json",
]);
await Promise.all([
  ...["index", "browser"].map((name) =>
    build({
      entryPoints: [`src/${name}.ts`],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      outfile: `dist/${name}.js`,
    }),
  ),
  ...["node", "cli"].map((name) =>
    build({
      entryPoints: [`src/${name}.ts`],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      outfile: `dist/${name}.js`,
    }),
  ),
]);
