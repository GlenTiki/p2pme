import { createServer } from "node:http";
import { cp, readFile, stat, mkdtemp, rm, symlink } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

export async function staticPreview() {
  const directory = await mkdtemp(join(tmpdir(), "p2pme-static-browser-"));
  const source = process.cwd();
  await cp("public", join(directory, "public"), { recursive: true });
  for (const name of ["web", "src", "skills", "node_modules"]) {
    await symlink(join(source, name), join(directory, name));
  }
  execFileSync(process.execPath, [resolve("scripts/build-web.mjs")], {
    cwd: directory,
  });
  const root = join(directory, "public");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    let file = resolve(root, "." + path);
    try {
      if (!file.startsWith(root + sep) && file !== root) throw Error("Path");
      if ((await stat(file)).isDirectory()) {
        if (!path.endsWith("/")) {
          response.writeHead(301, { Location: path + "/" });
          response.end();
          return;
        }
        file += "/index.html";
      }
      response.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html",
      );
      response.end(await readFile(file));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
