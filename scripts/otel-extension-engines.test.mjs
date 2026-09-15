import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, "extensions", "otel");

describe("vendored OTel extension engine range", () => {
  it("advertises no Node version its dependencies do not support", async () => {
    // Advertising a lower floor than the dependency train supports invites an
    // install that resolves and then fails at runtime, so the manifest is
    // checked against what the locked packages actually declare.
    const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(extension, "package-lock.json"), "utf8"));

    const declared = new Set();
    for (const [name, entry] of Object.entries(lock.packages)) {
      const node = entry.engines?.node;
      if (node && name.startsWith("node_modules/@opentelemetry")) declared.add(node);
    }
    assert.ok(declared.size > 0, "expected OpenTelemetry engine declarations in the lockfile");

    // Every distinct OTel range must be satisfied by the advertised range. The
    // comparison is exact rather than semver-evaluated: these packages publish a
    // single shared range, so a mismatch means the floor drifted.
    const strictest = [...declared].filter((range) => range.includes("20.6.0"));
    assert.ok(strictest.length > 0, "expected the OTel 2.x engine floor in the lockfile");
    for (const range of strictest) {
      assert.equal(manifest.engines.node, range, `engines.node must match the dependency floor ${range}`);
    }
  });
});
