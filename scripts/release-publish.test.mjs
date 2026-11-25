import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  REGISTRY,
  isAlphaVersion,
  packPackages,
  publishPackages,
  readSelectedPackages,
  validateReleaseManifest,
} from "./release-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestFor = (kind) => ({
  name: `@upstart/pi-${kind}`,
  version: "0.1.0-alpha.1",
  publishConfig: { registry: REGISTRY },
});
const hash = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const filename = (manifest) => `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;

function fixture(context) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-release-test-")));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "scripts"));
  for (const script of ["release-packages.mjs", "check-release-registry.mjs"])
    copyFileSync(join(root, "scripts", script), join(base, "scripts", script));
  for (const kind of ["clear", "effort"]) {
    mkdirSync(join(base, "packages", `pi-${kind}`), { recursive: true });
    writeFileSync(join(base, "packages", `pi-${kind}`, "package.json"), JSON.stringify(manifestFor(kind)));
  }
  return { base, output: join(base, "archives"), entries: readSelectedPackages(["clear", "effort"], base) };
}

function packRunner(calls, alter = (result) => result) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const manifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
    const bytes = JSON.stringify(manifest);
    const name = filename(manifest);
    writeFileSync(join(args[args.indexOf("--pack-destination") + 1], name), bytes);
    return JSON.stringify(
      alter([{ name: manifest.name, version: manifest.version, filename: name, integrity: hash(bytes) }]),
    );
  };
}

function publishRunner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "tar") return readFileSync(args[1], "utf8");
    return "";
  };
}

function receipt(output) {
  return JSON.parse(readFileSync(join(output, "release-assets.json"), "utf8"));
}

function updateArchive(output, mutate) {
  const data = receipt(output);
  const archive = data.archives.at(-1);
  const path = join(output, archive.filename);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  mutate(manifest);
  const bytes = JSON.stringify(manifest);
  writeFileSync(path, bytes);
  archive.integrity = hash(bytes);
  writeFileSync(join(output, "release-assets.json"), JSON.stringify(data));
}

test("strict alpha-only SemVer accepts numeric channels without normalization", () => {
  for (const version of ["0.0.0-alpha.0", "0.1.0-alpha.1", "123.45.67-alpha.890"])
    assert.equal(isAlphaVersion(version), true, version);
  for (const version of [
    undefined,
    null,
    1,
    {},
    "1.0.0",
    "1.0.0-beta.1",
    "1.0.0-rc.1",
    "1.0.0-alpha",
    "01.0.0-alpha.1",
    "1.01.0-alpha.1",
    "1.0.01-alpha.1",
    "1.0.0-alpha.01",
    "1.0.0-alpha.1+build",
    "v1.0.0-alpha.1",
    "1.0.0-alpha.1\n",
    " 1.0.0-alpha.1",
  ])
    assert.equal(isAlphaVersion(version), false, String(version));
});

test("manifest validation requires selected identity, non-private package and fixed alpha registry", () => {
  for (const kind of ["clear", "effort", "markdown-backlinks", "router-otel", "subagents", "skills-patch"]) {
    assert.doesNotThrow(() => validateReleaseManifest(kind, manifestFor(kind)));
    assert.doesNotThrow(() => validateReleaseManifest(kind, { ...manifestFor(kind), private: false }));
    for (const patch of [
      { name: "@other/pi-clear" },
      { name: "@upstart/pi-effort" },
      { name: "pi-clear" },
      { private: true },
      { private: "false" },
      { version: "0.1.0" },
      { publishConfig: { registry: "https://registry.npmjs.org/" } },
      { publishConfig: { registry: REGISTRY, tag: "latest" } },
    ]) {
      if (patch.name === manifestFor(kind).name) continue;
      assert.throws(
        () => validateReleaseManifest(kind, { ...manifestFor(kind), ...patch }),
        /Invalid release manifest/,
      );
    }
  }
  assert.throws(() => validateReleaseManifest("unknown", manifestFor("unknown")), /Invalid release manifest/);
});

test("CLI defaults to selected-only dry runs and forces scripts despite inherited suppression", (context) => {
  const { base } = fixture(context);
  const bin = join(base, "bin");
  const log = join(base, "calls.jsonl");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), optIn: process.env.PI_CODEARTIFACT_PUBLISH }) + "\\n");\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const cli = join(base, "scripts", "release-packages.mjs");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    npm_config_ignore_scripts: "true",
    PI_CODEARTIFACT_PUBLISH: "",
  };
  const result = spawnSync(process.execPath, [cli, "--package", "clear,effort", "-p", "clear"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  for (const [index, kind] of ["clear", "effort"].entries()) {
    assert.deepEqual(calls[index].args, ["pack", "--dry-run", "--json", "--ignore-scripts=false"]);
    assert.equal(calls[index].cwd, join(base, "packages", `pi-${kind}`));
    assert.equal(calls[index].optIn, "");
  }
  for (const args of [[], ["--package", "all"], ["--package"], ["--registry", "https://registry.npmjs.org/"]]) {
    assert.equal(spawnSync(process.execPath, [cli, ...args], { env }).status, 1);
  }
  assert.equal(spawnSync(process.execPath, [cli, "--help"], { env }).status, 0);
});

test("CLI publish packs the entire selection then publishes those verified tarballs and cleans up", (context) => {
  const { base } = fixture(context);
  const bin = join(base, "bin");
  const log = join(base, "calls.jsonl");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, optIn: process.env.PI_CODEARTIFACT_PUBLISH }) + "\\n");
if (args[0] === "pack") {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const output = args[args.indexOf("--pack-destination") + 1];
  const staging = path.join(output, manifest.name.split("/")[1]);
  fs.mkdirSync(path.join(staging, "package"), { recursive: true });
  fs.copyFileSync("package.json", path.join(staging, "package/package.json"));
  const filename = manifest.name.slice(1).replace("/", "-") + "-" + manifest.version + ".tgz";
  const archive = path.join(output, filename);
  execFileSync("tar", ["-czf", archive, "-C", staging, "package"]);
  const integrity = "sha512-" + createHash("sha512").update(fs.readFileSync(archive)).digest("base64");
  process.stdout.write(JSON.stringify([{ name: manifest.name, version: manifest.version, filename, integrity }]));
} else if (args[0] !== "publish") process.exit(1);
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const result = spawnSync(
    process.execPath,
    [join(base, "scripts", "release-packages.mjs"), "--package", "clear,effort", "--publish"],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        npm_config_ignore_scripts: "true",
        PI_CODEARTIFACT_PUBLISH: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map(({ args }) => args[0]),
    ["pack", "pack", "publish", "publish"],
  );
  const output = calls[0].args[calls[0].args.indexOf("--pack-destination") + 1];
  assert.equal(existsSync(output), false, "temporary archives and receipt must be removed");
  const { archives } = JSON.parse(result.stdout);
  for (const [index, kind] of ["clear", "effort"].entries()) {
    assert.equal(calls[index].optIn, "");
    assert.equal(calls[index + 2].optIn, "1");
    assert.deepEqual(calls[index + 2].args, [
      "publish",
      join(output, filename(manifestFor(kind))),
      "--registry",
      REGISTRY,
      "--tag",
      "alpha",
      "--ignore-scripts=false",
    ]);
    assert.equal(archives[index].name, manifestFor(kind).name);
    assert.match(archives[index].integrity, /^sha512-/);
  }
});

test("CLI validates the entire selection before invoking npm", (context) => {
  const { base } = fixture(context);
  const bin = join(base, "bin");
  const log = join(base, "called");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\ntouch '${log}'\nexit 1\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const path = join(base, "packages", "pi-effort", "package.json");
  for (const patch of [
    { name: "@upstart/pi-clear" },
    { private: true },
    { version: "01.0.0-alpha.1" },
    { publishConfig: { registry: "https://registry.npmjs.org/" } },
  ]) {
    writeFileSync(path, JSON.stringify({ ...manifestFor("effort"), ...patch }));
    for (const flags of [[], ["--publish"]]) {
      const result = spawnSync(
        process.execPath,
        [join(base, "scripts", "release-packages.mjs"), "--package", "clear,effort", ...flags],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid release manifest for effort/);
      assert.equal(existsSync(log), false);
    }
  }
});

test("packPackages forces lifecycle scripts and records exact archive hashes", (context) => {
  const { entries, output } = fixture(context);
  const calls = [];
  const archives = packPackages(entries, output, packRunner(calls));
  assert.deepEqual(receipt(output), { archives });
  assert.equal(archives.length, 2);
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(calls[index].args, ["pack", "--json", "--pack-destination", output, "--ignore-scripts=false"]);
    assert.equal(calls[index].options.cwd, entry.dir);
    assert.equal(archives[index].integrity, hash(readFileSync(join(output, archives[index].filename))));
  }
});

test("packPackages accepts npm 12 keyed results with the same strict identity checks", (context) => {
  const { entries, output } = fixture(context);
  const archives = packPackages(
    entries,
    output,
    packRunner([], ([archive]) => ({ [archive.name]: archive })),
  );
  assert.equal(archives.length, 2);
  assert.deepEqual(receipt(output), { archives });
});

test("packPackages rejects mismatched npm metadata and integrity", (context) => {
  const { entries, output } = fixture(context);
  for (const patch of [
    { name: "@other/name" },
    { version: "0.2.0-alpha.1" },
    { filename: "../escape.tgz" },
    { integrity: "sha512-wrong" },
  ]) {
    assert.throws(
      () =>
        packPackages(
          entries,
          output,
          packRunner([], ([archive]) => [{ ...archive, ...patch }]),
        ),
      /Unexpected npm pack result/,
    );
  }
  assert.throws(
    () =>
      packPackages(
        entries,
        output,
        packRunner([], (archives) => [...archives, ...archives]),
      ),
    /Unexpected npm pack result/,
  );
  assert.equal(existsSync(join(output, "release-assets.json")), false);
});

test("tarball publication requires explicit CLI-equivalent policy and never relies on hooks", (context) => {
  const { entries, output } = fixture(context);
  packPackages(entries, output, packRunner([]));
  const calls = [];
  const run = publishRunner(calls);
  for (const options of [
    {},
    { publish: "true" },
    { publish: true, registry: "https://registry.npmjs.org/" },
    { publish: true, tag: "latest" },
  ]) {
    assert.throws(() => publishPackages(entries, output, { ...options, run }), /Refusing publish/);
    assert.equal(calls.length, 0);
  }
  publishPackages(entries, output, { publish: true, run });
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["tar", "tar", "npm", "npm"],
  );
  const published = calls.filter(({ command }) => command === "npm");
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(published[index].args, [
      "publish",
      join(output, filename(entry.manifest)),
      "--registry",
      REGISTRY,
      "--tag",
      "alpha",
      "--ignore-scripts=false",
    ]);
    assert.equal(published[index].options.env.PI_CODEARTIFACT_PUBLISH, "1");
  }
});

test("all archive bytes and receipts are validated before any registry write", (context) => {
  const { entries, output } = fixture(context);
  const assertNoWrites = () => {
    const calls = [];
    assert.throws(() => publishPackages(entries, output, { publish: true, run: publishRunner(calls) }));
    assert.equal(
      calls.some(({ command }) => command === "npm"),
      false,
    );
  };
  packPackages(entries, output, packRunner([]));
  writeFileSync(join(output, filename(entries.at(-1).manifest)), "modified");
  assertNoWrites();
  packPackages(entries, output, packRunner([]));
  rmSync(join(output, filename(entries.at(-1).manifest)));
  assertNoWrites();
  packPackages(entries, output, packRunner([]));
  const original = receipt(output);
  for (const archives of [
    [],
    [original.archives[0], original.archives[0]],
    original.archives.map((item) => ({ ...item, filename: "../escape.tgz" })),
  ]) {
    writeFileSync(join(output, "release-assets.json"), JSON.stringify({ archives }));
    assertNoWrites();
  }
});

test("packed manifests cannot redirect the registry, identity, tag or version even with a matching receipt hash", (context) => {
  const { entries, output } = fixture(context);
  for (const patch of [
    { name: "@other/pi-effort" },
    { private: true },
    { version: "1.0.0-alpha.2" },
    { publishConfig: { registry: "https://registry.npmjs.org/" } },
    { publishConfig: { registry: REGISTRY, tag: "latest" } },
  ]) {
    packPackages(entries, output, packRunner([]));
    updateArchive(output, (manifest) => Object.assign(manifest, patch));
    const calls = [];
    assert.throws(() => publishPackages(entries, output, { publish: true, run: publishRunner(calls) }));
    assert.equal(
      calls.some(({ command }) => command === "npm"),
      false,
    );
  }
});

test("archive changed after preflight is rejected and publish failures stop the remaining selection", (context) => {
  const { entries, output } = fixture(context);
  packPackages(entries, output, packRunner([]));
  const calls = [];
  const run = publishRunner(calls);
  assert.throws(
    () =>
      publishPackages(entries, output, {
        publish: true,
        run(command, args, options) {
          const result = run(command, args, options);
          if (command === "tar" && calls.length === 2)
            writeFileSync(join(output, filename(entries[0].manifest)), "changed after preflight");
          return result;
        },
      }),
    /Modified archive/,
  );
  assert.equal(
    calls.some(({ command }) => command === "npm"),
    false,
  );
  packPackages(entries, output, packRunner([]));
  calls.length = 0;
  assert.throws(
    () =>
      publishPackages(entries, output, {
        publish: true,
        run(command, args, options) {
          if (command === "npm") throw new Error("simulated interruption");
          return run(command, args, options);
        },
      }),
    /simulated interruption/,
  );
});

test("direct npm lifecycle guard enforces the same strict manifest policy", (context) => {
  const { base } = fixture(context);
  const cwd = join(base, "packages", "pi-clear");
  const guard = join(base, "scripts", "check-release-registry.mjs");
  const env = { ...process.env, npm_config_registry: REGISTRY, npm_config_tag: "alpha", PI_CODEARTIFACT_PUBLISH: "1" };
  assert.equal(spawnSync(process.execPath, [guard], { cwd, env }).status, 0);
  for (const patch of [
    { npm_config_registry: "https://registry.npmjs.org/" },
    { npm_config_tag: "latest" },
    { PI_CODEARTIFACT_PUBLISH: "0" },
  ])
    assert.equal(spawnSync(process.execPath, [guard], { cwd, env: { ...env, ...patch } }).status, 1);
  for (const patch of [{ name: "@upstart/pi-effort" }, { private: true }, { version: "0.1.0-alpha.01" }]) {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ ...manifestFor("clear"), ...patch }));
    assert.equal(spawnSync(process.execPath, [guard], { cwd, env }).status, 1);
  }
});
