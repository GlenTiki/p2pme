import { copyFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["web/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: "public/app.js",
});
await copyFile("skills/p2pme/SKILL.md", "public/skill.md");
