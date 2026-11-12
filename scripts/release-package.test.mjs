import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { packPackages, readSelectedPackages } from "./release-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPackages = {
  clear: ["clear"],
  effort: ["effort"],
  "markdown-backlinks": ["markdown-backlinks"],
  "router-otel": ["router", "otel"],
  subagents: ["subagents"],
};
const kinds = [...Object.keys(extensionPackages), "skills-patch"];
const manifests = readSelectedPackages(kinds);

function listFiles(base, relativePath = "") {
  return readdirSync(join(base, relativePath), { withFileTypes: true }).flatMap((entry) => {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) return listFiles(base, child);
    assert.equal(entry.isFile(), true, `unexpected non-file: ${child}`);
    return [child];
  });
}

function runtimeFiles(extension) {
  const base = join(root, "extensions", extension);
  const files =
    extension === "otel"
      ? listFiles(join(base, "src")).map((path) => join("src", path))
      : readdirSync(base, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
  if (extension === "router") files.push(...listFiles(join(base, "core")).map((path) => join("core", path)));
  return files.filter((path) => path.endsWith(".ts") && !path.includes(".test."));
}

function packageFixture(context, kind) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `pi-consumer-${kind}-`));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const checkout = join(temporaryRoot, "checkout");
  // Never stage into the shared working tree. Lifecycle scripts run against a disposable
  // checkout, while the loader later sees only the extracted consumer archive outside it.
  for (const path of [
    "LICENSE",
    "ATTRIBUTION.md",
    "scripts/stage-release-package.mjs",
    "scripts/install-extensions.sh",
    `packages/pi-${kind}`,
  ]) {
    cpSync(join(root, path), join(checkout, path), {
      recursive: true,
      filter: (path) => !["dist", "node_modules"].includes(path.split(sep).at(-1)),
    });
  }
  for (const extension of extensionPackages[kind] ?? []) {
    cpSync(join(root, "extensions", extension), join(checkout, "extensions", extension), {
      recursive: true,
      filter: (path) => !["dist", "node_modules"].includes(path.split(sep).at(-1)),
    });
  }
  if (kind === "skills-patch") cpSync(join(root, "patches"), join(checkout, "patches"), { recursive: true });
  const output = join(temporaryRoot, "archives");
  const [archive] = packPackages(readSelectedPackages([kind], checkout), output, (command, args, options) =>
    execFileSync(command, args, {
      ...options,
      env: { ...process.env, npm_config_ignore_scripts: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true" },
    }),
  );
  const extract = join(temporaryRoot, "consumer");
  mkdirSync(extract);
  execFileSync("tar", ["-xzf", join(output, archive.filename), "-C", extract]);
  const packageRoot = join(extract, "package");
  return { temporaryRoot, packageRoot, files: listFiles(packageRoot).toSorted() };
}

function assertPayload(packed, kind) {
  const expected = ["package.json", "README.md", "dist/LICENSE", "dist/ATTRIBUTION.md"];
  for (const extension of extensionPackages[kind] ?? []) {
    expected.push(...runtimeFiles(extension).map((path) => `dist/extensions/${extension}/${path}`));
    if (extension === "otel") {
      expected.push("dist/extensions/otel/LICENSE");
      expected.push(
        ...readdirSync(join(root, "extensions", "otel"))
          .filter((path) => /^NOTICE(?:\..+)?$/.test(path))
          .map((path) => `dist/extensions/otel/${path}`),
      );
    }
  }
  if (kind === "skills-patch") {
    expected.push("dist/scripts/install-extensions.sh");
    expected.push(
      ...listFiles(join(root, "patches"))
        .filter((path) => /^pi-[^/]+\//.test(path) && /(?:\.(?:patch|sha256|absent)|-absent)$/.test(path))
        .map((path) => `dist/patches/${path}`),
    );
  }
  assert.deepEqual(
    packed.files,
    expected.toSorted(),
    `${kind} tarball must contain exactly its approved consumer payload`,
  );
  for (const path of packed.files) {
    assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|test|eval|fixtures|\.github)\/|\.test\.|(?:^|\/)\.env(?:\.|$)/);
  }
  assert.equal(
    readFileSync(join(packed.packageRoot, "dist", "LICENSE"), "utf8"),
    readFileSync(join(root, "LICENSE"), "utf8"),
  );
  assert.equal(
    readFileSync(join(packed.packageRoot, "dist", "ATTRIBUTION.md"), "utf8"),
    readFileSync(join(root, "ATTRIBUTION.md"), "utf8"),
  );
}

function importedSpecifiers(source, filename) {
  const specs = new Set();
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      specs.add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      specs.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true));
  return [...specs];
}

function assertImportClosure(packageRoot, manifest) {
  const files = new Set(listFiles(packageRoot).map((path) => resolve(packageRoot, path)));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    for (const specifier of importedSpecifiers(readFileSync(file, "utf8"), file)) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        // OTel retains upstream NodeNext .js specifiers; Pi's jiti loader resolves these
        // to the shipped .ts sources. Check the target inside the archive, never the repo.
        const candidates = [target, `${target}.ts`, `${target}.js`, join(target, "index.ts"), join(target, "index.js")];
        if (target.endsWith(".js")) candidates.push(target.replace(/\.js$/, ".ts"));
        assert.equal(
          candidates.some((path) => path.startsWith(`${packageRoot}${sep}`) && files.has(path)),
          true,
          `${relative(packageRoot, file)} missing packaged import: ${specifier}`,
        );
      } else {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        assert.equal(
          declared.has(name),
          true,
          `${relative(packageRoot, file)} imports undeclared package: ${specifier}`,
        );
      }
    }
  }
}

for (const kind of kinds) {
  test(`${kind} consumer archive has exact payload, closed imports and loads through Pi`, async (context) => {
    const packed = packageFixture(context, kind);
    const manifest = JSON.parse(readFileSync(join(packed.packageRoot, "package.json"), "utf8"));
    assertPayload(packed, kind);
    assertImportClosure(packed.packageRoot, manifest);
    assert.deepEqual(manifest.files, ["dist"]);
    for (const peer of Object.keys(manifest.peerDependencies ?? {}))
      assert.equal(manifest.dependencies?.[peer], undefined);
    const cwd = join(packed.temporaryRoot, "workspace");
    const agentDir = join(packed.temporaryRoot, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    if (Object.keys(manifest.dependencies ?? {}).length) {
      // Match Pi's consumer behavior: runtime deps only, no automatically installed host
      // peers, no lifecycle scripts, no CodeArtifact credentials or checkout node_modules.
      const userConfig = join(packed.temporaryRoot, "npmrc");
      writeFileSync(userConfig, "");
      execFileSync(
        "npm",
        [
          "install",
          "--omit=dev",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-package-lock",
          "--no-audit",
          "--no-fund",
          "--prefer-offline",
          "--min-release-age=0",
          "--registry=https://registry.npmjs.org/",
        ],
        {
          cwd: packed.packageRoot,
          env: { ...process.env, NPM_CONFIG_USERCONFIG: userConfig },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
    const loaded = await discoverAndLoadExtensions([packed.packageRoot], cwd, agentDir);
    try {
      assert.deepEqual(loaded.errors, [], `${kind} failed to load from its consumer archive`);
      assert.equal(loaded.extensions.length, extensionPackages[kind]?.length ?? 0);
      assert.deepEqual(
        loaded.extensions.map(({ resolvedPath }) => relative(packed.packageRoot, resolvedPath)).toSorted(),
        (manifest.pi?.extensions ?? []).map((path) => path.replace(/^\.\//, "")).toSorted(),
      );
    } finally {
      // Factory loading does not emit session_start (no telemetry/processes are started).
      loaded.runtime.invalidate();
    }
    if (kind === "router-otel") {
      assert.match(readFileSync(join(packed.packageRoot, "dist/extensions/otel/LICENSE"), "utf8"), /Apache License/);
      for (const extension of ["router", "otel"]) {
        const source = JSON.parse(readFileSync(join(root, "extensions", extension, "package.json"), "utf8"));
        for (const [name, version] of Object.entries(source.dependencies))
          assert.equal(manifest.dependencies[name], version);
      }
      assert.equal(manifest.dependencies.xstate, "5.33.2");
      for (const name of ["shell-quote", "shlex"]) assert.equal(manifest.dependencies[name], undefined);
    }
    if (kind === "skills-patch") {
      assert.equal(manifest.bin["pi-skills-patch"], "dist/scripts/install-extensions.sh");
      const installer = join(packed.packageRoot, manifest.bin["pi-skills-patch"]);
      assert.ok(statSync(installer).mode & 0o111, "packaged CLI must be executable");
      const binary = join(packed.temporaryRoot, "pi-skills-patch");
      symlinkSync(installer, binary);
      const help = execFileSync(binary, ["--help"], { encoding: "utf8" });
      assert.match(help, /apply only the version-checked/i);
      assert.doesNotMatch(help, /without-otel/);
      const noWork = spawnSync(binary, ["--skip-skill-loading-patch"], { encoding: "utf8" });
      assert.equal(noWork.status, 2);
      assert.match(noWork.stderr, /nothing to install/);
    }
  });
}

test("archive import closure accepts NodeNext .js-to-.ts but rejects missing or undeclared imports", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-closure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "index.ts"), 'export { value } from "./helper.js";\n');
  writeFileSync(join(directory, "helper.ts"), "export const value = 1;\n");
  assert.doesNotThrow(() => assertImportClosure(directory, {}));
  rmSync(join(directory, "helper.ts"));
  assert.throws(() => assertImportClosure(directory, {}), /missing packaged import: \.\/helper.js/);
  writeFileSync(join(directory, "index.ts"), 'void import("undeclared-runtime/subpath");\n');
  assert.throws(() => assertImportClosure(directory, {}), /undeclared package/);
  writeFileSync(join(directory, "index.ts"), 'import "../outside.ts";\n');
  assert.throws(() => assertImportClosure(directory, {}), /missing packaged import/);
});

test("router-otel and subagents declare the supported Pi host range", () => {
  const supported = ">=1.2.0 <2.0.0";
  const parse = (version) => version.split(".").map(Number);
  const compare = (left, right) => {
    const [a, b] = [parse(left), parse(right)];
    for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
  };
  for (const { kind, manifest } of manifests.filter(({ kind }) => ["router-otel", "subagents"].includes(kind))) {
    const range = manifest.peerDependencies["@earendil-works/pi-coding-agent"];
    assert.equal(range, supported, kind);
    const [, floor, ceiling] = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range) ?? [];
    const accepts = (version) => compare(version, floor) >= 0 && compare(version, ceiling) < 0;
    for (const version of ["1.2.0", "1.2.1", "1.3.0", "1.99.0"]) assert.equal(accepts(version), true, version);
    for (const version of ["1.1.9", "1.0.0", "2.0.0", "2.1.0"]) assert.equal(accepts(version), false, version);
  }
});
