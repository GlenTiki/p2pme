import { describe, expect, it } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli-main.js";
import { cliErrorMessage } from "../src/cli-error.js";
import {
  approvalText,
  createTerminalApprover,
  terminalJson,
} from "../src/cli-consent.js";
import type { ControlRequest } from "../src/local-client.js";

function fixture() {
  let output = "";
  const requests: ControlRequest[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });
  return {
    requests,
    output: () => output,
    options: {
      input: Readable.from(["private-invitation"]),
      output: stream,
      request: async (_socket: string, request: ControlRequest) => {
        requests.push(request);
        return {
          id: request.id,
          ok: true as const,
          result: { completed: true },
        };
      },
    },
  };
}
describe("local CLI", () => {
  it("closes the host on SIGHUP and removes all shutdown listeners", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const listeners = signals.map((signal) => process.listeners(signal));
    let closes = 0;
    let handlesHangup = false;
    const running = runCli(["host", "--workspace", tmpdir()], {
      ...fixture().options,
      daemon: async () => {
        setImmediate(() => {
          handlesHangup =
            process.listenerCount("SIGHUP") > listeners[2]!.length;
          process.emit("SIGHUP");
          if (!handlesHangup) process.emit("SIGTERM");
        });
        return {
          host: { hostId: crypto.randomUUID() },
          close: async () => {
            closes++;
          },
        };
      },
    });
    await running;
    expect(handlesHangup).toBe(true);
    expect(closes).toBe(1);
    for (const [index, signal] of signals.entries())
      expect(process.listeners(signal)).toEqual(listeners[index]);
  });
  it("reuses one terminal across aborted approvals until host shutdown", async () => {
    let opens = 0;
    let closes = 0;
    const input = new PassThrough();
    const terminal = createTerminalApprover(() => {
      opens++;
      return {
        input,
        output: new PassThrough(),
        close() {
          closes++;
          input.destroy();
        },
      };
    });
    const approval = {
      label: "test",
      principal: "human-device" as const,
      scopes: ["sessions:list" as const],
      profileIds: ["codex"],
      workspace: "/workspace",
      sessionAccess: "registered" as const,
      expiresAt: "2026-10-13T20:00:00Z",
    };
    for (let index = 0; index < 6; index++) {
      const abort = new AbortController();
      const question = terminal.confirm(approval, abort.signal);
      abort.abort();
      await expect(question).rejects.toThrow();
    }
    const question = terminal.confirm(approval, new AbortController().signal);
    input.write("approve\n");
    expect(await question).toBe(true);
    expect(opens).toBe(1);
    expect(closes).toBe(0);
    await terminal.close();
    expect(closes).toBe(1);
  });
  it("propagates daemon shutdown failure through the CLI error path", async () => {
    const f = fixture();
    await expect(
      runCli(["host", "--workspace", tmpdir()], {
        ...f.options,
        daemon: async () => {
          setImmediate(() => process.emit("SIGTERM"));
          return {
            host: { hostId: crypto.randomUUID() },
            close: async () => {
              throw new Error("close failed");
            },
          };
        },
      }),
    ).rejects.toThrow("close failed");
  });
  it("prints help without starting an agent or connection", async () => {
    const f = fixture();
    await runCli(["--help"], f.options);
    expect(f.output()).toContain("p2pme host --workspace");
    expect(f.requests).toEqual([]);
  });
  it("reads pairing secrets from stdin and requires explicit profiles", async () => {
    const f = fixture();
    await runCli(
      [
        "pair",
        "--profiles",
        "codex",
        "--agent",
        "--scopes",
        "sessions:list,tasks:delegate",
      ],
      f.options,
    );
    expect(f.requests[0]!.args).toEqual({
      invitation: "private-invitation",
      principal: "agent",
      scopes: ["sessions:list", "tasks:delegate"],
      profileIds: ["codex"],
    });
    expect(f.output()).not.toContain("private-invitation");
    await expect(runCli(["pair"], fixture().options)).rejects.toThrow(
      "--profiles",
    );
    await expect(
      runCli(["pair", "--profiles", "codex", "--yes"], fixture().options),
    ).rejects.toThrow();
  });
  it("rejects hidden command arguments before request dispatch", async () => {
    const f = fixture();
    await expect(
      runCli(["start", "codex", "--shell", "cmd"], f.options),
    ).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
  it("escapes terminal control and format characters in status", () => {
    const output = terminalJson({ label: "bad\u009b\u202e" });
    expect(output).not.toContain("\u009b");
    expect(output).not.toContain("\u202e");
    expect(JSON.parse(output)).toEqual({ label: "bad\u009b\u202e" });
  });
  it("states future session and provider tool access before approval", () => {
    const prompt = approvalText({
      label: "Phone",
      principal: "human-device",
      scopes: ["sessions:chat"],
      profileIds: ["codex"],
      workspace: "/workspace",
      sessionAccess: "registered",
      expiresAt: "2026-10-13T20:00:00Z",
    });
    expect(prompt).toContain("current and future registered sessions");
    expect(prompt).toContain("existing tools and return local file content");
    expect(prompt).toContain("/workspace");
  });
});

describe("safe CLI startup errors", () => {
  it.each([
    "Host workspace identity changed; use a separate state directory",
    "Missing workspace policy; use a separate state directory",
    "Invalid daemon policy file",
    "Invalid workspace",
    "Host state must be a regular file",
    "Host state path must be a directory",
    "The local host requires macOS or Linux",
    "Use absolute workspace and state paths",
    "Control socket path is too long",
    "Control directory must be private and owned by the current user",
    "Control socket must be private and owned by the current user",
  ])("reports the fixed startup error: %s", (message) => {
    expect(cliErrorMessage(new Error(message))).toContain(message);
  });
  it.each([
    new Error(
      "Host store is already open; inspect host.lock before manual recovery",
    ),
    Object.assign(new Error("listen EADDRINUSE /secret/path"), {
      code: "EADDRINUSE",
    }),
  ])("gives bounded manual recovery guidance for occupied state", (error) => {
    const message = cliErrorMessage(error);
    expect(message).toContain(
      "Confirm all host processes that use this state directory have stopped",
    );
    expect(message).toContain("host.lock");
    expect(message).toContain("control.sock");
    expect(message).not.toContain("/secret/path");
  });
  it.each([
    new Error("Control socket path is too long: private-invitation"),
    Object.assign(new Error("EACCES private-invitation"), { code: "EACCES" }),
    new SyntaxError('Unexpected token in {"secret":"private-invitation"}'),
    new Error("provider failed: private-invitation"),
    new Error("Local host rejected the request"),
    { message: "private-invitation" },
    "private-invitation",
  ])("keeps unknown errors private", (error) => {
    expect(cliErrorMessage(error)).toBe(
      "p2pme command failed. Check the command and host terminal; run p2pme --help.",
    );
  });
});

describe("host-first invitation CLI", () => {
  it("reserves the image before requesting an invitation and keeps the path local", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p2pme-cli-qr-"));
    const path = join(directory, "phone.png");
    const f = fixture();
    try {
      await runCli(["invite", "--profiles", "codex", "--qr-file", path], {
        ...f.options,
        request: async (_socket, request) => {
          expect((await lstat(path)).size).toBe(0);
          expect(request.args).not.toHaveProperty("qrFile");
          expect(JSON.stringify(request)).not.toContain(path);
          return {
            id: request.id,
            ok: true,
            result: {
              code: "7K3M2Q-9RX4TW6P",
              url: "https://p2pme.glentiki.dev/live/#pair=synthetic",
            },
          };
        },
      });
      expect((await lstat(path)).size).toBeGreaterThan(0);
      expect(f.output()).toContain("7K3M2Q-9RX4TW6P");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("removes the reserved image when the host rejects the request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p2pme-cli-qr-"));
    const path = join(directory, "phone.png");
    try {
      await expect(
        runCli(["invite", "--profiles", "codex", "--qr-file", path], {
          ...fixture().options,
          request: async () => {
            throw new Error("host unavailable");
          },
        }),
      ).rejects.toThrow("host unavailable");
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("prints the recovery link and code before image failure without another request", async () => {
    const f = fixture();
    let closed = false;
    let requests = 0;
    const result = {
      code: "7K3M2Q-9RX4TW6P",
      url: "https://p2pme.glentiki.dev/live/#pair=synthetic",
    };
    await expect(
      runCli(
        [
          "invite",
          "--profiles",
          "codex",
          "--qr-file",
          "/private/tmp/synthetic.png",
        ],
        {
          ...f.options,
          qrFile: async () => ({
            write: async () => {
              expect(f.output()).toContain(result.url);
              expect(f.output()).toContain(result.code);
              throw new Error("synthetic disk error");
            },
            close: async () => {
              closed = true;
            },
          }),
          request: async (_socket, request) => {
            requests++;
            return { id: request.id, ok: true, result };
          },
        },
      ),
    ).rejects.toThrow(
      "QR image could not be written. Use the printed code or connection link.",
    );
    expect(requests).toBe(1);
    expect(closed).toBe(true);
  });
  it.each([
    ["invite", "--profiles", "codex", "--qr-file", "relative.png"],
    ["invite", "--profiles", "codex", "--qr-file"],
    [
      "invite",
      "--profiles",
      "codex",
      "--qr-file",
      "/tmp/a",
      "--qr-file",
      "/tmp/b",
    ],
    ["pair", "--profiles", "codex", "--qr-file", "/tmp/a"],
    ["invite", "--qr-file", "/tmp/a"],
  ])(
    "does not mint an invitation for invalid QR arguments %j",
    async (...args) => {
      const f = fixture();
      await expect(runCli(args, f.options)).rejects.toThrow();
      expect(f.requests).toEqual([]);
    },
  );
  it("requests the default access without stdin or a terminal prompt and renders a local QR", async () => {
    const f = fixture();
    const result = {
      attemptId: crypto.randomUUID(),
      expiresAt: "2026-10-14T12:10:00Z",
      code: "7K3M2Q-9RX4TW6P",
      url: "https://p2pme.glentiki.dev/#pair=example",
      access: {
        principal: "human-device",
        scopes: ["sessions:list", "sessions:chat"],
        profileIds: ["codex"],
        workspace: "/workspace",
        sessionAccess: "registered",
      },
    };
    await runCli(["invite", "--profiles", "codex"], {
      ...f.options,
      input: new Readable({
        read() {
          this.destroy(new Error("Must not read stdin"));
        },
      }),
      request: async (_socket, request) => {
        f.requests.push(request);
        return { id: request.id, ok: true, result };
      },
    });
    expect(f.requests[0]).toMatchObject({
      op: "invite",
      args: {
        principal: "human-device",
        scopes: ["sessions:list", "sessions:chat"],
        profileIds: ["codex"],
      },
    });
    expect(f.output()).toContain(result.code);
    expect(f.output()).toContain(result.url);
    expect(f.output()).toContain(result.expiresAt);
    expect(f.output()).toContain("current and future registered sessions");
    expect(f.output()).toContain(
      "existing tools and return local file content",
    );
    expect(f.output()).toMatch(/[\u2580-\u259f]/u);
    expect(f.output()).not.toContain("\\u001b");
  });
  it("cancels the exact invitation and preserves explicit agent access", async () => {
    const f = fixture();
    const attemptId = crypto.randomUUID();
    await runCli(["cancel-invite", attemptId], f.options);
    expect(f.requests[0]).toMatchObject({
      op: "cancel-invite",
      args: { attemptId },
    });
    await runCli(
      [
        "invite",
        "--profiles",
        "codex,claude",
        "--agent",
        "--scopes",
        "sessions:list,tasks:delegate",
      ],
      {
        ...f.options,
        request: async (_socket, request) => {
          f.requests.push(request);
          return {
            id: request.id,
            ok: true,
            result: { url: "https://p2pme.glentiki.dev/#pair=example" },
          };
        },
      },
    );
    expect(f.requests[1]).toMatchObject({
      op: "invite",
      args: {
        principal: "agent",
        scopes: ["sessions:list", "tasks:delegate"],
        profileIds: ["codex", "claude"],
      },
    });
  });
  it.each([
    { args: ["invite"] },
    { args: ["invite", "--profiles", "codex", "--yes"] },
    { args: ["cancel-invite"] },
  ])(
    "rejects incomplete or unrecognized invitation arguments %j",
    async ({ args }) => {
      const f = fixture();
      await expect(runCli(args, f.options)).rejects.toThrow();
      expect(f.requests).toEqual([]);
    },
  );
});
