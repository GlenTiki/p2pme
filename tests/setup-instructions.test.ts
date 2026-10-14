// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps the live prompt, host guide and skill on the image QR flow", async () => {
  const live = new DOMParser().parseFromString(
    await readFile("public/live/index.html", "utf8"),
    "text/html",
  );
  const guide = new DOMParser().parseFromString(
    await readFile("public/host/index.html", "utf8"),
    "text/html",
  );
  const prompt = live.getElementById("agent-prompt")!.textContent;
  expect(prompt).toContain("https://p2pme.glentiki.dev/host/");
  expect(prompt).toMatch(/QR image/i);
  expect(prompt).not.toContain("p2pme pair");
  const pairing = guide.getElementById("pair")!;
  expect(pairing.textContent).toContain("p2pme invite");
  expect(pairing.textContent).toContain("--qr-file");
  expect(pairing.querySelector('a[href="/live/"]')).not.toBeNull();
  expect(pairing.textContent).not.toContain("p2pme pair");
  const skill = await readFile("skills/p2pme/SKILL.md", "utf8");
  const setup = skill.split("## Connect the browser")[1]!.split("Legacy")[0]!;
  expect(setup).toContain("p2pme invite");
  expect(setup).toContain("--qr-file");
  expect(setup).toContain("https://p2pme.glentiki.dev/live/");
  expect(setup).toContain("image viewer");
  expect(setup).not.toContain("p2pme pair");
});

it("gives the host prompt safe skill refresh commands for both providers", async () => {
  const html = await readFile("public/host/index.html", "utf8");
  const guide = new DOMParser().parseFromString(html, "text/html");
  const prompt = (
    guide.getElementById("host-instruction") as HTMLTextAreaElement
  ).value;
  for (const text of [
    "QR image",
    "clickable connection link",
    "pairing code",
    "access level and expiry",
    "Do not create another agent session.",
  ])
    expect(prompt).toContain(text);
  expect(prompt).not.toContain("0.2.0");
  for (const code of guide.querySelectorAll("code")) {
    if (code.textContent!.startsWith("cp ")) {
      expect(code.textContent).toContain("$(npm root -g)");
      expect(code.textContent).not.toMatch(/[\r\n]/);
    }
  }
  const readme = await readFile("README.md", "utf8");
  for (const text of [guide.body.textContent!, readme]) {
    for (const directory of [".agents", ".claude"]) {
      expect(text).toContain(`mkdir -p ${directory}/skills/p2pme`);
      expect(text).toContain(` ${directory}/skills/p2pme/SKILL.md`);
    }
    expect(text).not.toContain("cp -R");
  }
});
