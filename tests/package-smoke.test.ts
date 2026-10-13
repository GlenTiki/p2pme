import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

const run = promisify(execFile);

async function browserConsumer(directory: string) {
  const bundle = await build({
    stdin: {
      contents: `import {beginPairing,connectHost,createInvitation} from '@glentiki/p2pme/browser'; window.packageReady = typeof beginPairing === 'function' && typeof connectHost === 'function' && createInvitation('Consumer').version === 1;`,
      resolveDir: directory,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
  });
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/app.js" ? "application/javascript" : "text/html",
    );
    response.end(
      request.url === "/app.js"
        ? bundle.outputFiles[0]!.text
        : '<script type="module" src="/app.js"></script>',
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No HTTP port");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction("window.packageReady === true");
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

it("installs a complete tarball and runs its public imports, declarations and CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2pme-package-"));
  const project = process.cwd();
  const options = {
    cwd: directory,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  };
  try {
    const packed = await run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        directory,
        "--cache",
        join(directory, "cache"),
      ],
      { ...options, cwd: project },
    );
    const manifest = JSON.parse(packed.stdout)[0] as {
      filename: string;
      files: { path: string }[];
    };
    const files = manifest.files.map((file) => file.path);
    expect(files).toEqual(
      expect.arrayContaining([
        "dist/index.js",
        "dist/node.js",
        "dist/browser.js",
        "dist/cli.js",
        "dist/browser.d.ts",
        "skills/p2pme/SKILL.md",
        "LICENSE",
        "README.md",
      ]),
    );
    expect(
      files.some((file) =>
        /^(src|tests|public|\.claude|\.env)(\/|$)/.test(file),
      ),
    ).toBe(false);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
        "--cache",
        join(directory, "cache"),
        join(directory, manifest.filename),
        "@types/node@22.20.5",
      ],
      options,
    );
    const installed = join(directory, "node_modules/@glentiki/p2pme");
    expect((await lstat(installed)).isSymbolicLink()).toBe(false);
    expect(
      await readFile(join(installed, "skills/p2pme/SKILL.md"), "utf8"),
    ).toBe(await readFile("skills/p2pme/SKILL.md", "utf8"));
    const result = await run(
      join(directory, "node_modules/.bin/p2pme"),
      ["--help"],
      options,
    );
    expect(result.stdout).toContain("p2pme host --workspace");
    const consumer = `
      import {createEnvelope} from '@glentiki/p2pme';
      import {createSessionLog,createHost,attachCodex} from '@glentiki/p2pme/node';
      import {beginPairing,connectHost} from '@glentiki/p2pme/browser';
      const log = await createSessionLog({sessionId:crypto.randomUUID()});
      try { await log.append(createEnvelope(log.sessionId,'chat.send',{text:'Installed consumer'}));
      if ((await log.get(0))?.type !== 'chat.send') throw Error('Missing installed log');
      if ([createHost,attachCodex,beginPairing,connectHost].some(fn=>typeof fn!=='function')) throw Error('Missing export');
      } finally { await log.close(); }`;
    await writeFile(join(directory, "consumer.mjs"), consumer);
    await run(process.execPath, ["consumer.mjs"], options);
    await writeFile(join(directory, "consumer.ts"), consumer);
    await run(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--types",
        "node",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "consumer.ts",
      ],
      options,
    );
    await browserConsumer(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
