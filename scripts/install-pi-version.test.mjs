import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const installer = join(root, "scripts", "install-extensions.sh");

async function fixture(context, version = "1.1.0", name = "@earendil-works/pi-coding-agent") {
  const directory = await mkdtemp(join(tmpdir(), "pi-version-installer-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const agent = join(directory, "agent");
  const bin = join(agent, "bin");
  const packageRoot = join(agent, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version }));
  await writeFile(join(agent, "package.json"), JSON.stringify({ name: "unrelated-parent", version: "0.0.0" }));
  await writeFile(join(agent, "install", "current-version"), `${version}\n`);
  await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Prevent npm's global root from accidentally supplying a real Pi to a negative test.
  await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { directory, agent, bin, packageRoot };
}

function run(layout, args = ["--skip-extensions"], overrides = {}) {
  return spawnSync("bash", [installer, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_AGENT_DIR: layout.agent,
      PI_PACKAGE_DIR: "",
      PATH: `${layout.bin}:${process.env.PATH}`,
      ...overrides,
    },
  });
}

test("installer rejects Pi below 1.0.1 before changing extensions, even when patching is skipped", async (context) => {
  for (const version of ["0.87.1", "0.99.2", "1.0.0", "1.0.1-rc.1"]) {
    const layout = await fixture(context, version);
    const extensions = join(layout.agent, "extensions");
    await mkdir(extensions);
    await writeFile(join(extensions, "keep.ts"), "keep me\n");
    for (const args of [[], ["--skip-skill-loading-patch"]]) {
      const result = run(layout, args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Unsupported Pi version .*Pi >=1\.0\.1 is required/u);
      assert.equal(await readFile(join(extensions, "keep.ts"), "utf8"), "keep me\n");
    }
  }
});

test("installer rejects malformed versions and an explicit unrelated package", async (context) => {
  const layout = await fixture(context);
  for (const version of ["not-a-version", "1.0", null]) {
    await writeFile(
      join(layout.packageRoot, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
    );
    const result = run(layout, [], { PI_PACKAGE_DIR: layout.packageRoot });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid Pi version/u);
  }
  await writeFile(
    join(layout.packageRoot, "package.json"),
    JSON.stringify({ name: "another-package", version: "1.1.0" }),
  );
  assert.match(
    run(layout, [], { PI_PACKAGE_DIR: layout.packageRoot }).stderr,
    /Could not locate @earendil-works\/pi-coding-agent/u,
  );
});

test("installer accepts the 1.0.1 boundary and newer versions before checking patch availability", async (context) => {
  for (const version of ["1.0.1", "1.0.1+build.1", "1.0.2", "2.0.0"]) {
    const layout = await fixture(context, version);
    const result = run(layout);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No complete \/skills patch exists/u);
    assert.doesNotMatch(result.stderr, /Unsupported Pi version/u);
  }
});

test("installer finds and patches managed Pi 1.1.0 through a launcher symlink without PI_PACKAGE_DIR", async (context) => {
  const layout = await fixture(context);
  const source = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const patchDir = join(root, "patches", "pi-1.1.0");
  const baseline = await readFile(join(patchDir, "baseline.sha256"), "utf8");
  await copyFile(join(source, "package.json"), join(layout.packageRoot, "package.json"));
  for (const line of baseline.trim().split("\n")) {
    const [, file] = line.split(/\s+/u);
    await mkdir(dirname(join(layout.packageRoot, file)), { recursive: true });
    await copyFile(join(source, file), join(layout.packageRoot, file));
  }
  const linkedBin = join(layout.directory, "linked-bin");
  await mkdir(linkedBin);
  await symlink(join(layout.bin, "pi"), join(linkedBin, "pi"));
  const result = run(layout, ["--skip-extensions"], { PATH: `${linkedBin}:${layout.bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Applied \/skills patch for pi 1\.1\.0/u);
  assert.match(run(layout).stdout, /already applied/u);
  // Exercise normal extension installation through the managed launcher too, using real npm.
  const completeInstall = run(layout, [], { PATH: `${linkedBin}:${process.env.PATH}` });
  assert.equal(completeInstall.status, 0, completeInstall.stderr);
  assert.match(completeInstall.stdout, /Installed pi extensions/u);
  assert.equal(
    await readFile(join(layout.agent, "extensions", "clear", "index.ts"), "utf8"),
    await readFile(join(root, "extensions", "clear", "index.ts"), "utf8"),
  );
});

test("installer refuses a broken managed install instead of patching a different global Pi", async (context) => {
  const layout = await fixture(context);
  await writeFile(join(layout.agent, "install", "current-version"), "../../escape\n");
  await writeFile(join(layout.bin, "npm"), `#!/bin/sh\nprintf '%s\\n' '${join(root, "node_modules")}'\n`, {
    mode: 0o755,
  });
  const result = run(layout);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not locate the active managed Pi package/u);
});

test("installer finds a direct package bin and falls back from a shim to npm's global root", async (context) => {
  const layout = await fixture(context, "1.0.1");
  await rm(join(layout.bin, "pi"));
  await mkdir(join(layout.packageRoot, "dist"));
  await writeFile(join(layout.packageRoot, "dist", "cli.js"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await symlink(join(layout.packageRoot, "dist", "cli.js"), join(layout.bin, "pi"));
  assert.match(run(layout).stderr, /No complete \/skills patch exists/u);
  await rm(join(layout.bin, "pi"));
  await writeFile(join(layout.bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await rm(join(layout.agent, "install", "current-version"));
  await writeFile(
    join(layout.bin, "npm"),
    `#!/bin/sh\nprintf '%s\\n' '${join(layout.agent, "install", "releases", "1.0.1", "node_modules")}'\n`,
    { mode: 0o755 },
  );
  assert.match(run(layout).stderr, /No complete \/skills patch exists/u);
});

test("installer finds a Homebrew wrapper's nested Pi package", async (context) => {
  const layout = await fixture(context, "1.0.1");
  const formula = join(layout.directory, "formula");
  const bin = join(formula, "bin");
  await mkdir(bin, { recursive: true });
  await cp(layout.packageRoot, join(formula, "libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent"), {
    recursive: true,
  });
  await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.match(
    run(layout, ["--skip-extensions"], { PATH: `${bin}:${layout.bin}:${process.env.PATH}` }).stderr,
    /No complete \/skills patch exists/u,
  );
});
