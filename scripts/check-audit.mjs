// `npm audit` for this repository's devDependencies can surface a small, dated set of
// high/critical advisories that are not immediately fixable by this project.
//
// Most entries live entirely inside a nested `npm-shrinkwrap.json` published by
// `@earendil-works/pi-coding-agent`. A shrinkwrap file is a deliberate npm install boundary (see
// `npm help npm-shrinkwrap-json`): this project's `overrides` field cannot reach inside it, and
// bumping the pinned pi package does not help either — the same vulnerable nested versions are still
// present in the latest version published at the time each entry below was recorded.
//
// Some entries may be temporarily held by this repository's `min-release-age` npm policy after a
// patched package is published but before npm is allowed to install it. Each entry is scoped to an
// exact advisory, package, and node path so an unrelated or newly reachable instance of the same
// package/advisory still fails the gate.
//
// Review and prune this allowlist whenever `@earendil-works/pi-*` is upgraded or an embargoed fix
// ages past `min-release-age`: if `npm audit` output for an entry disappears, remove the entry.
import { execFileSync } from "node:child_process";

const ALLOWLIST = [
  {
    package: "brace-expansion",
    advisoryUrl: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
    nodePathPrefix: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
    recordedAt: "2026-07-20",
    reason:
      "Locked by @earendil-works/pi-coding-agent's published npm-shrinkwrap.json through at least 0.80.10; no override reaches inside a shrinkwrapped subtree.",
  },
  {
    package: "protobufjs",
    advisoryUrl: "https://github.com/advisories/GHSA-j3f2-48v5-ccww",
    nodePathPrefix: "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs",
    recordedAt: "2026-07-20",
    reason:
      "Locked by @earendil-works/pi-coding-agent's published npm-shrinkwrap.json through at least 0.80.10; no override reaches inside a shrinkwrapped subtree.",
  },
  {
    package: "fast-uri",
    advisoryUrl: "https://github.com/advisories/GHSA-v2hh-gcrm-f6hx",
    nodePathPrefix: "node_modules/fast-uri",
    recordedAt: "2026-07-22",
    reason:
      "Patched fast-uri 3.1.4 exists, but this repository's min-release-age policy blocks installing it until the release ages past five days; root dev-tooling path only.",
  },
  {
    package: "brace-expansion",
    advisoryUrl: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
    nodePaths: [
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
      "node_modules/brace-expansion",
      "node_modules/minimatch/node_modules/brace-expansion",
    ],
    recordedAt: "2026-07-25",
    reason:
      "The root dev-tooling tree and Pi's shrinkwrapped subtree resolve only versions covered by this advisory. Patched brace-expansion 5.0.8 was published 2026-07-23 and is temporarily blocked by min-release-age.",
  },
  {
    package: "brace-expansion",
    advisoryUrl: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
    nodePaths: [
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
      "node_modules/brace-expansion",
      "node_modules/minimatch/node_modules/brace-expansion",
    ],
    recordedAt: "2026-07-25",
    reason:
      "The root dev-tooling tree and Pi's shrinkwrapped subtree resolve only versions covered by this advisory. Patched brace-expansion 5.0.8 was published 2026-07-23 and is temporarily blocked by min-release-age.",
  },
  {
    package: "js-yaml",
    advisoryUrl: "https://github.com/advisories/GHSA-pm4m-ph32-ghv5",
    nodePaths: ["node_modules/js-yaml"],
    recordedAt: "2026-07-25",
    reason:
      "Patched js-yaml 5.2.2 was published 2026-07-23 and is temporarily blocked by min-release-age; the only non-shrinkwrapped instance is root dev-tooling.",
  },
];

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--json", "--registry=https://registry.npmjs.org/"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // `npm audit` exits non-zero whenever it finds any vulnerability; its JSON report is still on stdout.
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : undefined;
    if (stdout) return stdout;
    throw error;
  }
}

const report = JSON.parse(runAudit());
const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const blocking = vulnerabilities.filter((entry) => entry.severity === "high" || entry.severity === "critical");

const advisoryUrls = (entry) => (entry.via ?? []).filter((via) => typeof via === "object").map((via) => via.url);

const sameNodePaths = (left, right) =>
  left.length === right.length && left.every((node, index) => node === right[index]);

const directMatches = new Map();
for (const entry of blocking) {
  const urls = advisoryUrls(entry);
  if (urls.length === 0) continue;

  const nodes = Array.isArray(entry.nodes) ? [...entry.nodes].sort() : [];
  const match = ALLOWLIST.find(
    (allowed) =>
      allowed.package === entry.name &&
      urls.includes(allowed.advisoryUrl) &&
      nodes.length > 0 &&
      (allowed.nodePaths
        ? sameNodePaths(nodes, [...allowed.nodePaths].sort())
        : nodes.every((node) => node.startsWith(allowed.nodePathPrefix))),
  );
  if (match) directMatches.set(entry.name, match);
}

const acceptedNames = new Set(directMatches.keys());
let changed = true;
while (changed) {
  changed = false;
  for (const entry of blocking) {
    if (acceptedNames.has(entry.name) || advisoryUrls(entry).length > 0) continue;
    const sources = (entry.via ?? []).filter((via) => typeof via === "string");
    if (sources.length > 0 && sources.every((source) => acceptedNames.has(source))) {
      acceptedNames.add(entry.name);
      changed = true;
    }
  }
}

const accepted = blocking
  .filter((entry) => acceptedNames.has(entry.name))
  .map((entry) => ({ entry, match: directMatches.get(entry.name) }))
  .filter(({ match }) => match);
const unexplained = blocking.filter((entry) => !acceptedNames.has(entry.name));

for (const { match } of accepted) {
  console.log(
    `known reviewed advisory accepted: ${match.package} (${match.advisoryUrl}), recorded ${match.recordedAt} — ${match.reason}`,
  );
}

if (unexplained.length > 0) {
  console.error("npm audit found high/critical vulnerabilities that are not on the reviewed allowlist:");
  for (const entry of unexplained) {
    console.error(`- ${entry.name} (${entry.severity}): ${advisoryUrls(entry).join(", ") || "no advisory URL"}`);
    console.error(`  nodes: ${(entry.nodes ?? []).join(", ")}`);
  }
  process.exit(1);
}

const total = report.metadata?.vulnerabilities?.total ?? vulnerabilities.length;
console.log(`npm audit: ${String(total)} total finding(s), ${String(blocking.length)} high/critical, 0 unexplained`);
