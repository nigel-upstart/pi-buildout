import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const patchDirectory = fileURLToPath(new URL("../patches/pi-1.1.0/", import.meta.url));

function patchedFileSource(patch, path) {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `patch does not modify ${path}`);
  const next = patch.indexOf("\ndiff --git ", start + marker.length);
  const section = patch.slice(start, next === -1 ? undefined : next);

  return section
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith(" ") && !line.startsWith(" diff --git")),
    )
    .map((line) => line.slice(1))
    .join("\n")
    .concat("\n");
}

function manifestChecksum(manifest, path) {
  const line = manifest.split("\n").find((entry) => entry.endsWith(`  ${path}`));
  assert.ok(line, `manifest does not include ${path}`);
  return line.split(/\s+/u)[0];
}

/**
 * Pi 1.1.0 split the bundled bin: `dist/bundle/cli.js` enables Node's compile cache and then loads
 * `dist/bundle/cli-runtime.js` through `createRequire(...)`, and only the latter holds the bundled runtime. The
 * patch therefore replaces `cli-runtime.js` and leaves upstream's `cli.js` alone, which keeps the compile cache
 * and relies on `require()` of an ES module graph. Both manifests pin that loader to its upstream bytes, so the
 * installer refuses a package whose loader differs; the stand-in below is checked against that same checksum, which
 * makes it byte-identical to the published loader rather than a lookalike.
 */
test("pi 1.1.0 bundled CLI loader reaches the patched unbundled runtime through cli-runtime.js", async (context) => {
  const [patch, baselineManifest, patchedManifest] = await Promise.all([
    readFile(join(patchDirectory, "skills.patch"), "utf8"),
    readFile(join(patchDirectory, "baseline.sha256"), "utf8"),
    readFile(join(patchDirectory, "patched.sha256"), "utf8"),
  ]);
  const loaderPath = "dist/bundle/cli.js";
  const loader = [
    "#!/usr/bin/env node",
    'import { createRequire, enableCompileCache } from "node:module";',
    "",
    "enableCompileCache();",
    'createRequire(import.meta.url)("./cli-runtime.js");',
    "",
  ].join("\n");
  assert.doesNotMatch(patch, /^diff --git a\/dist\/bundle\/cli\.js /mu, "upstream's cli.js loader stays untouched");
  assert.equal(
    manifestChecksum(patchedManifest, loaderPath),
    manifestChecksum(baselineManifest, loaderPath),
    "the loader is verified, not modified",
  );
  assert.equal(
    createHash("sha256").update(loader).digest("hex"),
    manifestChecksum(baselineManifest, loaderPath),
    "the stand-in loader is byte-identical to the published one",
  );

  const runtime = patchedFileSource(patch, "dist/bundle/cli-runtime.js");
  const rpcEntry = patchedFileSource(patch, "dist/bundle/rpc-entry.js");
  assert.match(runtime, /from "\.\.\/cli\/setup\.js"/u);
  assert.match(runtime, /from "\.\.\/main\.js"/u);
  assert.match(rpcEntry, /from "\.\.\/main\.js"/u);
  for (const [path, source] of [
    ["dist/bundle/cli-runtime.js", runtime],
    ["dist/bundle/rpc-entry.js", rpcEntry],
  ]) {
    assert.match(manifestChecksum(baselineManifest, path), /^[0-9a-f]{64}$/u);
    assert.equal(createHash("sha256").update(source).digest("hex"), manifestChecksum(patchedManifest, path), path);
  }

  const packageDirectory = await mkdtemp(join(tmpdir(), "pi-patched-entrypoint-110-"));
  context.after(() => rm(packageDirectory, { force: true, recursive: true }));
  await mkdir(join(packageDirectory, "dist", "bundle"), { recursive: true });
  await mkdir(join(packageDirectory, "dist", "cli"), { recursive: true });
  await mkdir(join(packageDirectory, "dist", "core"), { recursive: true });
  await Promise.all([
    writeFile(join(packageDirectory, "package.json"), '{"type":"module"}\n'),
    writeFile(
      join(packageDirectory, "dist", "cli", "setup.js"),
      "export function setupCli() { process.title = 'pi'; process.stdout.write('setup\\n'); }\n",
    ),
    writeFile(
      join(packageDirectory, "dist", "core", "http-dispatcher.js"),
      "export function configureHttpDispatcher() { process.stdout.write('dispatcher\\n'); }\n",
    ),
    writeFile(join(packageDirectory, "dist", "config.js"), 'export const APP_NAME = "pi";\n'),
    writeFile(
      join(packageDirectory, "dist", "main.js"),
      "export function main(args) { process.stdout.write(`main ${process.title} ${JSON.stringify(args)}\\n`); }\n",
    ),
    writeFile(join(packageDirectory, loaderPath), loader),
    writeFile(join(packageDirectory, "dist", "bundle", "cli-runtime.js"), runtime),
    writeFile(join(packageDirectory, "dist", "bundle", "rpc-entry.js"), rpcEntry),
  ]);

  const run = (entrypoint) => {
    const result = spawnSync(process.execPath, [join(packageDirectory, entrypoint), "skills", "list"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n");
  };
  assert.deepEqual(run("dist/bundle/cli.js"), ["setup", 'main pi ["skills","list"]']);
  assert.deepEqual(run("dist/bundle/rpc-entry.js"), ["dispatcher", 'main pi-rpc ["--mode","rpc","skills","list"]']);
});
