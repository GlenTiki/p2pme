import { copyFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: { app: "web/main.ts", host: "web/host.ts" },
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outdir: "public",
});
await copyFile("skills/p2pme/SKILL.md", "public/skill.md");
