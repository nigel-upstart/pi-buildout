#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registry = "https://code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/";
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

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }
  const releaseList = options.selected.map((name) => {
    const dir = join(root, "packages", packages.get(name));
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (manifest.publishConfig?.registry !== registry || !/^\d+\.\d+\.\d+-alpha\.\d+$/.test(manifest.version)) {
      throw new Error(`${manifest.name} must target the approved CodeArtifact registry and use an alpha.N version`);
    }
    return { dir, manifest };
  });
  for (const { dir, manifest } of releaseList) {
    console.log(`\n${options.publish ? "Publishing" : "Dry run:"} ${manifest.name}@${manifest.version}`);
    if (options.publish) {
      run("npm", ["publish", "--registry", registry, "--tag", "alpha"], {
        cwd: dir,
        env: { ...process.env, PI_CODEARTIFACT_PUBLISH: "1" },
      });
    } else {
      run("npm", ["pack", "--dry-run", "--json"], { cwd: dir });
    }
  }
} catch (error) {
  console.error(`release:packages: ${error.message}`);
  process.exitCode = 1;
}
