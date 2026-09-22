/**
 * Locates clean pi packages for the version-specific `/skills` patch tests.
 *
 * The repository's development dependency pins one pi version (see `package.json`), but the patch tests run
 * for every version with an overlay. A test for another version needs an unpatched package of exactly that
 * version, supplied through `PI_SKILLS_TEST_PACKAGES`: a list of package directories separated by the
 * platform path delimiter (`:` on POSIX). Each directory must contain pi's `package.json`, `dist/`, `docs/`,
 * and a resolvable `node_modules/` (a symlink is fine). Tests only read these directories; they copy what
 * they patch into temporary trees.
 *
 * A version with no matching clean package is skipped with the reason, never silently passed.
 */

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sortVersions } from "./build-pi-patch.mjs";

export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every version that has both an authored overlay and committed patch artifacts. */
export function patchVersions() {
  const versionsRoot = join(repositoryRoot, "pi-overlay", "versions");
  return sortVersions(
    readdirSync(versionsRoot).filter(
      (version) =>
        existsSync(join(versionsRoot, version, "upstream.json")) &&
        existsSync(join(repositoryRoot, "patches", `pi-${version}`, "skills.patch")),
    ),
  );
}

export function patchDirectoryFor(version) {
  return join(repositoryRoot, "patches", `pi-${version}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function candidatePackageRoots() {
  const configured = (process.env.PI_SKILLS_TEST_PACKAGES ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
  return [...configured, join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent")];
}

/** Explains why `packageRoot` is not a clean package for `version`, or returns undefined when it is. */
async function cleanPackageProblem(packageRoot, version, requireDependencies) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!(await exists(packageJsonPath))) return `${packageRoot} has no package.json`;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== version) return `${packageRoot} is pi ${String(packageJson.version)}`;
  if (requireDependencies && !(await exists(join(packageRoot, "node_modules"))))
    return `${packageRoot} has no node_modules`;

  const patchDirectory = patchDirectoryFor(version);
  const baseline = await readFile(join(patchDirectory, "baseline.sha256"), "utf8");
  for (const line of baseline.trim().split("\n")) {
    const [expected, relativePath] = line.trim().split(/\s+/u, 2);
    const path = relativePath ? join(packageRoot, relativePath) : undefined;
    if (!expected || !path || !(await exists(path)) || (await sha256(path)) !== expected) {
      return `${packageRoot} does not match the ${version} baseline at ${relativePath ?? "an unknown path"}`;
    }
  }
  const absent = await readFile(join(patchDirectory, "baseline.absent"), "utf8");
  for (const relativePath of absent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (await exists(join(packageRoot, relativePath))) {
      return `${packageRoot} does not match the ${version} baseline at ${relativePath}`;
    }
  }
  return undefined;
}

/**
 * Finds a clean package for `version`, by default one whose dependencies are installed so it can run.
 *
 * @param {string} version
 * @param {{ requireDependencies?: boolean }} [options]
 * @returns {Promise<{ packageRoot: string; problem?: undefined } | { packageRoot?: undefined; problem: string }>}
 */
export async function findCleanPackage(version, { requireDependencies = true } = {}) {
  const problems = [];
  for (const packageRoot of candidatePackageRoots()) {
    const problem = await cleanPackageProblem(packageRoot, version, requireDependencies);
    if (problem === undefined) return { packageRoot };
    problems.push(problem);
  }
  return {
    problem:
      `no clean pi ${version} package is available (${problems.join("; ")}); ` +
      "set PI_SKILLS_TEST_PACKAGES to provide one",
  };
}
