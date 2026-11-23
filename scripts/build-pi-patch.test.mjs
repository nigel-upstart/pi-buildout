import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyPatchFile,
  applyPatchText,
  assertPatchApplies,
  assertUpgradeStatesRoundTrip,
  buildUnifiedDiff,
  countUpstreamEditedLines,
  diffGeneratedArtifacts,
  diffChecksumManifests,
  formatChecksumManifest,
  parseChecksumManifest,
  patchedFileList,
  sortVersions,
  sha256File,
} from "./build-pi-patch.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("formatChecksumManifest emits sha256sum format with two spaces and a trailing newline", () => {
  const text = formatChecksumManifest([
    { path: "dist/main.js", sha256: HASH_A },
    { path: "docs/skills.md", sha256: HASH_B },
  ]);
  assert.equal(text, `${HASH_A}  dist/main.js\n${HASH_B}  docs/skills.md\n`);
});

test("formatChecksumManifest preserves caller order so regeneration stays byte-stable", () => {
  const entries = [
    { path: "z.js", sha256: HASH_A },
    { path: "a.js", sha256: HASH_B },
  ];
  assert.equal(formatChecksumManifest(entries), formatChecksumManifest(entries));
  assert.match(formatChecksumManifest(entries), /^.*z\.js\n.*a\.js\n$/s);
});

test("formatChecksumManifest round-trips through parseChecksumManifest", () => {
  const entries = [
    { path: "dist/main.js", sha256: HASH_A },
    { path: "dist/core/skill-management.js", sha256: HASH_B },
  ];
  assert.deepEqual(parseChecksumManifest(formatChecksumManifest(entries)), entries);
});

test("parseChecksumManifest ignores blank lines and rejects malformed entries", () => {
  assert.deepEqual(parseChecksumManifest(`\n${HASH_A}  dist/main.js\n\n`), [{ path: "dist/main.js", sha256: HASH_A }]);
  assert.throws(() => parseChecksumManifest("not-a-hash  dist/main.js\n"), /Malformed/);
  assert.throws(() => parseChecksumManifest(`${HASH_A}\n`), /Malformed/);
  assert.throws(() => parseChecksumManifest(`${HASH_A.toUpperCase()}  dist/main.js\n`), /Malformed/);
});

const SAMPLE_PATCH = `diff --git a/dist/core/resource-loader.js b/dist/core/resource-loader.js
--- a/dist/core/resource-loader.js
+++ b/dist/core/resource-loader.js
@@ -11,6 +11,7 @@
 import { loadSkills } from "./skills.js";
+import { resolveActiveSkillPaths } from "./skill-management.js";
 import { createSourceInfo } from "./source-info.js";
-const removed = true;
diff --git a/dist/core/skill-management.js b/dist/core/skill-management.js
new file mode 100644
--- /dev/null
+++ b/dist/core/skill-management.js
@@ -0,0 +1,3 @@
+export function one() {}
+export function two() {}
+export function three() {}
`;

test("patchedFileList reports every touched file and which ones the patch creates", () => {
  assert.deepEqual(patchedFileList(SAMPLE_PATCH), [
    { path: "dist/core/resource-loader.js", added: false },
    { path: "dist/core/skill-management.js", added: true },
  ]);
});

test("patchedFileList returns nothing for an empty diff", () => {
  assert.deepEqual(patchedFileList(""), []);
});

test("countUpstreamEditedLines counts only the paths it is given", () => {
  // One added import and one removed line in resource-loader; the new file is ours and is not budgeted.
  assert.equal(countUpstreamEditedLines(SAMPLE_PATCH, new Set(["dist/core/resource-loader.js"])), 2);
});

test("countUpstreamEditedLines ignores files outside the budget entirely", () => {
  assert.equal(countUpstreamEditedLines(SAMPLE_PATCH, new Set()), 0);
  assert.equal(countUpstreamEditedLines(SAMPLE_PATCH, new Set(["dist/core/skill-management.js"])), 3);
});

test("countUpstreamEditedLines ignores context, headers, and hunk markers", () => {
  const contextOnly = `--- a/dist/main.js
+++ b/dist/main.js
@@ -1,3 +1,3 @@
 unchanged one
 unchanged two
`;
  assert.equal(countUpstreamEditedLines(contextOnly, new Set()), 0);
});

test("diffChecksumManifests reports missing, changed, and unexpected paths", () => {
  const expected = [
    { path: "dist/main.js", sha256: HASH_A },
    { path: "docs/skills.md", sha256: HASH_A },
  ];
  const actual = [
    { path: "dist/main.js", sha256: HASH_B },
    { path: "dist/extra.js", sha256: HASH_A },
  ];
  assert.deepEqual(diffChecksumManifests(expected, actual), [
    "changed: dist/main.js",
    "missing: docs/skills.md",
    "unexpected: dist/extra.js",
  ]);
});

test("diffChecksumManifests reports nothing for identical manifests", () => {
  const entries = [{ path: "dist/main.js", sha256: HASH_A }];
  assert.deepEqual(diffChecksumManifests(entries, [...entries]), []);
});

test("diffGeneratedArtifacts reports missing and changed generated files", () => {
  const artifacts = { "skills.patch": "alpha", "patched.sha256": "beta" };
  const actual = new Map([["skills.patch", "stale"]]);
  assert.deepEqual(
    diffGeneratedArtifacts(artifacts, (name) => actual.get(name)),
    ["changed: skills.patch", "missing: patched.sha256"],
  );
});

test("sortVersions orders dotted versions numerically rather than lexically", () => {
  assert.deepEqual(sortVersions(["0.87.1", "0.85.1", "0.100.0", "0.9.0"]), ["0.9.0", "0.85.1", "0.87.1", "0.100.0"]);
  assert.deepEqual(sortVersions([]), []);
});

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const versionsRoot = join(repositoryRoot, "pi-overlay", "versions");
const overlayVersions = readdirSync(versionsRoot).filter((name) =>
  existsSync(join(versionsRoot, name, "upstream.json")),
);

/** The post-image of one file in a unified diff: its context and added lines. */
function patchedSection(patchText, path) {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patchText.indexOf(marker);
  assert.notEqual(start, -1, `patch does not touch ${path}`);
  const next = patchText.indexOf("\ndiff --git ", start + marker.length);
  const lines = patchText.slice(start, next === -1 ? undefined : next).split("\n");
  const body = lines.slice(lines.findIndex((line) => line.startsWith("@@")));
  return body
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n")
    .concat("\n");
}

// Offline counterpart to `npm run patches:check`: it cannot prove the build reproduces, but it catches an
// overlay declaration that disagrees with the artifacts committed for it, for every supported version.
for (const version of overlayVersions) {
  test(`pi ${version} committed artifacts agree with the overlay declaration`, () => {
    const manifest = JSON.parse(readFileSync(join(versionsRoot, version, "upstream.json"), "utf8"));
    const patchDirectory = join(repositoryRoot, "patches", `pi-${version}`);
    const patchText = readFileSync(join(patchDirectory, "skills.patch"), "utf8");
    assert.equal(manifest.version, version);

    // `unchanged` entries are pinned by both manifests but never appear in the patch itself.
    const declared = manifest.trackedFiles
      .filter((entry) => entry.source !== "unchanged")
      .map((entry) => ({ path: entry.path, added: entry.added === true }));
    const byPath = (left, right) => left.path.localeCompare(right.path);
    assert.deepEqual(patchedFileList(patchText).sort(byPath), [...declared].sort(byPath));
    assert.deepEqual(
      parseChecksumManifest(readFileSync(join(patchDirectory, "patched.sha256"), "utf8")).map((entry) => entry.path),
      manifest.trackedFiles.map((entry) => entry.path),
    );

    const baselineByPath = new Map(
      parseChecksumManifest(readFileSync(join(patchDirectory, "baseline.sha256"), "utf8")).map((entry) => [
        entry.path,
        entry.sha256,
      ]),
    );
    const patchedByPath = new Map(
      parseChecksumManifest(readFileSync(join(patchDirectory, "patched.sha256"), "utf8")).map((entry) => [
        entry.path,
        entry.sha256,
      ]),
    );
    for (const entry of manifest.trackedFiles.filter((file) => file.source === "unchanged")) {
      assert.match(baselineByPath.get(entry.path) ?? "", /^[0-9a-f]{64}$/u, `${entry.path} is pinned by the baseline`);
      assert.equal(patchedByPath.get(entry.path), baselineByPath.get(entry.path), `${entry.path} stays unchanged`);
    }

    for (const entry of manifest.trackedFiles.filter((file) => file.source === "replacement")) {
      const replacement = readFileSync(join(versionsRoot, version, "replacements", entry.path), "utf8");
      assert.equal(patchedSection(patchText, entry.path), replacement, `${entry.path} is delivered verbatim`);
    }

    const budgeted = new Set(
      manifest.trackedFiles.filter((entry) => entry.source === "built" && !entry.added).map((entry) => entry.path),
    );
    assert.equal(
      countUpstreamEditedLines(patchText, budgeted),
      manifest.maxUpstreamEditedLines,
      "maxUpstreamEditedLines must equal the measured count, so the budget never silently loosens",
    );
  });
}

test("buildUnifiedDiff isolates hook Git state and disables global commit signing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-diff-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const parent = join(root, "parent");
  const baseline = join(root, "baseline");
  const patched = join(root, "patched");
  for (const directory of [home, parent, baseline, patched]) mkdirSync(directory);
  writeFileSync(join(home, ".gitconfig"), "[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = missing-pi-test-signer\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home });
  const git = (...args) => execFileSync("git", args, { cwd: parent, env, encoding: "utf8" });
  git("init", "--quiet");
  writeFileSync(join(parent, "keep.txt"), "committed\n");
  git("add", "keep.txt");
  git(
    "-c",
    "commit.gpgSign=false",
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "parent",
  );
  writeFileSync(join(parent, "keep.txt"), "staged\n");
  git("add", "keep.txt");
  const head = git("rev-parse", "HEAD");
  const index = readFileSync(join(parent, ".git/index"));
  writeFileSync(join(baseline, "example.js"), "before\n");
  writeFileSync(join(patched, "example.js"), "after\n");
  const moduleUrl = new URL("./build-pi-patch.mjs", import.meta.url).href;
  const patchText = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { buildUnifiedDiff } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(buildUnifiedDiff(...${JSON.stringify([root, baseline, patched, { trackedFiles: [{ path: "example.js" }] }])}));
    `,
    ],
    {
      cwd: parent,
      encoding: "utf8",
      env: {
        ...env,
        GIT_DIR: join(parent, ".git"),
        GIT_WORK_TREE: parent,
        GIT_INDEX_FILE: join(parent, ".git/index"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgSign",
        GIT_CONFIG_VALUE_0: "true",
      },
    },
  );
  assert.match(patchText, /--- a\/example\.js\n\+\+\+ b\/example\.js/u);
  assert.match(patchText, /-before\n\+after/u);
  assert.equal(git("rev-parse", "HEAD"), head, "the invoking repository's HEAD stays untouched");
  assert.deepEqual(readFileSync(join(parent, ".git/index")), index, "the invoking index stays untouched");
  assert.equal(readFileSync(join(parent, "keep.txt"), "utf8"), "staged\n");
  assertPatchApplies(
    root,
    baseline,
    patchText,
    formatChecksumManifest([{ path: "example.js", sha256: sha256File(join(patched, "example.js")) }]),
  );
});

function patchFixture(t, name = "ordinary") {
  const root = mkdtempSync(join(tmpdir(), "pi-shell-safe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "shell-executed");
  const workDir = join(root, name.replaceAll("MARKER", marker));
  const baseline = join(workDir, "baseline");
  const patched = join(workDir, "patched");
  const output = join(workDir, "output");
  for (const directory of [baseline, patched, output]) mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(baseline, "dist/example.js"), "before\n");
  writeFileSync(join(patched, "dist/example.js"), "after\n");
  // Patch contents must also remain literal, including quotes, variables and shell substitution.
  const addedText = "'$HOME' \"${PATH}\" $(printf shell-substitution)\n";
  writeFileSync(join(patched, "dist/added.js"), addedText);
  const trackedFiles = [{ path: "dist/example.js" }, { path: "dist/added.js", added: true }];
  const patchText = buildUnifiedDiff(workDir, baseline, patched, { trackedFiles });
  const patchFile = join(output, "migration ' \" $HOME.patch");
  writeFileSync(patchFile, patchText);
  const patchedManifest = formatChecksumManifest(
    trackedFiles.map(({ path }) => ({ path, sha256: sha256File(join(patched, path)) })),
  );
  writeFileSync(join(output, "patched.sha256"), patchedManifest);
  writeFileSync(join(output, "previous-upgrade.patch"), patchText);
  writeFileSync(
    join(output, "previous-patched.sha256"),
    formatChecksumManifest([{ path: "dist/example.js", sha256: sha256File(join(baseline, "dist/example.js")) }]),
  );
  writeFileSync(join(output, "previous-absent"), "dist/added.js\n");
  return { marker, workDir, baseline, patched, output, patchText, patchFile, patchedManifest, addedText };
}

test("patch generation and forward/reverse verification treat hostile paths literally", async (t) => {
  const normal = patchFixture(t);
  for (const name of [
    "path with spaces",
    "single ' and double \" quotes",
    "$HOME ${PATH} dollars",
    "$(touch${IFS}MARKER)",
    "`touch${IFS}MARKER`",
    '"; touch MARKER; #',
  ]) {
    await t.test(name, (t) => {
      const fixture = patchFixture(t, name);
      const { marker, workDir, baseline, patched, output, patchText, patchFile, patchedManifest, addedText } = fixture;
      assert.equal(patchText, normal.patchText);
      const stage = join(workDir, "direct ' \" $HOME target");
      cpSync(baseline, stage, { recursive: true });
      assert.equal(applyPatchFile(patchFile, stage), 0);
      assert.equal(readFileSync(join(stage, "dist/example.js"), "utf-8"), "after\n");
      assert.equal(readFileSync(join(stage, "dist/added.js"), "utf-8"), addedText);
      assert.equal(applyPatchText(patchText, stage, { reverse: true }), 0);
      assert.equal(readFileSync(join(stage, "dist/example.js"), "utf-8"), "before\n");
      assert.equal(existsSync(join(stage, "dist/added.js")), false);
      assertPatchApplies(workDir, baseline, patchText, patchedManifest);
      assertUpgradeStatesRoundTrip(workDir, patched, output);
      assert.equal(existsSync(marker), false, "path or patch contents executed a shell command");
    });
  }
});

test("patch helpers pipe stdin while inheriting output for overlay integration", (t) => {
  const { patchText, patchFile, baseline } = patchFixture(t);
  assert.equal(applyPatchText(patchText, baseline, { stdio: "inherit" }), 0);
  assert.equal(applyPatchFile(patchFile, baseline, { reverse: true, stdio: "inherit" }), 0);
  assert.equal(readFileSync(join(baseline, "dist/example.js"), "utf-8"), "before\n");
});

test("forward patch failures propagate from helpers and abort baseline verification", (t) => {
  const { workDir, baseline, patchText, patchFile, patchedManifest } = patchFixture(t);
  writeFileSync(join(baseline, "dist/example.js"), "incompatible baseline\n");
  assert.notEqual(applyPatchText(patchText, baseline), 0);
  assert.notEqual(applyPatchFile(patchFile, baseline), 0);
  assert.throws(
    () => assertPatchApplies(workDir, baseline, patchText, patchedManifest),
    /patch failed with status [1-9]/,
  );
  assert.notEqual(applyPatchText("not a patch\n", baseline), 0);
});

test("reverse patch failures propagate and abort upgrade verification with regeneration guidance", (t) => {
  const { workDir, patched, output, patchText, patchFile } = patchFixture(t);
  writeFileSync(join(patched, "dist/example.js"), "incompatible patched tree\n");
  assert.notEqual(applyPatchText(patchText, patched, { reverse: true }), 0);
  assert.notEqual(applyPatchFile(patchFile, patched, { reverse: true }), 0);
  assert.throws(
    () => assertUpgradeStatesRoundTrip(workDir, patched, output),
    /Upgrade state previous no longer applies.*regenerate it:/s,
  );
  assert.notEqual(applyPatchText("not a patch\n", patched, { reverse: true }), 0);
});

test("patch helpers fail closed for missing input files or target directories", (t) => {
  const { workDir, patchText, baseline } = patchFixture(t);
  assert.throws(() => applyPatchFile(join(workDir, "missing.patch"), baseline), { code: "ENOENT" });
  assert.notEqual(applyPatchText(patchText, join(workDir, "missing directory")), 0);
});
