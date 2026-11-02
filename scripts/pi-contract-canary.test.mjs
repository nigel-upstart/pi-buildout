import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installedPiPackages, isSupportedPi, lockstepPackages, SUPPORTED_RANGE } from "./pi-contract-canary.mjs";

test("the canary treats exactly >=1.2.0 <2.0.0 releases as supported", () => {
  assert.equal(SUPPORTED_RANGE, ">=1.2.0 <2.0.0");
  for (const version of ["1.2.0", "1.3.0", "1.99.12"]) assert.equal(isSupportedPi(version), true, version);
  // A future 2.x latest is an unsupported-upgrade investigation, never a silent support expansion.
  for (const version of ["1.1.9", "1.0.3", "0.87.1", "2.0.0", "2.1.0", "1.4.0-rc.1", "1.3", "latest", ""])
    assert.equal(isSupportedPi(version), false, version);
});

test("lockstep packages follow every transitive Pi dependency at the same version", () => {
  const registry = {
    "@earendil-works/pi-coding-agent@1.2.0": {
      version: "1.2.0",
      dependencies: { "@earendil-works/pi-ai": "^1.2.0", "@earendil-works/pi-tui": "^1.2.0", typebox: "1.3.27" },
    },
    "@earendil-works/pi-ai@1.2.0": { version: "1.2.0", dependencies: { "@earendil-works/pi-telemetry": "^1.2.0" } },
    "@earendil-works/pi-tui@1.2.0": { version: "1.2.0" },
    "@earendil-works/pi-telemetry@1.2.0": { version: "1.2.0", dependencies: { "@earendil-works/pi-ai": "^1.2.0" } },
  };
  assert.deepEqual(
    lockstepPackages("1.2.0", (spec) => registry[spec]),
    [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-telemetry",
      "@earendil-works/pi-tui",
    ],
  );
  delete registry["@earendil-works/pi-telemetry@1.2.0"];
  assert.throws(
    () => lockstepPackages("1.2.0", (spec) => registry[spec]),
    /pi-telemetry@1\.2\.0 is not published; the Pi 1\.2\.0 release is not coherent/,
  );
});

test("installed Pi packages include nested copies, so a caret-resolved peer cannot hide", async (t) => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-contract-fixture-"));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  const manifest = async (path, name, version) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version }));
  };
  const modules = join(prefix, "node_modules");
  await manifest(join(modules, "@earendil-works", "pi-coding-agent"), "@earendil-works/pi-coding-agent", "1.2.0");
  await manifest(
    join(modules, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai"),
    "@earendil-works/pi-ai",
    "1.3.0",
  );
  await manifest(join(modules, "typebox"), "typebox", "1.3.27");
  assert.deepEqual(
    installedPiPackages(prefix).map(({ name, version }) => `${name}@${version}`),
    ["@earendil-works/pi-coding-agent@1.2.0", "@earendil-works/pi-ai@1.3.0"],
  );
});
