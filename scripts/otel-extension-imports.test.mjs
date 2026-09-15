import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, "extensions", "otel");

// pi injects its own packages into every extension, so those are host-provided
// and must not be declared here.
const hostProvided = (specifier) =>
  specifier === "typebox" ||
  specifier.startsWith("typebox/") ||
  specifier.startsWith("@sinclair/typebox") ||
  specifier.startsWith("@earendil-works/") ||
  specifier.startsWith("@mariozechner/");

const packageName = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/**
 * Every syntax that pulls a package in at runtime, not just static imports: a
 * re-export or dynamic import of an undeclared package fails the same way.
 */
const runtimeSpecifiers = (text) => [
  ...[...text.matchAll(/^\s*import\s+(?!type\s)[^"']*["']([^"'.][^"']*)["']/gm)].map((m) => m[1]),
  ...[...text.matchAll(/^\s*export\s+(?!type\s)[^"']*\sfrom\s*["']([^"'.][^"']*)["']/gm)].map((m) => m[1]),
  ...[...text.matchAll(/\bimport\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g)].map((m) => m[1]),
];

async function trackedFiles(pattern) {
  const shipped = await execute("git", ["ls-files", `extensions/otel/${pattern}`], { cwd: root });
  return shipped.stdout.split("\n").filter(Boolean);
}

describe("vendored OTel extension imports", () => {
  it("declares every package the shipped source imports", async () => {
    const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
    const declared = new Set(Object.keys(manifest.dependencies));
    const sources = await trackedFiles("src/**");
    assert.ok(sources.length > 0, "expected shipped sources");
    for (const source of sources) {
      const text = await readFile(join(root, source), "utf8");
      for (const specifier of runtimeSpecifiers(text)) {
        if (specifier.startsWith("node:") || hostProvided(specifier)) continue;
        assert.ok(
          declared.has(packageName(specifier)),
          `${source} needs undeclared runtime dependency ${packageName(specifier)}`,
        );
      }
    }
  });

  it("declares every package the test suite imports", async () => {
    // The tests are not shipped, so a test-only import belongs in
    // devDependencies. Undeclared, it resolves only while some other dependency
    // happens to hoist it, and the tree stops testing standalone.
    const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
    const declared = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]);
    const tests = await trackedFiles("test/**");
    assert.ok(tests.length > 0, "expected shipped tests");
    for (const source of tests) {
      const text = await readFile(join(root, source), "utf8");
      for (const specifier of runtimeSpecifiers(text)) {
        if (specifier.startsWith("node:") || hostProvided(specifier)) continue;
        assert.ok(
          declared.has(packageName(specifier)),
          `${source} needs undeclared dependency ${packageName(specifier)}`,
        );
      }
    }
  });
});
