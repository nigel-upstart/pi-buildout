import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function install(args) {
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-otel-install-"));
  temporaryDirectories.push(agentDirectory);
  await execute(join(root, "scripts", "install-extensions.sh"), ["--skip-skill-loading-patch", ...args], {
    cwd: root,
    env: { ...process.env, PI_AGENT_DIR: agentDirectory },
  });
  return agentDirectory;
}

describe("vendored OTel extension installation", () => {
  it("installs telemetry by default and supports explicit opt-out", async () => {
    const agentDirectory = await install([]);
    assert.equal(await exists(join(agentDirectory, "extensions", "otel", "src", "index.ts")), true);
    assert.equal(await exists(join(agentDirectory, "extensions", "router", "index.ts")), true);

    const optedOut = await install(["--without-otel"]);
    assert.equal(await exists(join(optedOut, "extensions", "otel")), false);
    assert.equal(await exists(join(optedOut, "extensions", "router", "index.ts")), true);

    await execute(join(root, "scripts", "install-extensions.sh"), ["--skip-skill-loading-patch", "--without-otel"], {
      cwd: root,
      env: { ...process.env, PI_AGENT_DIR: agentDirectory },
    });
    assert.equal(await exists(join(agentDirectory, "extensions", "otel")), false);
  });

  it("refuses to replace or remove an unrelated OTel extension", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "pi-otel-foreign-"));
    temporaryDirectories.push(agentDirectory);
    const otel = join(agentDirectory, "extensions", "otel");
    await mkdir(otel, { recursive: true });
    await writeFile(join(otel, "package.json"), JSON.stringify({ name: "someone-else-otel" }));
    await writeFile(join(otel, "keep.ts"), "unrelated extension\n");

    for (const args of [[], ["--without-otel"]]) {
      await assert.rejects(
        execute(join(root, "scripts", "install-extensions.sh"), ["--skip-skill-loading-patch", ...args], {
          cwd: root,
          env: { ...process.env, PI_AGENT_DIR: agentDirectory },
        }),
        /not the managed OTel extension/,
      );
      assert.equal(await readFile(join(otel, "keep.ts"), "utf8"), "unrelated extension\n");
      assert.equal(await exists(join(agentDirectory, "extensions", "clear")), false);
    }
  });

  it("installs the manifest-declared entrypoint and prunes tests and build output", async () => {
    const agentDirectory = await install([]);
    const otel = join(agentDirectory, "extensions", "otel");

    const manifest = JSON.parse(await readFile(join(otel, "package.json"), "utf8"));
    const entrypoint = manifest.pi.extensions[0];
    assert.equal(entrypoint, "./src/index.ts");
    assert.equal(await exists(join(otel, entrypoint)), true);
    assert.equal(await exists(join(otel, "src", "otel", "sdk.ts")), true);

    // The lockfile ships so the installed tree gets the versions CI tested.
    assert.equal(await exists(join(otel, "package-lock.json")), true);
    // Installing is redistribution: the vendored Apache-2.0 notice must travel with the source.
    assert.equal(await exists(join(otel, "LICENSE")), true);
    assert.match(await readFile(join(otel, "LICENSE"), "utf8"), /Apache License/);
    // Tests and compiled output are development artifacts and must not be published.
    assert.equal(await exists(join(otel, "test")), false);
    assert.equal(await exists(join(otel, "dist")), false);
  });

  it("resolves every declared dependency from inside the installed tree", async () => {
    const agentDirectory = await install([]);
    const otel = join(agentDirectory, "extensions", "otel");
    const manifest = JSON.parse(await readFile(join(otel, "package.json"), "utf8"));
    const dependencies = Object.keys(manifest.dependencies);
    assert.ok(dependencies.length > 0);

    // Resolve exactly as pi does when it loads the extension: from the installed entrypoint, not
    // from this repository's development tree. Both paths are canonicalized because the macOS
    // temporary directory is reached through a /var -> /private/var symlink.
    const installedModules = await realpath(join(otel, "node_modules"));
    const resolver = createRequire(join(otel, "src", "index.ts"));
    for (const dependency of dependencies) {
      const resolved = await realpath(resolver.resolve(dependency));
      assert.ok(
        resolved.startsWith(installedModules),
        `${dependency} must resolve inside the installed extension, got ${resolved}`,
      );
    }
  });

  it("pins runtime dependencies exactly so the installed tree matches the tested lockfile", async () => {
    const manifest = JSON.parse(await readFile(join(root, "extensions", "otel", "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(root, "extensions", "otel", "package-lock.json"), "utf8"));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got ${version}`);
      assert.equal(lock.packages[`node_modules/${name}`].version, version, `${name} drifted from the lockfile`);
    }
  });
});
