import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
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

describe("extension installer", () => {
  it("transactionally replaces the complete router tree without shipping tests", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "pi-router-install-"));
    temporaryDirectories.push(agentDirectory);
    const stale = join(agentDirectory, "extensions", "router", "stale.ts");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "stale", "utf8");
    await execute(join(root, "scripts", "install-extensions.sh"), ["--skip-skill-loading-patch"], {
      cwd: root,
      env: { ...process.env, PI_AGENT_DIR: agentDirectory },
    });
    const router = join(agentDirectory, "extensions", "router");
    assert.equal(await exists(stale), false);
    assert.equal(await exists(join(router, "index.ts")), true);
    assert.equal(await exists(join(router, "core", "planning.ts")), true);
    assert.equal(await exists(join(router, "core", "planning.test.mjs")), false);
    assert.match(await readFile(join(router, "index.ts"), "utf8"), /submit_implementation_plan/);
  });

  it("installs the runtime dependencies the router imports so the extension can load", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "pi-router-install-deps-"));
    temporaryDirectories.push(agentDirectory);
    await execute(join(root, "scripts", "install-extensions.sh"), ["--skip-skill-loading-patch"], {
      cwd: root,
      env: { ...process.env, PI_AGENT_DIR: agentDirectory },
    });
    const router = join(agentDirectory, "extensions", "router");
    const manifest = JSON.parse(await readFile(join(router, "package.json"), "utf8"));
    const dependencies = Object.keys(manifest.dependencies);
    assert.ok(dependencies.length > 0, "the router manifest must declare its runtime dependencies");

    // Resolve exactly as pi does when it loads the extension: from the installed file that imports
    // them, not from this repository's development tree. Both paths are canonicalized because the
    // macOS temporary directory is reached through a /var -> /private/var symlink.
    const installedModules = await realpath(join(router, "node_modules"));
    const resolver = createRequire(join(router, "core", "shell.ts"));
    for (const dependency of dependencies) {
      const resolved = await realpath(resolver.resolve(dependency));
      assert.ok(
        resolved.startsWith(installedModules),
        `${dependency} must resolve inside the installed extension, got ${resolved}`,
      );
    }
  });

  it("declares every module the extension imports, at the version this repository pins", async () => {
    const manifest = JSON.parse(await readFile(join(root, "extensions", "router", "package.json"), "utf8"));
    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

    // The repository installs these as devDependencies for typecheck and tests while the extension
    // manifest installs them at runtime. Pinning both to one version stops the installed extension
    // from silently running a different version than the one this repository verifies.
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      assert.equal(rootManifest.devDependencies[name], version, `${name} version drifted from the root manifest`);
    }

    // Any bare import in shipped router sources must be declared, otherwise the extension loads in
    // this repository but fails once installed, which is exactly how shell-quote reached a released
    // extension that could not load. pi injects its own packages plus typebox into every extension
    // (see VIRTUAL_MODULES in pi's extension loader), so those are supplied by the host and must not
    // be declared here.
    const hostProvided = (specifier) =>
      specifier === "typebox" ||
      specifier.startsWith("typebox/") ||
      specifier.startsWith("@sinclair/typebox") ||
      specifier.startsWith("@earendil-works/") ||
      specifier.startsWith("@mariozechner/");
    const shipped = await execute("git", ["ls-files", "extensions/router"], { cwd: root });
    const sources = shipped.stdout.split("\n").filter((path) => path.endsWith(".ts") && !path.includes(".test."));
    assert.ok(sources.length > 0, "expected to find shipped router sources");
    const declared = new Set(Object.keys(manifest.dependencies));
    // Every syntax that can pull a package in at runtime is scanned, not just static imports: a
    // re-export or a dynamic import of an undeclared package fails exactly the same way once
    // installed. Type-only imports and re-exports are erased before the module runs, so they carry
    // no runtime requirement.
    const runtimeSpecifiers = (text) => [
      ...[...text.matchAll(/^\s*import\s+(?!type\s)[^"']*["']([^"'.][^"']*)["']/gm)].map((match) => match[1]),
      ...[...text.matchAll(/^\s*export\s+(?!type\s)[^"']*\sfrom\s*["']([^"'.][^"']*)["']/gm)].map((match) => match[1]),
      ...[...text.matchAll(/\bimport\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g)].map((match) => match[1]),
    ];
    for (const source of sources) {
      const text = await readFile(join(root, source), "utf8");
      for (const specifier of runtimeSpecifiers(text)) {
        if (specifier.startsWith("node:") || hostProvided(specifier)) continue;
        assert.ok(declared.has(specifier), `${source} needs undeclared runtime dependency ${specifier}`);
      }
    }
  });
});
