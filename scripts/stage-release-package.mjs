import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPackages = {
  clear: ["clear"],
  effort: ["effort"],
  "markdown-backlinks": ["markdown-backlinks"],
  "router-otel": ["router", "otel"],
  subagents: ["subagents"],
};
const kind = process.argv[2];
if (kind !== "skills-patch" && !Object.hasOwn(extensionPackages, kind)) {
  throw new Error("Unknown Pi release package");
}
const destination = join(root, "packages", `pi-${kind}`, "dist");
await rm(destination, { recursive: true, force: true });

async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}

if (kind !== "skills-patch") {
  for (const name of extensionPackages[kind]) {
    const base = join(root, "extensions", name);
    async function walk(relative = "") {
      for (const entry of await readdir(join(base, relative), { withFileTypes: true })) {
        const child = join(relative, entry.name);
        if (entry.isDirectory()) {
          if (name === "router" && entry.name === "core" && relative === "") await walk(child);
          if (name === "otel" && entry.name === "src" && relative === "") await walk(child);
          if (name === "otel" && relative.startsWith("src")) await walk(child);
        } else if (entry.isFile() && child.endsWith(".ts") && !child.endsWith(".test.ts")) {
          await copy(join(base, child), join(destination, "extensions", name, child));
        }
      }
    }
    await walk();
    if (name === "otel") await copy(join(base, "LICENSE"), join(destination, "extensions", name, "LICENSE"));
  }
} else {
  await copy(join(root, "scripts", "install-extensions.sh"), join(destination, "scripts", "install-extensions.sh"));
  for (const entry of await readdir(join(root, "patches"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("pi-")) continue;
    for (const file of await readdir(join(root, "patches", entry.name), { withFileTypes: true })) {
      if (file.isFile() && /^(?:.*\.(?:patch|sha256|absent))$/.test(file.name)) {
        await copy(join(root, "patches", entry.name, file.name), join(destination, "patches", entry.name, file.name));
      }
    }
  }
}
await copy(join(root, "ATTRIBUTION.md"), join(destination, "ATTRIBUTION.md"));
await copy(join(root, "LICENSE"), join(destination, "LICENSE"));
