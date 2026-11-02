// Scheduled Pi host contract canary: install one released Pi into an isolated temporary prefix with
// every @earendil-works package at the same version, confirm it is in the supported host range, and run
// the offline contract tests against it. Usage: node scripts/pi-contract-canary.mjs <1.2.0|latest>
//
// This is compatibility reporting, not npm enforcement. A version outside the supported range is reported
// as an unsupported-upgrade investigation and fails without being tested or treated as supported.
// Registry, install, and coherence failures also fail: an unverified Pi must never look compatible.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUPPORTED_RANGE = ">=1.2.0 <2.0.0";
const ROOT_PACKAGE = "@earendil-works/pi-coding-agent";
const SCOPE = "@earendil-works/";
const REGISTRY = "https://registry.npmjs.org/";
const repository = fileURLToPath(new URL("..", import.meta.url));
const CONTRACT_TESTS = ["extensions/router/pi-contract.test.mjs", "extensions/router/review-runner.test.mjs"];

/** Whether a resolved release is inside SUPPORTED_RANGE. Prereleases and malformed versions are not. */
export function isSupportedPi(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major === 1 && minor >= 2;
}

/** Every @earendil-works package reachable from the root package, each required at exactly `version`. */
export function lockstepPackages(version, view) {
  const names = new Set([ROOT_PACKAGE]);
  const pending = [ROOT_PACKAGE];
  while (pending.length > 0) {
    const name = pending.shift();
    const manifest = view(`${name}@${version}`);
    if (manifest?.version !== version)
      throw new Error(`${name}@${version} is not published; the Pi ${version} release is not coherent`);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      if (dependency.startsWith(SCOPE) && !names.has(dependency)) {
        names.add(dependency);
        pending.push(dependency);
      }
  }
  return [...names].sort();
}

/** Every installed @earendil-works package, including nested copies, as `{ name, version, path }`. */
export function installedPiPackages(directory) {
  const found = [];
  const visit = (modules) => {
    let entries;
    try {
      entries = readdirSync(modules, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packages = entry.name.startsWith("@")
        ? readdirSync(join(modules, entry.name), { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => join(modules, entry.name, child.name))
        : [join(modules, entry.name)];
      for (const path of packages) {
        if (entry.name === "@earendil-works") {
          const { name, version } = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
          found.push({ name, version, path });
        }
        visit(join(path, "node_modules"));
      }
    }
  };
  visit(join(directory, "node_modules"));
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function npm(args, options = {}) {
  // The cooldown is waived (as in check.yml) so `latest` means the dist-tag, even for a release from today.
  return execFileSync("npm", [...args, `--registry=${REGISTRY}`, "--min-release-age=0"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

/** One release's manifest fields; npm prints an array when a spec matches several releases. */
function view(spec) {
  const result = JSON.parse(npm(["view", spec, "name", "version", "dependencies", "--json"]));
  const manifests = Array.isArray(result) ? result : [result];
  if (manifests.length !== 1) throw new Error(`${spec} matched ${String(manifests.length)} releases, not one`);
  return manifests[0];
}

function summary(lines) {
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

function main() {
  const spec = process.argv[2];
  if (!spec) throw new Error("usage: node scripts/pi-contract-canary.mjs <version|latest>");
  const version = view(`${ROOT_PACKAGE}@${spec}`).version;
  if (typeof version !== "string") throw new Error(`${ROOT_PACKAGE}@${spec} did not resolve to one release`);
  if (!isSupportedPi(version)) {
    const message = `${ROOT_PACKAGE}@${spec} resolved to ${version}, outside the supported ${SUPPORTED_RANGE} range. Open an unsupported-upgrade investigation; do not expand the supported range from this canary.`;
    console.log(`::error title=Unsupported Pi upgrade investigation::${message}`);
    summary([`## Pi contract canary: ${spec} → ${version}`, "", `**Unsupported upgrade investigation:** ${message}`]);
    process.exitCode = 1;
    return;
  }
  const packages = lockstepPackages(version, view);
  const prefix = mkdtempSync(join(tmpdir(), `pi-contract-${version}-`));
  try {
    writeFileSync(join(prefix, "package.json"), '{"private":true}\n');
    npm(
      [
        "install",
        "--prefix",
        prefix,
        "--no-save",
        "--package-lock=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...packages.map((name) => `${name}@${version}`),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const installed = installedPiPackages(prefix);
    const incoherent = installed.filter((entry) => entry.version !== version);
    summary([
      `## Pi contract canary: ${spec} → ${version}`,
      "",
      "| Package | Installed | Path |",
      "| --- | --- | --- |",
      ...installed.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.path.slice(prefix.length)} |`),
    ]);
    if (incoherent.length > 0 || !packages.every((name) => installed.some((entry) => entry.name === name)))
      throw new Error(`The Pi ${version} fixture is not coherent: ${JSON.stringify(incoherent)}`);
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(repository, "scripts", "pi-contract-hooks.mjs")).href,
        "--test",
        ...CONTRACT_TESTS,
      ],
      {
        cwd: repository,
        stdio: "inherit",
        env: { ...process.env, PI_CONTRACT_FIXTURE: prefix, PI_CONTRACT_EXPECTED_VERSION: version },
      },
    );
    if (run.status !== 0) {
      summary(["", `**Pi ${version} contract drift:** the offline contract tests failed; see the job log.`]);
      process.exitCode = 1;
      return;
    }
    summary(["", `Pi ${version} satisfies the router's host contract.`]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
