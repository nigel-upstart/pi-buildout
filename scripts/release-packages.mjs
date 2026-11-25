#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const REGISTRY = "https://code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/";
const packages = new Map([
  ["router-otel", "pi-router-otel"],
  ["clear", "pi-clear"],
  ["effort", "pi-effort"],
  ["markdown-backlinks", "pi-markdown-backlinks"],
  ["subagents", "pi-subagents"],
  ["skills-patch", "pi-skills-patch"],
]);

function usage() {
  console.log(
    `Usage: npm run release:packages -- --package <name>[,<name>...] [--package <name>...] [--publish]\n\nNames: ${[...packages.keys()].join(", ")}\nDefault: dry-run (stages and inspects package archives).\n--publish: publish selected packages to the fixed internal CodeArtifact registry. Requires npm auth setup and PI_CODEARTIFACT_PUBLISH=1 is set by this command.`,
  );
}

function parseArgs(args) {
  const selected = [];
  let publish = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--help" || args[i] === "-h") return { help: true };
    if (args[i] === "--publish") publish = true;
    else if (args[i] === "--package" || args[i] === "-p") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error("--package requires one or more package names");
      selected.push(
        ...args[++i]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!selected.length) throw new Error("Select at least one package with --package; use --help for usage");
  const unknown = selected.filter((name) => !packages.has(name));
  if (unknown.length) throw new Error(`Unknown package name(s): ${unknown.join(", ")}`);
  return { selected: [...new Set(selected)], publish };
}

export function isAlphaVersion(version) {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/.exec(version);
  return match?.[0] === version;
}

export function validateReleaseManifest(kind, manifest) {
  if (
    !packages.has(kind) ||
    manifest?.name !== `@upstart/${packages.get(kind)}` ||
    (manifest.private !== undefined && manifest.private !== false) ||
    manifest.publishConfig?.registry !== REGISTRY ||
    (manifest.publishConfig.tag !== undefined && manifest.publishConfig.tag !== "alpha") ||
    !isAlphaVersion(manifest.version)
  ) {
    throw new Error(
      `Invalid release manifest for ${kind}: require its expected @upstart name, non-private package, approved CodeArtifact registry and strict alpha.N version`,
    );
  }
}

export function readSelectedPackages(selected, base = root) {
  return selected.map((kind) => {
    if (!packages.has(kind)) throw new Error(`Unknown package name: ${kind}`);
    const dir = join(base, "packages", packages.get(kind));
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    validateReleaseManifest(kind, manifest);
    return { kind, dir, manifest };
  });
}

function integrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function filename(manifest) {
  return `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
}

export function packPackages(entries, output, run = execFileSync) {
  mkdirSync(output, { recursive: true });
  // Validate the entire selection before even running a package lifecycle script.
  for (const { kind, manifest } of entries) validateReleaseManifest(kind, manifest);
  const archives = entries.map(({ kind, dir, manifest }) => {
    const packed = JSON.parse(
      run("npm", ["pack", "--json", "--pack-destination", resolve(output), "--ignore-scripts=false"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
    // npm 11 returns an array; npm 12 keys results by package name.
    const result = Array.isArray(packed) ? packed : Object.values(packed);
    const archive = result[0];
    if (
      result.length !== 1 ||
      archive?.name !== manifest.name ||
      archive.version !== manifest.version ||
      archive.filename !== filename(manifest) ||
      archive.integrity !== integrity(join(output, archive.filename))
    ) {
      throw new Error(`Unexpected npm pack result for ${manifest.name}`);
    }
    return {
      kind,
      name: manifest.name,
      version: manifest.version,
      filename: archive.filename,
      integrity: archive.integrity,
    };
  });
  writeFileSync(join(output, "release-assets.json"), `${JSON.stringify({ archives }, null, 2)}\n`);
  return archives;
}

export function publishPackages(
  entries,
  output,
  { publish = false, registry = REGISTRY, tag = "alpha", run = execFileSync } = {},
) {
  // Publishing tarballs does not run prepublishOnly. Enforce its policy here, independently
  // of npm lifecycle configuration; only the CLI's explicit --publish supplies this opt-in.
  if (publish !== true || registry !== REGISTRY || tag !== "alpha") {
    throw new Error("Refusing publish: require explicit --publish, the approved CodeArtifact registry and alpha tag");
  }
  const { archives } = JSON.parse(readFileSync(join(output, "release-assets.json"), "utf8"));
  if (!Array.isArray(archives) || archives.length !== entries.length) throw new Error("Invalid release receipt");
  const pending = entries.map(({ kind, manifest }) => {
    validateReleaseManifest(kind, manifest);
    const matches = archives.filter((item) => item.kind === kind);
    const archive = matches[0];
    if (
      matches.length !== 1 ||
      archive.name !== manifest.name ||
      archive.version !== manifest.version ||
      archive.filename !== filename(manifest) ||
      archive.integrity !== integrity(join(output, archive.filename))
    ) {
      throw new Error(`Missing or modified archive for ${manifest.name}@${manifest.version}`);
    }
    const path = resolve(output, archive.filename);
    // npm can apply publishConfig from inside a tarball. Check that manifest too, not
    // just the checkout/receipt, so it cannot redirect the write or change package identity.
    const packed = JSON.parse(run("tar", ["-xOzf", path, "package/package.json"], { encoding: "utf8" }));
    validateReleaseManifest(kind, packed);
    if (packed.version !== manifest.version) throw new Error(`Unexpected packed version for ${manifest.name}`);
    return { path, archive };
  });
  for (const { path, archive } of pending) {
    if (integrity(path) !== archive.integrity) throw new Error(`Modified archive: ${archive.filename}`);
    run("npm", ["publish", path, "--registry", REGISTRY, "--tag", "alpha", "--ignore-scripts=false"], {
      stdio: "inherit",
      env: { ...process.env, PI_CODEARTIFACT_PUBLISH: "1" },
    });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const releaseList = readSelectedPackages(options.selected);
  if (!options.publish) {
    for (const { dir, manifest } of releaseList) {
      console.log(`\nDry run: ${manifest.name}@${manifest.version}`);
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts=false"], { cwd: dir, stdio: "inherit" });
    }
    return;
  }
  // Pack every selection before the first registry write. The temporary receipt binds
  // this invocation's packed bytes to publication; separate dry runs remain previews.
  const output = mkdtempSync(join(tmpdir(), "pi-release-"));
  try {
    console.log(JSON.stringify({ archives: packPackages(releaseList, output) }, null, 2));
    publishPackages(releaseList, output, { publish: true });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    main();
  } catch (error) {
    console.error(`release:packages: ${error.message}`);
    process.exitCode = 1;
  }
}
