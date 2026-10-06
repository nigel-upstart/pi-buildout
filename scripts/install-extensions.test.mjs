import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      env: { ...process.env, PI_AGENT_DIR: agentDirectory },
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
