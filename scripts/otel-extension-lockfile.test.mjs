import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("vendored OTel extension dependency manifest", () => {
  it("resolves every package from the public registry", async () => {
    // A lockfile generated behind an internal mirror records that mirror's host in every
    // `resolved` URL. It installs for whoever generated it and fails for CI and for anyone
    // without those credentials, so the host set is asserted rather than assumed.
    const lock = JSON.parse(await readFile(join(root, "extensions", "otel", "package-lock.json"), "utf8"));
    const hosts = new Set();
    for (const entry of Object.values(lock.packages)) {
      if (typeof entry.resolved === "string") hosts.add(new URL(entry.resolved).host);
    }
    assert.ok(hosts.size > 0, "expected resolved packages in the lockfile");
    assert.deepEqual([...hosts], ["registry.npmjs.org"]);
  });

  it("pins the registry so a regenerated lockfile stays portable", async () => {
    const npmrc = await readFile(join(root, "extensions", "otel", ".npmrc"), "utf8");
    assert.match(npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
  });
});
