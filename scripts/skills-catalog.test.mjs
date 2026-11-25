import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { applyPatchFile, sortVersions } from "./build-pi-patch.mjs";
import { findCleanPackage, patchDirectoryFor, patchVersions, repositoryRoot } from "./skills-patch-packages.mjs";

// The catalog fixture replaces HOME, but the installer locates pi through PI_PACKAGE_DIR and
// PI_AGENT_DIR, so it keeps the real HOME. Version-manager shims such as mise resolve `node` and
// `npm` from configuration under HOME and fail when it points at the fixture.
const installerHome = process.env.HOME;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

async function verifyManifest(patchDirectory, target, manifestName) {
  const manifest = await readFile(join(patchDirectory, manifestName), "utf8");
  for (const line of manifest.trim().split("\n")) {
    const [expected, relativePath] = line.trim().split(/\s+/, 2);
    assert.ok(expected && relativePath, `${manifestName} contains a malformed entry`);
    assert.equal(await sha256(join(target, relativePath)), expected, relativePath);
  }
}

async function applyPatch(target, source, reverse = false) {
  if (applyPatchFile(source, target, { reverse }) !== 0) {
    throw new Error("patch exited with a non-zero status");
  }
}

const gitEnvironmentKeys = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

function testEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of gitEnvironmentKeys) {
    delete env[key];
  }
  return env;
}

async function runPatchedCli(target, args, { agentDir, cwd, home = process.env.HOME, input, env = {} }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(target, "dist", "bundle", "cli.js"), ...args], {
      cwd,
      env: testEnvironment({
        ...(home === undefined ? {} : { HOME: home }),
        ...env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      }),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input);
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

/** Copies a clean package, optionally applies `patchDirectory`'s patch, and verifies the expected state. */
async function copyPackage(packageRoot, target, patchDirectory, { patched = true } = {}) {
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(join(packageRoot, "dist"), join(target, "dist"), { recursive: true }),
    cp(join(packageRoot, "docs"), join(target, "docs"), { recursive: true }),
    copyFile(join(packageRoot, "package.json"), join(target, "package.json")),
  ]);
  // Pi 1.1.0 can hoist dependencies outside its own node_modules. Link the packages
  // Node actually searches so a fixture outside this checkout has the same imports.
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const resolver = createRequire(join(packageRoot, "package.json"));
  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    const candidates = resolver.resolve.paths(name) ?? [];
    let dependency;
    for (const directory of candidates) {
      const candidate = join(directory, name);
      if (await exists(join(candidate, "package.json"))) {
        dependency = candidate;
        break;
      }
    }
    assert.ok(dependency, `Pi runtime dependency ${name} must be installed`);
    const destination = join(target, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(dependency, destination, process.platform === "win32" ? "junction" : "dir");
  }
  if (patched) {
    await applyPatch(target, join(patchDirectory, "skills.patch"));
    await verifyManifest(patchDirectory, target, "patched.sha256");
  }
}

async function runInstaller(packageDirectory, agentDirectory) {
  return new Promise((resolvePromise, reject) => {
    // This suite exercises the versioned /skills patch, not router extension compatibility.
    const child = spawn("bash", [join(repositoryRoot, "scripts", "install-extensions.sh"), "--skip-extensions"], {
      env: testEnvironment({ HOME: installerHome, PI_AGENT_DIR: agentDirectory, PI_PACKAGE_DIR: packageDirectory }),
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
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function writeSkill(skillDirectory, name, description) {
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runGit(cwd, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, env: testEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git exited with code ${String(code)}: ${stderr.trim()}`));
    });
  });
}

async function addSkillsConcurrently(patchedPackage, sources, scope, options) {
  const results = await Promise.all(
    sources.map((source) => runPatchedCli(patchedPackage, ["skills", "add", source, `--${scope}`], options)),
  );
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
}

/** Every recorded already-patched state for a version, by the label its `<label>-upgrade.patch` carries. */
async function upgradeStates(patchDirectory) {
  const names = await readdir(patchDirectory);
  return names
    .filter((name) => name.endsWith("-upgrade.patch"))
    .map((name) => name.slice(0, -"-upgrade.patch".length))
    .sort();
}

for (const version of patchVersions()) {
  const patchDirectory = patchDirectoryFor(version);

  test(`pi ${version}: the patched catalog resolves fixed, package, and settings skills with trust and precedence`, async (t) => {
    const { packageRoot, problem } = await findCleanPackage(version);
    if (packageRoot === undefined) {
      t.skip(problem);
      return;
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-skills-catalog-"));
    const patchedPackage = join(temporaryRoot, "package");
    const fixtureRoot = join(temporaryRoot, "fixtures");
    const cwd = join(fixtureRoot, "project");
    const projectConfig = join(cwd, ".pi");
    const agentDir = join(fixtureRoot, "agent");
    const previousHome = process.env.HOME;
    const previousGitEnvironment = new Map(gitEnvironmentKeys.map((key) => [key, process.env[key]]));

    try {
      // The imported Pi shell also runs Git in this process, not only in CLI children.
      for (const key of gitEnvironmentKeys) delete process.env[key];
      process.env.HOME = join(fixtureRoot, "home");
      // Keep ancestor skill discovery inside this fixture, including when TMPDIR is in the checkout.
      await mkdir(cwd, { recursive: true });
      await runGit(cwd, ["init", "--quiet"]);
      try {
        await copyPackage(packageRoot, patchedPackage, patchDirectory);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          t.skip("the patch utility is unavailable");
          return;
        }
        throw error;
      }

      // The installer applies the patch to a clean package of this version.
      const cleanPackage = join(temporaryRoot, "clean-package");
      await copyPackage(packageRoot, cleanPackage, patchDirectory, { patched: false });
      const cleanInstall = await runInstaller(cleanPackage, join(temporaryRoot, "clean-installer-agent"));
      assert.equal(cleanInstall.code, 0, cleanInstall.stderr);
      assert.match(
        cleanInstall.stdout,
        new RegExp(`Applied /skills patch for pi ${version.replaceAll(".", "\\.")}`, "u"),
      );
      await verifyManifest(patchDirectory, cleanPackage, "patched.sha256");

      // Every recorded already-patched state is reconstructed from the current tree and upgraded in place.
      for (const state of await upgradeStates(patchDirectory)) {
        const statePackage = join(temporaryRoot, `${state}-package`);
        await copyPackage(packageRoot, statePackage, patchDirectory);
        await applyPatch(statePackage, join(patchDirectory, `${state}-upgrade.patch`), true);
        await verifyManifest(patchDirectory, statePackage, `${state}-patched.sha256`);
        const stateResult = await runInstaller(statePackage, join(temporaryRoot, `${state}-agent`));
        assert.equal(stateResult.code, 0, `${state}: ${stateResult.stderr}`);
        assert.match(stateResult.stdout, /Upgrading a previously applied \/skills patch/u, state);
        await verifyManifest(patchDirectory, statePackage, "patched.sha256");
      }

      await Promise.all([
        writeSkill(join(agentDir, "skills", "fixed"), "fixed-choice", "global fixed directory"),
        writeSkill(join(projectConfig, "skills", "fixed"), "fixed-choice", "project fixed directory"),
        writeSkill(
          join(agentDir, "packages", "convention", "skills", "directory"),
          "package-directory",
          "package convention directory",
        ),
        writeSkill(
          join(projectConfig, "packages", "manifest", "declared"),
          "package-manifest",
          "package pi.skills declaration",
        ),
        writeSkill(join(agentDir, "packages", "global-choice", "skills", "choice"), "package-choice", "global package"),
        writeSkill(
          join(projectConfig, "packages", "project-choice", "skills", "choice"),
          "package-choice",
          "project package",
        ),
        writeSkill(
          join(agentDir, "packages", "cross-group", "skills", "choice"),
          "package-vs-setting",
          "package group",
        ),
        writeSkill(join(agentDir, "settings", "global"), "setting-global", "global settings.skills"),
        writeSkill(join(projectConfig, "settings", "project"), "setting-project", "project settings.skills"),
        writeSkill(join(agentDir, "settings", "global-choice"), "settings-choice", "global setting"),
        writeSkill(join(projectConfig, "settings", "project-choice"), "settings-choice", "project setting"),
        writeSkill(join(agentDir, "settings", "cross-group"), "package-vs-setting", "settings group"),
      ]);
      await Promise.all([
        writeJson(join(projectConfig, "packages", "manifest", "package.json"), {
          pi: { skills: ["./declared"] },
        }),
        writeJson(join(agentDir, "settings.json"), {
          defaultProjectTrust: "always",
          packages: ["./packages/convention", "./packages/global-choice", "./packages/cross-group"],
          skills: ["./settings/global", "./settings/global-choice", "./settings/cross-group"],
        }),
        writeJson(join(projectConfig, "settings.json"), {
          packages: ["./packages/manifest", "./packages/project-choice"],
          skills: ["./settings/project", "./settings/project-choice"],
        }),
        writeJson(join(agentDir, "skills.json"), {
          enabled: ["package-directory", "setting-global"],
        }),
      ]);

      const moduleUrl = (relativePath) => pathToFileURL(join(patchedPackage, relativePath)).href;
      const [
        { SettingsManager },
        { getSkillCatalog, normalizeGitRemoteUrl, resolveSkillEntryPath, runSkillsCommand },
        { DefaultResourceLoader },
      ] = await Promise.all([
        import(moduleUrl("dist/core/settings-manager.js")),
        import(moduleUrl("dist/core/skill-management.js")),
        import(moduleUrl("dist/core/resource-loader.js")),
      ]);
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

      const normalizedPathAgentDir = join(fixtureRoot, "normalized-path-agent");
      const temporaryHome = join(fixtureRoot, "home");
      const homeSkill = join(temporaryHome, "skills", "home-skill");
      const relativeSkill = join(cwd, "relative-skill");
      const bareRelativeSkill = join(cwd, "bare-relative-skill");
      await Promise.all([
        writeSkill(homeSkill, "home-skill", "tilde path fixture"),
        writeSkill(relativeSkill, "relative-skill", "relative path fixture"),
        writeSkill(bareRelativeSkill, "bare-relative-skill", "bare relative path fixture"),
      ]);
      for (const source of ["~/skills/home-skill", "./relative-skill", "bare-relative-skill"]) {
        const result = await runPatchedCli(patchedPackage, ["skills", "add", source, "--global"], {
          cwd,
          agentDir: normalizedPathAgentDir,
          home: temporaryHome,
        });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
      }
      const normalizedConfig = JSON.parse(await readFile(join(normalizedPathAgentDir, "skills.json"), "utf8"));
      const canonicalCwd = await realpath(cwd);
      assert.deepEqual(normalizedConfig.enabled, [
        "~/skills/home-skill",
        join(canonicalCwd, "relative-skill"),
        join(canonicalCwd, "bare-relative-skill"),
      ]);

      // A bare name persisted as a path must stay removable by that name once the path is gone.
      await rm(bareRelativeSkill, { recursive: true, force: true });
      const removedBare = await runPatchedCli(patchedPackage, ["skills", "remove", "bare-relative-skill", "--global"], {
        cwd,
        agentDir: normalizedPathAgentDir,
        home: temporaryHome,
      });
      assert.equal(removedBare.code, 0, removedBare.stderr);
      assert.deepEqual(JSON.parse(await readFile(join(normalizedPathAgentDir, "skills.json"), "utf8")).enabled, [
        "~/skills/home-skill",
        join(canonicalCwd, "relative-skill"),
      ]);

      assert.equal(normalizeGitRemoteUrl("https://git.example.com:8443/org/repo.git"), "git.example.com:8443:org/repo");
      assert.equal(normalizeGitRemoteUrl("https://git.example.com:9443/org/repo.git"), "git.example.com:9443:org/repo");
      assert.equal(normalizeGitRemoteUrl("git@github.com:org/repo.git"), "github.com:org/repo");
      assert.equal(normalizeGitRemoteUrl("ssh://git@github.com/org/repo.git"), "github.com:org/repo");
      assert.equal(normalizeGitRemoteUrl("ssh://git@github.com:22/org/repo.git"), "github.com:org/repo");
      assert.equal(normalizeGitRemoteUrl("ssh://git@github.com:2222/org/repo.git"), "github.com:2222:org/repo");

      for (const invalidConfig of [[], null, "fixed-choice", 1]) {
        await writeJson(join(agentDir, "skills.json"), invalidConfig);
        const result = await runSkillsCommand(["active"], { cwd, agentDir, settingsManager });
        assert.equal(result.exitCode, 1);
        assert.deepEqual(result.lines, [`Could not parse ${join(agentDir, "skills.json")}: Expected a JSON object`]);
      }
      await writeJson(join(agentDir, "skills.json"), {
        enabled: ["package-directory", "setting-global"],
      });

      const invalidCommand = await runPatchedCli(patchedPackage, ["skills", "unknown"], { agentDir, cwd });
      assert.equal(invalidCommand.code, 1);
      assert.equal(invalidCommand.stdout, "");
      assert.match(invalidCommand.stderr, /Usage: pi skills/);

      const catalog = await getSkillCatalog({ cwd, agentDir, settingsManager });
      const catalogByName = new Map(catalog.map((skill) => [skill.name, skill]));

      assert.deepEqual(
        catalog.map((skill) => skill.name),
        [
          "fixed-choice",
          "package-choice",
          "package-directory",
          "package-manifest",
          "package-vs-setting",
          "setting-global",
          "setting-project",
          "settings-choice",
        ],
      );
      assert.equal(catalogByName.get("fixed-choice")?.description, "global fixed directory");
      assert.equal(catalogByName.get("package-choice")?.description, "project package");
      assert.equal(catalogByName.get("package-vs-setting")?.description, "package group");
      assert.equal(catalogByName.get("settings-choice")?.description, "project setting");

      const listResult = await runSkillsCommand(["list"], { cwd, agentDir, settingsManager });
      assert.equal(listResult.exitCode, 0);
      assert.deepEqual(
        listResult.lines,
        catalog.map((skill) => `${skill.name}\t${skill.description}`),
        "CLI and interactive command callers share the same catalog output",
      );
      const cliList = await runPatchedCli(patchedPackage, ["skills", "list"], { agentDir, cwd });
      assert.equal(cliList.code, 0);
      assert.equal(cliList.stderr, "");
      assert.deepEqual(cliList.stdout.trim().split("\n"), listResult.lines);

      const concurrentRoot = join(fixtureRoot, "concurrent-updates");
      const concurrentSources = Array.from({ length: 12 }, (_, index) =>
        join(concurrentRoot, "skills", `skill-${String(index)}`),
      );
      await Promise.all(
        concurrentSources.map((source, index) => writeSkill(source, `concurrent-${String(index)}`, "lock fixture")),
      );
      const seededEntries = Array.from({ length: 3_000 }, (_, index) => `existing-${String(index)}`);

      const concurrentGlobalAgentDir = join(concurrentRoot, "global-agent");
      const globalConfigPath = join(concurrentGlobalAgentDir, "skills.json");
      await writeJson(globalConfigPath, { enabled: seededEntries });
      await addSkillsConcurrently(patchedPackage, concurrentSources, "global", {
        agentDir: concurrentGlobalAgentDir,
        cwd,
      });
      const globalConfig = JSON.parse(await readFile(globalConfigPath, "utf8"));
      assert.equal(globalConfig.enabled.length, seededEntries.length + concurrentSources.length);
      assert.deepEqual(new Set(globalConfig.enabled), new Set([...seededEntries, ...concurrentSources]));
      assert.equal(await exists(`${globalConfigPath}.lock`), false);

      const concurrentRepoAgentDir = join(concurrentRoot, "repo-agent");
      const concurrentRepo = join(concurrentRoot, "repo");
      await mkdir(concurrentRepo, { recursive: true });
      await runGit(concurrentRepo, ["init", "--quiet"]);
      await runGit(concurrentRepo, ["remote", "add", "origin", "https://example.com/org/repo.git"]);
      const repoConfigPath = join(concurrentRepoAgentDir, "repo-skills.json");
      const repoKey = "example.com:org/repo";
      await writeJson(repoConfigPath, { [repoKey]: { enabled: seededEntries } });
      await addSkillsConcurrently(patchedPackage, concurrentSources, "repo", {
        agentDir: concurrentRepoAgentDir,
        cwd: concurrentRepo,
      });
      const repoConfig = JSON.parse(await readFile(repoConfigPath, "utf8"));
      assert.equal(repoConfig[repoKey].enabled.length, seededEntries.length + concurrentSources.length);
      assert.deepEqual(new Set(repoConfig[repoKey].enabled), new Set([...seededEntries, ...concurrentSources]));
      assert.equal(await exists(`${repoConfigPath}.lock`), false);

      // `/skills` arguments never pass through a shell, so the module expands variables itself. A spelling that
      // resolves now is persisted as typed and expanded again whenever skills load.
      const variableRoot = join(fixtureRoot, "variable-paths");
      const variableSkill = join(variableRoot, "skills", "expanded");
      await writeSkill(variableSkill, "expanded-variable", "variable fixture");
      const variableAgentDir = join(variableRoot, "agent");
      const variableOptions = {
        agentDir: variableAgentDir,
        cwd,
        env: { PI_SKILLS_FIXTURE: join(variableRoot, "skills") },
      };
      const variableAdd = await runPatchedCli(
        patchedPackage,
        ["skills", "add", "${PI_SKILLS_FIXTURE}/expanded", "--global"],
        variableOptions,
      );
      assert.equal(variableAdd.code, 0, variableAdd.stderr);
      const variableConfig = JSON.parse(await readFile(join(variableAgentDir, "skills.json"), "utf8"));
      assert.deepEqual(variableConfig.enabled, ["${PI_SKILLS_FIXTURE}/expanded"]);
      const previousVariable = process.env.PI_SKILLS_FIXTURE;
      try {
        process.env.PI_SKILLS_FIXTURE = join(variableRoot, "skills");
        const variableLoader = new DefaultResourceLoader({
          cwd,
          agentDir: variableAgentDir,
          settingsManager: SettingsManager.create(cwd, variableAgentDir, { projectTrusted: false }),
        });
        await variableLoader.reload();
        assert.deepEqual(
          variableLoader.getSkills().skills.map((skill) => skill.name),
          ["expanded-variable"],
        );
        const movedRoot = join(variableRoot, "moved");
        await writeSkill(join(movedRoot, "expanded"), "expanded-after-reload", "reload fixture");
        process.env.PI_SKILLS_FIXTURE = movedRoot;
        await variableLoader.reload();
        assert.deepEqual(
          variableLoader.getSkills().skills.map((skill) => skill.name),
          ["expanded-after-reload"],
        );
        assert.deepEqual(JSON.parse(await readFile(join(variableAgentDir, "skills.json"), "utf8")).enabled, [
          "${PI_SKILLS_FIXTURE}/expanded",
        ]);
      } finally {
        if (previousVariable === undefined) delete process.env.PI_SKILLS_FIXTURE;
        else process.env.PI_SKILLS_FIXTURE = previousVariable;
      }
      const variableRemove = await runPatchedCli(
        patchedPackage,
        ["skills", "remove", "$PI_SKILLS_FIXTURE/expanded", "--global"],
        variableOptions,
      );
      assert.equal(variableRemove.code, 0, variableRemove.stderr);
      assert.deepEqual(JSON.parse(await readFile(join(variableAgentDir, "skills.json"), "utf8")).enabled, []);
      const unsetVariable = await runPatchedCli(
        patchedPackage,
        ["skills", "add", "$PI_SKILLS_UNSET_FIXTURE/expanded", "--global"],
        variableOptions,
      );
      assert.equal(unsetVariable.code, 1);
      assert.match(unsetVariable.stderr, /environment variable \$PI_SKILLS_UNSET_FIXTURE is not set/u);

      // A checkout-relative entry follows the remote identity, but activating another clone's
      // files requires that clone's own project-trust decision.
      const cloneRoot = join(fixtureRoot, "clones");
      const [firstClone, secondClone] = [join(cloneRoot, "first"), join(cloneRoot, "second")];
      const cloneAgentDir = join(cloneRoot, "agent");
      for (const clone of [firstClone, secondClone]) {
        await mkdir(clone, { recursive: true });
        await runGit(clone, ["init", "--quiet"]);
        await runGit(clone, ["remote", "add", "origin", "https://example.com/org/cloned.git"]);
        await writeSkill(join(clone, ".agents", "skills", "cloned"), "cloned-skill", "clone fixture");
      }
      const cloneAdd = await runPatchedCli(patchedPackage, ["skills", "add", "./.agents/skills/cloned", "--repo"], {
        agentDir: cloneAgentDir,
        cwd: firstClone,
      });
      assert.equal(cloneAdd.code, 0, cloneAdd.stderr);
      const cloneConfig = JSON.parse(await readFile(join(cloneAgentDir, "repo-skills.json"), "utf8"));
      assert.deepEqual(cloneConfig["example.com:org/cloned"].enabled, [".agents/skills/cloned"]);
      const cloneLoader = new DefaultResourceLoader({
        cwd: secondClone,
        agentDir: cloneAgentDir,
        settingsManager: SettingsManager.create(secondClone, cloneAgentDir, { projectTrusted: false }),
      });
      await cloneLoader.reload();
      assert.deepEqual(cloneLoader.getSkills().skills, [], "an untrusted clone cannot supply active skill metadata");
      const trustedCloneLoader = new DefaultResourceLoader({
        cwd: secondClone,
        agentDir: cloneAgentDir,
        settingsManager: SettingsManager.create(secondClone, cloneAgentDir, { projectTrusted: true }),
      });
      await trustedCloneLoader.reload();
      assert.deepEqual(
        trustedCloneLoader.getSkills().skills.map((skill) => [skill.name, skill.filePath]),
        [["cloned-skill", join(await realpath(secondClone), ".agents", "skills", "cloned", "SKILL.md")]],
      );

      // Entry resolution lives in the skill-management module, so DefaultResourceLoader keeps no skill API.
      const entryContext = { cwd, agentDir, settingsManager, resolveResourcePath: (path) => path };
      for (const name of ["package-manifest", "setting-project"]) {
        const { resolved } = await resolveSkillEntryPath(entryContext, name);
        assert.equal(resolved, catalogByName.get(name)?.filePath, name);
      }

      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
      await loader.reload();
      assert.deepEqual(
        loader.getSkills().skills.map((skill) => skill.name),
        ["package-directory", "setting-global"],
        "catalog discovery does not activate skills that were not explicitly enabled",
      );

      // Exercise each activation surface against the real versioned loader, not just the shared core.
      const optInAgentDir = join(fixtureRoot, "opt-in-agent");
      const catalogOnlySkill = join(optInAgentDir, "skills", "catalog-only");
      const repoSkill = join(fixtureRoot, "repo-enabled");
      await writeSkill(catalogOnlySkill, "catalog-only", "inactive until explicitly enabled");
      await writeSkill(repoSkill, "repo-enabled", "repository activation fixture");
      const optInSettings = SettingsManager.create(cwd, optInAgentDir, { projectTrusted: false });
      const optInOptions = { cwd, agentDir: optInAgentDir, settingsManager: optInSettings };
      const defaultLoader = new DefaultResourceLoader(optInOptions);
      await defaultLoader.reload();
      assert.deepEqual(defaultLoader.getSkills().skills, [], "discovered directory skills start inactive");

      await runGit(cwd, ["remote", "add", "origin", "https://example.com/other/repo.git"]);
      await runGit(cwd, ["remote", "add", "upstream", "ssh://git@example.com:22/org/repo.git"]);
      await writeJson(join(optInAgentDir, "skills.json"), { enabled: ["catalog-only"] });
      await writeJson(join(optInAgentDir, "repo-skills.json"), {
        "example.com:org/repo": { enabled: [repoSkill] },
      });
      await defaultLoader.reload();
      assert.deepEqual(
        defaultLoader.getSkills().skills.map((skill) => skill.name),
        ["catalog-only", "repo-enabled"],
        "global and repository activation use the canonical upstream identity",
      );

      const disabledLoader = new DefaultResourceLoader({ ...optInOptions, noSkills: true });
      await disabledLoader.reload();
      assert.deepEqual(disabledLoader.getSkills().skills, [], "--no-skills suppresses both persisted scopes");
      const explicitLoader = new DefaultResourceLoader({
        ...optInOptions,
        noSkills: true,
        additionalSkillPaths: [repoSkill],
      });
      await explicitLoader.reload();
      assert.deepEqual(
        explicitLoader.getSkills().skills.map((skill) => skill.name),
        ["repo-enabled"],
        "explicit session/CLI skill paths survive --no-skills",
      );

      const untrustedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
      const untrustedCatalog = await getSkillCatalog({ cwd, agentDir, settingsManager: untrustedSettings });
      const untrustedByName = new Map(untrustedCatalog.map((skill) => [skill.name, skill]));
      assert.equal(untrustedByName.has("package-manifest"), false);
      assert.equal(untrustedByName.has("setting-project"), false);
      assert.equal(untrustedByName.get("package-choice")?.description, "global package");
      assert.equal(untrustedByName.get("settings-choice")?.description, "global setting");
    } finally {
      for (const [key, value] of previousGitEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

/** True when `version` is `minimum` or newer. */
function isAtLeast(version, minimum) {
  return sortVersions([version, minimum])[0] === minimum;
}

/**
 * Starts the patched host in RPC mode with an extension that records `ctx.isProjectTrusted()` at session start.
 * RPC mode starts a session without a model or provider request, so this stays offline.
 */
let trustProbeRuns = 0;
async function probeHostProjectTrust(patchedPackage, { agentDir, cwd, home, probeRoot }) {
  trustProbeRuns += 1;
  const extension = join(probeRoot, "trust-probe.mjs");
  const output = join(probeRoot, `trust-${String(trustProbeRuns)}.json`);
  await mkdir(probeRoot, { recursive: true });
  await writeFile(
    extension,
    `import { writeFileSync } from "node:fs";\n` +
      `export default function (pi) {\n` +
      `  pi.on("session_start", (_event, ctx) => {\n` +
      `    writeFileSync(process.env.PI_TRUST_PROBE_OUTPUT, JSON.stringify({ trusted: ctx.isProjectTrusted() }));\n` +
      `  });\n` +
      `}\n`,
  );
  const result = await runPatchedCli(patchedPackage, ["--mode", "rpc", "--no-session", "--extension", extension], {
    agentDir,
    cwd,
    home,
    input: `${JSON.stringify({ type: "get_state" })}\n`,
    env: { PI_TRUST_PROBE_OUTPUT: output },
  });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(await readFile(output, "utf8")).trusted;
}

// Regressions for upstream fixes that cross the patched seams: saved project distrust, skill diagnostic labels,
// and path identity between catalog names and explicit paths. Assertions about the fixed upstream behaviour run
// only for the versions that carry the fix; older versioned patches keep their own upstream behaviour.
for (const version of patchVersions()) {
  const patchDirectory = patchDirectoryFor(version);

  test(`pi ${version}: saved distrust, skill diagnostics, and path aliases survive the patched seams`, async (t) => {
    const { packageRoot, problem } = await findCleanPackage(version);
    if (packageRoot === undefined) {
      t.skip(problem);
      return;
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-skills-regressions-"));
    const patchedPackage = join(temporaryRoot, "package");
    const fixtureRoot = join(temporaryRoot, "fixtures");
    const home = join(fixtureRoot, "home");
    const agentDir = join(fixtureRoot, "agent");
    const previousHome = process.env.HOME;
    const previousGitEnvironment = new Map(gitEnvironmentKeys.map((key) => [key, process.env[key]]));

    try {
      for (const key of gitEnvironmentKeys) delete process.env[key];
      process.env.HOME = home;
      await mkdir(home, { recursive: true });
      try {
        await copyPackage(packageRoot, patchedPackage, patchDirectory);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          t.skip("the patch utility is unavailable");
          return;
        }
        throw error;
      }

      const moduleUrl = (relativePath) => pathToFileURL(join(patchedPackage, relativePath)).href;
      const [{ SettingsManager }, { DefaultResourceLoader }, { ProjectTrustStore }, { resolveProjectTrusted }] =
        await Promise.all([
          import(moduleUrl("dist/core/settings-manager.js")),
          import(moduleUrl("dist/core/resource-loader.js")),
          import(moduleUrl("dist/core/trust-manager.js")),
          import(moduleUrl("dist/core/project-trust.js")),
        ]);

      // Pi 1.5.0 (#10947): a saved "do not trust" decision holds for a project whose only project resource is
      // AGENTS.md. `pi skills` resolves trust through resolveProjectTrusted; the host's ctx.isProjectTrusted()
      // comes from the patched main.js and is what the subagents extension maps to --approve/--no-approve.
      await writeSkill(join(agentDir, "skills", "global-only"), "global-only", "user catalog skill");
      const distrusted = await realpath(await mkdtemp(join(fixtureRoot, "distrusted-")));
      const undecided = await realpath(await mkdtemp(join(fixtureRoot, "undecided-")));
      for (const project of [distrusted, undecided]) {
        await runGit(project, ["init", "--quiet"]);
        await writeFile(join(project, "AGENTS.md"), "# Project instructions\n");
      }
      const trustStore = new ProjectTrustStore(agentDir);
      trustStore.set(distrusted, false);
      const probeRoot = join(fixtureRoot, "probe");
      if (isAtLeast(version, "1.5.0")) {
        assert.equal(
          await resolveProjectTrusted({ cwd: distrusted, trustStore, defaultProjectTrust: "always" }),
          false,
          "the skills CLI trust resolution honours a saved distrust decision",
        );
        assert.equal(
          await probeHostProjectTrust(patchedPackage, { agentDir, cwd: distrusted, home, probeRoot }),
          false,
          "the patched host reports the saved distrust to extensions",
        );
      }
      assert.equal(
        await probeHostProjectTrust(patchedPackage, { agentDir, cwd: undecided, home, probeRoot }),
        true,
        "a project with no trust-requiring resources and no saved decision stays trusted",
      );

      // Adding project-local skills to the distrusted project must not surface them through the patched catalog.
      await writeSkill(join(distrusted, ".pi", "skills", "project-config"), "project-config", "project .pi skill");
      await writeSkill(join(distrusted, ".agents", "skills", "project-agents"), "project-agents", "project skill");
      const distrustedList = await runPatchedCli(patchedPackage, ["skills", "list"], {
        agentDir,
        cwd: distrusted,
        home,
      });
      assert.equal(distrustedList.code, 0, distrustedList.stderr);
      assert.deepEqual(distrustedList.stdout.trim().split("\n"), ["global-only\tuser catalog skill"]);
      const projectAdd = await runPatchedCli(patchedPackage, ["skills", "add", "project-agents", "--global"], {
        agentDir,
        cwd: distrusted,
        home,
      });
      assert.equal(projectAdd.code, 1, "a distrusted project-local skill is not in the catalog");
      assert.equal(
        await probeHostProjectTrust(patchedPackage, { agentDir, cwd: distrusted, home, probeRoot }),
        false,
        "the host stays untrusted once project-local skills exist",
      );

      // Pi 1.5.0 (#11521): non-collision skill warnings, including the overlay's unresolved-entry warning, render
      // under [Skill warnings]; real name collisions stay distinguishable as collision diagnostics.
      const diagnosticsAgentDir = join(fixtureRoot, "diagnostics-agent");
      const duplicateA = join(fixtureRoot, "duplicates", "a", "duplicate");
      const duplicateB = join(fixtureRoot, "duplicates", "b", "duplicate");
      const invalid = join(fixtureRoot, "invalid", "bad-name");
      await Promise.all([
        writeSkill(duplicateA, "duplicate", "first duplicate"),
        writeSkill(duplicateB, "duplicate", "second duplicate"),
        writeSkill(invalid, "Bad_Name", "invalid name fixture"),
      ]);
      await writeJson(join(diagnosticsAgentDir, "skills.json"), {
        enabled: ["missing-skill", duplicateA, duplicateB, invalid],
      });
      const diagnosticsLoader = new DefaultResourceLoader({
        cwd: undecided,
        agentDir: diagnosticsAgentDir,
        settingsManager: SettingsManager.create(undecided, diagnosticsAgentDir, { projectTrusted: false }),
      });
      await diagnosticsLoader.reload();
      const { diagnostics } = diagnosticsLoader.getSkills();
      assert.ok(
        diagnostics.some(
          (d) =>
            d.type === "warning" && d.message === "Active skill could not be resolved" && d.path === "missing-skill",
        ),
        "an unresolved active entry is a warning, not a collision",
      );
      assert.ok(
        diagnostics.some((d) => d.type === "warning" && d.path === join(invalid, "SKILL.md")),
        "upstream validation warnings still reach the loader",
      );
      assert.deepEqual(
        diagnostics.filter((d) => d.type === "collision").map((d) => d.collision?.name),
        ["duplicate"],
        "only the real name collision is a collision",
      );
      const interactive = await readFile(join(patchedPackage, "dist/modes/interactive/interactive-mode.js"), "utf8");
      const patchText = await readFile(join(patchDirectory, "skills.patch"), "utf8");
      assert.doesNotMatch(patchText, /\[Skill (?:warnings|conflicts)\]/u, "the patch never rewrites the label");
      if (isAtLeast(version, "1.5.0")) {
        assert.match(interactive, /\[Skill warnings\]/u);
        assert.doesNotMatch(interactive, /\[Skill conflicts\]/u);
      }

      // Pi 1.5.0 (#10488) folds path identity through getResourcePathKey. A skill activated by catalog name and
      // by an aliased path must still load once through the patched resolver and loader merge.
      const aliasAgentDir = join(fixtureRoot, "alias-agent");
      const aliasedSkill = join(aliasAgentDir, "skills", "aliased");
      await writeSkill(aliasedSkill, "aliased", "path identity fixture");
      const alias = join(fixtureRoot, "alias-link");
      await symlink(aliasedSkill, alias, process.platform === "win32" ? "junction" : "dir");
      await writeJson(join(aliasAgentDir, "skills.json"), { enabled: ["aliased", alias, `${aliasedSkill}/`] });
      const aliasLoader = new DefaultResourceLoader({
        cwd: undecided,
        agentDir: aliasAgentDir,
        settingsManager: SettingsManager.create(undecided, aliasAgentDir, { projectTrusted: false }),
        additionalSkillPaths: [aliasedSkill],
      });
      await aliasLoader.reload();
      assert.deepEqual(
        aliasLoader.getSkills().skills.map((skill) => skill.name),
        ["aliased"],
        "the same user skill reached by name, alias, and session path loads once",
      );
      assert.deepEqual(
        aliasLoader.getSkills().diagnostics.filter((d) => d.type === "collision"),
        [],
        "aliases of one skill are not reported as a collision",
      );
    } finally {
      for (const [key, value] of previousGitEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
