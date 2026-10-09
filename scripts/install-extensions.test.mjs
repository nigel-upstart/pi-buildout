import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installerPath = join(repositoryRoot, "scripts", "install-extensions.sh");
const managedExtensions = ["clear", "effort", "markdown-backlinks", "subagents"];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runInstaller(agentDirectory) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [installerPath, "--skip-skill-loading-patch"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PI_AGENT_DIR: agentDirectory,
        PI_PACKAGE_DIR: join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test("installer retires legacy top-level extensions after installing directory replacements", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-extension-installer-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const agentDirectory = join(temporaryRoot, "agent");
  const extensionDirectory = join(agentDirectory, "extensions");
  await mkdir(extensionDirectory, { recursive: true });

  await Promise.all([
    ...managedExtensions.flatMap((extension) => [
      copyFile(join(repositoryRoot, "extensions", extension, "index.ts"), join(extensionDirectory, `${extension}.ts`)),
      copyFile(
        join(repositoryRoot, "extensions", extension, "index.test.mjs"),
        join(extensionDirectory, `${extension}.test.mjs`),
      ),
    ]),
    writeFile(join(extensionDirectory, "unrelated.ts"), "unrelated extension\n"),
  ]);

  const result = await runInstaller(agentDirectory);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Installed pi extensions/u);
  for (const extension of managedExtensions) {
    assert.equal(await exists(join(extensionDirectory, `${extension}.ts`)), false);
    assert.equal(await exists(join(extensionDirectory, `${extension}.test.mjs`)), false);
    assert.equal(await exists(join(extensionDirectory, extension, "index.ts")), true);
    assert.equal(await exists(join(extensionDirectory, extension, "helpers.ts")), true);
    assert.equal(
      await readFile(join(extensionDirectory, extension, "index.ts"), "utf8"),
      await readFile(join(repositoryRoot, "extensions", extension, "index.ts"), "utf8"),
    );
  }
  assert.equal(await readFile(join(extensionDirectory, "unrelated.ts"), "utf8"), "unrelated extension\n");
});

test("installer refuses to delete unrecognized same-name top-level extensions or tests", async (context) => {
  for (const name of ["clear.ts", "effort.test.mjs", "otel.ts"]) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-extension-conflict-"));
    context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
    const agentDirectory = join(temporaryRoot, "agent");
    const extensionDirectory = join(agentDirectory, "extensions");
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(extensionDirectory, name), "unrelated extension\n");

    const result = await runInstaller(agentDirectory);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a recognized managed legacy extension file/u);
    assert.equal(await readFile(join(extensionDirectory, name), "utf8"), "unrelated extension\n");
    assert.equal(await exists(join(extensionDirectory, "clear", "index.ts")), false);
  }
});

test("installer locates pi through the managed launcher shim", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-extension-installer-shim-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const agentDirectory = join(temporaryRoot, "agent");
  const releaseVersion = "9.9.9";
  const packageDirectory = join(
    agentDirectory,
    "install",
    "releases",
    releaseVersion,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  await mkdir(join(agentDirectory, "bin"), { recursive: true });
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(agentDirectory, "bin", "pi"), "#!/bin/sh\nexit 0\n");
  await chmod(join(agentDirectory, "bin", "pi"), 0o755);
  // A failed managed lookup must not be rescued by a real globally installed Pi.
  await writeFile(join(agentDirectory, "bin", "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(agentDirectory, "install", "current-version"), `${releaseVersion}\n`);
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: releaseVersion }),
  );

  // No /skills patch exists for the fake release, so the installer stops after locating the package.
  // Reaching that message proves the shim resolved without a globally installed Pi.
  const env = {
    ...process.env,
    PI_AGENT_DIR: agentDirectory,
    PATH: `${join(agentDirectory, "bin")}:${process.env.PATH}`,
  };
  delete env.PI_PACKAGE_DIR;
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [installerPath, "--skip-extensions"], {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stderr }));
  });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /Could not locate/u);
  assert.match(result.stderr, /No complete \/skills patch exists for pi 9\.9\.9/u);
});
