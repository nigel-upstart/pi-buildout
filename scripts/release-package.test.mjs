import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registry = "https://code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/";
const extensionPackages = {
  clear: ["clear"],
  effort: ["effort"],
  "markdown-backlinks": ["markdown-backlinks"],
  "router-otel": ["router", "otel"],
  subagents: ["subagents"],
};
const manifests = [...Object.keys(extensionPackages), "skills-patch"].map((name) => {
  const directory = join(root, "packages", `pi-${name}`);
  return { name, directory, manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) };
});

test("release CLI defaults to selected-package dry runs and requires an explicit publish flag", () => {
  const binDir = mkdtempSync(join(tmpdir(), "pi-release-cli-"));
  const log = join(binDir, "calls.jsonl");
  const npm = join(binDir, "npm");
  writeFileSync(
    npm,
    [
      "#!/usr/bin/env node",
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), publishFlag: process.env.PI_CODEARTIFACT_PUBLISH }) + String.fromCharCode(10));`,
      "",
    ].join("\n"),
  );
  chmodSync(npm, 0o755);
  const cli = join(root, "scripts", "release-packages.mjs");
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PI_CODEARTIFACT_PUBLISH: "" };
  try {
    const dryRun = spawnSync(process.execPath, [cli, "--package", "clear,effort", "-p", "clear"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        ["pack", "--dry-run", "--json"],
        ["pack", "--dry-run", "--json"],
      ],
    );
    assert.match(calls[0].cwd, /packages[\\/]pi-clear$/);
    assert.match(calls[1].cwd, /packages[\\/]pi-effort$/);
    assert.equal(calls[0].publishFlag, "");

    const publish = spawnSync(process.execPath, [cli, "--package", "clear", "--publish"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(publish.status, 0, publish.stderr);
    const publishCall = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
    assert.deepEqual(publishCall.args, ["publish", "--registry", registry, "--tag", "alpha"]);
    assert.equal(publishCall.publishFlag, "1");

    const invalid = spawnSync(process.execPath, [cli, "--package", "all"], { cwd: root, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown package name/);
    const missing = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Select at least one package/);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("packages are independent alpha releases guarded against public npm and latest", () => {
  for (const { directory, manifest } of manifests) {
    assert.match(manifest.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
    assert.equal(manifest.publishConfig.registry, registry);
    assert.notEqual(manifest.private, true);
    const env = {
      ...process.env,
      npm_config_registry: registry,
      npm_config_tag: "alpha",
      PI_CODEARTIFACT_PUBLISH: "1",
    };
    const guard = join(root, "scripts", "check-release-registry.mjs");
    assert.equal(spawnSync(process.execPath, [guard], { cwd: directory, env }).status, 0);
    for (const overrides of [
      { npm_config_registry: "https://registry.npmjs.org/" },
      { npm_config_tag: "latest" },
      { PI_CODEARTIFACT_PUBLISH: "0" },
    ]) {
      assert.equal(spawnSync(process.execPath, [guard], { cwd: directory, env: { ...env, ...overrides } }).status, 1);
    }
  }
});

test("each extension package stages only its own runtime files and host peers", () => {
  for (const { name, directory, manifest } of manifests.filter(({ name }) => name !== "skills-patch")) {
    execFileSync(process.execPath, [join(root, "scripts", "stage-release-package.mjs"), name]);
    const staged = join(directory, "dist", "extensions");
    assert.deepEqual(readdirSync(staged).sort(), extensionPackages[name].toSorted());
    for (const entry of manifest.pi.extensions) assert.equal(statSync(join(directory, entry)).isFile(), true);
    for (const peer of Object.keys(manifest.peerDependencies)) assert.equal(manifest.dependencies?.[peer], undefined);
  }
});

test("router and OTel share dependencies and keep the vendored license", () => {
  const { directory, manifest } = manifests.find(({ name }) => name === "router-otel");
  execFileSync(process.execPath, [join(root, "scripts", "stage-release-package.mjs"), "router-otel"]);
  const staged = join(directory, "dist", "extensions");
  assert.match(readFileSync(join(staged, "otel", "LICENSE"), "utf8"), /Apache License/);
  assert.deepEqual(
    readdirSync(join(staged, "router", "core")).filter((name) => name.endsWith(".test.mjs")),
    [],
  );
  assert.equal(manifest.dependencies["shell-quote"], "1.11.0");
  const otel = JSON.parse(readFileSync(join(root, "extensions", "otel", "package.json"), "utf8"));
  for (const [name, version] of Object.entries(otel.dependencies)) assert.equal(manifest.dependencies[name], version);
});

test("patch package stages only versioned patch data and a patch-only CLI", () => {
  const { directory, manifest } = manifests.find(({ name }) => name === "skills-patch");
  execFileSync(process.execPath, [join(root, "scripts", "stage-release-package.mjs"), "skills-patch"]);
  const dist = join(directory, "dist");
  assert.equal(statSync(join(dist, "scripts", "install-extensions.sh")).isFile(), true);
  assert.equal(manifest.bin["pi-skills-patch"], "dist/scripts/install-extensions.sh");
  assert.match(readFileSync(join(dist, "scripts", "install-extensions.sh"), "utf8"), /--skip-extensions/);
  const patchVersions = readdirSync(join(root, "patches")).filter((name) => /^pi-\d/.test(name));
  assert.deepEqual(readdirSync(join(dist, "patches")).sort(), patchVersions.toSorted());
  for (const version of patchVersions) {
    const expected = readdirSync(join(root, "patches", version))
      .filter((name) => /(?:\.(?:patch|sha256|absent)|-absent)$/.test(name))
      .sort();
    assert.deepEqual(readdirSync(join(dist, "patches", version)).sort(), expected, version);
  }
  for (const state of ["handwritten", "legacy", "pre-validation"]) {
    assert.equal(statSync(join(dist, "patches", "pi-0.85.1", `${state}-absent`)).isFile(), true);
  }
  assert.equal(readdirSync(dist).includes("extensions"), false);

  const binDir = mkdtempSync(join(tmpdir(), "pi-skills-package-"));
  try {
    const binary = join(binDir, "pi-skills-patch");
    symlinkSync(join(dist, manifest.bin["pi-skills-patch"].replace("dist/", "")), binary);
    const help = execFileSync(binary, ["--help"], { encoding: "utf8" });
    assert.match(help, /apply only the version-checked/i);
    assert.doesNotMatch(help, /without-otel/);
    const noWork = spawnSync(binary, ["--skip-skill-loading-patch"], { encoding: "utf8" });
    assert.equal(noWork.status, 2);
    assert.match(noWork.stderr, /nothing to install/);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});
